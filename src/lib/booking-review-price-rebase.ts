import "server-only";

import type { Prisma } from "@prisma/client";

import { bookingFinalPriceCents } from "@/lib/booking-final-price";
import { recalculateBookingPromo } from "@/lib/booking-guest-removal-service";
import type { CalendarDate } from "@/lib/club-time";
import { isNonNegativeIntegerCents } from "@/lib/edit-financial-review-context";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";

/**
 * #3219 (epic #2797): what a booking's stored price MEANS once a parked edit's
 * financial review has been settled or dismissed - and the writer that makes it
 * true again.
 *
 * ## The half-finished update this closes
 *
 * Every ordinary edit path re-bases `Booking.totalPriceCents` to the repriced
 * total. A PARKED edit deliberately FREEZES it, because a parked edit is
 * precisely one whose money nobody may compute. That freeze is correct and
 * stays. Nothing thawed it when the review settled, so afterwards the booking
 * said one thing in its headline and another in its nights, permanently, with
 * nothing in the tree comparing the two.
 *
 * ## D1: the recomputed price governs EVERYWHERE
 *
 * Owner decision, 5 September 2026. `Booking.finalPriceCents` is read as money
 * authority in five places - the cancellation refund cap, Internet-Banking
 * reconciliation's "amount law", the unpaid-invoice clearing credit note,
 * per-night revenue allocation and member lifetime spend - and all five follow
 * the recomputed figure. One rule; no reader gets its own.
 *
 * That accepts a real consequence, deliberately: a member who paid $240, had a
 * guest removed on a review that was then DISMISSED, and later cancels under a
 * 100% policy is refunded $120 rather than $240, because the cap is
 * `min(paid, finalPriceCents + fee) - fee`. What the decision does NOT accept is
 * that happening invisibly, which is why this writer's caller records the
 * re-base in the booking's own history rather than only in an audit entry an
 * operator would have to know to go looking for.
 *
 * ## Why it is RECOMPUTED and never derived from the settled amount
 *
 * The obvious fix - apply the signed settlement delta to the frozen headline -
 * is wrong on the path most parked strands actually end on. This writer also
 * runs on a DISMISSAL, whose audit entry says in as many words that nothing
 * moved: there is no delta to apply there and the totals must still come back
 * into agreement. It would also be wrong wherever the park left the headline out
 * of step by MORE than this settlement moves - a parked guest REMOVAL, whose
 * structural half commits and takes the strand away while the frozen headline
 * still counts it (#3257).
 *
 * So the new total is the sum of what the strands say once this transaction's
 * writes have landed. There is no second derivation to keep in step.
 *
 * ## D2 is what makes that sum trustworthy
 *
 * A sum of strands is only as good as the strands. `INV-MOD-028` requires every
 * night to be valued from exact, reconciling stored evidence, so this writer
 * REFUSES TO RE-BASE AT ALL unless every surviving strand reconciles - every
 * strand has night rows, every row carries usable money, and each strand's rows
 * sum to its stored total. Anything less would assert a booking total built from
 * strands the system has said it cannot value, which is a worse lie than the
 * stale one. Where the evidence is not there the totals stay exactly as the park
 * left them, and the still-open review over the other strand re-bases when it is
 * settled in turn.
 *
 * D2 - the officer must record the night prices before a review whose price
 * boxes are offered may be closed - is what stops that being the common case. It
 * is enforced where the boxes are decided, in
 * `stored-night-price-repair-store.ts`, not here.
 *
 * ## The promotion FOLLOWS THE STRANDS, and that is a correctness rule
 *
 * Owner decision, 5 September 2026. Carrying the frozen promotional adjustment
 * through is not merely stale, it is UNSOUND: two guests at $100 with a valid
 * 75%-off code carry a $150 discount against a $200 total. Remove one, record
 * the other at $100, and a carried-through adjustment gives a stored price of
 * MINUS $50 - a shape no other writer in this tree can produce, and one the
 * money invariants have no form for. Reconciliation then refuses with "nothing
 * owing" on a booking the member still owes for; the commoner variant lands on
 * exactly zero, which is the same defect wearing a legal-looking number.
 *
 * Every other writer of this column runs the promotion through
 * `recalculateBookingPromo`, which re-applies the code to the NEW total and
 * re-caps the discount. This one does too - the same function, not a second
 * spelling of it (`INV-SSOT-001`) - so 75% off $100 is $75 and the stored price
 * is $25. That is what "re-capped" means here, and it is why
 * `bookingFinalPriceCents` deliberately does not clamp: the clamp belongs to the
 * promotion, beside the `PromoRedemption` row it has to agree with.
 *
 * A NON-NEGATIVE STORED PRICE IS THEREFORE STRUCTURAL rather than policed - but
 * the assertion below is kept anyway, because this is the one column in the tree
 * that has been shown able to go negative, and a silent negative here is a
 * refund cap and a reconciliation law reading nonsense.
 *
 * ## Locks
 *
 * NO ADVISORY TIER, matching the completion path this rides on, which
 * `docs/CONCURRENCY_AND_LOCKING.md` records as deliberately holding none - a key
 * here would sit over the Stripe round trip that follows the commit. The
 * single-flight guarantee is the task's own status claim, and safety against a
 * concurrent booking edit is a COMPARE-AND-SET on all four money columns as they
 * were read inside this transaction.
 *
 * It does take one lock the settle path did not take before: the PROMO ROW,
 * inside `recalculateBookingPromo`, which row-locks the promo code and re-reads
 * its usage counter because a re-base can release a redemption slot. That is the
 * same key that function's two other callers take, it is the only tier this
 * transaction holds so it can close no cycle, and it is registered in
 * `docs/CONCURRENCY_AND_LOCKING.md` under this issue.
 */

