// Repair-payment transaction derivation (ledger + legacy fallback) for the
// booking-vs-Xero repair tool. Extracted verbatim from xero-booking-repair.ts
// (#1208 item 2). Money stays in integer cents.
import {
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
} from "@prisma/client";
import type { BookingPaymentRecord } from "./xero-booking-repair-types";
import { captureChangeId } from "@/lib/additional-capture-receipt-link";
import {
  editReviewChargeRequestCriteria,
  isEditReviewChargeRequestRow,
} from "@/lib/edit-financial-review-charge-shape";
import { compareLedgerRowsNewestFirst } from "@/lib/payment-ledger-order";
import { buildEditFinancialReviewChargeReason } from "@/lib/payment-recovery-keys";
import { isCapturedTransactionStatus } from "@/lib/payment-transactions";
import { hasCapturedPayment } from "@/lib/booking-payment-state";

interface RepairPaymentTransaction {
  /** The ledger row's id; null for a legacy payment's reconstructed slice. */
  id: string | null;
  kind: PaymentTransactionKind;
  source: PaymentSource;
  stripePaymentIntentId: string | null;
  amountCents: number;
  refundedAmountCents: number;
  status: PaymentStatus;
  createdAt: Date;
  /** #4132: the ledger's tiebreak; a legacy slice is numbered in the order it is reconstructed. */
  insertionSeq: number;
}

const CANCELLABLE_REPAIR_PAYMENT_STATUSES = new Set<PaymentStatus>([
  PaymentStatus.PENDING,
  PaymentStatus.PROCESSING,
]);

/**
 * "Captured" is `isCapturedTransactionStatus` (`payment-transaction-status.ts`), the
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
      id: transaction.id,
      kind: transaction.kind,
      source: transaction.source,
      stripePaymentIntentId: transaction.stripePaymentIntentId,
      amountCents: transaction.amountCents,
      refundedAmountCents: transaction.refundedAmountCents,
      status: transaction.status,
      createdAt: transaction.createdAt,
      insertionSeq: transaction.insertionSeq,
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
      id: null,
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
      insertionSeq: 0,
    });
  }

  if (payment.additionalPaymentIntentId) {
    legacyTransactions.push({
      id: null,
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
      insertionSeq: 1,
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

/**
 * #3639: "was money ever captured on this payment?" — asked of EVERY source.
 *
 * `getCapturedRepairTransactions` above keeps its Stripe-only filter because
 * its rows feed Stripe cancel and refund calls, which an internet-banking row
 * (no intent id) must never reach (#668). But "was this booking ever paid?" is
 * a different question, and answering it from that list made a cancelled
 * booking paid by bank transfer look never-paid, so the cancelled-open-invoice
 * arm queued a full clearing note against an invoice the member had paid.
 *
 * The same SHAPE as the modification arm's test (the aggregate status OR the
 * ledger) but NOT the same test: that arm keeps its ledger half Stripe-only
 * because it routes a card refund, and a bank-transfer row must not reach one.
 * Here the ledger half is unfiltered by source: the aggregate covers a
 * pre-ledger payment with no rows, and the ledger covers a capture row sitting
 * under a still-PENDING aggregate.
 */
