// Split out of src/lib/booking-modify-settlement.ts (#3829, composing epic
// #3813 with main): what a booking reduction may return and how - the
// policy-tiered options, the untiered full-reduction options (D-3813-5) and
// the one basis both read. Code moved verbatim; import via
// "@/lib/booking-modify" or "@/lib/booking-modify-settlement".

import {
  assertReductionReadForNet,
  type ReductionAgainstUnpaidAsk,
} from "@/lib/additional-ask-reduction";
import type { CalendarDate } from "@/lib/club-time";
import {
  calculateDualRefundAmounts,
  daysUntilDate,
  getRefundTier,
  loadCancellationPolicy,
  type CancellationPolicyDb,
} from "@/lib/cancellation";
import { hasCapturedPayment, isSettledBookingStatus } from "@/lib/booking-payment-state";
import {
  type BookingModificationSettlementMethod,
  type LoadedBookingForModify,
} from "@/lib/booking-modify-validation";
import { ApiError } from "@/lib/api-error";
import { effectiveOrganiserPaidChangeFeeCents } from "@/lib/organiser-extra-state";
import { BookingModificationSettlementMethodRequiredError } from "@/lib/booking-modify-settlement-required";
import {
  refundableCashNetOfOpenHandBacks,
  type OpenNonCancellationHandBackDb,
} from "@/lib/edit-refund-hand-back";
import { paidByOrganiser, paidByOrganiserInternetBanking } from "@/lib/group-organiser-paid";
import { PaymentSource, type Prisma } from "@prisma/client";
import { paymentDisputedCaptureCents, type CaptureDisputeHold } from "@/lib/stripe-dispute-hold";

export type BookingModificationSettlementOptions = {
  basisAmountCents: number;
  cardRefundAmountCents: number;
  cardRefundPercentage: number;
  accountCreditAmountCents: number;
  accountCreditPercentage: number;
  daysUntilCheckIn: number;
  requiresSettlementMethod: boolean;
  /**
   * #3653, #3949 (review round 5): the booking was paid for by its group
   * organiser (`paidByOrganiser`), so the reduction goes back to the organiser,
   * on the card tier, and there is no choice to make - the joiner paid nothing
   * and is never handed account credit for it.
   */
  returnsToOrganiser: boolean;
  /**
   * #3949: and the organiser paid by Internet Banking, so it goes back to them by
   * bank transfer - the edit's hand-back (`raiseEditRefundHandBackIfOwed`) -
   * never to a card. Always false where `returnsToOrganiser` is false; where it
   * is true, false means the organiser's card.
   */
  organiserRefundByBankTransfer: boolean;
  /**
   * #5061 follow-up (`INV-PAY-153`): an OPEN or LOST Stripe dispute holds the
   * member's card payment (`editReductionDisputeHold`), so the reduction is
   * handed to the treasurer: no choice is offered, no card refund is made and
   * no account credit is minted (`heldForDisputeSettlementCents`).
   */
  refundHeldForDispute: boolean;
};

/** What `editReductionDisputeHold` reads: the dispute rows and the payment's ledger captures. */
export type EditDisputeHoldDb = Pick<Prisma.TransactionClient, "stripeDispute" | "paymentTransaction">;

const NO_DISPUTE_HOLD: CaptureDisputeHold = { cents: 0, disputes: [] };

/**
 * #5061 follow-up (`INV-PAY-153`): the Stripe dispute hold on the money a
 * reduction would return - the member's own captured card payment. A booking
 * the group organiser paid for is outside it: an organiser-card joiner's refund
 * is stopped by the refund chokepoint instead (`processRefund`), and an
 * organiser's bank payment has no card. Every edit door reads it under its
 * locks, through `applyPaymentAdjustments` and the settlement options; the
 * quote reads it with none, as advice.
 */
export async function editReductionDisputeHold(
  db: EditDisputeHoldDb,
  booking: Pick<LoadedBookingForModify, "status" | "payment" | "organiserSettled" | "parentBookingId">,
): Promise<CaptureDisputeHold> {
  const payment = booking.payment;
  if (!payment || payment.source !== PaymentSource.STRIPE || paidByOrganiser(booking)) return NO_DISPUTE_HOLD;
  if (!isSettledBookingStatus(booking.status) || !hasCapturedPayment(payment)) return NO_DISPUTE_HOLD;
  return paymentDisputedCaptureCents(db, payment);
}

