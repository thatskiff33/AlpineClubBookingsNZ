/** The note routing shared by charge.refunded and the recovery preflight. */
import type { Payment } from "@prisma/client";
import { findAdditionalCaptureReceiptInvoiceId } from "@/lib/additional-capture-receipt-link";
import { queueWebhookCardRefundNotes } from "@/lib/card-refund-own-note";
import { queueLateCaptureRefundCreditNote } from "@/lib/late-capture-refund-credit-note";
import { readUnrecordedLateCaptureRefund } from "@/lib/late-capture-unrecorded-refunds";
import { findLateCapturePaymentIntents } from "@/lib/late-capture-xero-receipt";

/** Keeps the webhook's existing boundary between routing and enqueue failures. */
export class RecordedCardRefundNoteEnqueueError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

export async function queueRecordedCardRefundNotes(params: {
  payment: Payment;
  paymentIntentId: string;
  deltaCents: number;
  refunds: Parameters<typeof queueWebhookCardRefundNotes>[0]["refunds"];
  newlyCountedRefundIds: readonly string[];
}): Promise<{ queueOperationId: string | null }> {
  if (params.deltaCents <= 0 && params.newlyCountedRefundIds.length === 0) return { queueOperationId: null };
  if ((await findLateCapturePaymentIntents([params.paymentIntentId])).has(params.paymentIntentId)) {
    await queueLateCaptureRefundCreditNote({ paymentId: params.payment.id, paymentIntentId: params.paymentIntentId });
    return { queueOperationId: null };
  }
  if ((await readUnrecordedLateCaptureRefund({
    paymentId: params.payment.id,
    paymentIntentId: params.paymentIntentId,
    refundedCents: params.deltaCents,
    refunds: params.refunds,
  })) !== "none") return { queueOperationId: null };
  try {
    const creditsInvoiceId = await findAdditionalCaptureReceiptInvoiceId(params.paymentIntentId);
    return await queueWebhookCardRefundNotes({
      payment: params.payment,
      deltaCents: params.deltaCents,
      refunds: params.refunds,
      newlyCountedRefundIds: params.newlyCountedRefundIds,
      ...(creditsInvoiceId ? { creditsInvoiceId } : {}),
    });
  } catch (error) {
    throw new RecordedCardRefundNoteEnqueueError(error);
  }
}
