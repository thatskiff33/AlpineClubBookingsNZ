// A payment-level credit note's recorded amount and kind, read from either
// shape its operation row can hold: the enqueue-time payload or the executed
// one. Moved out of `xero-operation-retry.ts` (#3635) so the retry replay and
// the resolved-in-Xero coverage fence read ONE answer to "how much did this
// note cover" (`INV-SSOT`).
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { asArray, asRecord, readNumber, readString } from "@/lib/xero-json";
import {
  XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE,
} from "@/lib/xero-operation-outbox-payload";
import { parseRefundMethod, readRefundNoteWording } from "@/lib/xero-refund-method";
import type { CashRefundMethod, RefundNoteWording } from "@/lib/xero-refund-method";

/**
 * `INV-PAY-101`: the refund method a stored payload carries, as the cash-refund
 * builders take it. Both the enqueue-time shape and the execution-time shape
 * record it under the same key; account credit never reaches a cash builder, so
 * it reads as "not carried" here and the builder falls back to the payment's
 * source.
 */
export function readCashRefundMethod(payload: Record<string, unknown> | null): CashRefundMethod | undefined {
  const method = parseRefundMethod(payload?.refundMethod);
  return method && method !== "account-credit" ? method : undefined;
}

export function parsePaymentCreditNoteRetryInput(
  operation: { requestPayload: unknown }
): {
  amountCents: number;
  kind: "refund" | "unapplied";
  /** `INV-PAY-101`: carried on both payload shapes; absent on pre-#3529 rows. */
  refundMethod?: CashRefundMethod;
  /**
   * F4 (#1354): present when the operation is a per-delta Stripe refund note.
   * The retry MUST re-enter delta mode — pre-#1354 it dropped the watermark,
   * fell into legacy single-note mode, and silently skipped as soon as ANY
   * refund note existed, reporting the swallowed delta as resolved. The
   * value itself is advisory: createXeroCreditNote recomputes coverage at
   * execution time.
   */
  watermarkCents?: number;
  /**
   * #3635 round-3 R4/R3: the late capture a refund note answers and the club
   * day its refund left Stripe, carried at the top level of both shapes.
   */
  paymentIntentId?: string;
  documentDate?: string;
  /** #3827 (D-3813-8): a refund request's own note, keyed by the request. */
  refundRequestId?: string;
  /** #3935 (`INV-PAY-116`): the officer's cash answer, carried on both shapes. */
  noteWording?: RefundNoteWording;
} | null {
  const payload = asRecord(operation.requestPayload);
  if (!payload) {
    return null;
  }

  // Queued payload shape (#1354): an operation that failed BEFORE the handler
  // overwrote requestPayload still carries the enqueue-time
  // {queueType, refundAmountCents[, watermarkCents]} — previously unparseable
  // here, leaving operator-reset operations permanently dead-ended.
  const queueType = typeof payload.queueType === "string" ? payload.queueType : null;
  const lateCapture = {
    ...(readString(payload.paymentIntentId) ? { paymentIntentId: readString(payload.paymentIntentId)! } : {}),
    ...(readString(payload.documentDate) ? { documentDate: readString(payload.documentDate)! } : {}),
    ...(readString(payload.refundRequestId) ? { refundRequestId: readString(payload.refundRequestId)! } : {}),
    ...(readRefundNoteWording(payload) ? { noteWording: readRefundNoteWording(payload)! } : {}),
  };
  const queuedRefundAmount = readNumber(payload.refundAmountCents);
  if (queueType === XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE && queuedRefundAmount !== null) {
    const queuedWatermark = readNumber(payload.watermarkCents);
    return {
      amountCents: Math.round(queuedRefundAmount),
      kind: "refund",
      // #3827 (D-3813-8): a refund request's own note carries no watermark and
      // must not be re-entered as a per-delta note.
      ...(readString(payload.refundRequestId)
        ? {}
        : { watermarkCents: queuedWatermark !== null ? Math.round(queuedWatermark) : 0 }),
      refundMethod: readCashRefundMethod(payload),
      ...lateCapture,
    };
  }
  if (queueType === XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE && queuedRefundAmount !== null) {
    return {
      amountCents: Math.round(queuedRefundAmount),
      kind: "unapplied",
    };
  }

  const allocation = asRecord(payload.allocation);
  const allocationAmountCents = providerAmountToCents(readNumber(allocation?.amount));
  if (allocationAmountCents !== null) {
    // #3880 F2: a delta run records its watermark on the Xero request shape
    // too, so a row it created inline (no queue type) retries in delta mode.
    const recordedWatermark = readNumber(payload.watermarkCents);
    return {
      amountCents: allocationAmountCents,
      kind: "refund",
      refundMethod: readCashRefundMethod(payload),
      ...(recordedWatermark !== null ? { watermarkCents: Math.round(recordedWatermark) } : {}),
      ...lateCapture,
    };
  }

  const creditNote = asRecord(asArray(payload.creditNotes)[0]);
  const lineItem = asRecord(creditNote ? asArray(creditNote.lineItems)[0] : null);
  const unitAmountCents = providerAmountToCents(readNumber(lineItem?.unitAmount));
  if (unitAmountCents === null) {
    return null;
  }

  return {
    amountCents: unitAmountCents,
    kind: "unapplied",
  };
}