/**
 * #5061 follow-up (`INV-PAY-153`): what a disputed reduction hands to the
 * treasurer - the whole reduction on the credit tier, as a disputed paid
 * cancel's hand-back is (`cancelRefundDisposition`), whatever the member chose.
 */
export function heldForDisputeSettlementCents(options: BookingModificationSettlementOptions): number {
  return options.accountCreditAmountCents;
}

/** One cash cap for the quote and save, after unpaid asks have been netted. */
export async function refundableCashForModification(
  db: OpenNonCancellationHandBackDb,
  payment: LoadedBookingForModify["payment"],
  reduction: ReductionAgainstUnpaidAsk,
): Promise<number> {
  const cashCents = await refundableCashNetOfOpenHandBacks(db, payment);
  const paidFeeCents = reduction.organiserExtras && payment
    ? effectiveOrganiserPaidChangeFeeCents(payment.changeFeeCents, reduction.organiserExtras)
    : 0;
  return Math.max(0, cashCents - paidFeeCents);
}

/**
 * #4299 S2 (`INV-PAY-148`): the card tier an edit nets organiser extras at,
 * from the same policy and day `calculateModificationSettlementOptions` reads,
 * and read even where those options are null: a reduction sized wholly against
 * an unpaid extra leaves no cash basis, yet cash that races its waiver is
 * refunded at this tier. 100%, no fee, only for an untiered re-price.
 */
export async function modificationCardRefundTier(
  db: CancellationPolicyDb,
  booking: Pick<LoadedBookingForModify, "checkIn" | "lodgeId">,
  todayAtClub: CalendarDate,
  untiered: boolean,
): Promise<{ refundPercentage: number; fixedFeeCents: number }> {
  if (untiered) return { refundPercentage: 100, fixedFeeCents: 0 };
  const tier = getRefundTier(daysUntilDate(booking.checkIn, todayAtClub), await loadCancellationPolicy(booking.checkIn, booking.lodgeId, db));
  return { refundPercentage: tier.refundPercentage, fixedFeeCents: tier.fixedFeeCents };
}

/**
 * `db` is REQUIRED and reads the cancellation policy set: this module is
 * transaction-scoped and imports no module-level client, so a default would hide
 * a second pooled connection under the caller's locks. `INV-LOCK-004`; see
 * `CancellationPolicyDb` in `cancellation.ts`.
 *
 * `todayAtClub` is REQUIRED for the SAME reason and is the other half of the
 * same rule (#3123). `INV-LOCK-004` names the club timezone as one of only two
 * reads that cannot take a transaction client, so the club's day is resolved by
 * whichever caller opened the transaction, BEFORE it opened it, and arrives here
 * as a value. All four production callers hold the global cohort key and the
 * per-lodge capacity key when they reach this line.
 */
