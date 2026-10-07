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
import type { ClubFormat } from "@/lib/club-format";
import { formatCents } from "@/lib/utils";
import type {
  XeroReconciliationIssueItem,
  XeroReconciliationIssueSection,
} from "@/lib/xero-hardening-types";
import { asRecord, readNumber, readString } from "@/lib/xero-json";
import {
  parsePaymentCreditNoteRetryInput,
  readCashRefundMethod,
} from "@/lib/xero-payment-credit-note-payload";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { xeroDocumentDateForClubToday } from "@/lib/xero-provider-dates";
import { resolveRefundNoteMethod } from "@/lib/xero-refund-method";
import { readRefundRequestIdFromPayload } from "@/lib/refund-request-credit-note";
import {
  finishRefundCreditNoteSettlement,
  refundNoteSettlementInterrupted,
  refundNoteSettlementOnRecord,
  refundPaymentLinkWhere,
  type EvidenceLink,
  type EvidenceOperation,
} from "@/lib/xero-refund-note-settlement";

/**
 * Whether a credit-note create row raised a REFUND note (#3548 round 3). An
 * account-credit (unapplied) note on a payment has the same entity, operation
 * and model, and no settling payment is ever due on it: it is never listed,
 * and never paid from the refund account. The one payload reader decides.
 */
function raisedRefundNote(operation: { requestPayload: unknown }): boolean {
  return parsePaymentCreditNoteRetryInput(operation)?.kind === "refund";
}

/** A remainder a part-settled read recorded on the row, if any. */
function recordedRemainingCents(responsePayload: unknown): number | null {
  const remaining = readNumber(asRecord(responsePayload)?.refundPaymentRemainingCents);
  return remaining !== null && remaining > 0 ? remaining : null;
}

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
 * the newest. Refund notes only (`raisedRefundNote`), and the links are read
 * active or not (`refundPaymentLinkWhere`). Pure over loaded rows, so both
 * readers share it.
 */
export function unsettledRefundNoteRows(
  operations: Array<
    EvidenceOperation & {
      localModel: string | null;
      localId: string | null;
      xeroObjectNumber: string | null;
      createdAt: Date;
      requestPayload: unknown;
    }
  >,
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
      operation.operationType !== "CREATE" ||
      !raisedRefundNote(operation)
    ) {
      continue;
    }
    const paymentId = operation.localId;
    const remaining = recordedRemainingCents(operation.responsePayload);
    const partSettled = remaining !== null;
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
      requestPayload: true,
      responsePayload: true,
      manuallyResolvedAt: true,
      createdAt: true,
    },
  });
  if (!operations?.length) return [];
  const paymentIds = [...new Set(operations.flatMap((operation) => (operation.localId ? [operation.localId] : [])))];
  const links = await prisma.xeroObjectLink.findMany({
    where: refundPaymentLinkWhere(paymentIds),
    select: { localId: true, role: true, xeroObjectType: true, metadata: true },
  });
  return unsettledRefundNoteRows(operations, links ?? []);
}

/** The reconciliation report's section for these rows; empty when there are none. */
export async function buildUnsettledRefundNoteSection(
  format: ClubFormat,
  topLimit: number,
  paymentItem: (paymentId: string, detail: string) => XeroReconciliationIssueItem,
): Promise<{ count: number; sections: XeroReconciliationIssueSection[] }> {
  const items = (await findUnsettledRefundNoteRows()).map((row) =>
    paymentItem(
      row.paymentId,
      row.kind === "part-settled"
        ? `Refund credit note ${row.creditNoteNumber ?? row.creditNoteId} is part-settled in Xero: ${formatCents(row.remainingCents ?? 0, format)} is still outstanding (operation ${row.operationId}).`
        : `Refund credit note ${row.creditNoteNumber ?? row.creditNoteId} completed with neither its settling payment nor a reason none is due (operation ${row.operationId}).`
    )
  );
  if (items.length === 0) return { count: 0, sections: [] };
  return {
    count: items.length,
    sections: [
      {
        id: "unsettled-refund-credit-notes",
        title: "Refund credit notes with no settlement on record",
        severity: "warning",
        count: items.length,
        whatWentWrong:
          "A refund credit note's operation completed with neither its settling payment nor a reason none is due, or Xero shows the note part-settled, so the refund may still read as owed in Xero.",
        howToFix:
          'Check the note in Xero. Run the booking repair tool: its REFUND_CREDIT_NOTE_UNSETTLED finding offers a settle action, applied only by key, which reads the note back and never pays one already settled. Settle the remainder of a part-settled note in Xero by hand, then apply the action for that note to record it: for a part-settled note it only reads the note back, and never pays. Runbook: docs/MAINTENANCE.md, "Refund credit notes with no settlement on record (#3548)".',
        items: items.slice(0, topLimit),
      },
    ],
  };
}

/**
 * The repair tool's `SETTLE_REFUND_CREDIT_NOTE`, applied only by an operator
 * (`safeToAutoApply: false`). Re-reads the row and the evidence first, so a
 * note settled since the dry run is left alone. Refuses an account-credit
 * note. On a row that recorded a part-settled note it only re-reads the note
 * (`recordOnly`), recording the payments Xero now shows, and never pays.
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
  if (!raisedRefundNote(operation)) {
    return {
      status: "failed",
      message: `Credit note ${creditNoteId} on operation ${operationId} is not a refund credit note, so no settling payment is ever recorded against it.`,
    };
  }
  const partSettled = recordedRemainingCents(operation.responsePayload) !== null;
  if (!partSettled && !(await refundNoteSettlementInterrupted(paymentId, creditNoteId))) {
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
    recordOnly: partSettled,
    // #3827 (D-3813-8): a refund request's own note keeps its own link role.
    refundRequestId: readRefundRequestIdFromPayload(requestPayload),
  });
  if (outcome.refundPaymentErr) {
    return { status: "failed", message: "The settling payment failed in Xero; the row is PARTIAL for the repair leg." };
  }
  return {
    status: "applied",
    message: outcome.refundPaymentSkipReason ?? "Recorded the refund credit note's settling payment.",
  };
}
