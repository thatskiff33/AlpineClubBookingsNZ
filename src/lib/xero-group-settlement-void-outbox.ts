import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  buildXeroIdempotencyKey,
  startXeroSyncOperation,
} from "@/lib/xero-sync";
import { XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_VOID_TYPE } from "@/lib/xero-operation-outbox-payload";
import { GROUP_SETTLEMENT_INVOICE_ROLE } from "@/lib/group-settlement-invoice-binding";

/**
 * Persist the compensating VOID debt for a cancelled combined group invoice.
 *
 * This is deliberately independent of the original CREATE operation: that row
 * may already be SUCCEEDED when the organiser later cancels.  The active
 * correlation-key partial index and the pre-check below make concurrent
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

  const correlationKey = buildXeroIdempotencyKey(
    "group-settlement",
    settlement.id,
    "invoice-void-after-cancel",
    settlement.xeroInvoiceId,
    "v1"
  );
  const existing = await db.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "UPDATE",
      localModel: "GroupBookingSettlement",
      localId: settlement.id,
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
    localId: settlement.id,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_VOID_TYPE,
      settlementId: settlement.id,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
    store: options?.store,
  });
  return {
    queueOperationId: operation.id,
    message: "Xero group invoice VOID queued for background processing.",
  };
}

/**
 * #3642 (`INV-PAY-106`): persist the VOID debt for a combined group invoice the
 * settlement has ABANDONED while the group itself stays live — the reaper
 * released the settlement, or the organiser re-settled after that release. The
 * group is not cancelled, so the cancellation VOID above refuses it; this one
 * names the invoice in its payload instead of reading it off the settlement,
 * because the abandoning transaction clears the settlement's pointer in the
 * same commit (a later invoice may take its place).
 *
 * Same convergence rule as the cancellation VOID: an invoice-specific
 * correlation key plus the active-row pre-check make every observer of one
 * abandoned invoice land on one replayable UPDATE row.
 */
export async function enqueueXeroGroupSettlementInvoiceAbandonVoidOperation(
  settlementId: string,
  xeroInvoiceId: string,
  options: {
    createdByMemberId?: string;
    store: Prisma.TransactionClient;
  }
) {
  const db = options.store;
  const correlationKey = buildXeroIdempotencyKey(
    "group-settlement",
    settlementId,
    "invoice-void-after-abandon",
    xeroInvoiceId,
    "v1"
  );
  const existing = await db.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "UPDATE",
      localModel: "GroupBookingSettlement",
      localId: settlementId,
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
    localId: settlementId,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_VOID_TYPE,
      settlementId,
      xeroInvoiceId,
    },
    createdByMemberId: options.createdByMemberId ?? null,
    store: db,
  });
  return {
    queueOperationId: operation.id,
    message: "Xero group invoice VOID queued for background processing.",
  };
}

/**
 * Retire an invoice the settlement has abandoned, inside the caller's `lock(1)`
 * transaction: queue its replayable VOID, drop the settlement's pointer to it,
 * and deactivate its object link (so a replacement invoice is not mistaken for
 * "already linked"). The link row itself is kept — the inbound reconciliation
 * reads it to recognise a payment that still lands on the abandoned invoice.
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
  await tx.xeroObjectLink.updateMany({
    where: {
      localModel: "GroupBookingSettlement",
      localId: params.settlementId,
      xeroObjectType: "INVOICE",
      xeroObjectId: params.xeroInvoiceId,
      role: GROUP_SETTLEMENT_INVOICE_ROLE,
      active: true,
    },
    data: { active: false },
  });
}