export async function calculateModificationSettlementOptions({
  booking,
  netChargeCents,
  reduction,
  db,
  todayAtClub,
}: {
  booking: Pick<
    LoadedBookingForModify,
    "id" | "checkIn" | "status" | "payment" | "lodgeId" | "organiserSettled" | "parentBookingId"
  >;
  netChargeCents: number;
  /**
   * #3954: this edit's net set against the booking's unpaid ask, READ ONCE by
   * the caller (`readReductionAgainstUnpaidAsk`) and handed to
   * `applyPaymentAdjustments` too, so the options are sized on exactly what the
   * save retires - a capture between two reads can no longer split them.
   */
  reduction: ReductionAgainstUnpaidAsk;
  /**
   * Also reads the payment's OPEN edit refund hand-backs (#3827,
   * `INV-PAY-117`), so a reduction is sized off cash not already promised back.
   */
  db: CancellationPolicyDb & OpenNonCancellationHandBackDb & EditDisputeHoldDb;
  /**
   * The club's own calendar day (`INV-CONFIG-002`), resolved outside this
   * transaction. It feeds `daysUntilDate` below, which is the refund-tier
   * boundary: a day early tiers a member's reduction refund one step down from
   * the club's published policy.
   */
  todayAtClub: CalendarDate;
}): Promise<BookingModificationSettlementOptions | null> {
  assertReductionReadForNet(reduction, netChargeCents, booking.id);
  const basisAmountCents = settlementBasisCents(
    booking,
    reduction.netChargeLeftCents,
    await refundableCashForModification(db, booking.payment, reduction),
  );
  if (basisAmountCents === null) return null;

  const policy = await loadCancellationPolicy(booking.checkIn, booking.lodgeId, db);
  const daysUntilCheckIn = daysUntilDate(booking.checkIn, todayAtClub);
  const {
    cardRefundAmountCents,
    cardRefundPercentage,
    creditRefundAmountCents,
    creditRefundPercentage,
  } = calculateDualRefundAmounts(basisAmountCents, daysUntilCheckIn, policy);

  if (paidByOrganiser(booking)) {
    // #3653: one disposition, the organiser's, so nothing to choose. #3949
    // (review round 5; owner decisions of 15-22 Oct 2026): so is a child the
    // organiser settled by Internet Banking - its reduction goes back to the
    // organiser by a bank-transfer hand-back on the card tier, as the joiner's
    // own cancel does, never as the joiner's account credit.
    return {
      basisAmountCents,
      cardRefundAmountCents,
      cardRefundPercentage,
      accountCreditAmountCents: 0,
      accountCreditPercentage: 0,
      daysUntilCheckIn,
      requiresSettlementMethod: false,
      returnsToOrganiser: true,
      organiserRefundByBankTransfer: paidByOrganiserInternetBanking(booking),
      refundHeldForDispute: false,
    };
  }
  // #5061 follow-up (`INV-PAY-153`): a disputed payment offers no choice; the treasurer has the reduction.
  const refundHeldForDispute = (await editReductionDisputeHold(db, booking)).cents > 0;
  return {
    basisAmountCents,
    cardRefundAmountCents,
    cardRefundPercentage,
    accountCreditAmountCents: creditRefundAmountCents,
    accountCreditPercentage: creditRefundPercentage,
    daysUntilCheckIn,
    requiresSettlementMethod:
      !refundHeldForDispute && (cardRefundAmountCents > 0 || creditRefundAmountCents > 0),
    returnsToOrganiser: false,
    organiserRefundByBankTransfer: false,
    refundHeldForDispute,
  };
}

/**
 * What a reduction can return from the captured payment: the reduction, capped
 * at what is still refundable — or null when the booking holds no captured
 * payment in a settled status, or there is nothing to return. ONE basis for the
 * policy-tiered options above and the untiered ones below.
 *
 * `refundableCashCents` is REQUIRED and is
 * `refundableCashNetOfOpenHandBacks` (#3827, `INV-PAY-117`): the captured
 * cash not yet refunded AND not already promised back by an open edit refund
 * hand-back.
 */
function settlementBasisCents(
  booking: Pick<LoadedBookingForModify, "status" | "payment">,
  netChargeCents: number,
  refundableCashCents: number,
): number | null {
  const basisAmountCents = Math.min(Math.max(0, -netChargeCents), refundableCashCents);
  const hasSettledPayment =
    isSettledBookingStatus(booking.status) && hasCapturedPayment(booking.payment);
  return basisAmountCents > 0 && hasSettledPayment ? basisAmountCents : null;
}

/**
 * The settlement options for a reduction that is NOT a cancellation, so no
 * cancellation-policy tier applies: the whole basis comes back, by either arm
 * (#3827, owner decision D-3813-5 — a guest's acceptance re-pricing the
 * booking's promo codes). The same basis and shape as
 * {@link calculateModificationSettlementOptions}, at 100%, so the ordinary
 * `applyPaymentAdjustments` settles it unchanged. Pure: no policy is read.
 */
