// Repair-payment transaction derivation (ledger + legacy fallback) for the
// booking-vs-Xero repair tool. Extracted verbatim from xero-booking-repair.ts
// (#1208 item 2). Money stays in integer cents.
import {
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
} from "@prisma/client";
import type { BookingPaymentRecord } from "./xero-booking-repair-types";
import { isEditReviewChargeRequestRow } from "@/lib/edit-financial-review-charge-shape";
import { isCapturedTransactionStatus } from "@/lib/payment-transactions";

interface RepairPaymentTransaction {
  kind: PaymentTransactionKind;
  source: PaymentSource;
  stripePaymentIntentId: string | null;
  amountCents: number;
  refundedAmountCents: number;
  status: PaymentStatus;
  createdAt: Date;
}

const CANCELLABLE_REPAIR_PAYMENT_STATUSES = new Set<PaymentStatus>([
  PaymentStatus.PENDING,
  PaymentStatus.PROCESSING,
]);

/**
 * "Captured" is `isCapturedTransactionStatus` (`payment-transactions.ts`), the
 * same predicate the live settlement's own guards ask (`INV-SSOT`).
 *
 * This module used to carry a byte-identical private `Set` of its own. The
 * duplication was harmless while it only decided which rows to *report*; #3187
 * made it decide whether the repair tool asserts a Stripe PAYMENT, and two
 * spellings of "the member has paid" — one in the accounting leg, one in the
 * tool that audits it — is exactly the pair that comes to disagree silently, in
 * a report an operator trusts. `payment-transactions.ts` carries no
 * `server-only`, so `cli-server-only-reach-census.test.ts` is satisfied and the
 * operator CLI still starts.
 */

function mapLegacyAdditionalPaymentStatus(
  status: string | null | undefined
): PaymentStatus {
  switch (status) {
    case "FAILED":
      return PaymentStatus.FAILED;
    case "SUCCEEDED":
      return PaymentStatus.SUCCEEDED;
    case "PROCESSING":
      return PaymentStatus.PROCESSING;
    case "PENDING":
    default:
      return PaymentStatus.PENDING;
  }
}

// The repair pass's legacy-fallback status synthesis: when a payment has no
// ledger rows, its captured/refunded state is derived from the aggregate
// refund mirror (#1208 item 2). Exported so the #1506 cancel-flatten backfill
// restores the exact captured status this read path already synthesizes,
// rather than duplicating the derivation.
export function applyLegacyRefundStatus(
  baseStatus: PaymentStatus,
  amountCents: number,
  refundedAmountCents: number
) {
  if (amountCents > 0 && refundedAmountCents >= amountCents) {
    return PaymentStatus.REFUNDED;
  }

  if (refundedAmountCents > 0) {
    return PaymentStatus.PARTIALLY_REFUNDED;
  }

  return baseStatus;
}

