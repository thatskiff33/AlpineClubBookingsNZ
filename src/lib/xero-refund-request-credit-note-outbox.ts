import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { refundRequestCreditNoteKey } from "@/lib/xero-credit-notes";
import { XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE } from "@/lib/xero-operation-outbox-payload";
import { readResolvedRefundCreditNoteCoverage } from "@/lib/xero-resolved-in-xero-fences";
import { startXeroSyncOperation } from "@/lib/xero-sync";

/**
 * #3827, owner decision D-3813-8 (`INV-PAY-116`): queue a refund request's
 * OWN Xero refund credit note, for exactly the amount the treasurer paid back,
 * when its refund task is marked paid back - after the money has moved.
 *
 * ONE NOTE PER REQUEST, keyed by the request (`refundRequestCreditNoteKey`),
 * never by the payment or the amount: a second request on the same payment
 * gets its own note, and a replay of this request's completion finds this
 * request's row - whatever its status - and queues nothing. The note is not a
 * per-delta Stripe note (no watermark) and never takes the payment's one
 * refund-note pointer (`refund-request-credit-note.ts`). A note an officer
 * raised and resolved by hand in Xero under this key is honoured as for any
 * refund note (`INV-INT-025`).
 */
export async function enqueueXeroRefundRequestCreditNoteOperation(params: {
  paymentId: string;
  refundRequestId: string;
  amountCents: number;
  createdByMemberId?: string;
  store?: Prisma.TransactionClient;
}): Promise<{ queueOperationId: string | null; message: string }> {
  const { paymentId, refundRequestId, amountCents } = params;
  const db = params.store ?? prisma;
  if (amountCents <= 0) {
    return { queueOperationId: null, message: "No refund was paid back, so no credit note is required." };
  }
  const correlationKey = refundRequestCreditNoteKey(paymentId, refundRequestId);

  const resolvedCoverage = await readResolvedRefundCreditNoteCoverage(paymentId, db);
  if (resolvedCoverage.correlationKeys.includes(correlationKey)) {
    return {
      queueOperationId: null,
      message: "An officer resolved this refund request's Xero credit note by hand in Xero, so no new note is queued.",
    };
  }

  const existing = await db.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: paymentId,
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (existing) {
    return {
      queueOperationId: existing.id,
      message: "This refund request's Xero credit note is already queued or raised.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "CREDIT_NOTE",
    operationType: "CREATE",
    localModel: "Payment",
    localId: paymentId,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE,
      refundAmountCents: amountCents,
      refundMethod: "internet-banking",
      refundRequestId,
    },
    createdByMemberId: params.createdByMemberId ?? null,
    store: db,
  });
  return {
    queueOperationId: queuedOperation.id,
    message: "This refund request's Xero credit note is queued for background processing.",
  };
}
