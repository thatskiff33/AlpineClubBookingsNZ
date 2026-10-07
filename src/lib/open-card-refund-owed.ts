import type {
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
} from "@prisma/client";

import {
  getRemainingRefundableCents,
  type BookingPaymentState,
} from "@/lib/booking-payment-state";
import { isRecordedRefundStatus } from "@/lib/payment-transaction-status";
import type { RefundAllocationSlice } from "@/lib/payment-transactions";

/**
 * #3372 (owner, 7 Oct 2026: "count in both"): CARD REFUNDS STARTED BUT NOT YET
 * PAID BY STRIPE. A refund-type `PaymentRecoveryOperation` that has not
 * SUCCEEDED - pending, processing, or failed and waiting for a retry or a
 * person - is money the club has decided to send back to a card and has not
 * yet sent. It counts in "Refunds owed" and comes off Net Collected straight
 * away, like a refund owed by hand (`openHandBackOwedCents`).
 *
 * That covers a cancellation's card refund, an approved refund request's, an
 * edit's, an edit review's, a treasurer-approved late capture's, an organiser
 * child's (`INV-PAY-114`) and a superseded intent's (#3340). Plain module (a
 * type-only Prisma import), so a client page can import the module that reads it.
 */

/** The operation types that send money back to a card. */
export const CARD_REFUND_RECOVERY_OPERATION_TYPES = [
  "REFUND_BOOKING_MODIFICATION",
  "REFUND_SUPERSEDED_PAYMENT",
] as const satisfies readonly PaymentRecoveryOperationType[];

const SUCCEEDED = "SUCCEEDED" satisfies PaymentRecoveryOperationStatus;

/**
 * The unclosed card refunds, as a `PaymentRecoveryOperation` where clause.
 * "Unclosed" is every status but the terminal SUCCEEDED, so a status added
 * later counts as owed rather than silently dropping out.
 */
export const OPEN_CARD_REFUND_OPERATION_WHERE: {
  status: { not: PaymentRecoveryOperationStatus };
  type: { in: PaymentRecoveryOperationType[] };
} = {
  status: { not: SUCCEEDED },
  type: { in: [...CARD_REFUND_RECOVERY_OPERATION_TYPES] },
};

/** Parse a persisted allocation plan (#1097); null when absent or malformed. */
export function parseRefundAllocationPlan(
  value: unknown,
): RefundAllocationSlice[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const slices: RefundAllocationSlice[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const { paymentTransactionId, amountCents } = entry as Record<
      string,
      unknown
    >;
    if (
      typeof paymentTransactionId !== "string" ||
      !paymentTransactionId ||
      typeof amountCents !== "number" ||
      !Number.isInteger(amountCents) ||
      amountCents <= 0
    ) {
      return null;
    }
    slices.push({ paymentTransactionId, amountCents });
  }
  return slices;
}

/** A card refund operation, as the owed figure reads it. */
export interface CardRefundOperationRow {
  type: string;
  status: string;
  amountCents: number;
  allocationPlan: unknown;
  paymentTransactionId: string | null;
  createdAt: Date;
}

/** A refund recorded on the payment (`PaymentRefund`), as the net-out reads it. */
export interface RecordedCardRefundRow {
  paymentTransactionId: string | null;
  amountCents: number;
  status: string;
  createdAt: Date;
}

/** A payment as `openCardRefundOwedCents` reads it. */
export type CardRefundOwedPaymentRow = BookingPaymentState & {
  recoveryOperations: ReadonlyArray<CardRefundOperationRow>;
  refunds: ReadonlyArray<RecordedCardRefundRow>;
};

function isOpenCardRefundOperation(operation: CardRefundOperationRow): boolean {
  return (
    operation.status !== SUCCEEDED &&
    (CARD_REFUND_RECOVERY_OPERATION_TYPES as readonly string[]).includes(operation.type)
  );
}

/**
 * The slices an operation refunds: its frozen plan, or a superseded intent's
 * one transaction. A ledger refund with no plan yet has sent nothing (the plan
 * is persisted before its first Stripe call), so it has no slices to net.
 */
function operationSlices(operation: CardRefundOperationRow): RefundAllocationSlice[] {
  const plan = parseRefundAllocationPlan(operation.allocationPlan);
  if (plan) return plan;
  if (operation.type === "REFUND_SUPERSEDED_PAYMENT" && operation.paymentTransactionId) {
    return [{ paymentTransactionId: operation.paymentTransactionId, amountCents: operation.amountCents }];
  }
  return [];
}

/**
 * What one payment still owes back by card, in cents.
 *
 * NET OF WHAT IS ALREADY RECORDED. A refund's `PaymentRefund` row and its
 * `refundedAmountCents` are written slice by slice, BEFORE the operation is
 * closed (`refundPaymentTransactions`, then `completePaymentRecoveryOperation`),
 * and a partial failure leaves the operation open with some slices sent. So each
 * slice is netted against the refunds recorded on its transaction since the
 * operation was raised, each refund row used once, oldest operation first. A
 * refund made by hand in the Stripe dashboard for a dead operation reaches the
 * same row through `charge.refunded`, so it nets out too.
 *
 * CAPPED PER PAYMENT at what the payment still holds
 * (`getRemainingRefundableCents`): money cannot be owed back from a payment
 * that no longer has it.
 */
export function openCardRefundOwedCents(payment: CardRefundOwedPaymentRow): number {
  const operations = payment.recoveryOperations
    .filter(isOpenCardRefundOperation)
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  if (operations.length === 0) return 0;
  const used = new Set<RecordedCardRefundRow>();
  const recorded = payment.refunds.filter((refund) => isRecordedRefundStatus(refund.status));
  let owedCents = 0;
  for (const operation of operations) {
    let nettedCents = 0;
    for (const slice of operationSlices(operation)) {
      let sliceNetCents = 0;
      for (const refund of recorded) {
        if (sliceNetCents >= slice.amountCents) break;
        if (
          used.has(refund) ||
          refund.paymentTransactionId !== slice.paymentTransactionId ||
          refund.createdAt.getTime() < operation.createdAt.getTime()
        ) {
          continue;
        }
        used.add(refund);
        sliceNetCents += Math.max(0, refund.amountCents);
      }
      nettedCents += Math.min(sliceNetCents, slice.amountCents);
    }
    owedCents += Math.max(0, operation.amountCents - nettedCents);
  }
  return Math.min(owedCents, getRemainingRefundableCents(payment));
}