/**
 * The strand this settle just repaired names a guest who is not on the task's
 * own booking.
 *
 * A 409, and a PRE-EXISTING hole rather than one this issue introduced: nothing
 * cross-checked the `bookingGuestId` an `EDIT_FINANCIAL_REVIEW` context carries
 * against the task's `bookingId`. Without this check a malformed context would
 * re-base one booking's headline from another booking's strands, and a booking
 * whose guest list came back empty would have its headline zeroed outright.
 */
export const REBASE_STRAND_NOT_ON_BOOKING_MESSAGE =
  "This review names a guest who is not on this booking, so nothing was saved. Check the booking's guests before trying again.";

/** The compare-and-set refusal: a concurrent edit moved the booking's money. */
export const REBASE_RACED_MESSAGE =
  "This booking's price changed while you were closing the review, so nothing was saved. Reload the page and check the booking before trying again.";

/**
 * The assertion that must never fire. It is not a refusal an operator can act
 * on, so it is deliberately not a `ManualBookingPaymentError`: reaching it means
 * the promotion cap failed and the transaction must roll back loudly.
 */
export const REBASE_NEGATIVE_PRICE_MESSAGE =
  "Re-basing this booking from its strands produced a price below zero, which INV-MONEY forbids; the promotion was not re-capped.";

export type BookingPriceRebase = {
  previousTotalPriceCents: number;
  previousDiscountCents: number;
  previousPromoAdjustmentCents: number;
  previousFinalPriceCents: number;
  newTotalPriceCents: number;
  newDiscountCents: number;
  newPromoAdjustmentCents: number;
  newFinalPriceCents: number;
  /** The promotion no longer applies to what is left, so its redemption is gone. */
  promoRemoved: boolean;
};

export type BookingPriceRebaseOutcome =
  | { rebased: true; rebase: BookingPriceRebase }
  /**
   * At least one surviving strand cannot be read back as exact, reconciling
   * stored evidence, so there is nothing sound to re-base from and the totals
   * are left exactly as the park set them. NOT a failure: such a booking still
   * carries an open review over that strand, and settling it re-bases then.
   */
  | { rebased: false; reason: "strand-evidence-unreadable" };

const REBASE_BOOKING_INCLUDE = {
  promoRedemption: {
    include: {
      guestTargets: { select: { bookingGuestId: true } },
      promoCode: {
        include: {
          assignments: { select: { memberId: true } },
          lodges: { select: { lodgeId: true } },
        },
      },
    },
  },
  guests: {
    select: {
      id: true,
      priceCents: true,
      memberId: true,
      isMember: true,
      nights: { select: { stayDate: true, priceCents: true } },
    },
  },
} as const;

type RebaseStrand = {
  id: string;
  priceCents: number;
  memberId: string | null;
  isMember: boolean;
  nights: ReadonlyArray<{ stayDate: Date; priceCents: number | null }>;
};

type StrandNightPrices = {
  bookingGuestId: string;
  memberId: string | null;
  isMember: boolean;
  perNightRates: number[];
  nightDates: Date[];
};

/**
 * Each surviving strand's nights as exact money, or `null` the moment one cannot
 * be read back that way.
 *
 * THE THREE CONDITIONS ARE `INV-MOD-028` APPLIED TO THE WHOLE BOOKING rather
 * than to one strand. A strand with no night rows has a stay envelope and no
 * evidence; a row that is not usable money is an absence of evidence and not a
 * price; and rows that do not sum to the strand's stored total are two stored
 * numbers disagreeing, which is a decision about which one is wrong rather than
 * a number anybody has. Feeding any of those to the promotion would re-price the
 * booking from evidence the system has already said it cannot read.
 *
 * The rows are sorted by date so `perNightRates` and `nightDates` are parallel
 * and in stay order, which is what an internal work-party promo's night window
 * is applied against.
 */
