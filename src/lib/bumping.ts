import { prisma } from "./prisma";
import { LODGE_CAPACITY } from "./capacity";
import { BookingStatus, Prisma } from "@prisma/client";
import { eachDayOfInterval, subDays, format, startOfDay } from "date-fns";
import { sendBookingBumpedEmail, sendAdminBookingBumpedAlert } from "./email";
import logger from "@/lib/logger";

export interface BumpResult {
  bumpedBookingIds: string[];
  capacityRestored: boolean;
}

type BookingWithGuests = Prisma.BookingGetPayload<{
  include: { guests: true; member: true };
}>;

/**
 * Calculate occupied beds per night for a date range, excluding specific booking IDs.
 * Only counts CONFIRMED and PENDING bookings.
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
      status: { in: [BookingStatus.CONFIRMED, BookingStatus.PENDING] },
      ...(excludeBookingIds.length > 0
        ? { id: { notIn: excludeBookingIds } }
        : {}),
    },
    include: { guests: true },
  });

  const occupiedMap = new Map<string, number>();

  for (const night of nights) {
    const nightTime = night.getTime();
    let occupiedBeds = 0;

    for (const booking of overlappingBookings) {
      const bCheckIn = startOfDay(new Date(booking.checkIn)).getTime();
      const bCheckOut = startOfDay(new Date(booking.checkOut)).getTime();
      if (nightTime >= bCheckIn && nightTime < bCheckOut) {
        occupiedBeds += booking.guests.length;
      }
    }

    const key = format(night, "yyyy-MM-dd");
    occupiedMap.set(key, occupiedBeds);
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
    orderBy: { createdAt: "desc" }, // FIFO: most recent first
  });
}

/**
 * Check if capacity would be exceeded on any night after adding new guests.
 */
export function wouldExceedCapacity(
  occupiedBedsPerNight: Map<string, number>,
  newGuestCount: number
): boolean {
  for (const [, occupied] of occupiedBedsPerNight) {
    if (occupied + newGuestCount > LODGE_CAPACITY) {
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
  const bCheckIn = new Date(booking.checkIn).getTime();
  const bCheckOut = new Date(booking.checkOut).getTime();

  for (const [dateKey, occupied] of updated) {
    const nightTime = new Date(dateKey).getTime();
    if (nightTime >= bCheckIn && nightTime < bCheckOut) {
      updated.set(dateKey, occupied - booking.guests.length);
    }
  }

  return updated;
}

/**
 * FIFO bumping algorithm.
 *
 * When a MEMBER creates a booking that would push any night past 29 beds:
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
  newGuestCount: number,
  tx: Prisma.TransactionClient
): Promise<BumpResult> {
  // Get current occupancy excluding nothing (we want the full picture)
  let occupiedMap = await getOccupiedBedsPerNight(checkIn, checkOut, [], tx);

  // Check if bumping is even needed
  if (!wouldExceedCapacity(occupiedMap, newGuestCount)) {
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

    // Clean up PromoRedemption if this booking used a promo code
    const promoRedemption = await tx.promoRedemption.findUnique({
      where: { bookingId: candidate.id },
    });
    if (promoRedemption) {
      await tx.promoRedemption.delete({
        where: { id: promoRedemption.id },
      });
      await tx.promoCode.update({
        where: { id: promoRedemption.promoCodeId },
        data: { currentRedemptions: { decrement: 1 } },
      });
    }

    bumpedBookingIds.push(candidate.id);

    // Remove this booking's guests from occupancy count
    occupiedMap = removeBumpedBookingFromOccupancy(occupiedMap, candidate);

    // Check if capacity is now restored
    if (!wouldExceedCapacity(occupiedMap, newGuestCount)) {
      break;
    }
  }

  // Final check: is capacity restored?
  const capacityRestored = !wouldExceedCapacity(occupiedMap, newGuestCount);

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
