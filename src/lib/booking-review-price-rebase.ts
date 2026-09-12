import "server-only";

import type { Prisma } from "@prisma/client";

import { bookingFinalPriceCents } from "@/lib/booking-final-price";
import { recalculateBookingPromo } from "@/lib/booking-guest-removal-service";
import type { CalendarDate } from "@/lib/club-time";
import { isNonNegativeIntegerCents } from "@/lib/edit-financial-review-context";
import {
  NIGHT_ADJUSTMENT_INVARIANT,
  recordBookingNightAdjustments,
} from "@/lib/night-adjustment-write";
import {
  readBookingMoneyBuildUp,
  selectLoadedBookingMoneyBuildUp,
  type BookingMoneyBuildUpSelection,
} from "@/lib/booking-money-build-up";
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
 * ## THE TRIGGER IS A PARKED REVIEW CLOSING, NOT A STRAND BEING REPAIRED (#3257)
 *
 * Owner decision, 7 September 2026. This writer used to run only off a repaired
 * strand - it was invoked from the night-price repair writer, so it happened
 * only where the officer was offered price boxes and typed into them. Two
 * reachable shapes of a parked guest REMOVAL offer no boxes at all, so neither
 * produced a repair and neither re-priced:
 *
 * 1. THE REMOVED GUEST IS THE UNREADABLE ONE. The park raises its review over
 *    the departing strand and the same transaction deletes that strand, so the
 *    only review names a guest who no longer exists: no rows, no summary, no
 *    boxes.
 * 2. A SURVIVING STRAND HOLDS NO EXPLICIT NIGHT ROWS AT ALL. It classifies
 *    unusable and raises a review, but boxes appear only for a strand with
 *    genuine BLANK nights among readable ones, so it closes blank.
 *
 * In both, a booking stored at $240.00 whose only remaining guest sums $120.00
 * kept the $240.00 headline PERMANENTLY - reconciliation refusing a correct
 * $120.00 payment, revenue and lifetime spend overstating, and no open review
 * left to correct it.
 *
 * So the trigger is now "a parked review closed and this booking's strands can
 * be reconciled", and `repairedStrand` is OPTIONAL: null says this closure
 * repaired nothing, which is an ordinary answer rather than a missing input.
 *
 * ## THE DECLINE IS WHAT MAKES RE-PRICING ON ANY CLOSE SAFE
 *
 * A sum of strands is only as good as the strands. `INV-MOD-028` requires every
 * night to be valued from exact, reconciling stored evidence, so this writer
 * REFUSES TO RE-BASE AT ALL unless every surviving strand reconciles - every
 * strand has night rows, every row carries usable money, and each strand's rows
 * sum to its stored total. Anything less would assert a booking total built from
 * strands the system has said it cannot value, which is a worse lie than the
 * stale one. Where the evidence is not there the totals stay exactly as the park
 * left them.
 *
 * THAT IS THE HALF THE TRIGGER MOVE DEPENDS ON, and shape 2 above is exactly
 * why: a strand with no night rows is unreadable, so the closure that used to
 * offer it no boxes now reaches this writer and DECLINES rather than inventing a
 * figure from a strand carrying money and no evidence. Shape 1 re-prices,
 * because every strand that survives it does reconcile.
 *
 * D2 - the officer must record the night prices before a review whose price
 * boxes ARE offered may be closed - is what stops the decline being the common
 * case. It is enforced where the boxes are decided, in
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
 * same key that function's two other callers take, it is the only ADVISORY tier
 * this transaction holds so it can close no cycle against a lodge, member or
 * global key, and it is registered in `docs/CONCURRENCY_AND_LOCKING.md` under
 * this issue - along with the ordinary row locks the repair write takes before
 * it, and the deadlock shape their ordering leaves against a waitlist confirm.
 *
 * MOVING THE TRIGGER (#3257) WIDENED WHEN THAT KEY IS TAKEN AND NOT WHICH KEY:
 * every closure of a parked review on a promoted booking now takes it, where
 * before only a closure that repaired a strand did. Same key, same single
 * advisory tier, same ordering; more closures reach it, and one of them is a
 * DISMISSAL, which took none of it before.
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

/**
 * Why a re-base wrote nothing, where that is an answer rather than a failure.
 *
 * `strand-evidence-unreadable`: at least one surviving strand cannot be read
 * back as exact, reconciling stored evidence, so there is nothing sound to
 * re-base from and the totals are left exactly as the park set them.
 *
 * `no-surviving-strands`: the booking came back with no guests at all. Summing
 * them would ZERO the headline outright, which is the shape the strand guard
 * below exists to keep unreachable - and with no repaired strand to check
 * against, this is the check that keeps it so.
 */
export type BookingPriceRebaseDeclineReason =
  | "strand-evidence-unreadable"
  | "no-surviving-strands";

export type BookingPriceRebaseOutcome =
  | {
      rebased: true;
      rebase: BookingPriceRebase;
      moneyBuildUpSelection: BookingMoneyBuildUpSelection;
    }
  | {
      rebased: false;
      reason: BookingPriceRebaseDeclineReason;
      moneyBuildUpSelection: BookingMoneyBuildUpSelection;
    };

/**
 * Did the re-base actually move any of the booking's four money columns?
 *
 * Since the trigger became ANY parked review closing (#3257), most closures on a
 * booking whose park never froze it out of step recompute the figures it already
 * held. That is a correct no-op and it must not read as an event, which is why
 * the booking's own page does not collect a "Price Recalculated" entry recording
 * no change.
 *
 * THIS IS A CLAIM ABOUT THE FOUR COLUMNS AND NOTHING ELSE - it is what the audit
 * entry's `bookingPriceMoved` reports. Whether the history row is written is the
 * WIDER question below, because money is not the only thing a re-base can change.
 */
export function rebaseMovedStoredMoney(rebase: BookingPriceRebase): boolean {
  return (
    rebase.newTotalPriceCents !== rebase.previousTotalPriceCents ||
    rebase.newDiscountCents !== rebase.previousDiscountCents ||
    rebase.newPromoAdjustmentCents !== rebase.previousPromoAdjustmentCents ||
    rebase.newFinalPriceCents !== rebase.previousFinalPriceCents
  );
}

/**
 * Does this re-base leave the booking's own history anything to say?
 *
 * The money question above is not the whole one. `promoRemoved` is a FIFTH,
 * independent outcome of the same recompute: `recalculateBookingPromo` deletes
 * the `PromoRedemption` row outright and hands its usage slot back, and outside
 * the audit log the ONLY place that fact reaches a person is the `PRICE_REBASE`
 * narrative, which renders "The promotion no longer applies and was removed."
 *
 * IT HAPPENS WITH ALL FOUR COLUMNS UNMOVED, because a redemption that delivered
 * no benefit is deliberately representable: `shouldPersistPromoRedemption` is
 * explicitly wider than the benefit test, so a promo that had eligible guests
 * and delivered nothing still records its redemption (owner decision, #2299).
 * A booking carrying such a redemption for a code that has since expired
 * recomputes to exactly the figures it already held while the redemption is
 * deleted - so a money-only gate would delete a promotion the member can see on
 * their booking and say nothing anywhere they can read.
 *
 * Composed from the money predicate rather than restating it (`INV-SSOT-001`).
 */
export function rebaseChangedTheBooking(rebase: BookingPriceRebase): boolean {
  return rebaseMovedStoredMoney(rebase) || rebase.promoRemoved;
}

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
 *
 * A STATED LIMIT, pre-existing and deliberately not closed here: the three
 * conditions require the rows to EXIST, to be usable money and to SUM to the
 * strand's stored total - never that they span the strand's stay envelope. A
 * strand whose stored total is covered by fewer rows than it has nights reads
 * back as exact, and the booking's total is unaffected either way because that
 * sums `BookingGuest.priceCents`. What can be short is the per-night VECTOR
 * handed to the promotion, so a free-nights or night-windowed code re-caps
 * against a shorter stay than the guest actually has. Moving the trigger (#3257)
 * builds that vector on more closures without changing when it can be short.
 * Closing it needs a stay envelope this writer is not given, and belongs with
 * the writers that create the night rows.
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
  repairedStrand,
  todayAtClub,
  store,
}: {
  bookingId: string;
  /**
   * The strand this closure just repaired and what the repair wrote to it, or
   * NULL where the review offered no price boxes and nothing was repaired -
   * which since #3257 is a closure this writer still runs on.
   *
   * The id and the value travel together because neither is a guard on its own:
   * checking the id alone would sum a pre-repair figure, and checking the value
   * alone would check somebody else's strand.
   */
  repairedStrand: { bookingGuestId: string; totalCents: number } | null;
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
  // the booking's own nights rather than of somebody else's.
  if (repairedStrand !== null) {
    const repaired = booking.guests.find(
      (guest) => guest.id === repairedStrand.bookingGuestId,
    );
    if (
      repaired === undefined ||
      repaired.priceCents !== repairedStrand.totalCents
    ) {
      throw new ManualBookingPaymentError(
        REBASE_STRAND_NOT_ON_BOOKING_MESSAGE,
        409,
      );
    }
  }

  // #3277: the review writer consumes exact per-night provenance because it is
  // about to run a night-grain promotion over these rows. A booking/headline
  // reader deliberately uses a broader grain in the same canonical projection.
  const recordedMoneyBuildUp = await readBookingMoneyBuildUp(store, {
    bookingId,
    operation: "REVIEW_REBASE",
  });
  const currentMoneyBuildUpSelection = selectLoadedBookingMoneyBuildUp(
    recordedMoneyBuildUp,
    {
      derivedCents: booking.finalPriceCents,
      mismatchClassification: "STORED_SIDE_DEFECT",
    },
  );

  if (booking.guests.length === 0) {
    // A repaired strand PROVED the list was not empty. With none there is
    // nothing to prove it, and summing an empty list would zero the headline
    // outright - the second half of the hole the guard above closes.
    return {
      rebased: false,
      reason: "no-surviving-strands",
      moneyBuildUpSelection: currentMoneyBuildUpSelection,
    };
  }

  const strandNights = readStrandNightPrices(booking.guests);
  if (
    strandNights === null ||
    currentMoneyBuildUpSelection.source === "BASE_EVIDENCE_UNKNOWN"
  ) {
    return {
      rebased: false,
      reason: "strand-evidence-unreadable",
      moneyBuildUpSelection: currentMoneyBuildUpSelection,
    };
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
  // #3276: the engine just re-decided the promotion over the strands' STORED
  // nights, so what it took off each of them is recorded here — the night rows
  // themselves were written by the repair before this ran, and nothing rewrites
  // them after it. The officer's prices stay OFFICER_PRICED; the build-up on
  // top of them is the engine's own figure and is RECORDED.
  await recordBookingNightAdjustments(store, {
    bookingId,
    guestIds: strandNights.map((strand) => strand.bookingGuestId),
    targets: promo.adjustmentTargets,
    writer: "the review price re-base",
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

  const freshlyRecordedMoneyBuildUp = await readBookingMoneyBuildUp(store, {
    bookingId,
    operation: "REVIEW_REBASE",
  });
  const moneyBuildUpSelection = selectLoadedBookingMoneyBuildUp(
    freshlyRecordedMoneyBuildUp,
    {
      derivedCents: newFinalPriceCents,
      mismatchClassification: "STORED_SIDE_DEFECT",
    },
  );
  if (moneyBuildUpSelection.source === "BASE_EVIDENCE_UNKNOWN") {
    throw new Error(
      `${NIGHT_ADJUSTMENT_INVARIANT}: the review re-base lost exact base evidence after recording its build-up`,
    );
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
    moneyBuildUpSelection,
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
 * What the re-price did, shaped for the audit entry its caller writes.
 *
 * It lives HERE rather than inline at the audit call because it is a statement
 * about the re-base, and a reader asking "why does this booking cost what it
 * does?" months later is reading these fields (`INV-SSOT-001`). Every money
 * column, before and after, because there is nowhere else to look.
 *
 * `bookingRebased: false` says the re-price DECLINED -
 * `bookingRebaseDeclinedReason` says which of the two reasons - and the
 * booking's own figures are then untouched.
 *
 * `bookingPriceMoved` is the SEPARATE question of whether the recomputed
 * figures differed from the stored ones. Since #3257 every parked-review
 * closure re-prices, so most recompute what the booking already held; this is
 * the audit's record of those, and they write no history row.
 */
export function bookingRebaseAuditMetadata({
  outcome,
  xeroInvoiceDiverged,
}: {
  outcome: BookingPriceRebaseOutcome;
  /**
   * D1's first consequence, on the record: this closure issued no Xero
   * document, so the club's invoice still says the old figure.
   */
  xeroInvoiceDiverged: boolean;
}): Record<string, unknown> {
  const rebase = outcome.rebased ? outcome.rebase : null;
  return {
    bookingRebased: rebase !== null,
    bookingPriceMoved: rebase !== null && rebaseMovedStoredMoney(rebase),
    bookingRebaseDeclinedReason: outcome.rebased ? null : outcome.reason,
    previousBookingTotalPriceCents: rebase?.previousTotalPriceCents ?? null,
    newBookingTotalPriceCents: rebase?.newTotalPriceCents ?? null,
    previousBookingDiscountCents: rebase?.previousDiscountCents ?? null,
    newBookingDiscountCents: rebase?.newDiscountCents ?? null,
    previousBookingPromoAdjustmentCents:
      rebase?.previousPromoAdjustmentCents ?? null,
    newBookingPromoAdjustmentCents: rebase?.newPromoAdjustmentCents ?? null,
    previousBookingFinalPriceCents: rebase?.previousFinalPriceCents ?? null,
    newBookingFinalPriceCents: rebase?.newFinalPriceCents ?? null,
    promoRemoved: rebase?.promoRemoved ?? null,
    xeroInvoiceDiverged,
    ...outcome.moneyBuildUpSelection.historyMetadata,
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
 * carries before/after money snapshots, and `modificationType` is free text -
 * so this needs no schema change and lands on the screen every other price
 * movement lands on.
 *
 * It is NOT an edit and does not pretend to be one: nothing about the stay
 * changed, and `describeModification` says in as many words that the price was
 * recalculated from what the nights sold for.
 *
 * BOTH MONEY COMPONENTS ARE 0, AND THAT IS THE POINT. `priceDiffCents +
 * changeFeeCents` is how this tree says money MOVED, and every generic reader
 * of it applies to every row with no `modificationType` filter:
 * `getModificationNetAmountCents` feeds the Xero repair classifier, which
 * raises a `critical` MISSING_SUPPLEMENTARY_INVOICE finding marked
 * `safeToAutoApply` on any positive net with no supplementary invoice of its
 * own, a credit note on any negative one; `getKnownModificationRefundTotalCents`
 * sums the negatives as refunds already known; and `booking-delete` counts a
 * non-zero net as a hard-delete blocker. A re-base runs AFTER the primary
 * invoice was raised and after the review's own settlement was billed, so a
 * signed component here reads to all of them as a second, unbilled ask - one
 * click from issuing a duplicate invoice for money already taken. The signed
 * movement therefore lives in `newData`, which only the booking's own history
 * narrative reads.
 */
export { recordBookingPriceRebaseHistory } from "@/lib/booking-review-price-rebase-history";
