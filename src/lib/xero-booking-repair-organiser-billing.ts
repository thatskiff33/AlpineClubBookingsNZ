/** Historical organiser billing (#4299 B1): bill the recorded edit, even after a cut or cancel. */
import { paidByOrganiserInternetBanking } from "@/lib/group-organiser-paid";
import { resolveOrganiserBilling } from "@/lib/organiser-billing";
import { compareOrdinal } from "@/lib/ordinal-order";
import { stableDigest } from "@/lib/stable-digest";
import { isAdmissibleRepairOperation } from "./xero-booking-repair-utils";
import { XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE } from "./xero-operation-outbox-payload";
import { buildBookingSummary } from "./xero-booking-repair-findings";
import { loadAuditData } from "./xero-booking-repair-load";
import type { RepairDependencies } from "./xero-booking-repair-deps";
import type { BookingClassificationContext, BookingXeroRepairAction, MutableFinding } from "./xero-booking-repair-types";

export async function classifyOrganiserBillingRepair(context: BookingClassificationContext, deps: RepairDependencies) {
  const { booking } = context;
  if (!paidByOrganiserInternetBanking(booking)) return null;
  const findings: MutableFinding[] = [];
  const actions = new Map<string, BookingXeroRepairAction>();
  const changes = booking.modifications.filter((row) => row.priceDiffCents + row.changeFeeCents > 0);
  if (changes.length === 0) return buildBookingSummary(context, findings, actions);

  // No contact resolution, provider request, task write or outbox write in a dry run.
  let billing: Awaited<ReturnType<typeof resolveOrganiserBilling>>;
  try {
    billing = await resolveOrganiserBilling(deps.prisma, booking);
    if (!billing) throw new Error("The organiser's internet-banking settlement could not be resolved.");
  } catch (error) {
    findings.push({ code: "MANUAL_REVIEW_REQUIRED", severity: "manual_review", safeToAutoApply: false,
      summary: "The organiser's combined invoice is missing or the settlement cannot be resolved; nothing will be billed.",
      details: { reason: error instanceof Error ? error.message : String(error) }, actionKeys: [] });
    return buildBookingSummary(context, findings, actions);
  }
  const events = await deps.prisma.bookingEvent.findMany({
    where: { bookingId: booking.id, type: { in: ["CANCELLED", "REFUNDED", "CREDITED"] } },
    select: { id: true, type: true, amountCents: true, occurredAt: true, snapshot: true },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
  });

  for (const change of changes) {
    const links = context.modificationLinksById.get(change.id) ?? [];
    const operations = (context.modificationOperationsById.get(change.id) ?? []).filter((row) =>
      row.direction === "OUTBOUND" && row.entityType === "INVOICE" && row.operationType === "CREATE" &&
      isAdmissibleRepairOperation(row, XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE));
    // An inactive/voided invoice is still an invoice already raised for this edit.
    // Failed, resolved-by-hand and cancelled operations are reported, never minted beside.
    if (links.some((row) => row.xeroObjectType === "INVOICE" && row.role === "SUPPLEMENTARY_INVOICE") || operations.length > 0) {
      findings.push({ code: "BLOCKED_BY_XERO_OPERATION", severity: "info", safeToAutoApply: false,
        summary: "This organiser-paid change already has an invoice or an operation; historical repair skips it. Use Xero Operations for any failed operation.",
        details: { modificationId: change.id, operationIds: operations.map((row) => row.id), invoiceIds: links.filter((row) => row.role === "SUPPLEMENTARY_INVOICE").map((row) => row.xeroObjectId) }, actionKeys: [] });
      continue;
    }
    const laterReductions = booking.modifications.filter((row) => row.createdAt >= change.createdAt && row.id !== change.id && row.priceDiffCents < 0)
      .map((row) => ({ modificationId: row.id, priceDiffCents: row.priceDiffCents, changeFeeCents: row.changeFeeCents, createdAt: row.createdAt.toISOString() }))
      .sort((a, b) => compareOrdinal(a.createdAt, b.createdAt) || compareOrdinal(a.modificationId, b.modificationId));
    const laterEvents = events.filter((row) => row.occurredAt >= change.createdAt)
      .map((row) => ({ ...row, occurredAt: row.occurredAt.toISOString() }));
    const evidence = {
      bookingId: booking.id, bookingModificationId: change.id, priceDiffCents: change.priceDiffCents, changeFeeCents: change.changeFeeCents,
      billCents: change.priceDiffCents + change.changeFeeCents, changedAt: change.createdAt.toISOString(),
      organiserMemberId: billing.organiserMemberId, settlementId: billing.settlementId, combinedInvoiceId: billing.combinedInvoiceId,
      bookingStatus: booking.status, recordedRefundedAmountCents: booking.payment?.refundedAmountCents ?? 0,
      laterReductions, laterEvents,
    };
    // A key copied from the reviewed dry run is the approval of THESE figures and history.
    const digest = stableDigest(evidence);
    const key = `queue:organiser-historical:${change.id}:${digest}`;
    actions.set(key, { key, bookingId: booking.id, type: "QUEUE_HISTORICAL_ORGANISER_INVOICE", safeToAutoApply: false,
      description: "Bill the organiser the recorded price change plus fee, including cases later reduced or cancelled.",
      payload: { ...evidence, reviewedDigest: digest }, status: "planned", resultMessage: null });
    findings.push({ code: "MISSING_SUPPLEMENTARY_INVOICE", severity: "warning", safeToAutoApply: false,
      summary: "A past positive change was never billed to the organiser. Review the full figures and later reductions/refunds before applying its exact action key; the recorded increase is billed in full.",
      details: evidence, actionKeys: [key] });
  }
  return buildBookingSummary(context, findings, actions);
}

export async function applyHistoricalOrganiserInvoiceRepair(action: BookingXeroRepairAction, deps: RepairDependencies) {
  // Fresh local history before enqueue; immutable changes are billed regardless of current status.
  const contexts = await loadAuditData({ bookingId: action.bookingId }, deps);
  const context = contexts.find((row) => row.booking.id === action.bookingId);
  const fresh = context ? await classifyOrganiserBillingRepair(context, deps) : null;
  const reviewed = fresh?.actions.find((row) => row.key === action.key);
  if (!reviewed) {
    action.status = "skipped";
    action.resultMessage = "The reviewed figures or history changed, or this edit is already billed. Run and review a fresh dry run.";
    return;
  }
  const result = await deps.enqueueXeroSupplementaryInvoiceOperation({
    bookingId: action.bookingId, bookingModificationId: String(reviewed.payload.bookingModificationId),
    priceDiffCents: Number(reviewed.payload.priceDiffCents), changeFeeCents: Number(reviewed.payload.changeFeeCents),
  }, { recordPayment: false, waitForConfirmedAdditionalPayment: false, paymentIntentId: null });
  action.status = result.queueOperationId ? "queued" : "skipped";
  action.resultMessage = result.message;
}
