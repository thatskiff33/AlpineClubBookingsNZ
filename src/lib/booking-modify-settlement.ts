// Split out of src/lib/booking-modify.ts (issue #1138): settlement handoff
// (refund vs account credit), payment adjustments, and booking lifecycle
// transitions after a modification. Code moved verbatim; import via the
// "@/lib/booking-modify" barrel.

import {
  BookingStatus,
  PaymentSource,
  PaymentStatus,
  type Prisma,
} from "@prisma/client";

import {
  NO_ADDITIONAL_ASK,
  reissueUnpaidAdditionalAsk,
  sizeAdditionalAsk,
  type AdditionalAsk,
} from "@/lib/additional-payment-ask";
import {
  assertReductionReadForNet,
  foldWaitingReissuedAsks,
  retireUnpaidAskChain,
  type ReductionAgainstUnpaidAsk,
  type RetiredAdditionalAsk,
} from "@/lib/additional-ask-reduction";
import { bookingOwner } from "@/lib/booking-owner";
import { BookingModificationSettlementMethodRequiredError } from "@/lib/booking-modify-settlement-required";
import type { CalendarDate } from "@/lib/club-time";
import type { ClubFormat } from "@/lib/club-format";
import { giveBackPaidReductionCredit } from "@/lib/booking-modify-credit-give-back";
import type { PaidReductionCreditGiveBack } from "@/lib/booking-credit-give-back-marker";
import { getNonMemberHoldPolicy } from "@/lib/cancellation";
import {
  queueSupersededPrimaryIntentCancellations,
  type SupersededPrimaryPaymentIntent,
} from "@/lib/booking-payment-cleanup";
import {
  bookingAmountOwedCents,
  bookingWorthCents,
  canAskCardForIncrease,
  hasCapturedPayment,
  hasIssuedPrimaryXeroInvoice,
  isSettledBookingStatus,
  recordedChangeFeeCents,
} from "@/lib/booking-payment-state";
import {
  type BookingModificationSettlementMethod,
  type LoadedBookingForModify,
} from "@/lib/booking-modify-validation";
import { type GuestPlan } from "@/lib/booking-modify-plan";
import { calculateBookingHoldDecision } from "@/lib/policies/booking-route-decisions";
import {
  clampAppliedCreditToBookingPrice,
  deriveBookingAppliedCreditCents,
} from "@/lib/member-credit";
import { clearStaleCreditElection } from "@/lib/booking-credit-election";
import { refundableCashNetOfOpenHandBacks } from "@/lib/edit-refund-hand-back";
import { ApiError } from "@/lib/api-error";
import { formatCents } from "@/lib/utils";
import {
  OrganiserChildRefundRefusedError,
  planOrganiserChildModificationRefund,
  type CombinedCardSettlement,
} from "@/lib/organiser-child-refund";
import { ORGANISER_CHILD_CHARGE_REFUSAL, paidByOrganiserCard } from "@/lib/group-organiser-paid";