function buildRepairPaymentTransactions(
  payment: BookingPaymentRecord | null | undefined
): RepairPaymentTransaction[] {
  if (!payment) {
    return [];
  }

  const ledgerTransactions = (payment.transactions ?? []).map(
    (transaction): RepairPaymentTransaction => ({
      kind: transaction.kind,
      source: transaction.source,
      stripePaymentIntentId: transaction.stripePaymentIntentId,
      amountCents: transaction.amountCents,
      refundedAmountCents: transaction.refundedAmountCents,
      status: transaction.status,
      createdAt: transaction.createdAt,
    })
  );

  if (ledgerTransactions.length > 0) {
    return ledgerTransactions;
  }

  const legacyTransactions: RepairPaymentTransaction[] = [];
  const additionalStatus = mapLegacyAdditionalPaymentStatus(
    payment.additionalPaymentStatus
  );
  const additionalCapturedAmountCents =
    payment.additionalPaymentIntentId &&
    additionalStatus === PaymentStatus.SUCCEEDED
      ? payment.additionalAmountCents
      : 0;
  const primaryAmountCents = payment.stripePaymentIntentId
    ? Math.max(payment.amountCents - additionalCapturedAmountCents, 0)
    : payment.amountCents;
  const additionalRefundedAmountCents =
    payment.additionalPaymentIntentId &&
    additionalStatus === PaymentStatus.SUCCEEDED
      ? Math.min(
          Math.max(payment.refundedAmountCents - primaryAmountCents, 0),
          payment.additionalAmountCents
        )
      : 0;
  const primaryRefundedAmountCents = payment.stripePaymentIntentId
    ? Math.min(
        Math.max(payment.refundedAmountCents - additionalRefundedAmountCents, 0),
        primaryAmountCents
      )
    : 0;

  if (payment.stripePaymentIntentId) {
    legacyTransactions.push({
      kind: PaymentTransactionKind.PRIMARY,
      source: PaymentSource.STRIPE,
      stripePaymentIntentId: payment.stripePaymentIntentId,
      amountCents: primaryAmountCents,
      refundedAmountCents: primaryRefundedAmountCents,
      status: applyLegacyRefundStatus(
        payment.status,
        primaryAmountCents,
        primaryRefundedAmountCents
      ),
      createdAt: payment.createdAt,
    });
  }

  if (payment.additionalPaymentIntentId) {
    legacyTransactions.push({
      kind: PaymentTransactionKind.ADDITIONAL,
      source: PaymentSource.STRIPE,
      stripePaymentIntentId: payment.additionalPaymentIntentId,
      amountCents: payment.additionalAmountCents,
      refundedAmountCents: additionalRefundedAmountCents,
      status: applyLegacyRefundStatus(
        additionalStatus,
        payment.additionalAmountCents,
        additionalRefundedAmountCents
      ),
      createdAt:
        payment.updatedAt.getTime() >= payment.createdAt.getTime()
          ? payment.updatedAt
          : payment.createdAt,
    });
  }

  return legacyTransactions;
}

function isStripeRepairPaymentTransaction(
  transaction: RepairPaymentTransaction
): transaction is RepairPaymentTransaction & {
  source: typeof PaymentSource.STRIPE;
  stripePaymentIntentId: string;
} {
  return (
    transaction.source === PaymentSource.STRIPE &&
    Boolean(transaction.stripePaymentIntentId)
  );
}

export function getOutstandingRepairTransactions(
  payment: BookingPaymentRecord | null | undefined
) {
  return buildRepairPaymentTransactions(payment)
    .filter(isStripeRepairPaymentTransaction)
    .filter((transaction) =>
      CANCELLABLE_REPAIR_PAYMENT_STATUSES.has(transaction.status)
    );
}

export function getCapturedRepairTransactions(
  payment: BookingPaymentRecord | null | undefined
) {
  return buildRepairPaymentTransactions(payment)
    .filter(isStripeRepairPaymentTransaction)
    .filter((transaction) => isCapturedTransactionStatus(transaction.status));
}

export function getOutstandingCapturedRefundAmountCents(
  payment: BookingPaymentRecord | null | undefined
) {
  return getCapturedRepairTransactions(payment).reduce((sum, transaction) => {
    return sum + Math.max(transaction.amountCents - transaction.refundedAmountCents, 0);
  }, 0);
}


