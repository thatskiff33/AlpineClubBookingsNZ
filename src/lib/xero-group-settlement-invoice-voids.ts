/**
 * The compensating VOIDs of the combined group-settlement invoice, and the one
 * read of that invoice's state in Xero.
 *
 * Split from `xero-group-settlement-invoices.ts` (#3642), which raises the
 * invoice: a cancelled group's invoice is voided by
 * `voidXeroInvoiceForCancelledGroupSettlement` (`INV-PAY-035`), and an invoice a
 * live group's settlement abandoned by `voidXeroInvoiceForAbandonedGroupSettlement`
 * (`INV-PAY-105`). Both are replayable outbox handlers, and both read the
 * invoice first (#3642): Xero refuses to void an invoice that has a payment or
 * a credit allocated, and an invoice already voided needs nothing. The first
 * becomes one operator alert instead of a VOID that fails for ever; the second
 * completes quietly. Anything else that fails leaves the row FAILED, which the
 * operator's Retry returns to the outbox (`xero-operation-retry.ts`).
 *
 * Deploy note: code from before #3642 reads an abandon VOID row (its payload
 * names an invoice) as a cancellation VOID, refuses it ("Cannot VOID an active
 * group settlement") and leaves it FAILED. That fails closed — nothing is voided
 * wrongly — and the row can be retried once this code is back.
 */

import { Invoice } from "xero-node";
import { GroupBookingStatus } from "@prisma/client";
import { prisma } from "./prisma";
import logger from "@/lib/logger";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import { completeXeroSyncOperation, upsertXeroObjectLink } from "@/lib/xero-sync";
import { callXeroApi, getAuthenticatedXeroClient } from "./xero-api-client";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { getXeroErrorStatusCode } from "@/lib/xero-error-shape";
import {
  groupSettlementInvoiceLink,
  groupSettlementInvoiceVoidKey,
} from "@/lib/xero-group-settlement-invoice-outbox";
import { alertGroupSettlementInvoice } from "@/lib/group-settlement-invoice-alerts";
import { clubFormatValues } from "@/lib/club-format-server";
import { formatCents } from "@/lib/utils";

/** What a combined invoice's state in Xero lets the app do with it. */
export type GroupSettlementInvoiceState =
  | { kind: "void"; status: string }
  /**
   * Xero has no such invoice: deleted there, or the club is now connected to
   * a different Xero organisation. Never voided (there is nothing here to
   * void, and in another organisation it may have been paid); the operators
   * are told, and the settlement is treated as no longer bound to it.
   */
  | { kind: "not_found" }
  | { kind: "open"; totalCents: number | null }
  | {
      kind: "has_money";
      status: string;
      amountPaidCents: number;
      amountCreditedCents: number;
    };

/**
 * Classify a fetched invoice. VOIDED or DELETED: nothing to do. Any payment,
 * credit or PAID status: money a person must reconcile — the app never voids
 * or replaces it. Otherwise open, and safe to void.
 */
export function classifyGroupSettlementInvoiceState(invoice: {
  status?: unknown;
  amountPaid?: unknown;
  amountCredited?: unknown;
  total?: unknown;
  payments?: unknown;
}): GroupSettlementInvoiceState {
  const status = String(invoice.status ?? "");
  if (status === "VOIDED" || status === "DELETED") {
    return { kind: "void", status };
  }
  const amountPaidCents = providerAmountToCents(invoice.amountPaid) ?? 0;
  const amountCreditedCents = providerAmountToCents(invoice.amountCredited) ?? 0;
  const hasPayments = Array.isArray(invoice.payments) && invoice.payments.length > 0;
  if (status === "PAID" || amountPaidCents > 0 || amountCreditedCents > 0 || hasPayments) {
    return { kind: "has_money", status, amountPaidCents, amountCreditedCents };
  }
  return { kind: "open", totalCents: providerAmountToCents(invoice.total) };
}

/** Read one combined invoice from Xero and classify it. Throws when it cannot. */
export async function readGroupSettlementInvoiceState(
  invoiceId: string,
  context: string
): Promise<GroupSettlementInvoiceState> {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  let response: Awaited<ReturnType<typeof xero.accountingApi.getInvoice>>;
  try {
    response = await callXeroApi(
      () => xero.accountingApi.getInvoice(tenantId, invoiceId),
      {
        operation: "getInvoice",
        resourceType: "INVOICE",
        workflow: "groupSettlementInvoiceState",
        context: `getInvoice(${context} ${invoiceId})`,
      }
    );
  } catch (err) {
    // A definite "no such invoice" is an answer; anything else (Xero
    // disconnected, rate-limited, down) is not, and is thrown for the caller.
    if (getXeroErrorStatusCode(err) === 404) return { kind: "not_found" };
    throw err;
  }
  const invoice = response.body.invoices?.[0];
  if (!invoice?.invoiceID) return { kind: "not_found" };
  return classifyGroupSettlementInvoiceState(invoice);
}

/** The operator sentence for money found on an invoice the app will not touch. */
export function describeGroupSettlementInvoiceMoney(
  state: Extract<GroupSettlementInvoiceState, { kind: "has_money" }>,
  format: Parameters<typeof formatCents>[1]
): string {
  const parts = [
    state.amountPaidCents > 0 ? `${formatCents(state.amountPaidCents, format)} paid` : null,
    state.amountCreditedCents > 0
      ? `${formatCents(state.amountCreditedCents, format)} credited`
      : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" and ") : `marked ${state.status}`;
}

