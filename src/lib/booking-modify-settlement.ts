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

import { ApiError } from "@/lib/api-error";
import type { CalendarDate } from "@/lib/club-time";
import {
  calculateDualRefundAmounts,
  daysUntilDate,
  loadCancellationPolicy,
  getNonMemberHoldPolicy,
  type CancellationPolicyDb,
} from "@/lib/cancellation";
import {
  queueSupersededPrimaryIntentCancellations,
  type SupersededPrimaryPaymentIntent,
} from "@/lib/booking-payment-cleanup";
import {
  getRemainingRefundableCents,
  hasCapturedPayment,
  hasIssuedPrimaryXeroInvoice,
  isSettledBookingStatus,
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

export type BookingModificationSettlementOptions = {
  basisAmountCents: number;
  cardRefundAmountCents: number;
  cardRefundPercentage: number;
  accountCreditAmountCents: number;
  accountCreditPercentage: number;
  daysUntilCheckIn: number;
  requiresSettlementMethod: boolean;
};

export type PaymentAdjustmentResult = {
  refundAmountCents: number;
  accountCreditAmountCents: number;
  additionalAmountCents: number;
  pendingRefundAmountCents: number;
  hasSucceededPayment: boolean;
  hasIssuedXeroInvoice: boolean;
  xeroRefundAmountCents: number;
  xeroAdditionalAmountCents: number;
  settlementMethod: BookingModificationSettlementMethod | null;
  policyRetainedAmountCents: number;
};

// isSettledBookingStatus moved to booking-payment-state (#1729) so the Xero
// period lock-date guard shares the hasIssuedPrimaryXeroInvoice derivation.

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
  db,
  todayAtClub,
}: {
  booking: Pick<LoadedBookingForModify, "checkIn" | "status" | "payment" | "lodgeId">;
  netChargeCents: number;
  db: CancellationPolicyDb;
  /**
   * The club's own calendar day (`INV-CONFIG-002`), resolved outside this
   * transaction. It feeds `daysUntilDate` below, which is the refund-tier
   * boundary: a day early tiers a member's reduction refund one step down from
   * the club's published policy.
   */
  todayAtClub: CalendarDate;
}): Promise<BookingModificationSettlementOptions | null> {
  const reductionAmountCents = Math.max(0, -netChargeCents);
  const remainingRefundableCents = getRemainingRefundableCents(booking.payment);
  const basisAmountCents = Math.min(
    reductionAmountCents,
    remainingRefundableCents,
  );
  const hasSettledPayment =
    isSettledBookingStatus(booking.status) && hasCapturedPayment(booking.payment);

  if (basisAmountCents <= 0 || !hasSettledPayment) {
    return null;
  }

  const policy = await loadCancellationPolicy(booking.checkIn, booking.lodgeId, db);
  const daysUntilCheckIn = daysUntilDate(booking.checkIn, todayAtClub);
  const {
    cardRefundAmountCents,
    cardRefundPercentage,
    creditRefundAmountCents,
    creditRefundPercentage,
  } = calculateDualRefundAmounts(basisAmountCents, daysUntilCheckIn, policy);

  return {
    basisAmountCents,
    cardRefundAmountCents,
    cardRefundPercentage,
    accountCreditAmountCents: creditRefundAmountCents,
    accountCreditPercentage: creditRefundPercentage,
    daysUntilCheckIn,
    requiresSettlementMethod:
      cardRefundAmountCents > 0 || creditRefundAmountCents > 0,
  };
}

/**
 * The refusal when a modification produces a settleable refund and the caller has
 * not said where it goes. Exported with a machine CODE (#2526) so a surface that
 * can OFFER the choice — the officer's booking-policy exception queue — can tell
 * this apart from every other 400 and render the card/credit control instead of
 * an error the reader cannot act on.
 */
export const SETTLEMENT_METHOD_REQUIRED_MESSAGE =
  "Choose a refund or account credit before saving";
