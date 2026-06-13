import { prisma } from "./prisma";
import { getLodgeCapacity } from "./capacity";
import { FALLBACK_LODGE_CAPACITY } from "@/lib/lodge-capacity";
import { BookingStatus, Prisma } from "@prisma/client";
import { eachDayOfInterval, subDays, format } from "date-fns";
import {
  sendBookingBumpedEmail,
  sendBookingGuestsRemovedEmail,
  sendAdminBookingBumpedAlert,
} from "./email";
import logger from "@/lib/logger";
import { CAPACITY_HOLDING_BOOKING_STATUSES } from "@/lib/booking-status";
import {
  countActiveGuestsForNight,
  type GuestStayRange,
} from "@/lib/booking-guest-stay-ranges";
import { deletePromoRedemptionAndAdjustCount } from "@/lib/promo";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { revokePaymentLinksForBooking } from "@/lib/payment-link";
import { applyPartialBumpInTransaction } from "@/lib/partial-bump";

export interface BumpResult {
  bumpedBookingIds: string[];
  // Bookings whose non-member guests were removed but kept their member
  // guests (the new default). These members get a "your guests didn't fit,
  // your booking continues" email rather than a bumped email.
  partiallyBumpedBookingIds: string[];
  capacityRestored: boolean;
}