export type PaymentAdjustmentResult = {
  refundAmountCents: number;
  accountCreditAmountCents: number;
  /**
   * The plain figure the EMAILS, the response bodies and the Xero leg read. On
   * the card arm it equals `additionalAsk.amountCents`; where there is no card
   * it is the supplementary invoice's own delta, which supersedes nothing.
   */
  additionalAmountCents: number;
  /**
   * #3371: the same card ask as a value only `@/lib/additional-payment-ask` can
   * build, carrying what minting it will absorb. This is what the minter takes;
   * `additionalAmountCents` above is not, and must never be handed to it.
   */
  additionalAsk: AdditionalAsk;
  pendingRefundAmountCents: number;
  hasSucceededPayment: boolean;
  hasIssuedXeroInvoice: boolean;
  xeroRefundAmountCents: number;
  xeroAdditionalAmountCents: number;
  settlementMethod: BookingModificationSettlementMethod | null;
  policyRetainedAmountCents: number;
  /**
   * #3809: applied credit a paid booking's reduction gave back - what the card
   * basis could not return, tiered like a card refund (`giveBackPaidReductionCredit`);
   * neither a refund nor minted credit, so in neither figure above. The Xero leg
   * takes it as an allocated note worded as account credit (`appliedCreditGiveBackCents`).
   */
  appliedCreditGivenBackCents: number;
  /** #3809: the settlement of applied credit (null where not reached), on the edit's history row (`creditGiveBackHistory`); a later cancel caps by it (`INV-PAY-115`). */
  appliedCreditGiveBack: PaidReductionCreditGiveBack | null;
  /**
   * #3653: the refund an organiser-settled child's reduction returns from the
   * group's combined card payment, decided under this transaction's locks. The
   * door writes its debt with `reserveOrganiserChildRefund` once its
   * `BookingModification` row exists; null for every other booking.
   */
  organiserChildRefund: { settlement: CombinedCardSettlement; amountCents: number } | null;
  /**
   * #3954: how much of the reduction released the member from an unpaid ask
   * rather than being refunded or credited, and the asks it retired inside this
   * transaction (cancelled at Stripe after commit by the minter). A shrunk ask is
   * `additionalAsk` above, re-issued.
   */
  unpaidAskOffsetCents: number;
  retiredAdditionalAsks: RetiredAdditionalAsk[];
  /**
   * #3954: the edits whose unpaid asks this reduction retired - a parked
   * invoice's anchor, or a waiting recovery's edit - for the history row the
   * booking-vs-Xero repair pass reads.
   */
  retiredAskModificationIds: string[];
  /** #3954 decision A: what the re-issued ask's own supplementary invoice bills, 0 for none. */
  reissuedAskInvoiceCents: number;
  /** #3954: the part of the offset Xero had already billed, for the repair pass. */
  unpaidAskBilledOffsetCents: number;
};

/**
 * #3653 (`INV-PAY-114`): the refusal an edit that raises the price of a booking
 * the organiser paid for by card meets, or null. One predicate for the save
 * (`applyPaymentAdjustments`) and the quote that previews it, so the quote
 * cannot offer a change the save refuses.
 */
export function organiserChildChargeRefusal({
  booking,
  netChargeCents,
}: {
  booking: Pick<LoadedBookingForModify, "status" | "payment" | "organiserSettled" | "parentBookingId">;
  netChargeCents: number;
}): string | null {
  // #3502: the increase question, so a credit-paid ($0) child is refused here
  // exactly as `applyPaymentAdjustments` now asks its card.
  return netChargeCents > 0 && canAskCardForIncrease(booking) && paidByOrganiserCard(booking)
    ? ORGANISER_CHILD_CHARGE_REFUSAL
    : null;
}

// isSettledBookingStatus moved to booking-payment-state (#1729) so the Xero
// period lock-date guard shares the hasIssuedPrimaryXeroInvoice derivation.

// #3829: the settlement OPTIONS (what a reduction may return, and how) moved
// to `booking-modify-settlement-options.ts` verbatim, to keep this module inside
// its size budget once epic #3813 composed with main; re-exported here so no
// importer or barrel moved.
export {
  calculateFullReductionSettlementOptions,
  calculateModificationSettlementOptions,
  type BookingModificationSettlementOptions,
} from "@/lib/booking-modify-settlement-options";
import type { BookingModificationSettlementOptions } from "@/lib/booking-modify-settlement-options";

// #3232: the settlement-required refusal moved to `booking-modify-settlement-
// required.ts`, whose only import is `ApiError`, so a caller that needs to
// RECOGNISE it does not have to pull this file's pricing/cancellation/payment
// graph in with it. It is imported above and thrown below exactly as before; the
// `booking-modify` barrel re-exports it from its new home, so no importer moved.