/**
 * HOW A REPAIRED FINANCIAL-REVIEW INVOICE MUST TREAT PAYMENT (#3187).
 *
 * `enqueueXeroSupplementaryInvoiceOperation` defaults `recordPayment` to TRUE,
 * because its original caller captured the member's card BEFORE queueing. That
 * default is wrong for a completed financial review, and wrong in the dangerous
 * direction: on the internet-banking route the supplementary invoice IS the ask
 * and nothing has been paid, so recording a Stripe bank payment against it would
 * assert money the club does not hold and quietly break bank reconciliation.
 * Queueing a repair invoice that lies about payment is worse than queueing none.
 *
 * So the plan is derived the way the live settlement derives it
 * (`xero-booking-edit-settlement.ts` -> `recordPayment: requiresAdditionalStripePayment
 * ? Boolean(waitForPaymentIntentId) : false`), from the ONE ledger row that is
 * this edit's combined charge request:
 *
 *   * NO request row and NO open intent-mint recovery - the internet-banking
 *     route, where the invoice IS the ask. Raise it UNPAID.
 *   * NO request row but an OPEN intent-mint recovery - the mint failed at the
 *     provider and the replay is still owed. DEFER: see below.
 *   * A CAPTURED request for AT LEAST the ask - the member has paid it. Record
 *     the payment, and do not wait for a confirmation that has already
 *     happened; a `WAITING_PAYMENT` operation queued after its own release ran
 *     would never be released.
 *   * A CAPTURED request for LESS than the ask - a shortfall, not a receipt.
 *     Manual review: see below.
 *   * An OUTSTANDING request with an intent - the ordinary card arrangement.
 *     Park the invoice on that intent, exactly as the live path does. This is
 *     the one arm whose answer can go stale between here and the enqueue; see
 *     "the member who pays mid-sweep" below.
 *   * An OUTSTANDING request with NO intent - nothing to park on, so raise it
 *     unpaid and let an operator record the payment when the card clears. The
 *     live path refuses to queue at all here; a repair run that has found the
 *     invoice missing is later and better informed, and an unpaid invoice is
 *     recoverable where a false payment is not.
 *
 * ## Why a CAPTURED request is not on its own permission to record payment
 *
 * The worker books the invoice's OWN net as the Stripe receipt
 * (`xero-supplementary-invoices.ts`: `amount: netAmountCents / 100`), not the
 * amount the card actually took. So "captured" has to mean captured FOR THIS
 * ASK, and the two come apart for a reason this epic designed in: two review
 * shares, the first settling and minting a request, the member paying it in the
 * window before the second share syncs. The second share's sync returns
 * `already-paid` and records the uncollected difference as an audit row - both
 * tasks are COMPLETED, so the ask derives to the combined total while the
 * ledger row is SUCCEEDED at the first share's figure alone. Recording payment
 * there would overstate the Stripe clearing account by the difference and show
 * an invoice paid in full that the member still owes money on.
 *
 * That difference IS the shortfall #3187 exists to surface, so it goes to a
 * person rather than to the queue. Note the comparison is against the CAPTURED
 * amount and ignores any later refund: a refunded charge was still paid, and
 * Xero settles the reversal through the credit-note leg, not by unsaying the
 * payment.
 *
 * ## Why a failed intent mint DEFERS instead of raising an unpaid invoice
 *
 * "No request row" has two causes and they need opposite handling. On the
 * internet-banking route nothing was ever going to be minted. On the card route
 * a mint that failed at the provider writes a `PaymentRecoveryOperation` under
 * the edit-scoped key and leaves the debt for the replay - and the live path
 * queues NOTHING at all in that state
 * (`xero-booking-edit-settlement.ts`: "Deferred, not short"). Raising an unpaid
 * invoice on top of it would claim the anchor the replay is about to use, and
 * nothing would ever mark that invoice paid once the member's card cleared:
 * `releaseXeroSupplementaryInvoiceOperationsForPaymentIntent` only touches
 * `WAITING_PAYMENT` operations, and this one would be long COMPLETED. Xero
 * would read unpaid permanently, the Stripe clearing account would be short,
 * and the next repair run would see a matching amount and report nothing.
 *
 * ## The member who pays mid-sweep, and why the answer is not here (#3187 fix
 * round)
 *
 * Every branch above is decided from the snapshot the sweep's loader took when
 * the pass STARTED; the enqueue happens minutes later. So a request that reads
 * PENDING here can be captured by the time the invoice is queued, and this
 * function's own warning then bites the arm that wrote it: the release runs from
 * the webhook, finds no `WAITING_PAYMENT` row because none exists yet, and the
 * sweep then parks one on an intent whose confirmation has already been and
 * gone. The 14-day reaper is the only thing that ever clears it, and until then
 * the next run reads the anchor as `BLOCKED_BY_XERO_OPERATION` - warning, not
 * auto-appliable, "waiting for its additional Stripe payment" - so the tool
 * conceals the very finding it exists to raise. This window is not the live
 * path's millisecond one: the sweep acts on requests outstanding for DAYS, so a
 * member paying inside it is the ordinary case, not the exotic one.
 *
 * Re-reading here, just before the enqueue, would only NARROW that window -
 * check-then-write always leaves one. `xero-booking-repair-passes.ts` therefore
 * re-reads AFTER the enqueue and releases the row itself, which leaves no window
 * at all: the row the webhook's release needs already exists before anybody
 * looks at the capture, so whichever of the two observes it first, one of them
 * releases it. It releases only on `covers-ask`, through the same
 * `classifyEditReviewChargeCapture` this function asks, because releasing a
 * `short-of-ask` capture would book the full net as received - the exact
 * overstatement the section above refuses.
 */
