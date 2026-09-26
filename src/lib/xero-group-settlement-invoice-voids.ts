/**
 * The compensating VOIDs of the combined group-settlement invoice, and the key
 * that keeps a replacement invoice distinct from the one it replaces.
 *
 * Split from `xero-group-settlement-invoices.ts` (#3642), which raises the
 * invoice: a cancelled group's invoice is voided by
 * `voidXeroInvoiceForCancelledGroupSettlement` (`INV-PAY-035`), and an invoice a
 * live group's settlement abandoned by `voidXeroInvoiceForAbandonedGroupSettlement`
 * (`INV-PAY-106`). Both are replayable outbox handlers.
 */

import { Invoice } from "xero-node";
import { GroupBookingStatus } from "@prisma/client";
import { prisma } from "./prisma";
import logger from "@/lib/logger";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  upsertXeroObjectLink,
} from "@/lib/xero-sync";
import { callXeroApi, getAuthenticatedXeroClient } from "./xero-api-client";
import { GROUP_SETTLEMENT_INVOICE_ROLE } from "@/lib/group-settlement-invoice-binding";

/** Void an invoice raised for a settlement whose group was then cancelled. */
export async function voidCancelledGroupSettlementInvoice(params: {
  settlementId: string;
  invoiceId: string;
  invoiceNumber: string | null;
  syncOperationId?: string;
  createResponse?: unknown;
}): Promise<void> {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const idempotencyKey = buildXeroIdempotencyKey(
    "group-settlement",
    params.settlementId,
    "invoice-void-after-cancel",
    params.invoiceId,
    "v1"
  );
  const response = await callXeroApi(
    () =>
      xero.accountingApi.updateInvoice(
        tenantId,
        params.invoiceId,
        {
          invoices: [
            {
              invoiceID: params.invoiceId,
              status: Invoice.StatusEnum.VOIDED,
            },
          ],
        },
        undefined,
        idempotencyKey
      ),
    {
      operation: "updateInvoice",
      resourceType: "INVOICE",
      workflow: "createXeroInvoiceForGroupSettlement",
      context: `voidInvoice(cancelled group settlement ${params.settlementId})`,
    }
  );

  const link = {
    localModel: "GroupBookingSettlement",
    localId: params.settlementId,
    xeroObjectType: "INVOICE",
    xeroObjectId: params.invoiceId,
    xeroObjectNumber: params.invoiceNumber,
    xeroObjectUrl: buildXeroInvoiceUrl(params.invoiceId),
    role: GROUP_SETTLEMENT_INVOICE_ROLE,
  } as const;

  if (params.syncOperationId) {
    await completeXeroSyncOperation(params.syncOperationId, {
      status: "SUCCEEDED",
      responsePayload: {
        cancelledAfterInvoiceCreation: true,
        createInvoice: params.createResponse ?? null,
        voidInvoice: response.body ?? null,
        invoiceEmailSuppressed: true,
      },
      xeroObjectType: "INVOICE",
      xeroObjectId: params.invoiceId,
      xeroObjectNumber: params.invoiceNumber,
      xeroObjectUrl: buildXeroInvoiceUrl(params.invoiceId),
      extraLinks: [link],
    });
  } else {
    await upsertXeroObjectLink(link);
  }
}

/** Replayable outbox handler for the compensating VOID after group cancel. */
export async function voidXeroInvoiceForCancelledGroupSettlement(
  settlementId: string,
  options: { syncOperationId: string }
): Promise<void> {
  const settlement = await prisma.groupBookingSettlement.findUnique({
    where: { id: settlementId },
    select: {
      id: true,
      xeroInvoiceId: true,
      xeroInvoiceNumber: true,
      groupBooking: { select: { status: true } },
    },
  });
  if (!settlement) {
    throw new Error(`Group settlement not found: ${settlementId}`);
  }
  if (settlement.groupBooking.status !== GroupBookingStatus.CANCELLED) {
    throw new Error(`Cannot VOID an active group settlement: ${settlementId}`);
  }
  if (!settlement.xeroInvoiceId) {
    throw new Error(`Cancelled group settlement has no Xero invoice: ${settlementId}`);
  }
  await voidCancelledGroupSettlementInvoice({
    settlementId: settlement.id,
    invoiceId: settlement.xeroInvoiceId,
    invoiceNumber: settlement.xeroInvoiceNumber,
    syncOperationId: options.syncOperationId,
  });
}

