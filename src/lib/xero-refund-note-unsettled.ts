/**
 * Refund credit notes whose settlement is not on record (#3548 review F5/F6):
 * the hardening-report class and the repair tool's finding and
 * operator-applied settle. Both read the rows through `unsettledRefundNoteRows`,
 * over `refundNoteSettlementOnRecord` (one predicate), and the settle runs the
 * one `finishRefundCreditNoteSettlement`.
 *
 * Never swept automatically: a legacy note an officer left open on purpose
 * would otherwise be paid from the Stripe account. Runbook: docs/MAINTENANCE.md,
 * "Refund credit notes with no settlement on record (#3548)".
 */
import { prisma } from "@/lib/prisma";
import { asRecord, readNumber, readString } from "@/lib/xero-json";
import { readCashRefundMethod } from "@/lib/xero-payment-credit-note-payload";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { xeroDocumentDateForClubToday } from "@/lib/xero-provider-dates";
import { resolveRefundNoteMethod } from "@/lib/xero-refund-method";
import {
  finishRefundCreditNoteSettlement,
  refundNoteSettlementInterrupted,
  refundNoteSettlementOnRecord,
  type EvidenceLink,
  type EvidenceOperation,
} from "@/lib/xero-refund-note-settlement";

/** A SUCCEEDED refund-note row whose note has neither its payment nor a skip on record, or is part-settled. */
export interface UnsettledRefundNoteRow {
  operationId: string;
  paymentId: string;
  creditNoteId: string;
  creditNoteNumber: string | null;
  kind: "unsettled" | "part-settled";
  remainingCents: number | null;
  createdAt: Date;
}

/**
 * The hardening-report class and the repair-tool finding (#3548 review F5/F6):
 * every SUCCEEDED refund-note create row whose note's outcome is not on record
 * (`refundNoteSettlementOnRecord`) — rows the pre-#3548 early return closed with
 * neither — and every row that recorded a part-settled note. One row per note,
 * the newest. Pure over loaded rows, so both readers share it.
 */
export function unsettledRefundNoteRows(
  operations: Array<EvidenceOperation & { localModel: string | null; localId: string | null; xeroObjectNumber: string | null; createdAt: Date }>,
  paymentLinks: Array<EvidenceLink & { localId: string }>,
): UnsettledRefundNoteRow[] {
  const byNote = new Map<string, UnsettledRefundNoteRow>();
  for (const operation of operations) {
    if (
      operation.status !== "SUCCEEDED" ||
      operation.localModel !== "Payment" ||
      !operation.localId ||
      !operation.xeroObjectId ||
      operation.entityType !== "CREDIT_NOTE" ||
      operation.operationType !== "CREATE"
    ) {
      continue;
    }
    const paymentId = operation.localId;
    const remaining = readNumber(asRecord(operation.responsePayload)?.refundPaymentRemainingCents);
    const partSettled = remaining !== null && remaining > 0;
    const onRecord = refundNoteSettlementOnRecord(operation.xeroObjectId, {
      paymentLinks: paymentLinks.filter((link) => link.localId === paymentId),
      noteOperations: operations.filter((candidate) => candidate.localId === paymentId),
    });
    if (!partSettled && onRecord) continue;
    const key = `${paymentId}:${operation.xeroObjectId}`;
    const existing = byNote.get(key);
    if (existing && existing.createdAt >= operation.createdAt) continue;
    byNote.set(key, {
      operationId: operation.id,
      paymentId,
      creditNoteId: operation.xeroObjectId,
      creditNoteNumber: operation.xeroObjectNumber,
      kind: partSettled ? "part-settled" : "unsettled",
      remainingCents: partSettled ? remaining : null,
      createdAt: operation.createdAt,
    });
  }
  return [...byNote.values()];
}

/** The hardening report's read: every refund-note create row and settling link. */
export async function findUnsettledRefundNoteRows(): Promise<UnsettledRefundNoteRow[]> {
  const operations = await prisma.xeroSyncOperation.findMany({
    where: {
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      xeroObjectId: { not: null },
    },
    select: {
      id: true,
      entityType: true,
      operationType: true,
      status: true,
      localModel: true,
      localId: true,
      xeroObjectId: true,
      xeroObjectNumber: true,
      responsePayload: true,
      manuallyResolvedAt: true,
      createdAt: true,
    },
  });
  if (!operations?.length) return [];
  const paymentIds = [...new Set(operations.flatMap((operation) => (operation.localId ? [operation.localId] : [])))];
  const links = await prisma.xeroObjectLink.findMany({
    where: { localModel: "Payment", localId: { in: paymentIds }, xeroObjectType: "PAYMENT", role: "REFUND_PAYMENT" },
    select: { localId: true, role: true, xeroObjectType: true, metadata: true },
  });
  return unsettledRefundNoteRows(operations, links ?? []);
}

/**
 * The repair tool's `SETTLE_REFUND_CREDIT_NOTE`, applied only by an operator
 * (`safeToAutoApply: false`). Re-reads the row and the evidence first, so a
 * note settled since the dry run is left alone.
 */
export async function applyRefundNoteSettlementRepair(
  payload: Record<string, unknown>,
  finish: typeof finishRefundCreditNoteSettlement = finishRefundCreditNoteSettlement,
): Promise<{ status: "applied" | "skipped" | "failed"; message: string }> {
  const operationId = readString(payload.operationId);
  const paymentId = readString(payload.paymentId);
  const creditNoteId = readString(payload.creditNoteId);
  if (!operationId || !paymentId || !creditNoteId) {
    return { status: "failed", message: "The settle action is missing its operation, payment or note." };
  }
  const operation = await prisma.xeroSyncOperation.findUnique({
    where: { id: operationId },
    select: { requestPayload: true, responsePayload: true, correlationKey: true, idempotencyKey: true, xeroObjectId: true },
  });
  if (!operation || operation.xeroObjectId !== creditNoteId) {
    return { status: "failed", message: `Operation ${operationId} no longer names refund credit note ${creditNoteId}.` };
  }
  if (!(await refundNoteSettlementInterrupted(paymentId, creditNoteId))) {
    return { status: "skipped", message: "This refund credit note's settlement is already on record." };
  }
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: { source: true, xeroInvoiceId: true },
  });
  const requestPayload = asRecord(operation.requestPayload);
  const invoiceId = readString(asRecord(requestPayload?.allocation)?.invoiceId) ?? payment?.xeroInvoiceId ?? null;
  if (!invoiceId) {
    return { status: "failed", message: `No Xero invoice is recorded for refund credit note ${creditNoteId}.` };
  }
  const { refundMethod, refundMethodRecorded } = resolveRefundNoteMethod(
    readCashRefundMethod(requestPayload),
    payment?.source,
  );
  const outcome = await finish({
    operationId,
    paymentId,
    creditNoteId,
    creationKeys: [operation.correlationKey, operation.idempotencyKey],
    originalInvoiceId: invoiceId,
    refundMethod,
    refundMethodRecorded,
    fallbackPaymentDate: async () => xeroDocumentDateForClubToday(await readClubTimeZoneOutsideRequest()),
    priorResponse: asRecord(operation.responsePayload),
  });
  if (outcome.refundPaymentErr) {
    return { status: "failed", message: "The settling payment failed in Xero; the row is PARTIAL for the repair leg." };
  }
  return {
    status: "applied",
    message: outcome.refundPaymentSkipReason ?? "Recorded the refund credit note's settling payment.",
  };
}
