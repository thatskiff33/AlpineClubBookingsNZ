import { prisma } from "./prisma";
import { getLodgeCapacity } from "./capacity";
import { FALLBACK_LODGE_CAPACITY } from "@/lib/lodge-capacity";
import { BookingStatus, Prisma } from "@prisma/client";
import { eachDayOfInterval, subDays, format } from "date-fns";
import { sendBookingBumpedEmail, sendAdminBookingBumpedAlert } from "./email";
import logger from "@/lib/logger";
import { CAPACITY_HOLDING_BOOKING_STATUSES } from "@/lib/booking-status";
import {
  countActiveGuestsForNight,
  type GuestStayRange,
} from "@/lib/booking-guest-stay-ranges";
import { deletePromoRedemptionAndAdjustCount } from "@/lib/promo";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";

export interface BumpResult {
  bumpedBookingIds: string[];
  capacityRestored: boolean;
}

type BookingWithGuests = Prisma.BookingGetPayload<{
  include: { guests: true; member: true };
}>;

/**
 * Calculate occupied beds per night for a date range, excluding specific booking IDs.
 * Only counts bookings that intentionally reserve capacity.
 */
export async function getOccupiedBedsPerNight(
  checkIn: Date,
  checkOut: Date,
  excludeBookingIds: string[] = [],
  tx?: Prisma.TransactionClient
): Promise<Map<string, number>> {
  const db = tx || prisma;
  const nights = eachDayOfInterval({
    start: checkIn,
    end: subDays(checkOut, 1),
  });

  const overlappingBookings = await db.booking.findMany({
    where: {
      checkIn: { lt: checkOut },
      checkOut: { gt: checkIn },
      status: { in: [...CAPACITY_HOLDING_BOOKING_STATUSES] },
      ...(excludeBookingIds.length > 0
        ? { id: { notIn: excludeBookingIds } }
        : {}),
    },
    include: { guests: true },
  });

  const occupiedMap = new Map<string, number>();

  for (const night of nights) {
    const key = format(night, "yyyy-MM-dd");
    const activeGuestCount = overlappingBookings.reduce(
      (total, booking) =>
        total + countActiveGuestsForNight(booking.guests, night, booking),
      0
    );

    occupiedMap.set(key, activeGuestCount);
  }

  return occupiedMap;
}

/**
 * Find PENDING bookings that overlap with a date range, sorted by createdAt DESC
 * (most recently created first = first to be bumped).
 */
export async function findBumpCandidates(
  checkIn: Date,
  checkOut: Date,
  tx?: Prisma.TransactionClient
): Promise<BookingWithGuests[]> {
  const db = tx || prisma;

  return db.booking.findMany({
    where: {
      checkIn: { lt: checkOut },
      checkOut: { gt: checkIn },
      status: BookingStatus.PENDING,
    },
    include: { guests: true, member: true },
    orderBy: { createdAt: "desc" }, // Most recent pending bookings are bumped first
  });
}

/**
 * Check if capacity would be exceeded on any night after adding new guests.
 */
export function wouldExceedCapacity(
  occupiedBedsPerNight: Map<string, number>,
  newGuestCount: number,
  lodgeCapacity = FALLBACK_LODGE_CAPACITY,
): boolean {
  for (const [, occupied] of occupiedBedsPerNight) {
    if (occupied + newGuestCount > lodgeCapacity) {
      return true;
    }
  }
  return false;
}

function wouldExceedCapacityForGuestRanges(
  occupiedBedsPerNight: Map<string, number>,
  checkIn: Date,
  checkOut: Date,
  newGuests: number | GuestStayRange[],
  lodgeCapacity: number,
): boolean {
  for (const [dateKey, occupied] of occupiedBedsPerNight) {
    const proposedBeds = Array.isArray(newGuests)
      ? countActiveGuestsForNight(
          newGuests,
          new Date(`${dateKey}T00:00:00.000Z`),
          { checkIn, checkOut }
        )
      : newGuests;

    if (occupied + proposedBeds > lodgeCapacity) {
      return true;
    }
  }

  return false;
}

/**
 * Recalculate occupied beds after removing a bumped booking's guests.
 */
function removeBumpedBookingFromOccupancy(
  occupiedMap: Map<string, number>,
  booking: BookingWithGuests
): Map<string, number> {
  const updated = new Map(occupiedMap);

  for (const [dateKey, occupied] of updated) {
    const night = new Date(`${dateKey}T00:00:00.000Z`);
    const activeGuestCount = countActiveGuestsForNight(
      booking.guests,
      night,
      booking
    );

    if (activeGuestCount > 0) {
      updated.set(dateKey, occupied - activeGuestCount);
    }
  }

  return updated;
}