function resolveSelectedSettlementAmount({
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
        "This booking was paid for by the group organiser, so a reduction goes back to the organiser's card and cannot be held as account credit.",
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

export async function applyPaymentAdjustments(
  tx: Prisma.TransactionClient,
  {
    booking,
    priceDiffCents,
    changeFeeCents,
    reduction,
    settlementOptions,
    settlementMethod,
    todayAtClub,
    format,
    appliedCreditReturnedByCaller = false,
    reductionUntiered = false,
    changeFeeRecordedByCaller = false,
  }: {
    booking: LoadedBookingForModify;
    priceDiffCents: number;
    changeFeeCents: number;
    /**
     * #3954: this edit's net set against the booking's unpaid ask - the SAME
     * read the caller's settlement options were sized on
     * (`readReductionAgainstUnpaidAsk`, once per edit, after the caller's
     * locks). An increase passes `noReductionAgainstUnpaidAsk`.
     */
    reduction: ReductionAgainstUnpaidAsk;
    settlementOptions?: BookingModificationSettlementOptions | null;
    settlementMethod?: BookingModificationSettlementMethod;
    /** #3809: the club's day, the tier boundary of a credit-paid booking's give-back. */
    todayAtClub: CalendarDate;
    /** #3809: resolved before the transaction, for the give-back's ledger lock. */
    format: ClubFormat;
    /**
     * #3827 (owner decision D-3813-5): the caller returns the applied credit
     * itself, in full and untiered - a guest's acceptance re-price, which is not
     * a cancellation - so #3809's tiered give-back below must not also run, or
     * the credit would come back twice (or tiered, against the decision).
     * Every ordinary edit door omits it and keeps #3809's give-back.
     */
    appliedCreditReturnedByCaller?: boolean;
    /**
     * #3750 (F2 on #3955): the caller already charged the cancellation tier in
     * its change fee (a finished-stay correction), so the applied-credit
     * give-back returns the remaining reduction in full rather than tiering it
     * a second time.
     */
    reductionUntiered?: boolean;
    /**
     * #3954 x #3750: the caller records this edit's fee on the payment itself
     * (a finished-stay correction's fee added to the amount owed,
     * `recordFinishedStayFeeOwed`), so the unpaid-ask arm below must not record
     * it a second time.
     */
    changeFeeRecordedByCaller?: boolean;
  },
): Promise<PaymentAdjustmentResult> {
  const inSettledStatus = isSettledBookingStatus(booking.status);
  const hasSettledPayment =
    inSettledStatus && hasCapturedPayment(booking.payment);
  // #3954 (owner decision, 8 Oct 2026): a reduction is first set against the
  // booking's unpaid ask - read ONCE by the caller, after its locks, and the
  // same read its settlement options were sized on - and every branch below
  // settles only what is left. An increase carries no ask and is unchanged.
  assertReductionReadForNet(reduction, priceDiffCents + changeFeeCents, booking.id);
  const unpaidAsk = reduction.ask;
  const setAgainstAsk = reduction;
  const netAmountCents = setAgainstAsk.netChargeLeftCents;
  // #3502 (owner decision, 6 Oct 2026): a booking paid wholly with credit or a
  // 100% promotion carries `{ amountCents: 0, status: SUCCEEDED }`, which
  // `hasCapturedPayment` rightly reads as "nothing captured" - so every
  // REDUCTION branch below keeps reading `hasSettledPayment` and #3809's
  // give-back is untouched. An INCREASE on it is asked of the member's card,
  // exactly as on a card-paid booking: before this it fell through to the Xero
  // arm, which bills only when an invoice has been issued, so with Xero off (or
  // before the primary invoice was raised) the extra was asked of nobody.
  const zeroDollarCardIncrease =
    netAmountCents > 0 && !hasSettledPayment && canAskCardForIncrease(booking);
  const hasSucceededPayment =
    (hasSettledPayment && booking.payment?.source === PaymentSource.STRIPE) ||
    zeroDollarCardIncrease;
  const hasIssuedXeroInvoice = hasIssuedPrimaryXeroInvoice(booking);
  // #3827 (`INV-PAY-117`): net of edit refunds already promised back by hand.
  const remainingRefundableCents = await refundableCashNetOfOpenHandBacks(tx, booking.payment);

  // #3954: the options must have been sized on what is left of the reduction
  // (`calculateModificationSettlementOptions` reads the same ask), or a
  // reduction would both release the ask and refund the same money.
  if (settlementOptions && settlementOptions.basisAmountCents > Math.max(0, -netAmountCents)) {
    throw new Error(
      `INV-PAY-047 (#3954): booking ${booking.id}'s settlement options return ${formatCents(settlementOptions.basisAmountCents, format)} of a reduction whose unpaid-ask offset leaves ${formatCents(Math.max(0, -netAmountCents), format)}; they were sized before the reduction was set against the unpaid ask.`,
    );
  }

  const selectedSettlement = resolveSelectedSettlementAmount({
    settlementOptions,
    settlementMethod,
  });
  // On a reduction against an issued Xero invoice (#1015): when a payment has
  // been captured the credit note is policy-limited (selectedSettlement); when
  // the invoice is issued but unpaid (pay-on-account, no captured payment) no
  // policy tier applies — nothing was paid — so the invoice must be corrected
  // for the full net delta, otherwise a `settlementOptions` of null leaves
  // xeroRefund at 0 and the outstanding invoice keeps the removed guests.
  //
  // #3809: a PAID booking gives back, as applied credit, the part of the
  // reduction the captured money's basis cannot return - all of it where
  // nothing was captured - tiered like a card refund, before any Payment row
  // write here. Its Xero note is that give-back, as a card refund's is the
  // refund; with nothing captured there is then no other note to raise.
  const creditGiveBack =
    netAmountCents < 0 && !appliedCreditReturnedByCaller
      ? await giveBackPaidReductionCredit(tx, {
          booking,
          reductionCents: -netAmountCents,
          cardBasisCents: hasSettledPayment ? Math.min(-netAmountCents, remainingRefundableCents) : 0,
          todayAtClub,
          format,
          untiered: reductionUntiered,
        })
      : null;
  const xeroRefundAmountCents =
    hasIssuedXeroInvoice && netAmountCents < 0
      ? hasSettledPayment
        ? selectedSettlement.amountCents
        : creditGiveBack
          ? 0
          : Math.abs(netAmountCents)
      : 0;
  const xeroAdditionalAmountCents =
    hasIssuedXeroInvoice && netAmountCents > 0 ? netAmountCents : 0;

  let refundAmountCents = 0;
  let accountCreditAmountCents = 0;
  let additionalAmountCents = 0;
  // #3371: zero until a card arm builds one. `NO_ADDITIONAL_ASK` never mints, so
  // every non-card ending is safe by construction rather than by remembering.
  let additionalAsk: AdditionalAsk = NO_ADDITIONAL_ASK;
  let pendingRefundAmountCents = 0;
  let retiredAdditionalAsks: RetiredAdditionalAsk[] = [];
  let retiredAskModificationIds: string[] = [];
  let reissuedAskInvoiceCents = 0;
  let unpaidAskBilledOffsetCents = 0;

  if (setAgainstAsk.offsetCents > 0 && booking.payment) {
    const retiredAsk = await retireUnpaidAskChain(tx, {
      bookingId: booking.id,
      paymentId: booking.payment.id,
      ask: unpaidAsk,
    });
    retiredAdditionalAsks = retiredAsk.retired;
    retiredAskModificationIds = retiredAsk.retiredAskModificationIds;
    // Decision A (#3954, owner 9 Oct 2026, "Raise a $30 invoice"): the smaller
    // ask gets its own supplementary invoice for what the retired asks' invoices
    // would have billed, less the offset - never more than the ask itself.
    // What the offset took beyond those invoices was money Xero had ALREADY
    // billed (a primary invoice raised after the increase), recorded for the
    // repair pass rather than billed again.
    reissuedAskInvoiceCents = Math.min(
      setAgainstAsk.askLeftCents,
      Math.max(0, retiredAsk.invoicedCents - setAgainstAsk.offsetCents),
    );
    unpaidAskBilledOffsetCents = hasIssuedXeroInvoice
      ? Math.max(0, setAgainstAsk.offsetCents - retiredAsk.invoicedCents)
      : 0;
    // What the reduction did not cover is still owed, on a fresh ask that
    // carries it (`INV-PAY-098`); the minter mints it after commit.
    additionalAsk = reissueUnpaidAdditionalAsk({ askLeftCents: setAgainstAsk.askLeftCents });
    additionalAmountCents = additionalAsk.amountCents;
    // The fee this edit charges was collected by shrinking the ask, so it is
    // recorded beside the ask like any fee an ask collects (`INV-PAY-047`) -
    // also on a credit-paid booking, which the settled arm below never reaches.
    if (changeFeeCents > 0 && !hasSettledPayment && !changeFeeRecordedByCaller) {
      await tx.payment.update({
        where: { id: booking.payment.id },
        data: { changeFeeCents: { increment: changeFeeCents } },
      });
    }
  }

  // #3502: the zero-dollar increase joins the settled arm. It is an increase by
  // construction, so it can reach only the `netAmountCents > 0` branch: the
  // organiser refusal, `sizeAdditionalAsk`, and the change fee recorded on the
  // payment in this transaction, without which `INV-PAY-047` reads the fee the
  // ask collects as money retained.
  if ((hasSettledPayment || zeroDollarCardIncrease) && booking.payment) {
    if (settlementOptions && netAmountCents < 0) {
      if (selectedSettlement.settlementMethod === "credit") {
        accountCreditAmountCents = selectedSettlement.amountCents;
      } else {
        refundAmountCents = selectedSettlement.amountCents;
      }
      pendingRefundAmountCents = hasSucceededPayment ? refundAmountCents : 0;
    } else if (netAmountCents < 0) {
      refundAmountCents = Math.min(
        Math.abs(netAmountCents),
        remainingRefundableCents,
      );
      pendingRefundAmountCents = hasSucceededPayment ? refundAmountCents : 0;
    } else if (netAmountCents > 0) {
      // #3340 (`INV-PAY-047`, `INV-ADDPAY-023`). A bare `netAmountCents` here is
      // the money leak: minting the new ADDITIONAL intent retires every other
      // outstanding ask on this payment
      // (`queueSupersededAdditionalIntentCancellations`), so a delta-sized ask
      // DELETES the unpaid balance of the one it replaces. Two +$70 edits on a
      // $130 paid booking asked $70 and lost $70, permanently and silently.
      //
      // `sizeAdditionalAsk` is the one home for the arithmetic and the one
      // place its reasoning is written down. `booking.payment` is the POST-LOCK
      // re-read in every production caller (each re-reads the booking with
      // `payment: true` after `pg_advisory_xact_lock(1)` + the per-lodge key).
      //
      // BE PRECISE ABOUT WHAT THOSE LOCKS BUY, because an earlier draft of this
      // comment claimed more (#3340 fix round). The READ is inside them. The
      // WRITER is not: `Payment.additionalAmountCents` is only ever written by
      // `reconcilePaymentAggregates` from `upsertPaymentIntentTransaction`, and
      // every mint site runs that AFTER the transaction has committed and
      // OUTSIDE `lock(1)` - correctly so, because a provider round trip must not
      // sit inside a transaction (`docs/CONCURRENCY_AND_LOCKING.md`). So two
      // edits whose transactions both commit before either mint completes read
      // the same pre-edit value, the second is sized without the first's ask, and
      // whichever mints last retires the other. The locks serialise the edits;
      // they do not serialise the edits against the mints.
      //
      // That window is not opened by this change and is not closed by it - before
      // #3340 both edits were delta-sized, so the same pair lost the same money.
      // The compensating control is the census (`INV-PAY-047`), which makes the
      // resulting shortfall visible instead of silent.
      //
      // The Xero arm below is deliberately untouched: `xeroAdditionalAmountCents`
      // sizes a SUPPLEMENTARY INVOICE for THIS edit, which supersedes nothing and
      // is collected alongside whatever came before it.
      const organiserChargeRefusal = organiserChildChargeRefusal({ booking, netChargeCents: netAmountCents });
      if (organiserChargeRefusal) {
        // #3653: the organiser paid for this booking out of ONE combined card
        // payment. An ask minted here would charge the JOINER, and its
        // transaction row would make the next reconcile recompute this
        // payment's refunded total from rows that do not hold the organiser's
        // refunds. Refused before the edit commits.
        throw new OrganiserChildRefundRefusedError(organiserChargeRefusal);
      } else if (hasSucceededPayment) {
        additionalAsk = sizeAdditionalAsk({
          priceDiffCents,
          changeFeeCents,
          payment: booking.payment,
          // #3954 round 4: a reduction's re-issue still waiting on its mint is
          // asked for on this one fresh ask, and its recovery closed.
          waitingReissuedAskCents: await foldWaitingReissuedAsks(tx, booking),
        });
        additionalAmountCents = additionalAsk.amountCents;
      } else {
        additionalAmountCents = xeroAdditionalAmountCents;
      }
    }

    if (changeFeeCents > 0) {
      await tx.payment.update({
        where: { id: booking.payment.id },
        data: { changeFeeCents: { increment: changeFeeCents } },
      });
    }
  } else if (xeroAdditionalAmountCents > 0) {
    additionalAmountCents = xeroAdditionalAmountCents;
  }

  // #3653: refused here, before the edit commits, when the organiser's combined
  // payment cannot return it.
  const organiserChildRefund = await planOrganiserChildModificationRefund(
    tx,
    booking,
    pendingRefundAmountCents,
  );

  return {
    refundAmountCents,
    accountCreditAmountCents,
    additionalAmountCents,
    additionalAsk,
    pendingRefundAmountCents,
    hasSucceededPayment,
    hasIssuedXeroInvoice,
    xeroRefundAmountCents,
    xeroAdditionalAmountCents,
    settlementMethod: selectedSettlement.settlementMethod,
    policyRetainedAmountCents:
      selectedSettlement.policyRetainedAmountCents +
      (creditGiveBack ? creditGiveBack.basisCents - creditGiveBack.givenBackCents : 0),
    appliedCreditGivenBackCents: creditGiveBack?.givenBackCents ?? 0,
    appliedCreditGiveBack: creditGiveBack,
    organiserChildRefund,
    unpaidAskOffsetCents: setAgainstAsk.offsetCents,
    retiredAdditionalAsks,
    retiredAskModificationIds,
    reissuedAskInvoiceCents,
    unpaidAskBilledOffsetCents,
  };
}

export type LifecycleTransitionResult = {
  hasNonMembers: boolean;
  newNonMemberHoldUntil: Date | null;
  newStatus: BookingStatus;
  zeroDollarAutoPaid: boolean;
  supersededPrimaryPaymentIntents: SupersededPrimaryPaymentIntent[];
  // F20 (#1887): account credit still applied to the booking after the reprice,
  // and any over-consumed slice refunded to the member on this modification.
  appliedCreditCents: number;
  refundedExcessCreditCents: number;
  // #2266: this edit parked a DRAFT to AWAITING_REVIEW, so the caller must
  // null draftExpiresAt — a parked booking is held for an admin decision and
  // must not be swept by the 72-hour draft expiry mid-review (the exact
  // create-path behaviour: booking-create nulls draftExpiresAt whenever
  // review.blockForReview lands a draft directly in AWAITING_REVIEW).
  clearDraftExpiresAt: boolean;
};

export async function applyLifecycleTransitions(
  tx: Prisma.TransactionClient,
  {
    booking,
    bookingId,
    newCheckIn,
    newFinalPriceCents,
    feeRecordedByThisEditCents,
    format,
    guestsForPricing,
    skipBookingLifecycleRules,
    reviewUpdate,
  }: {
    booking: LoadedBookingForModify;
    bookingId: string;
    newCheckIn: Date;
    newFinalPriceCents: number;
    /**
     * #3750 (#3955 review F1): a change fee THIS edit recorded on the payment
     * of a booking with nothing captured ("Add fee to amount owed"), already
     * written by the caller. With the fee already on the payment it is what
     * the booking is worth (`bookingWorthCents`), so the credit clamp, the $0
     * decision and the stale-intent comparison below all read worth, never the
     * bare price. Every other edit door records none and passes 0.
     */
    feeRecordedByThisEditCents: number;
    format: ClubFormat;
    guestsForPricing: Array<{ isMember: boolean }>;
    skipBookingLifecycleRules: boolean;
    reviewUpdate?: GuestPlan["reviewUpdate"];
  },
): Promise<LifecycleTransitionResult> {
  const hasNonMembers = !guestsForPricing.every((g) => g.isMember);
  let newNonMemberHoldUntil = booking.nonMemberHoldUntil;
  let newStatus = booking.status;
  let zeroDollarAutoPaid = false;
  let supersededPrimaryPaymentIntents: SupersededPrimaryPaymentIntent[] = [];
  let appliedCreditCents = 0;
  let refundedExcessCreditCents = 0;

  // Parking moves a booking to AWAITING_REVIEW only from the pre-payment
  // statuses that state was built for: approval releases AWAITING_REVIEW to
  // PAYMENT_PENDING, which must never happen to captured money (#1100). A
  // paid/confirmed booking that trips a review rule is flagged (the caller
  // writes requiresAdminReview + adminReviewStatus PENDING, which drives the
  // admin queue) but keeps its status.
  //
  // #2266: DRAFT parks too, in CREATE PARITY — a member-created draft that
  // trips the no-adult rule at booking-create lands directly in
  // AWAITING_REVIEW (booking-create.ts), so a member DRAFT edit that trips
  // the same rule must land in the same place. Without this, the edit wrote
  // adminReviewStatus PENDING while the booking STAYED DRAFT — and the DRAFT
  // pay/confirm doors did not check review fields, so a minors-only booking
  // could reach PAID with its review still pending. Parking from DRAFT also
  // clears draftExpiresAt (via clearDraftExpiresAt below), again matching
  // create. Approval then releases to PAYMENT_PENDING exactly like a
  // review-parked created draft.
  const canParkForReview =
    newStatus === BookingStatus.PENDING ||
    newStatus === BookingStatus.PAYMENT_PENDING ||
    newStatus === BookingStatus.DRAFT;
  let clearDraftExpiresAt = false;
  if (reviewUpdate?.parkForReview && canParkForReview) {
    clearDraftExpiresAt = newStatus === BookingStatus.DRAFT;
    newStatus = "AWAITING_REVIEW";
  }
  // No release arm here: an edit never reaches AWAITING_REVIEW (every edit
  // door refuses it), so the only writer of AWAITING_REVIEW -> PAYMENT_PENDING
  // is the officer review route (#3500, `INV-MOD-013`).

  // #2266: a DRAFT never carries a hold — it holds no capacity and owes no
  // money until the pay step (or $0 confirm-draft) makes it real, and THAT
  // door computes the hold rail. Member draft edits reach here with
  // skipBookingLifecycleRules false (only admin edits of non-lifecycle
  // statuses skip), so without this guard a member editing a draft with
  // non-member guests would stamp a meaningless nonMemberHoldUntil onto it.
  const isDraftEdit = booking.status === BookingStatus.DRAFT;
  if (!skipBookingLifecycleRules && hasNonMembers && !isDraftEdit) {
    const holdPolicy = await getNonMemberHoldPolicy(newCheckIn, booking.lodgeId, tx);
    const holdDecision = calculateBookingHoldDecision({
      hasNonMembers,
      checkIn: newCheckIn,
      holdDays: holdPolicy.holdDays,
      holdEnabled: holdPolicy.enabled,
    });

    if (holdDecision.shouldBePending) {
      newNonMemberHoldUntil = new Date(
        newCheckIn.getTime() - holdPolicy.holdDays * 24 * 60 * 60 * 1000,
      );
    } else {
      newNonMemberHoldUntil = null;
      if (booking.status === "PENDING") {
        newStatus = "PAYMENT_PENDING";
      }
    }
  } else if (!skipBookingLifecycleRules && !isDraftEdit) {
    newNonMemberHoldUntil = null;
  }

  // F20 (#1887): a pre-payment reduction can drop finalPriceCents below the
  // account credit applied at booking-create. Refund the over-consumed slice and
  // take the EFFECTIVE (credit-reduced) price for the zero-dollar decision, so a
  // now-fully-credit-covered booking auto-confirms at $0 instead of dead-ending
  // at the card-intent guard (effective <= 0). Skipped when lifecycle rules are
  // skipped (admin date shift freezes money).
  //
  // F1 (#1887): gate on the LEDGER + a pre-payment status, NOT the payment's
  // creditAppliedCents mirror. A CARD booking has NO Payment row until it
  // requests a card intent (booking-create only writes a payment row for the $0
  // and Internet-Banking paths), so the mirror gate missed exactly the surface
  // this clamp targets — a card booking editing dates/guests in PAYMENT_PENDING.
  // Without the clamp that booking would dead-end unpayable at the card-intent
  // guard (effective <= 0) with its credit over-consumed. A cheap UNLOCKED
  // ledger read decides whether any credit was applied at all, so a no-credit
  // modification still never takes the member-credit lock or writes a row and
  // keeps byte-for-byte the pre-#1887 behaviour (effective == newFinalPriceCents).
  //
  // F4 (#1887): only run in PENDING/PAYMENT_PENDING. A modification parked to
  // AWAITING_REVIEW (above) deliberately does NOT refund credit or auto-$0-pay
  // before an admin approves it — booking-create likewise blocks the zero-dollar
  // path while a booking is under review. The release-from-review transition
  // lands PAYMENT_PENDING, at which point the clamp runs.
  const isRepriceablePrePayment =
    newStatus === BookingStatus.PENDING ||
    newStatus === BookingStatus.PAYMENT_PENDING;
  // #3750 (#3955 review F1, `INV-PAY-119`): the fee recorded on the payment —
  // before this edit, plus what this edit recorded — is owed with the price, so
  // the clamp keeps credit up to the booking's WORTH and the $0 decision and
  // stale-intent comparison read what it owes. Read from the one home.
  const feeOwedCents =
    recordedChangeFeeCents(booking.payment) + feeRecordedByThisEditCents;
  const newWorthCents = bookingWorthCents({
    finalPriceCents: newFinalPriceCents,
    changeFeeCents: feeOwedCents,
  });
  if (!skipBookingLifecycleRules && isRepriceablePrePayment) {
    const appliedBeforeClamp = await deriveBookingAppliedCreditCents(
      bookingId,
      tx,
    );
    if (appliedBeforeClamp > 0) {
      const clamp = await clampAppliedCreditToBookingPrice(
        { memberId: bookingOwner(booking).memberId, bookingId, newWorthCents, format },
        tx,
      );
      appliedCreditCents = clamp.appliedCreditCents;
      refundedExcessCreditCents = clamp.refundedExcessCents;
    }
  }
  const effectivePriceCents = bookingAmountOwedCents({
    finalPriceCents: newFinalPriceCents,
    changeFeeCents: feeOwedCents,
    appliedCreditCents,
  });

  if (
    !skipBookingLifecycleRules &&
    effectivePriceCents === 0 &&
    newStatus === BookingStatus.PAYMENT_PENDING
  ) {
    newStatus = BookingStatus.PAID;
    zeroDollarAutoPaid = true;
    // #2265 (#2319). This booking is settling at $0, so there is nothing left
    // for account credit to pay and a stored credit election has become moot —
    // clear it rather than let it ride into a PAID row. The same reasoning, and
    // the same silence, as `confirm-draft`'s $0 confirm: no credit was consumed
    // and none is owed, so nothing is lost by dropping the request and there is
    // no unhonoured choice to report to anybody.
    //
    // Defence in depth (#3500): no edit reaches a review-parked booking with
    // its election still stored, because every edit door refuses
    // AWAITING_REVIEW and a self-removal on one can never clear the review.
    // The clear stays so that a later writer which does let one through cannot
    // land a PAID row still advertising an outstanding election that no
    // consumer would ever look at again.
    await clearStaleCreditElection(tx, booking);
    const zeroDollarPayment = await tx.payment.upsert({
      where: { bookingId },
      create: {
        bookingId,
        amountCents: 0,
        creditAppliedCents: appliedCreditCents,
        status: PaymentStatus.SUCCEEDED,
      },
      update: {
        amountCents: 0,
        creditAppliedCents: appliedCreditCents,
        status: PaymentStatus.SUCCEEDED,
        stripePaymentIntentId: null,
        stripePaymentMethodId: null,
        additionalPaymentIntentId: null,
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
      },
    });
    // effectivePriceCents (0 here) sweeps every positive pending primary intent,
    // matching the pre-#1887 price-to-zero behaviour for a credit-covered booking.
    supersededPrimaryPaymentIntents =
      await queueSupersededPrimaryIntentCancellations(tx, {
        bookingId,
        paymentId: zeroDollarPayment.id,
        newFinalPriceCents: effectivePriceCents,
      });
  } else if (booking.payment) {
    // Nonzero price changes strand any pending primary intent at the old
    // amount (#1161): the payment page would hand back its stale
    // client_secret and Stripe would capture the old total. Supersede the
    // mismatched intents now; the pay-time paths mint a fresh one.
    //
    // Compare against the EFFECTIVE (credit-reduced) price (#2266, INFO-10):
    // the pay page mints primary intents at finalPrice - appliedCredit, so a
    // pending intent already at the correct effective amount is not stale and
    // must not be swept (the old raw-price comparison cancelled it
    // needlessly; benign — the pay page re-minted — but wasteful). Outside
    // the pre-payment reprice arm appliedCreditCents is 0, so
    // effectivePriceCents equals newFinalPriceCents and behaviour is
    // unchanged there.
    supersededPrimaryPaymentIntents =
      await queueSupersededPrimaryIntentCancellations(tx, {
        bookingId,
        paymentId: booking.payment.id,
        newFinalPriceCents: effectivePriceCents,
      });
  }

  return {
    hasNonMembers,
    newNonMemberHoldUntil,
    newStatus,
    zeroDollarAutoPaid,
    supersededPrimaryPaymentIntents,
    appliedCreditCents,
    refundedExcessCreditCents,
    clearDraftExpiresAt,
  };
}