function readStrandNightPrices(
  guests: readonly RebaseStrand[],
): StrandNightPrices[] | null {
  const read: StrandNightPrices[] = [];
  for (const guest of guests) {
    if (!isNonNegativeIntegerCents(guest.priceCents)) return null;
    if (guest.nights.length === 0) return null;
    const nights = [...guest.nights].sort(
      (a, b) => a.stayDate.getTime() - b.stayDate.getTime(),
    );
    let sum = 0;
    const perNightRates: number[] = [];
    const nightDates: Date[] = [];
    for (const night of nights) {
      if (night.priceCents === null) return null;
      if (!isNonNegativeIntegerCents(night.priceCents)) return null;
      sum += night.priceCents;
      perNightRates.push(night.priceCents);
      nightDates.push(night.stayDate);
    }
    if (sum !== guest.priceCents) return null;
    read.push({
      bookingGuestId: guest.id,
      memberId: guest.memberId,
      isMember: guest.isMember,
      perNightRates,
      nightDates,
    });
  }
  return read;
}

/**
 * Re-base the booking's four money columns from its strands.
 *
 * MUST run after the strand write and on the same transaction, which already
 * holds the completion's status claim.
 */
export async function rebaseBookingPriceFromStrands({
  bookingId,
  repairedGuestId,
  repairedGuestTotalCents,
  todayAtClub,
  store,
}: {
  bookingId: string;
  repairedGuestId: string;
  /** What the night-price repair has just written to that strand. */
  repairedGuestTotalCents: number;
  /**
   * The club's own calendar day (`INV-CONFIG-002`, `INV-LOCK-004`), resolved by
   * the caller BEFORE it opened this transaction. Required: it decides the
   * promotion's validity window inside `recalculateBookingPromo`.
   */
  todayAtClub: CalendarDate;
  store: Prisma.TransactionClient;
}): Promise<BookingPriceRebaseOutcome> {
  const booking = await store.booking.findUnique({
    where: { id: bookingId },
    include: REBASE_BOOKING_INCLUDE,
  });
  if (booking === null) {
    throw new ManualBookingPaymentError(REBASE_RACED_MESSAGE, 409);
  }

  // The strand this settle just repaired has to be one of THESE strands, at the
  // value it was just written to. That is what makes the sum below the sum of
  // the booking's own nights rather than of somebody else's, and what makes an
  // empty guest list unreachable rather than a zeroed headline.
  const repaired = booking.guests.find((guest) => guest.id === repairedGuestId);
  if (
    repaired === undefined ||
    repaired.priceCents !== repairedGuestTotalCents
  ) {
    throw new ManualBookingPaymentError(
      REBASE_STRAND_NOT_ON_BOOKING_MESSAGE,
      409,
    );
  }

  const strandNights = readStrandNightPrices(booking.guests);
  if (strandNights === null) {
    return { rebased: false, reason: "strand-evidence-unreadable" };
  }

  const newTotalPriceCents = booking.guests.reduce(
    (sum, guest) => sum + guest.priceCents,
    0,
  );

  // The promotion follows the strands, through the tree's ONE recompute
  // (`INV-SSOT-001`). It re-applies the code to the NEW total, re-caps the
  // discount, rewrites the redemption's allocations, and removes the redemption
  // outright where the promotion no longer applies to what is left.
  const promo = await recalculateBookingPromo({
    tx: store,
    bookingId,
    booking,
    newTotalPriceCents,
    guestNightRates: strandNights.map((strand) => ({
      bookingGuestId: strand.bookingGuestId,
      memberId: strand.memberId,
      isMember: strand.isMember,
      perNightRates: strand.perNightRates,
      nightDates: strand.nightDates,
      // Every promo window on this booking dates from the stay start, exactly as
      // the removal and waitlist repricings pass it.
      firstNight: booking.checkIn,
    })),
    todayAtClub,
  });

  const newFinalPriceCents = bookingFinalPriceCents({
    totalPriceCents: newTotalPriceCents,
    promoAdjustmentCents: promo.newPromoAdjustmentCents,
  });
  if (newFinalPriceCents < 0) {
    // Unreachable while the promotion is re-capped above, and kept because this
    // is the one column in the tree that has been shown able to go negative.
    throw new Error(REBASE_NEGATIVE_PRICE_MESSAGE);
  }

  const rebased = await store.booking.updateMany({
    where: {
      id: bookingId,
      totalPriceCents: booking.totalPriceCents,
      discountCents: booking.discountCents,
      promoAdjustmentCents: booking.promoAdjustmentCents,
      finalPriceCents: booking.finalPriceCents,
    },
    data: {
      totalPriceCents: newTotalPriceCents,
      discountCents: promo.newDiscountCents,
      promoAdjustmentCents: promo.newPromoAdjustmentCents,
      finalPriceCents: newFinalPriceCents,
    },
  });
  if (rebased.count !== 1) {
    throw new ManualBookingPaymentError(REBASE_RACED_MESSAGE, 409);
  }

  return {
    rebased: true,
    rebase: {
      previousTotalPriceCents: booking.totalPriceCents,
      previousDiscountCents: booking.discountCents,
      previousPromoAdjustmentCents: booking.promoAdjustmentCents,
      previousFinalPriceCents: booking.finalPriceCents,
      newTotalPriceCents,
      newDiscountCents: promo.newDiscountCents,
      newPromoAdjustmentCents: promo.newPromoAdjustmentCents,
      newFinalPriceCents,
      promoRemoved: promo.promoRemoved,
    },
  };
}