/** Void an invoice raised for a settlement whose group was then cancelled. */
export async function voidCancelledGroupSettlementInvoice(params: {
  settlementId: string;
  invoiceId: string;
  invoiceNumber: string | null;
  syncOperationId?: string;
  createResponse?: unknown;
}): Promise<void> {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
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
        groupSettlementInvoiceVoidKey(params.settlementId, params.invoiceId, "cancel")
      ),
    {
      operation: "updateInvoice",
      resourceType: "INVOICE",
      workflow: "createXeroInvoiceForGroupSettlement",
      context: `voidInvoice(cancelled group settlement ${params.settlementId})`,
    }
  );

  const link = groupSettlementInvoiceLink(params.settlementId, {
    id: params.invoiceId,
    number: params.invoiceNumber,
  });

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

/**
 * The shared first step of both VOID handlers: an invoice already voided
 * completes quietly, and one carrying money completes with one operator alert
 * instead of a VOID Xero would refuse. Returns true when the caller should
 * still void it.
 */
async function voidStillNeeded(params: {
  settlementId: string;
  invoiceId: string;
  syncOperationId: string;
  reason: "cancel" | "abandon";
}): Promise<boolean> {
  const state = await readGroupSettlementInvoiceState(
    params.invoiceId,
    params.reason === "cancel" ? "cancelled group" : "abandoned group invoice"
  );
  if (state.kind === "open") return true;
  if (state.kind === "not_found") {
    logger.error(
      { settlementId: params.settlementId, invoiceId: params.invoiceId },
      "Group settlement invoice to void is not in the connected Xero organisation - not voided"
    );
    await alertGroupSettlementInvoice(
      {
        kind: "invoice_not_found",
        settlementId: params.settlementId,
        invoiceId: params.invoiceId,
        errorMessage: `The group's combined invoice ${params.invoiceId} should be voided, but the connected Xero organisation has no such invoice (it was deleted, or Xero was reconnected to a different organisation). Nothing was voided; check the invoice in the organisation it was raised in.`,
      },
      await clubFormatValues()
    );
    await completeXeroSyncOperation(params.syncOperationId, {
      status: "SUCCEEDED",
      responsePayload: { invoiceNotFoundInXero: true },
    });
    return false;
  }
  if (state.kind === "void") {
    await completeXeroSyncOperation(params.syncOperationId, {
      status: "SUCCEEDED",
      responsePayload: { invoiceAlreadyVoid: true, invoiceStatus: state.status },
      xeroObjectType: "INVOICE",
      xeroObjectId: params.invoiceId,
      xeroObjectUrl: buildXeroInvoiceUrl(params.invoiceId),
    });
    return false;
  }
  const format = await clubFormatValues();
  const money = describeGroupSettlementInvoiceMoney(state, format);
  logger.error(
    { settlementId: params.settlementId, invoiceId: params.invoiceId, state },
    "Group settlement invoice carries money, so it was not voided - operator review required"
  );
  await alertGroupSettlementInvoice(
    {
      kind: "void_blocked_by_money",
      settlementId: params.settlementId,
      invoiceId: params.invoiceId,
      errorMessage:
        params.reason === "cancel"
          ? `The group was cancelled, but its combined invoice ${params.invoiceId} has ${money}, so it was not voided. Refund or credit the organiser in Xero.`
          : `The group's settlement stopped using its combined invoice ${params.invoiceId} (it lapsed or was replaced), but the invoice has ${money}, so it was not voided. No bookings were settled from it; refund the organiser, or apply the money to the group's current bill by hand.`,
    },
    format
  );
  await completeXeroSyncOperation(params.syncOperationId, {
    status: "SUCCEEDED",
    responsePayload: { invoiceNotVoidedCarriesMoney: true, invoiceState: state },
    xeroObjectType: "INVOICE",
    xeroObjectId: params.invoiceId,
    xeroObjectUrl: buildXeroInvoiceUrl(params.invoiceId),
  });
  return false;
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
  if (
    !(await voidStillNeeded({
      settlementId: settlement.id,
      invoiceId: settlement.xeroInvoiceId,
      syncOperationId: options.syncOperationId,
      reason: "cancel",
    }))
  ) {
    return;
  }
  await voidCancelledGroupSettlementInvoice({
    settlementId: settlement.id,
    invoiceId: settlement.xeroInvoiceId,
    invoiceNumber: settlement.xeroInvoiceNumber,
    syncOperationId: options.syncOperationId,
  });
}

/**
 * #3642 (`INV-PAY-105`): replayable outbox handler for the VOID of an invoice a
 * LIVE group's settlement abandoned (the reaper released it, the organiser's
 * group changed and it was replaced, or it arrived after its attempt was
 * superseded). The group is not cancelled, so the handler above refuses it; the
 * invoice is named by the operation, because the abandoning transaction already
 * cleared the settlement's pointer.
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
  if (
    !(await voidStillNeeded({
      settlementId,
      invoiceId: xeroInvoiceId,
      syncOperationId: options.syncOperationId,
      reason: "abandon",
    }))
  ) {
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
        groupSettlementInvoiceVoidKey(settlementId, xeroInvoiceId, "abandon")
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