export const SETTLEMENT_METHOD_REQUIRED_CODE = "SETTLEMENT_METHOD_REQUIRED";

export class BookingModificationSettlementMethodRequiredError extends ApiError {
  readonly code = SETTLEMENT_METHOD_REQUIRED_CODE;

  constructor() {
    super(SETTLEMENT_METHOD_REQUIRED_MESSAGE, 400);
    this.name = "BookingModificationSettlementMethodRequiredError";
  }
}

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
    settlementOptions,
    settlementMethod,
  }: {
    booking: LoadedBookingForModify;
    priceDiffCents: number;
    changeFeeCents: number;
    settlementOptions?: BookingModificationSettlementOptions | null;
    settlementMethod?: BookingModificationSettlementMethod;
  },
): Promise<PaymentAdjustmentResult> {
  const inSettledStatus = isSettledBookingStatus(booking.status);
  const hasSettledPayment =
    inSettledStatus && hasCapturedPayment(booking.payment);
  const hasSucceededPayment =
    hasSettledPayment && booking.payment?.source === PaymentSource.STRIPE;
  const hasIssuedXeroInvoice = hasIssuedPrimaryXeroInvoice(booking);
  const remainingRefundableCents = getRemainingRefundableCents(booking.payment);

  const netAmountCents = priceDiffCents + changeFeeCents;
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
  const xeroRefundAmountCents =
    hasIssuedXeroInvoice && netAmountCents < 0
      ? hasSettledPayment
        ? selectedSettlement.amountCents
        : Math.abs(netAmountCents)
      : 0;
  const xeroAdditionalAmountCents =
    hasIssuedXeroInvoice && netAmountCents > 0 ? netAmountCents : 0;

  let refundAmountCents = 0;
  let accountCreditAmountCents = 0;
  let additionalAmountCents = 0;
  let pendingRefundAmountCents = 0;

  if (hasSettledPayment && booking.payment) {
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
      additionalAmountCents = hasSucceededPayment
        ? netAmountCents
        : xeroAdditionalAmountCents;
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

  return {
    refundAmountCents,
    accountCreditAmountCents,
    additionalAmountCents,
    pendingRefundAmountCents,
    hasSucceededPayment,
    hasIssuedXeroInvoice,
    xeroRefundAmountCents,
    xeroAdditionalAmountCents,
    settlementMethod: selectedSettlement.settlementMethod,
    policyRetainedAmountCents: selectedSettlement.policyRetainedAmountCents,
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
    guestsForPricing,
    skipBookingLifecycleRules,
    reviewUpdate,
  }: {
    booking: LoadedBookingForModify;
    bookingId: string;
    newCheckIn: Date;
    newFinalPriceCents: number;
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
  } else if (reviewUpdate?.releaseFromReview && newStatus === "AWAITING_REVIEW") {
    newStatus = "PAYMENT_PENDING";
  }

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
  if (!skipBookingLifecycleRules && isRepriceablePrePayment) {
    const appliedBeforeClamp = await deriveBookingAppliedCreditCents(
      bookingId,
      tx,
    );
    if (appliedBeforeClamp > 0) {
      const clamp = await clampAppliedCreditToBookingPrice(
        { memberId: booking.memberId, bookingId, newFinalPriceCents },
        tx,
      );
      appliedCreditCents = clamp.appliedCreditCents;
      refundedExcessCreditCents = clamp.refundedExcessCents;
    }
  }
  const effectivePriceCents = newFinalPriceCents - appliedCreditCents;

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
    // This is the one arm that can genuinely reach a settled booking with a live
    // election. A guest removal on a review-parked booking releases it from
    // AWAITING_REVIEW to PAYMENT_PENDING (above) with its election still stored,
    // and a removal that reprices the stay to nothing then lands it PAID right
    // here — without this line, on a row still advertising an outstanding
    // election that no consumer would ever look at again.
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
