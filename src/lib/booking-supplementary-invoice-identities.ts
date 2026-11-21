import "server-only";
import { prisma } from "@/lib/prisma";
import { editReviewChargeShareTaskWhere } from "@/lib/edit-financial-review-charge-shape";
import { parseEditFinancialReviewContext } from "@/lib/edit-financial-review-context";
import { readQueuedOutboxPayload, XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE } from "@/lib/xero-operation-outbox-payload";
import { resolveObjectFromCandidates } from "@/lib/xero-booking-repair-object-resolution";
import { getOperationQueueTypeHint, isAdmissibleRepairOperation } from "@/lib/xero-booking-repair-utils";
import { xeroObjectLinkSelect, xeroOperationSelect, type XeroOperationRecord } from "@/lib/xero-booking-repair-types";
import { asRecord } from "@/lib/xero-json";
import { stableDigest } from "@/lib/stable-digest";
import { compareOrdinal } from "@/lib/ordinal-order";
import { buildXeroBookingInvoiceCorrelationKey } from "@/lib/xero-booking-invoice-key";
import { isXeroSupplementaryInvoiceKeyForAnchor } from "@/lib/xero-supplementary-invoice-key";

export type SupplementaryInvoiceIdentities = {
  invoiceIds: string[];
  /** Local evidence cannot establish an issued, independently collectable instrument. */
  incomplete: boolean;
  revision: string;
};

function collectionKind(operation: XeroOperationRecord, bookingId: string): "bank" | "receipt" | "unknown" {
  const payload = readQueuedOutboxPayload(operation.requestPayload);
  if (payload?.queueType === XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE) {
    if (payload.bookingId !== bookingId ||
        (operation.localModel === "Booking" && (operation.localId !== payload.bookingId || payload.bookingModificationId || payload.shortfallReviewTaskId)) ||
        (operation.localModel === "BookingModification" && (operation.localId !== payload.bookingModificationId || payload.shortfallReviewTaskId)) ||
        (operation.localModel === "ManualRefundTask" && operation.localId !== payload.shortfallReviewTaskId)) return "unknown";
    // The card's receipt (including a failed payment-recording leg) is never a bank demand.
    if (payload.paymentIntentId || payload.waitForConfirmedAdditionalPayment || payload.recordPayment === true) return "receipt";
    if (payload.recordPayment === false) return "bank";
  }
  // Legacy direct/executed operations preserve this actual execution result even
  // when their queue payload was overwritten. No balance is read from a snapshot.
  const result = asRecord(operation.responsePayload);
  if (result?.paymentSkipped === false) return "receipt";
  if (result?.paymentSkipped === true) return "bank";
  return "unknown";
}

/** Every supplementary-invoice row anchored to the booking, before any classification. */
async function loadSupplementaryInvoiceEvidence(bookingId: string) {
  const [modifications, tasks] = await Promise.all([
    prisma.bookingModification.findMany({ where: { bookingId }, select: { id: true } }),
    prisma.manualRefundTask.findMany({ where: { bookingId, ...editReviewChargeShareTaskWhere }, select: { id: true, reviewContext: true } }),
  ]);
  const modificationIds = new Set(modifications.map((row) => row.id));
  const eligibleTasks = tasks.filter((row) => {
    const anchor = parseEditFinancialReviewContext(row.reviewContext)?.bookingModificationId;
    return typeof anchor === "string" && modificationIds.has(anchor);
  });
  const anchors = [
    { localModel: "Booking", localId: bookingId },
    ...modifications.map((row) => ({ localModel: "BookingModification", localId: row.id })),
    ...eligibleTasks.map((row) => ({ localModel: "ManualRefundTask", localId: row.id })),
  ];
  const [links, operations] = await Promise.all([
    prisma.xeroObjectLink.findMany({ where: { OR: anchors, xeroObjectType: "INVOICE", role: "SUPPLEMENTARY_INVOICE" }, select: xeroObjectLinkSelect }),
    prisma.xeroSyncOperation.findMany({ where: { OR: anchors, direction: "OUTBOUND", entityType: "INVOICE", operationType: "CREATE" }, select: xeroOperationSelect }),
  ]);
  // Database row order is not a financial revision. Stabilise every hashed population.
  links.sort((a, b) => compareOrdinal(a.id, b.id));
  operations.sort((a, b) => compareOrdinal(a.id, b.id));
  eligibleTasks.sort((a, b) => compareOrdinal(a.id, b.id));
  const primaryKey = buildXeroBookingInvoiceCorrelationKey(bookingId);
  const supplementaryOperations = operations.filter((row) =>
    isAdmissibleRepairOperation(row, XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE) &&
    // A positively identified primary is excluded; an unclassified, scoped
    // legacy CREATE remains unknown rather than disappearing into all-clear.
    !(row.localModel === "Booking" && getOperationQueueTypeHint(row) === null &&
      [row.correlationKey, row.idempotencyKey].includes(primaryKey) &&
      ![row.correlationKey, row.idempotencyKey].some((key) => isXeroSupplementaryInvoiceKeyForAnchor(key, row.localModel, row.localId))));
  return { tasks, eligibleTasks, anchors, links, operations, supplementaryOperations };
}