/**
 * #3642 (`INV-PAY-106`): replayable outbox handler for the VOID of an invoice a
 * LIVE group's settlement abandoned (the reaper released it, or a later settle
 * attempt replaced it). The group is not cancelled, so the handler above
 * refuses it; the invoice is named by the operation, because the abandoning
 * transaction already cleared the settlement's pointer.
 *
 * Voids through the same idempotent `updateInvoice` call as the cancellation
 * VOID, under an invoice-specific key. A Xero refusal (an invoice that was paid
 * before the VOID ran) fails the operation for the outbox's retry and alerting;
 * the payment itself is caught by the inbound reconciliation, which recognises
 * an abandoned invoice by its deactivated object link and alerts the operators.
 */
export async function voidXeroInvoiceForAbandonedGroupSettlement(
  settlementId: string,
  xeroInvoiceId: string,
  options: { syncOperationId: string }
): Promise<void> {
  const settlement = await prisma.groupBookingSettlement.findUnique({
    where: { id: settlementId },
    select: { id: true, xeroInvoiceId: true },
  });
  if (!settlement) {
    throw new Error(`Group settlement not found: ${settlementId}`);
  }
  // Defensive: an abandoned invoice is never re-bound (a replacement is always
  // a NEW invoice), so a settlement pointing at this one means the VOID was
  // queued in error. Never void the invoice a settlement still settles on.
  if (settlement.xeroInvoiceId === xeroInvoiceId) {
    logger.error(
      { settlementId, xeroInvoiceId },
      "Refusing to void a group settlement invoice the settlement still points at"
    );
    await completeXeroSyncOperation(options.syncOperationId, {
      status: "SUCCEEDED",
      responsePayload: { skippedInvoiceStillLinkedToSettlement: true },
    });
    return;
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const response = await callXeroApi(
    () =>
      xero.accountingApi.updateInvoice(
        tenantId,
        xeroInvoiceId,
        {
          invoices: [
            { invoiceID: xeroInvoiceId, status: Invoice.StatusEnum.VOIDED },
          ],
        },
        undefined,
        buildXeroIdempotencyKey(
          "group-settlement",
          settlementId,
          "invoice-void-after-abandon",
          xeroInvoiceId,
          "v1"
        )
      ),
    {
      operation: "updateInvoice",
      resourceType: "INVOICE",
      workflow: "createXeroInvoiceForGroupSettlement",
      context: `voidInvoice(abandoned group settlement ${settlementId})`,
    }
  );
  await completeXeroSyncOperation(options.syncOperationId, {
    status: "SUCCEEDED",
    responsePayload: {
      abandonedBySettlement: true,
      voidInvoice: response.body ?? null,
    },
    xeroObjectType: "INVOICE",
    xeroObjectId: xeroInvoiceId,
    xeroObjectUrl: buildXeroInvoiceUrl(xeroInvoiceId),
  });
}

/**
 * #3642: the Xero idempotency key for this settlement's NEXT invoice. The first
 * invoice keeps the original key; each later one (after an abandoned invoice)
 * is keyed by how many invoices the settlement has already linked, active or
 * not, so a fresh invoice is never answered with Xero's replay of the voided
 * one, while a retry of the SAME attempt, which has linked nothing new, still
 * reuses its key and is deduplicated by Xero.
 */
export async function nextGroupSettlementInvoiceIdempotencyKey(
  settlementId: string
): Promise<string> {
  const priorInvoices = await prisma.xeroObjectLink.count({
    where: {
      localModel: "GroupBookingSettlement",
      localId: settlementId,
      xeroObjectType: "INVOICE",
      role: GROUP_SETTLEMENT_INVOICE_ROLE,
    },
  });
  return priorInvoices === 0
    ? buildXeroIdempotencyKey("group-settlement", settlementId, "invoice", "v1")
    : buildXeroIdempotencyKey(
        "group-settlement",
        settlementId,
        "invoice",
        `after-${priorInvoices}`,
        "v1"
      );
}