export function hasCapturedRepairPayment(
  payment: BookingPaymentRecord | null | undefined
): boolean {
  return (
    hasCapturedPayment(payment) ||
    buildRepairPaymentTransactions(payment).some((transaction) =>
      isCapturedTransactionStatus(transaction.status)
    )
  );
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
 * this edit's charge request. A review-priced edit's row is its review charge
 * (`isEditReviewChargeRequestRow`). An ordinary price increase's row is the
 * newest Stripe ADDITIONAL request `captureChangeId` attributes to the edit
 * (#4413). The booking's aggregate paid status, the legacy additional-payment
 * mirror, and a capture that names no edit are not evidence this invoice was
 * paid: an old unattributed capture keeps the receipt path (`INV-PAY-139`).
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
 * `planSupplementaryInvoicePayment` from the sweep's loaded snapshot, and
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
    }
  | {
      /**
       * #3528 (`INV-ADDPAY-040`): the newest request for this edit was
       * WITHDRAWN by an officer. The money is no longer asked for, so no
       * invoice is missing - the classifier raises nothing, rather than
       * parking a fresh supplementary invoice on a cancelled intent.
       */
      outcome: "withdrawn";
      withdrawnAt: Date;
    };

/** Which request a repaired supplementary invoice reads. A review-priced edit keeps its review charge; an ordinary edit reads the Stripe request attributed to it. */
export type SupplementaryInvoiceChargeKind = "review" | "ordinary";

/**
 * The ledger row a repaired supplementary invoice may treat as its card ask.
 * Review matching stays `isEditReviewChargeRequestRow`. An ordinary edit is a
 * Stripe ADDITIONAL request `captureChangeId` attributes to this edit — the
 * stamp, or a review charge whose reason names the edit and carries no stamp.
 */
function isSupplementaryInvoiceChargeRequestRow(
  row: {
    kind: PaymentTransactionKind;
    source: PaymentSource;
    reason: string | null;
    bookingModificationId: string | null;
  },
  bookingModificationId: string,
  chargeKind: SupplementaryInvoiceChargeKind,
): boolean {
  if (chargeKind === "review") return isEditReviewChargeRequestRow(row, bookingModificationId);
  return (
    row.kind === PaymentTransactionKind.ADDITIONAL &&
    row.source === PaymentSource.STRIPE &&
    captureChangeId(row) === bookingModificationId
  );
}

/**
 * The same row, as a query. The ordinary arm is `captureChangeId`: the stamp
 * wins, and a null stamp falls through to the review-charge reason. The two
 * spellings decide the same request — one at classify time, one on the fresh
 * read after enqueue (`INV-SSOT`).
 */
export function supplementaryInvoiceChargeRequestWhere(
  bookingModificationId: string,
  chargeKind: SupplementaryInvoiceChargeKind,
) {
  if (chargeKind === "review") return editReviewChargeRequestCriteria(bookingModificationId);
  return {
    kind: PaymentTransactionKind.ADDITIONAL,
    source: PaymentSource.STRIPE,
    OR: [
      { bookingModificationId },
      {
        bookingModificationId: null,
        reason: buildEditFinancialReviewChargeReason(bookingModificationId),
      },
    ],
  };
}

export function missingSupplementaryInvoiceManualReviewSummary(
  reason: "capture-short-of-ask" | "intent-mint-awaiting-recovery",
  chargeKind: SupplementaryInvoiceChargeKind,
): string {
  if (chargeKind === "review") {
    return reason === "capture-short-of-ask"
      ? "A completed financial review priced this booking edit above what the member's card actually took, and no supplementary Xero invoice exists - the difference is owed outside any invoice, so raise it by hand."
      : "A completed financial review priced this booking edit as money owed, but its card request has not been raised yet and its recovery is still owed - no supplementary Xero invoice can be raised until that replay runs.";
  }
  return reason === "capture-short-of-ask"
    ? "This booking edit's card took less than the supplementary invoice would record, and no supplementary Xero invoice exists. The difference is owed outside any invoice, so raise it by hand."
    : "This booking edit is money owed, but its card request has not been raised yet and its recovery is still owed. No supplementary Xero invoice can be raised until that replay runs.";
}

type SupplementaryInvoiceChargePayment = {
  transactions: ReadonlyArray<{
    kind: PaymentTransactionKind;
    source: PaymentSource;
    reason: string | null;
    bookingModificationId: string | null;
    stripePaymentIntentId: string | null;
    amountCents: number;
    status: PaymentStatus;
    withdrawnAt: Date | null;
    createdAt: Date;
    insertionSeq: number;
  }>;
};

export function planSupplementaryInvoicePayment({
  payment,
  bookingModificationId,
  expectedNetAmountCents,
  hasOpenIntentMintRecovery,
  chargeKind,
}: {
  payment: SupplementaryInvoiceChargePayment | null | undefined;
  bookingModificationId: string;
  /** What the repaired invoice would bill - and therefore book as received. */
  expectedNetAmountCents: number;
  /** An open edit-scoped `CREATE_ADDITIONAL_PAYMENT_INTENT` recovery row. */
  hasOpenIntentMintRecovery: boolean;
  chargeKind: SupplementaryInvoiceChargeKind;
}): EditReviewChargeInvoicePaymentPlan {
  // Newest first, and on a tie the row inserted last, matching
  // `findEditReviewChargeRequest`'s own `LEDGER_ROWS_NEWEST_FIRST` rather than
  // trusting the select's order (#4132).
  const request =
    (payment?.transactions ?? [])
      .filter((transaction) =>
        isSupplementaryInvoiceChargeRequestRow(transaction, bookingModificationId, chargeKind)
      )
      .sort(compareLedgerRowsNewestFirst)[0] ??
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

  if (request.withdrawnAt) {
    return { outcome: "withdrawn", withdrawnAt: request.withdrawnAt };
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