/**
 * Whether the booking has ANY supplementary invoice, or evidence of one: a bank
 * demand, a card receipt (which the reader below leaves out by design), a create
 * not yet sent or failed, an inactive link, or an unclassifiable second ask.
 * Over-reports on purpose — a superset of every id and every `incomplete` the
 * reader below can produce — for a surface that must not hand over the primary
 * invoice as the whole record (#5066).
 */
export async function bookingHasAnySupplementaryInvoiceEvidence(bookingId: string): Promise<boolean> {
  const { tasks, eligibleTasks, links, supplementaryOperations } = await loadSupplementaryInvoiceEvidence(bookingId);
  return tasks.length !== eligibleTasks.length || links.length > 0 || supplementaryOperations.length > 0;
}

/** Complete display discovery; intentionally separate from the narrower clearing selector. */
export async function readBookingSupplementaryInvoiceIdentities(bookingId: string): Promise<SupplementaryInvoiceIdentities> {
  const { tasks, eligibleTasks, anchors, links, operations, supplementaryOperations } = await loadSupplementaryInvoiceEvidence(bookingId);
  const bankIds = new Set<string>();
  const receiptIds = new Set<string>();
  let incomplete = tasks.length !== eligibleTasks.length;
  for (const anchor of anchors) {
    const ownLinks = links.filter((row) => row.localModel === anchor.localModel && row.localId === anchor.localId);
    const ownOperations = supplementaryOperations.filter((row) => row.localModel === anchor.localModel && row.localId === anchor.localId);
    const resolved = resolveObjectFromCandidates({
      links: ownLinks.filter((row) => row.active), operations: ownOperations,
      xeroObjectType: "INVOICE", role: "SUPPLEMENTARY_INVOICE", entityType: "INVOICE", operationType: "CREATE",
      payloadQueueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
    });
    const ids = resolved ? [resolved.objectId, ...resolved.conflicts] : [];
    for (const id of ids) {
      const evidence = supplementaryOperations.filter((row) => row.xeroObjectId === id);
      const kinds = new Set(evidence.map((row) => collectionKind(row, bookingId)));
      if (kinds.size === 1 && kinds.has("bank")) bankIds.add(id);
      else if (kinds.size === 1 && kinds.has("receipt")) receiptIds.add(id);
      else incomplete = true;
    }
    for (const row of ownOperations) {
      if (collectionKind(row, bookingId) !== "receipt" && (!row.xeroObjectId || !ids.includes(row.xeroObjectId))) incomplete = true;
    }
    if (ownLinks.some((row) => !row.active && !ids.includes(row.xeroObjectId))) incomplete = true;
  }
  // Conflicting provenance across replayed anchors never creates two demands.
  for (const id of receiptIds) {
    if (bankIds.delete(id)) incomplete = true;
  }
  const invoiceIds = [...bankIds].sort();
  return { invoiceIds, incomplete, revision: stableDigest({ invoiceIds, incomplete, links, operations, eligibleTasks }) };
}
