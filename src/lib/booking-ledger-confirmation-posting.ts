/**
 * THE CHARGE LINES A CONFIRMED BOOKING'S PRICE IS MADE OF (#3580,
 * programme #3527; design `docs/design/booking-ledger.md` §5.1).
 *
 * Pure: it takes the booking as the settle body already read it and returns
 * the lines to post. It reads nothing, writes nothing, and posts nothing —
 * `postBookingLedgerLines` does that, inside the settle's own transaction.
 *
 * WHAT IT POSTS, AND THE IDENTITY IT HOLDS:
 *
 *   Σ GUEST_NIGHT  +  PROMOTION  ===  Booking.finalPriceCents
 *
 * which is `bookingFinalPriceCents`'s own arithmetic (`totalPriceCents +
 * promoAdjustmentCents`) restated as lines. `discountCents` is deliberately
 * NOT a line: `INV-MONEY-031` defines it as `max(0, -promoAdjustmentCents)`,
 * a projection of the promotion rather than a second reduction, so posting it
 * would count the same discount twice. The `GROUP_DISCOUNT` kind exists for
 * the day a discount is a fact of its own; nothing posts it today.
 *
 * A NIGHT WITH NO STORED PRICE POSTS NOTHING FOR ITS STRAND, and the strand is
 * returned instead. `INV-MOD-028` is the rule: a blank night is not evidence
 * of an amount, and inventing one here would put a guessed figure into a row
 * that is never edited again. C4's census (#3583) reports the coverage gap.
 */
import { bookingFinalPriceCents } from "@/lib/booking-final-price";
import { ledgerLineAmountCents, type BookingLedgerPosting } from "@/lib/booking-ledger-write";
import { guestNightPosting, promotionPosting } from "@/lib/booking-ledger-charge-line";
import {
  confirmationNightKey,
  confirmationPromotionKey,
} from "@/lib/booking-ledger-posting-keys";

export type ConfirmationPostingBooking = {
  id: string;
  lodgeId: string;
  totalPriceCents: number;
  promoAdjustmentCents: number;
  guests: ReadonlyArray<{
    id: string;
    firstName: string;
    lastName: string;
    ageTier: BookingLedgerPosting["ageTier"];
    rateMembershipTypeId: string | null;
    nights: ReadonlyArray<{ stayDate: Date; priceCents: number | null }>;
  }>;
};

export type ConfirmationPostingPlan = {
  postings: BookingLedgerPosting[];
  /** Strands whose nights are not all priced, so nothing was posted for them. */
  unpricedStrandIds: string[];
  /**
   * True when what the plan posts adds up to the booking's own final price.
   * False is not an error here — an unpriced strand makes it false by
   * construction — but it is what a caller records and what C4 measures.
   */
  reconciles: boolean;
};

export function planConfirmationChargeLines(
  booking: ConfirmationPostingBooking,
): ConfirmationPostingPlan {
  const postings: BookingLedgerPosting[] = [];
  const unpricedStrandIds: string[] = [];
  const anchor = {
    bookingId: booking.id,
    lodgeId: booking.lodgeId,
    anchorKind: "CONFIRMATION" as const,
    anchorId: booking.id,
  };

  for (const guest of booking.guests) {
    const nights = [...guest.nights].sort(
      (a, b) => a.stayDate.getTime() - b.stayDate.getTime(),
    );
    if (nights.length === 0) continue;
    if (nights.some((night) => night.priceCents === null)) {
      unpricedStrandIds.push(guest.id);
      continue;
    }
    const guestName = `${guest.firstName} ${guest.lastName}`.trim();
    // ONE LINE PER NIGHT, not one per strand: the night is the thing that was
    // sold, and a later edit reverses the nights it touches rather than the
    // whole strand. Folding runs of equal-priced nights would be a rendering
    // decision, and rendering is C6's (#3585), not the posting's.
    for (const night of nights) {
      // Makes THIS night's posting idempotent against a replay. It does not
      // make the confirmation happen once — the settle fences that per
      // booking, because nights can change between two settles (#3595).
      postings.push(
        guestNightPosting(anchor, {
          bookingGuestId: guest.id,
          name: guestName,
          rateMembershipTypeId: guest.rateMembershipTypeId,
          ageTier: guest.ageTier,
          stayDate: night.stayDate,
          priceCents: night.priceCents ?? 0,
          postingKey: confirmationNightKey(booking.id, guest.id, night.stayDate),
        }),
      );
    }
  }

  const promotion = promotionPosting(anchor, booking.promoAdjustmentCents, confirmationPromotionKey(booking.id));
  if (promotion) postings.push(promotion);

  // Through the one home for a line's arithmetic, not a second copy of it.
  const posted = postings.reduce((sum, posting) => sum + ledgerLineAmountCents(posting), 0);
  return {
    postings,
    unpricedStrandIds,
    reconciles:
      unpricedStrandIds.length === 0 &&
      posted ===
        bookingFinalPriceCents({
          totalPriceCents: booking.totalPriceCents,
          promoAdjustmentCents: booking.promoAdjustmentCents,
        }),
  };
}