/**
 * WHETHER THE CLUB'S INVOICE STILL AGREES WITH THE BOOKING AFTER A RE-BASE.
 *
 * D1's first consequence, written down rather than shipped blind. A DISMISSAL
 * issues no Xero document at all - the dispatch has no anchor and returns
 * without doing anything - so after a re-base the invoice can say $240 while the
 * booking says $120, and Internet-Banking reconciliation's "amount law" would
 * mark the booking PAID on the lower figure. D1 says the BOOKING is right; it
 * does not say the invoice should be quietly ignored.
 *
 * So the divergence is a FACT ON THE BOOKING, recorded at the moment it is
 * created: the history row below carries it, `describeModification` turns it
 * into a sentence on the booking's own page, and the audit entry that records
 * the re-base is raised to `critical` when it is true. That is the surface a
 * treasurer meets before they record a bank payment against the new figure.
 */
export function rebaseDivergesFromIssuedInvoice({
  rebase,
  hasIssuedXeroInvoice,
  settlementIssuesXeroDocument,
}: {
  rebase: BookingPriceRebase;
  hasIssuedXeroInvoice: boolean;
  settlementIssuesXeroDocument: boolean;
}): boolean {
  if (!hasIssuedXeroInvoice) return false;
  if (settlementIssuesXeroDocument) return false;
  return rebase.newFinalPriceCents !== rebase.previousFinalPriceCents;
}

/**
 * Write the re-base into the BOOKING'S OWN HISTORY, in the same transaction.
 *
 * D1's second consequence. A member can now be refunded less than they paid,
 * from a back-office action they never saw, so the reason has to be READABLE
 * from the booking rather than reconstructable from an audit trail somebody has
 * to know exists. `BookingModification` is the booking's history, it already
 * carries a signed `priceDiffCents` and before/after money snapshots, and
 * `modificationType` is free text - so this needs no schema change and lands on
 * the screen every other price movement lands on.
 *
 * It is NOT an edit and does not pretend to be one: nothing about the stay
 * changed, and `describeModification` says in as many words that the price was
 * recalculated from what the nights sold for.
 */
export async function recordBookingPriceRebaseHistory({
  bookingId,
  actingMemberId,
  taskId,
  resolution,
  rebase,
  xeroInvoiceDiverged,
  store,
}: {
  bookingId: string;
  actingMemberId: string;
  taskId: string;
  resolution: "completed" | "dismissed";
  rebase: BookingPriceRebase;
  xeroInvoiceDiverged: boolean;
  store: Prisma.TransactionClient;
}): Promise<void> {
  await store.bookingModification.create({
    data: {
      bookingId,
      memberId: actingMemberId,
      modificationType: "PRICE_REBASE",
      previousData: {
        totalPriceCents: rebase.previousTotalPriceCents,
        discountCents: rebase.previousDiscountCents,
        promoAdjustmentCents: rebase.previousPromoAdjustmentCents,
        finalPriceCents: rebase.previousFinalPriceCents,
      },
      newData: {
        totalPriceCents: rebase.newTotalPriceCents,
        discountCents: rebase.newDiscountCents,
        promoAdjustmentCents: rebase.newPromoAdjustmentCents,
        finalPriceCents: rebase.newFinalPriceCents,
        promoRemoved: rebase.promoRemoved,
        xeroInvoiceDiverged,
        financialReviewTaskId: taskId,
        financialReviewResolution: resolution,
      },
      // The signed movement of the figure every money reader follows. NOT a
      // settlement: no money is moved by this row, and the review's own task
      // carries what was settled.
      priceDiffCents:
        rebase.newFinalPriceCents - rebase.previousFinalPriceCents,
      changeFeeCents: 0,
    },
  });
}