export function calculateFullReductionSettlementOptions({
  booking,
  netChargeCents,
  refundableCashCents,
  todayAtClub,
  refundHeldForDispute,
}: {
  booking: Pick<
    LoadedBookingForModify,
    "checkIn" | "status" | "payment" | "organiserSettled" | "parentBookingId"
  >;
  netChargeCents: number;
  /** `refundableCashNetOfOpenHandBacks`, read by the caller under its locks (`INV-PAY-117`). */
  refundableCashCents: number;
  todayAtClub: CalendarDate;
  /** #5061 follow-up: `editReductionDisputeHold` above zero, read by the caller under its locks (`INV-PAY-153`). */
  refundHeldForDispute: boolean;
}): BookingModificationSettlementOptions | null {
  const basisAmountCents = settlementBasisCents(booking, netChargeCents, refundableCashCents);
  if (basisAmountCents === null) return null;
  const daysUntilCheckIn = daysUntilDate(booking.checkIn, todayAtClub);
  if (paidByOrganiser(booking)) {
    // #3653, composed by #3829: the booking was paid by the group organiser, so
    // "the same way it was paid" (D-3813-5) is back to the organiser - their
    // card, or (#3949) a bank transfer - one disposition, nothing to choose,
    // exactly as the tiered options above.
    return {
      basisAmountCents,
      cardRefundAmountCents: basisAmountCents,
      cardRefundPercentage: 100,
      accountCreditAmountCents: 0,
      accountCreditPercentage: 0,
      daysUntilCheckIn,
      requiresSettlementMethod: false,
      returnsToOrganiser: true,
      organiserRefundByBankTransfer: paidByOrganiserInternetBanking(booking),
      refundHeldForDispute: false,
    };
  }
  return {
    basisAmountCents,
    cardRefundAmountCents: basisAmountCents,
    cardRefundPercentage: 100,
    accountCreditAmountCents: basisAmountCents,
    accountCreditPercentage: 100,
    daysUntilCheckIn,
    requiresSettlementMethod: !refundHeldForDispute,
    returnsToOrganiser: false,
    organiserRefundByBankTransfer: false,
    refundHeldForDispute,
  };
}

/**
 * The refund or credit an edit's chosen settlement takes of its options. Moved
 * verbatim from `booking-modify-settlement.ts` (#3980, its size budget); its one
 * caller is `applyPaymentAdjustments`.
 */
export function resolveSelectedSettlementAmount({
  settlementOptions,
  settlementMethod,
}: {
  settlementOptions: BookingModificationSettlementOptions | null | undefined;
  settlementMethod: BookingModificationSettlementMethod | undefined;
}) {
  if (!settlementOptions) {
    return {
      settlementMethod: null,
      amountCents: 0,
      policyRetainedAmountCents: 0,
    };
  }

  if (settlementOptions.returnsToOrganiser) {
    if (settlementMethod === "credit") {
      throw new ApiError(
        "This booking was paid for by the group organiser, so a reduction goes back to the organiser and cannot be held as account credit.",
        400,
      );
    }
    const amountCents = settlementOptions.cardRefundAmountCents;
    return {
      settlementMethod: amountCents > 0 ? ("card" as const) : null,
      amountCents,
      policyRetainedAmountCents: Math.max(0, settlementOptions.basisAmountCents - amountCents),
    };
  }

  if (settlementOptions.refundHeldForDispute) {
    // #5061 follow-up (`INV-PAY-153`): money back, by the treasurer's hand - never account credit.
    const amountCents = heldForDisputeSettlementCents(settlementOptions);
    return {
      settlementMethod: amountCents > 0 ? ("card" as const) : null,
      amountCents,
      policyRetainedAmountCents: Math.max(0, settlementOptions.basisAmountCents - amountCents),
    };
  }

  if (settlementOptions.requiresSettlementMethod && !settlementMethod) {
    throw new BookingModificationSettlementMethodRequiredError();
  }

  if (!settlementOptions.requiresSettlementMethod) {
    return {
      settlementMethod: null,
      amountCents: 0,
      policyRetainedAmountCents: settlementOptions.basisAmountCents,
    };
  }

  const resolvedMethod = settlementMethod ?? "card";
  const amountCents =
    resolvedMethod === "credit"
      ? settlementOptions.accountCreditAmountCents
      : settlementOptions.cardRefundAmountCents;

  return {
    settlementMethod: resolvedMethod,
    amountCents,
    policyRetainedAmountCents: Math.max(
      0,
      settlementOptions.basisAmountCents - amountCents,
    ),
  };
}
