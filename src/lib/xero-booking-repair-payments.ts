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

interface RepairPaymentTransaction {
  kind: PaymentTransactionKind;
  source: PaymentSource;
  stripePaymentIntentId: string | null;
  amountCents: number;
  refundedAmountCents: number;
  status: PaymentStatus;
  createdAt: Date;
}

const CAPTURED_REPAIR_PAYMENT_STATUSES = new Set<PaymentStatus>([
  PaymentStatus.SUCCEEDED,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
]);

const CANCELLABLE_REPAIR_PAYMENT_STATUSES = new Set<PaymentStatus>([
  PaymentStatus.PENDING,
  PaymentStatus.PROCESSING,
]);

function isCapturedRepairPaymentStatus(status: PaymentStatus) {
  return CAPTURED_REPAIR_PAYMENT_STATUSES.has(status);
}

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
    .filter((transaction) => isCapturedRepairPaymentStatus(transaction.status));
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
 *   * NO request row - the internet-banking route, or an intent that was never
 *     minted. Raise the invoice UNPAID.
 *   * A CAPTURED request - the member has paid. Record the payment, and do not
 *     wait for a confirmation that has already happened; a `WAITING_PAYMENT`
 *     operation queued after its own release ran would never be released.
 *   * An OUTSTANDING request with an intent - the ordinary card arrangement.
 *     Park the invoice on that intent, exactly as the live path does.
 *   * An OUTSTANDING request with NO intent - nothing to park on, so raise it
 *     unpaid and let an operator record the payment when the card clears. The
 *     live path refuses to queue at all here; a repair run that has found the
 *     invoice missing is later and better informed, and an unpaid invoice is
 *     recoverable where a false payment is not.
 */
export type EditReviewChargeInvoicePaymentPlan = {
  recordPayment: boolean;
  waitForConfirmedAdditionalPayment: boolean;
  paymentIntentId: string | null;
};

export function planEditReviewChargeInvoicePayment(
  payment: BookingPaymentRecord | null | undefined,
  bookingModificationId: string
): EditReviewChargeInvoicePaymentPlan {
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
    return {
      recordPayment: false,
      waitForConfirmedAdditionalPayment: false,
      paymentIntentId: null,
    };
  }

  if (isCapturedRepairPaymentStatus(request.status)) {
    return {
      recordPayment: true,
      waitForConfirmedAdditionalPayment: false,
      paymentIntentId: request.stripePaymentIntentId,
    };
  }

  if (request.stripePaymentIntentId) {
    return {
      recordPayment: true,
      waitForConfirmedAdditionalPayment: true,
      paymentIntentId: request.stripePaymentIntentId,
    };
  }

  return {
    recordPayment: false,
    waitForConfirmedAdditionalPayment: false,
    paymentIntentId: null,
  };
}
