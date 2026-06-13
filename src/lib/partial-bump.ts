import { BookingStatus, Prisma } from "@prisma/client";
import { calculateBookingPrice } from "@/lib/pricing";
import {
  loadSeasonRateData,
  recalculateBookingPromo,
} from "@/lib/booking-guest-removal-service";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";

/**
 * The booking shape the partial bump needs: guests plus the promo redemption
 * (with its promo code, assignments, and stored guest targets) so the discount
 * can be re-validated against the remaining member guests.
 */
export type PartialBumpBooking = Prisma.BookingGetPayload<{
  include: {
    guests: true;
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

export type PartialBumpResult =
  // The booking has no non-member guests to remove — caller should not bump.
  | { kind: "no-non-members" }
  // Every guest is a non-member, so a partial bump would empty the booking.
  // The caller should fall back to a whole-booking bump.
  | { kind: "no-members-remain" }
  // A concurrent worker already partial-bumped this booking (claim lost).
  | { kind: "already-processed" }
  // Non-members removed, members kept, repriced.
  | {
      kind: "partial";
      removedGuests: PartialBumpBooking["guests"];
      remainingGuests: PartialBumpBooking["guests"];
      newTotalPriceCents: number;
      newDiscountCents: number;
      newPromoAdjustmentCents: number;
      newFinalPriceCents: number;
      promoRemoved: boolean;
    };

/**
 * Partial bump: remove a PENDING member booking's non-member guests, keep the
 * member guests, reprice, recalculate (or drop) the promo, and reconcile bed
 * allocations — all inside the caller's transaction. Nothing is charged here;
 * partial bumps always happen pre-charge so no refund path is ever involved.
 *
 * Idempotency follows the cron status-claim convention: the booking is claimed
 * with an `updateMany` that flips `hasNonMembers` true -> false. A concurrent
 * worker that already processed it sees `count === 0` and we bail out.
 */
export async function applyPartialBumpInTransaction({
  tx,
  booking,
}: {
  tx: Prisma.TransactionClient;
  booking: PartialBumpBooking;
}): Promise<PartialBumpResult> {
  const nonMemberGuests = booking.guests.filter((guest) => !guest.isMember);
  const remainingGuests = booking.guests.filter((guest) => guest.isMember);

  if (nonMemberGuests.length === 0) {
    return { kind: "no-non-members" };
  }
  if (remainingGuests.length === 0) {
    return { kind: "no-members-remain" };
  }

  // Claim the booking idempotently: only one worker may flip hasNonMembers
  // off and clear the hold. Clearing nonMemberHoldUntil also locks the
  // surviving member guests in (the cron only revisits PENDING rows with a
  // hold deadline).
  const claimed = await tx.booking.updateMany({
    where: {
      id: booking.id,
      status: BookingStatus.PENDING,
      hasNonMembers: true,
    },
    data: { hasNonMembers: false, nonMemberHoldUntil: null },
  });
  if (claimed.count === 0) {
    return { kind: "already-processed" };
  }

  const nonMemberIds = nonMemberGuests.map((guest) => guest.id);

  // Detach chore assignments first (mirrors the manage-guests removal path),
  // then delete the guest rows. Cascades clean up the removed guests' bed
  // allocations, chore tokens, and promo guest targets.
  await tx.choreAssignment.deleteMany({
    where: { bookingGuestId: { in: nonMemberIds } },
  });
  await tx.bookingGuest.deleteMany({ where: { id: { in: nonMemberIds } } });

  const seasonRateData = await loadSeasonRateData(tx);
  const guestsForPricing = remainingGuests.map((guest) => ({
    bookingGuestId: guest.id,
    ageTier: guest.ageTier,
    isMember: guest.isMember,
    memberId: guest.memberId ?? null,
  }));

  const priceBreakdown = calculateBookingPrice(
    booking.checkIn,
    booking.checkOut,
    guestsForPricing,
    seasonRateData
  );
  const guestNightRates = guestsForPricing.map((guest, index) => ({
    bookingGuestId: guest.bookingGuestId,
    memberId: guest.memberId ?? null,
    isMember: guest.isMember,
    perNightRates: priceBreakdown.guests[index].perNightCents,
    // Guests are priced across the full booking range, so the first rate is
    // the check-in night. Dating the rates lets an internal work-party promo
    // restrict its discount to the event's night window.
    firstNight: booking.checkIn,
  }));

  const newTotalPriceCents = priceBreakdown.totalPriceCents;
  const promoResult = await recalculateBookingPromo({
    tx,
    bookingId: booking.id,
    booking,
    newTotalPriceCents,
    guestNightRates,
  });
  const newFinalPriceCents =
    newTotalPriceCents + promoResult.newPromoAdjustmentCents;

  await Promise.all(
    remainingGuests.map((guest, index) =>
      tx.bookingGuest.update({
        where: { id: guest.id },
        data: { priceCents: priceBreakdown.guests[index].priceCents },
      })
    )
  );

  await tx.booking.update({
    where: { id: booking.id },
    data: {
      totalPriceCents: newTotalPriceCents,
      discountCents: promoResult.newDiscountCents,
      promoAdjustmentCents: promoResult.newPromoAdjustmentCents,
      finalPriceCents: newFinalPriceCents,
    },
  });

  await reconcileBedAllocationsForBooking({
    bookingId: booking.id,
    db: tx,
    previousRange: {
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
    },
  });

  return {
    kind: "partial",
    removedGuests: nonMemberGuests,
    remainingGuests,
    newTotalPriceCents,
    newDiscountCents: promoResult.newDiscountCents,
    newPromoAdjustmentCents: promoResult.newPromoAdjustmentCents,
    newFinalPriceCents,
    promoRemoved: promoResult.promoRemoved,
  };
}