type BookingWithGuests = Prisma.BookingGetPayload<{
  include: {
    guests: true;
    member: true;
    promoRedemption: {
      include: {
        guestTargets: { select: { bookingGuestId: true } };
        promoCode: {
          include: { assignments: { select: { memberId: true } } };
        };
      };
    };
  };
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
    include: {
      guests: true,
      member: true,
      promoRedemption: {
        include: {
          guestTargets: { select: { bookingGuestId: true } },
          promoCode: {
            include: { assignments: { select: { memberId: true } } },
          },
        },
      },
    },
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
 * Recalculate occupied beds after freeing a specific set of a booking's guests
 * (the whole guest list for a full bump, or just the non-members for a partial
 * bump). The booking's check-in/out range bounds each guest's active nights.
 */
function subtractGuestsFromOccupancy(
  occupiedMap: Map<string, number>,
  guests: GuestStayRange[],
  range: { checkIn: Date; checkOut: Date }
): Map<string, number> {
  const updated = new Map(occupiedMap);

  for (const [dateKey, occupied] of updated) {
    const night = new Date(`${dateKey}T00:00:00.000Z`);
    const activeGuestCount = countActiveGuestsForNight(guests, night, range);

    if (activeGuestCount > 0) {
      updated.set(dateKey, occupied - activeGuestCount);
    }
  }

  return updated;
}

function removeBumpedBookingFromOccupancy(
  occupiedMap: Map<string, number>,
  booking: BookingWithGuests
): Map<string, number> {
  return subtractGuestsFromOccupancy(occupiedMap, booking.guests, booking);
}

/**
 * Whole-booking bump with the cron-style status claim for idempotency: only
 * one worker may move the booking PENDING -> BUMPED. On a successful claim we
 * reconcile bed allocations and clean up any promo redemption. No charge or
 * refund is involved — bumped bookings are always still PENDING (uncharged).
 */
async function claimAndWholeBump(
  tx: Prisma.TransactionClient,
  booking: BookingWithGuests
): Promise<boolean> {
  const claimed = await tx.booking.updateMany({
    where: { id: booking.id, status: BookingStatus.PENDING },
    data: { status: BookingStatus.BUMPED },
  });
  if (claimed.count === 0) {
    return false;
  }

  await reconcileBedAllocationsForBooking({
    bookingId: booking.id,
    db: tx,
    previousRange: {
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
    },
  });

  const promoRedemption = await tx.promoRedemption.findUnique({
    where: { bookingId: booking.id },
  });
  if (promoRedemption) {
    await deletePromoRedemptionAndAdjustCount(tx, promoRedemption);
  }

  // Revoke any tokenised payment links (request-origin bookings, #707) so a
  // bumped booking can't be paid for. No-op for bookings without links.
  await revokePaymentLinksForBooking(booking.id, tx);

  return true;
}

/**
 * Most-recent-first bumping algorithm.
 *
 * When a MEMBER creates a booking that would push any night past lodge capacity:
 * 1. Find all PENDING bookings overlapping those nights
 * 2. Sort by createdAt DESC (most recently created = first bumped)
 * 3. For each candidate, free capacity until the incoming booking fits:
 *    - Flagged ("only book if my guests can come") => whole-booking bump.
 *    - Default => partial bump: drop the non-member guests, keep the members,
 *      reprice. If freeing the non-members isn't enough, fall back to a
 *      whole-booking bump of that same candidate.
 * 4. No refund needed — every candidate is PENDING (uncharged).
 *
 * Returns the bumped/partially-bumped booking IDs and whether capacity was
 * restored. If there aren't enough PENDING bookings to free, returns
 * capacityRestored=false and the caller should reject the new booking.
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

  const capacityNowRestored = () =>
    !wouldExceedCapacityForGuestRanges(
      occupiedMap,
      checkIn,
      checkOut,
      newGuests,
      lodgeCapacity,
    );

  // Check if bumping is even needed
  if (capacityNowRestored()) {
    return {
      bumpedBookingIds: [],
      partiallyBumpedBookingIds: [],
      capacityRestored: true,
    };
  }

  // Find bump candidates (PENDING, overlapping, most recent first)
  const candidates = await findBumpCandidates(checkIn, checkOut, tx);

  if (candidates.length === 0) {
    return {
      bumpedBookingIds: [],
      partiallyBumpedBookingIds: [],
      capacityRestored: false,
    };
  }

  const bumpedBookingIds: string[] = [];
  const partiallyBumpedBookingIds: string[] = [];

  for (const candidate of candidates) {
    const nonMemberGuests = candidate.guests.filter((guest) => !guest.isMember);
    const memberGuests = candidate.guests.filter((guest) => guest.isMember);

    // Default behaviour: drop only the non-members and keep the members. Only
    // attempt it when the member opted into the gentler path and there is a
    // mix of member and non-member guests to split.
    const canPartialBump =
      !candidate.cancelIfGuestsBumped &&
      nonMemberGuests.length > 0 &&
      memberGuests.length > 0;

    if (canPartialBump) {
      const partial = await applyPartialBumpInTransaction({
        tx,
        booking: candidate,
      });

      if (partial.kind === "already-processed") {
        // Another worker handled this booking; nothing more to free here.
        continue;
      }

      if (partial.kind === "partial") {
        // Free just the non-member beds — the member portion stays put.
        occupiedMap = subtractGuestsFromOccupancy(
          occupiedMap,
          partial.removedGuests,
          candidate
        );

        if (capacityNowRestored()) {
          partiallyBumpedBookingIds.push(candidate.id);
          break;
        }

        // Removing the non-members alone wasn't enough — fall back to a
        // whole-booking bump of this candidate (free the member beds too).
        if (await claimAndWholeBump(tx, candidate)) {
          occupiedMap = subtractGuestsFromOccupancy(
            occupiedMap,
            partial.remainingGuests,
            candidate
          );
          bumpedBookingIds.push(candidate.id);
        } else {
          partiallyBumpedBookingIds.push(candidate.id);
        }

        if (capacityNowRestored()) {
          break;
        }
        continue;
      }
      // partial.kind === "no-non-members" / "no-members-remain" falls through
      // to the whole-booking bump below.
    }

    if (await claimAndWholeBump(tx, candidate)) {
      occupiedMap = removeBumpedBookingFromOccupancy(occupiedMap, candidate);
      bumpedBookingIds.push(candidate.id);
    }

    if (capacityNowRestored()) {
      break;
    }
  }

  return {
    bumpedBookingIds,
    partiallyBumpedBookingIds,
    capacityRestored: capacityNowRestored(),
  };
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

/**
 * Notify members whose non-member guests were dropped (partial bump) that their
 * booking continues at the repriced amount. Called after the transaction
 * commits so emails aren't sent on rollback. No charge happens here — partial
 * bumps are pre-charge, so there is never a refund to mention.
 */
export async function sendPartialBumpNotifications(
  partiallyBumpedBookingIds: string[]
): Promise<void> {
  for (const bookingId of partiallyBumpedBookingIds) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { member: true, guests: true },
    });

    if (!booking) continue;

    try {
      await sendBookingGuestsRemovedEmail(
        booking.member.email,
        booking.member.firstName,
        booking.checkIn,
        booking.checkOut,
        booking.guests.length,
        booking.finalPriceCents
      );
    } catch (err) {
      logger.error(
        { err, bookingId },
        "Failed to send partial-bump (guests removed) email"
      );
    }
  }
}
