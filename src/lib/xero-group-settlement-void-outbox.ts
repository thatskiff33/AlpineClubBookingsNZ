import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { startXeroSyncOperation } from "@/lib/xero-sync";
import { XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_VOID_TYPE } from "@/lib/xero-operation-outbox-payload";
import {
  groupSettlementInvoiceLink,
  groupSettlementInvoiceVoidKey,
} from "@/lib/xero-group-settlement-invoice-outbox";

/**
 * The one VOID enqueue both reasons share: an invoice-specific correlation key
 * plus the active-row pre-check make every observer of one invoice land on one
 * replayable UPDATE row. Only the key's reason and the payload differ — the
 * abandon VOID names its invoice, because the abandoning transaction clears the
 * settlement's pointer in the same commit; the cancellation VOID reads it off
 * the settlement, whose pointer it leaves in place.
 */
async function enqueueGroupSettlementInvoiceVoid(
  db: Prisma.TransactionClient | typeof prisma,
  params: {
    settlementId: string;
    xeroInvoiceId: string;
    after: "cancel" | "abandon";
    createdByMemberId?: string;
    store?: Prisma.TransactionClient;
  }
) {
  const correlationKey = groupSettlementInvoiceVoidKey(
    params.settlementId,
    params.xeroInvoiceId,
    params.after
  );
  const existing = await db.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "UPDATE",
      localModel: "GroupBookingSettlement",
      localId: params.settlementId,
      status: { in: ["PENDING", "RUNNING", "WAITING_PAYMENT"] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    return {
      queueOperationId: existing.id,
      message: "Xero group invoice VOID is already queued.",
    };
  }

  const operation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "UPDATE",
    localModel: "GroupBookingSettlement",
    localId: params.settlementId,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_VOID_TYPE,
      settlementId: params.settlementId,
      ...(params.after === "abandon" ? { xeroInvoiceId: params.xeroInvoiceId } : {}),
    },
    createdByMemberId: params.createdByMemberId ?? null,
    store: params.store,
  });
  return {
    queueOperationId: operation.id,
    message: "Xero group invoice VOID queued for background processing.",
  };
}

/**
 * Persist the compensating VOID debt for a cancelled combined group invoice.
 *
 * This is deliberately independent of the original CREATE operation: that row
 * may already be SUCCEEDED when the organiser later cancels.  The active
 * correlation-key partial index and the pre-check make concurrent
 * cancellation/worker observations converge on one replayable UPDATE row.
 */
export async function enqueueXeroGroupSettlementInvoiceVoidOperation(
  settlementId: string,
  options?: {
    createdByMemberId?: string;
    store?: Prisma.TransactionClient;
  }
) {
  const db = options?.store ?? prisma;
  const settlement = await db.groupBookingSettlement.findUnique({
    where: { id: settlementId },
    select: {
      id: true,
      xeroInvoiceId: true,
      groupBooking: { select: { status: true } },
    },
  });
  if (!settlement) {
    throw new Error(`Group settlement not found: ${settlementId}`);
  }
  if (settlement.groupBooking.status !== "CANCELLED") {
    return { queueOperationId: null, message: "Group is not cancelled." };
  }
  if (!settlement.xeroInvoiceId) {
    return {
      queueOperationId: null,
      message: "Cancelled group has no persisted Xero invoice to void.",
    };
  }
  return enqueueGroupSettlementInvoiceVoid(db, {
    settlementId: settlement.id,
    xeroInvoiceId: settlement.xeroInvoiceId,
    after: "cancel",
    createdByMemberId: options?.createdByMemberId,
    store: options?.store,
  });
}

/**
 * #3642 (`INV-PAY-105`): persist the VOID debt for a combined group invoice the
 * settlement has ABANDONED while the group itself stays live — the reaper
 * released the settlement, the organiser's group changed and the invoice was
 * replaced, or a create finished after its attempt was superseded. The group is
 * not cancelled, so the cancellation VOID above refuses it.
 */
export async function enqueueXeroGroupSettlementInvoiceAbandonVoidOperation(
  settlementId: string,
  xeroInvoiceId: string,
  options: {
    createdByMemberId?: string;
    store: Prisma.TransactionClient;
  }
) {
  return enqueueGroupSettlementInvoiceVoid(options.store, {
    settlementId,
    xeroInvoiceId,
    after: "abandon",
    createdByMemberId: options.createdByMemberId,
    store: options.store,
  });
}

/**
 * Retire an invoice the settlement has abandoned, inside the caller's `lock(1)`
 * transaction: queue its replayable VOID, drop the settlement's pointer to it,
 * and deactivate its object link. The link row itself is kept — the inbound
 * reconciliation reads it to recognise a payment that still lands on the
 * abandoned invoice.
 *
 * The active link is written in the same `lock(1)` transaction as the pointer
 * (#3642), so this step always sees it.
 *
 * `preserveUpdatedAt` keeps the settlement's clock where it was: the reaper's
 * expiry phase measures its second window from `updatedAt`, so a pass that only
 * retires a legacy invoice must not restart it.
 */
export async function abandonGroupSettlementInvoiceInTx(
  tx: Prisma.TransactionClient,
  params: {
    settlementId: string;
    xeroInvoiceId: string;
    preserveUpdatedAt?: Date;
  }
): Promise<void> {
  await enqueueXeroGroupSettlementInvoiceAbandonVoidOperation(
    params.settlementId,
    params.xeroInvoiceId,
    { store: tx }
  );
  await tx.groupBookingSettlement.updateMany({
    where: { id: params.settlementId, xeroInvoiceId: params.xeroInvoiceId },
    data: {
      xeroInvoiceId: null,
      xeroInvoiceNumber: null,
      ...(params.preserveUpdatedAt ? { updatedAt: params.preserveUpdatedAt } : {}),
    },
  });
  const link = groupSettlementInvoiceLink(params.settlementId, {
    id: params.xeroInvoiceId,
  });
  await tx.xeroObjectLink.updateMany({
    where: {
      localModel: link.localModel,
      localId: link.localId,
      xeroObjectType: link.xeroObjectType,
      xeroObjectId: link.xeroObjectId,
      role: link.role,
      active: true,
    },
    data: { active: false },
  });
}