/**
 * Most-recent-first bumping algorithm.
 *
 * When a MEMBER creates a booking that would push any night past lodge capacity:
 * 1. Find all PENDING bookings overlapping those nights
 * 2. Sort by createdAt DESC (most recently created = first bumped)
 * 3. Bump one at a time until capacity is restored
 * 4. For each bumped booking: set status=BUMPED, send notification email
 * 5. No refund needed (PENDING bookings haven't been charged)
 *
 * Returns the list of bumped booking IDs and whether capacity was restored.
 * If there aren't enough PENDING bookings to bump, returns capacityRestored=false
 * and the caller should reject the new booking.
 */
export async function bumpPendingBookings(
  checkIn: Date,
  checkOut: Date,
  newGuests: number | GuestStayRange[],
  tx: Prisma.TransactionClient
): Promise<BumpResult> {
  const lodgeCapacity = await getLodgeCapacity(tx);

  // Get current occupancy excluding nothing (we want the full picture)
  let occupiedMap = await getOccupiedBedsPerNight(checkIn, checkOut, [], tx);

  // Check if bumping is even needed
  if (
    !wouldExceedCapacityForGuestRanges(
      occupiedMap,
      checkIn,
      checkOut,
      newGuests,
      lodgeCapacity,
    )
  ) {
    return { bumpedBookingIds: [], capacityRestored: true };
  }

  // Find bump candidates (PENDING, overlapping, most recent first)
  const candidates = await findBumpCandidates(checkIn, checkOut, tx);

  if (candidates.length === 0) {
    return { bumpedBookingIds: [], capacityRestored: false };
  }

  const bumpedBookingIds: string[] = [];

  for (const candidate of candidates) {
    // Bump this booking
    await tx.booking.update({
      where: { id: candidate.id },
      data: { status: BookingStatus.BUMPED },
    });
    await reconcileBedAllocationsForBooking({
      bookingId: candidate.id,
      db: tx,
      previousRange: {
        checkIn: candidate.checkIn,
        checkOut: candidate.checkOut,
      },
    });

    // Clean up PromoRedemption if this booking used a promo code
    const promoRedemption = await tx.promoRedemption.findUnique({
      where: { bookingId: candidate.id },
    });
    if (promoRedemption) {
      await deletePromoRedemptionAndAdjustCount(tx, promoRedemption);
    }

    bumpedBookingIds.push(candidate.id);

    // Remove this booking's guests from occupancy count
    occupiedMap = removeBumpedBookingFromOccupancy(occupiedMap, candidate);

    // Check if capacity is now restored
    if (
      !wouldExceedCapacityForGuestRanges(
        occupiedMap,
        checkIn,
        checkOut,
        newGuests,
        lodgeCapacity,
      )
    ) {
      break;
    }
  }

  // Final check: is capacity restored?
  const capacityRestored = !wouldExceedCapacityForGuestRanges(
    occupiedMap,
    checkIn,
    checkOut,
    newGuests,
    lodgeCapacity,
  );

  return { bumpedBookingIds, capacityRestored };
}

/**
 * Send bumped notification emails for a list of booking IDs.
 * Called after the transaction commits so emails aren't sent on rollback.
 * @param triggeringMemberName - Name of the member whose booking triggered the bump (for admin alerts)
 */
export async function sendBumpedNotifications(
  bumpedBookingIds: string[],
  triggeringMemberName?: string
): Promise<void> {
  for (const bookingId of bumpedBookingIds) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { member: true, guests: true },
    });

    if (!booking) continue;

    try {
      await sendBookingBumpedEmail(
        booking.member.email,
        booking.member.firstName,
        booking.checkIn,
        booking.checkOut,
        booking.guests.length
      );
    } catch (err) {
      logger.error({ err, bookingId }, "Failed to send bumped email");
    }

    // N-07: Send admin alert for each bumped booking
    sendAdminBookingBumpedAlert({
      bumpedMemberName: `${booking.member.firstName} ${booking.member.lastName}`,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      guestCount: booking.guests.length,
      triggeringMemberName: triggeringMemberName || "Unknown",
    }).catch((err) =>
      logger.error({ err, bookingId }, "Failed to send admin bump alert")
    );
  }
}