/**
 * WHAT THIS EDIT'S CHARGE REQUEST SAYS ABOUT THE ASK, as one predicate (#3187
 * fix round).
 *
 * It is asked TWICE and the two must never diverge: once by
 * `planEditReviewChargeInvoicePayment` from the sweep's loaded snapshot, and
 * once by `xero-booking-repair-passes.ts` from a fresh read taken AFTER the
 * invoice has been queued, to catch a member who paid mid-sweep. Two spellings
 * of "the card covered this ask" - one deciding whether to record a payment, one
 * deciding whether to release a parked invoice - is exactly the pair that comes
 * to disagree silently, in the accounting leg (`INV-SSOT`).
 *
 * `short-of-ask` is a distinct answer rather than folded into `not-captured`
 * because the two demand opposite handling: a card that took LESS than the
 * officer settled on must never have its invoice released, and must never be
 * reported as merely unpaid.
 */
export type EditReviewChargeCaptureState =
  | "covers-ask"
  | "short-of-ask"
  | "not-captured";

export function classifyEditReviewChargeCapture(
  request: { status: PaymentStatus; amountCents: number },
  expectedNetAmountCents: number
): EditReviewChargeCaptureState {
  if (!isCapturedTransactionStatus(request.status)) {
    return "not-captured";
  }

  return request.amountCents < expectedNetAmountCents
    ? "short-of-ask"
    : "covers-ask";
}

export type EditReviewChargeInvoicePaymentPlan =
  | {
      outcome: "queue";
      recordPayment: boolean;
      waitForConfirmedAdditionalPayment: boolean;
      paymentIntentId: string | null;
    }
  | {
      outcome: "manual-review";
      reason: "capture-short-of-ask" | "intent-mint-awaiting-recovery";
      capturedAmountCents: number | null;
    };

export function planEditReviewChargeInvoicePayment({
  payment,
  bookingModificationId,
  expectedNetAmountCents,
  hasOpenIntentMintRecovery,
}: {
  payment: BookingPaymentRecord | null | undefined;
  bookingModificationId: string;
  /** What the repaired invoice would bill - and therefore book as received. */
  expectedNetAmountCents: number;
  /** An open edit-scoped `CREATE_ADDITIONAL_PAYMENT_INTENT` recovery row. */
  hasOpenIntentMintRecovery: boolean;
}): EditReviewChargeInvoicePaymentPlan {
  // Newest first, matching `findEditReviewChargeRequest`'s own
  // `orderBy: { createdAt: "desc" }` rather than trusting the select's order.
  const request =
    (payment?.transactions ?? [])
      .filter((transaction) =>
        isEditReviewChargeRequestRow(transaction, bookingModificationId)
      )
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ??
    null;

  if (!request) {
    if (hasOpenIntentMintRecovery) {
      return {
        outcome: "manual-review",
        reason: "intent-mint-awaiting-recovery",
        capturedAmountCents: null,
      };
    }

    return {
      outcome: "queue",
      recordPayment: false,
      waitForConfirmedAdditionalPayment: false,
      paymentIntentId: null,
    };
  }

  const capture = classifyEditReviewChargeCapture(request, expectedNetAmountCents);

  if (capture === "short-of-ask") {
    return {
      outcome: "manual-review",
      reason: "capture-short-of-ask",
      capturedAmountCents: request.amountCents,
    };
  }

  if (capture === "covers-ask") {
    return {
      outcome: "queue",
      recordPayment: true,
      waitForConfirmedAdditionalPayment: false,
      paymentIntentId: request.stripePaymentIntentId,
    };
  }

  if (request.stripePaymentIntentId) {
    return {
      outcome: "queue",
      recordPayment: true,
      waitForConfirmedAdditionalPayment: true,
      paymentIntentId: request.stripePaymentIntentId,
    };
  }

  return {
    outcome: "queue",
    recordPayment: false,
    waitForConfirmedAdditionalPayment: false,
    paymentIntentId: null,
  };
}
