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
import {
  addCalendarDays,
  calendarDateOfDateOnlyInstant,
  dateOnlyInstantOf,
} from "@/lib/club-time";

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

/**
 * The morning after a stored night, half-open like every stay range here.
 *
 * Through `club-time` rather than through `date-only`'s adapter (CT-6): the
 * stored value is a `@db.Date`, so it is DECODED to the calendar day it
 * encodes (`INV-DATE-010`), stepped as a day, and re-encoded. Review of #3580
 * first routed this to `addDaysDateOnly`, which is the same arithmetic but
 * adds an importer to the escape-hatch census that may only ever shrink.
 */
function morningAfter(storedNight: Date): Date {
  return dateOnlyInstantOf(
    addCalendarDays(calendarDateOfDateOnlyInstant(storedNight), 1),
  );
}

export function planConfirmationChargeLines(
  booking: ConfirmationPostingBooking,
): ConfirmationPostingPlan {
  const postings: BookingLedgerPosting[] = [];
  const unpricedStrandIds: string[] = [];

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
      postings.push({
        bookingId: booking.id,
        lodgeId: booking.lodgeId,
        side: "CHARGE",
        kind: "GUEST_NIGHT",
        sign: 1,
        quantity: 1,
        unitCents: night.priceCents ?? 0,
        anchorKind: "CONFIRMATION",
        anchorId: booking.id,
        bookingGuestId: guest.id,
        nightStart: night.stayDate,
        nightEndExclusive: morningAfter(night.stayDate),
        rateMembershipTypeId: guest.rateMembershipTypeId,
        ageTier: guest.ageTier,
        guestNames: guestName ? [guestName] : [],
        narration: `${guestName || "Guest"} — one night`,
      });
    }
  }

  if (booking.promoAdjustmentCents !== 0) {
    const sign = booking.promoAdjustmentCents < 0 ? -1 : 1;
    postings.push({
      bookingId: booking.id,
      lodgeId: booking.lodgeId,
      side: "CHARGE",
      kind: "PROMOTION",
      sign,
      quantity: 1,
      unitCents: Math.abs(booking.promoAdjustmentCents),
      anchorKind: "CONFIRMATION",
      anchorId: booking.id,
      narration:
        sign < 0 ? "Promotion applied" : "Promotion, price raised",
    });
  }

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
