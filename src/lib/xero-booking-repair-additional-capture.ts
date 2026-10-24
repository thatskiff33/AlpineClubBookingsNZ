/**
 * #3953 (`INV-PAY-139`): THE REPAIR TOOL'S HALF OF A CHANGE'S CARD CAPTURE
 * THAT XERO NEVER RECORDED - "card payment not recorded in Xero".
 *
 * A change's capture is recorded in Xero by the supplementary invoice that
 * waited on it, or, where none did, by its own receipt
 * (`additional-capture-xero-receipt.ts`), queued as the capture lands. A
 * booking captured before that existed, or whose release never ran, has
 * neither: its primary invoice stays part-unpaid in Xero though Stripe holds
 * the money. This names it and offers the receipt; the worker then reads Xero
 * and records it, or refuses and tells an officer, so applying it never
 * guesses.
 *
 * Never where another writer records the capture (`readCaptureRecorder`: the
 * primary's own payment, or a supplementary invoice for the change or naming
 * it). Auto-applied only where the primary invoice's stored figures say which
 * captures its cash covered (`paymentIntentIdsRecordedAtLink`). Without them
 * (an invoice raised before them) it is offered for an officer to apply: the
 * capture may be in the invoice's own payment already.
 */
import { XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE } from "@/lib/additional-capture-receipt-payload";
import { ADDITIONAL_CAPTURE_PAYMENT_ROLE, captureChangeId } from "@/lib/additional-capture-receipt-link";
import { ADDITIONAL_CAPTURE_RECEIPT_REFUSED_CODE } from "@/lib/additional-capture-xero-receipt";
import { readPrimaryInvoiceFeeAtLink } from "@/lib/xero-primary-invoice-gap-anchors";
import { readCaptureRecorder, type RecorderStore } from "@/lib/additional-capture-recorder";
import { asRecord } from "@/lib/xero-json";
import {
  xeroOperationSelect,
  type BookingXeroRepairAction,
  type MutableFinding,
  type XeroOperationRecord,
} from "./xero-booking-repair-types";
import { addAction, addFinding, buildManualReviewAction, buildRetryAction } from "./xero-booking-repair-findings";
import { getBlockingOperation } from "./xero-booking-repair-object-resolution";
import type { RepairDependencies } from "./xero-booking-repair-deps";

/** What the repair pass knows about one booking's change captures in Xero. */
export type AdditionalCaptureReceiptEvidence = {
  /** The receipt rows, by the capture's ledger row. */
  operationsByTransactionId: Map<string, XeroOperationRecord[]>;
  /** Captures whose receipt's Xero payment is linked. */
  recordedTransactionIds: ReadonlySet<string>;
  /**
   * Review round 1 (B): captures another writer records (`readCaptureRecorder`):
   * the primary's own payment, or a supplementary invoice for the change or
   * naming the capture. Read only for captures with no receipt row or link.
   */
  recordedElsewhereIntentIds: ReadonlySet<string>;
  /** Whether the primary's stored figures say which captures its cash covered. */
  primaryCoverageKnown: boolean;
  /**
   * Changes a capture of which its receipt has recorded, or may be recording
   * (its payment linked, the row RUNNING, or a decision stored on it - round
   * 4): a supplementary invoice the repair tool queues for one is raised
   * unpaid, so the capture is recorded once. Round 3 (F1): never for a receipt
   * that has decided nothing yet, or was refused before deciding - that one
   * records against the change's invoice once it exists, or the invoice
   * records it.
   */
  receiptModificationIds: ReadonlySet<string>;
};

type LoadBooking = {
  id: string;
  status: string;
  payment: {
    xeroInvoiceId: string | null;
    transactions: Array<{
      id: string | null;
      kind: string;
      stripePaymentIntentId: string | null;
      bookingModificationId?: string | null;
      reason?: string | null;
    }>;
  } | null;
};

/** Read-only: the evidence for every booking with a primary invoice and a change capture. */
export async function loadAdditionalCaptureReceiptEvidence(
  store: RecorderStore,
  bookings: readonly LoadBooking[],
): Promise<Map<string, AdditionalCaptureReceiptEvidence>> {
  const evidence = new Map<string, AdditionalCaptureReceiptEvidence>();
  for (const booking of bookings) {
    const payment = booking.payment;
    const primaryInvoiceId = payment?.xeroInvoiceId;
    if (booking.status === "CANCELLED" || !payment || !primaryInvoiceId) continue;
    const captures = payment.transactions.filter(
      (row): row is typeof row & { id: string; stripePaymentIntentId: string } =>
        row.kind === "ADDITIONAL" && row.stripePaymentIntentId !== null && row.id !== null,
    );
    if (captures.length === 0) continue;
    const transactionIds = captures.map((row) => row.id);
    const [operations, links, figures] = await Promise.all([
      store.xeroSyncOperation.findMany({
        where: {
          localModel: "PaymentTransaction",
          localId: { in: transactionIds },
          queueType: XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
        },
        select: xeroOperationSelect,
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      }) as Promise<XeroOperationRecord[]>,
      store.xeroObjectLink.findMany({
        where: {
          localModel: "PaymentTransaction",
          localId: { in: transactionIds },
          role: ADDITIONAL_CAPTURE_PAYMENT_ROLE,
          active: true,
        },
        select: { localId: true },
      }),
      readPrimaryInvoiceFeeAtLink(booking.id, primaryInvoiceId, store),
    ]);
    const operationsByTransactionId = new Map<string, XeroOperationRecord[]>();
    for (const operation of operations) {
      if (!operation.localId || operation.queueType !== XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE) continue;
      operationsByTransactionId.set(operation.localId, [
        ...(operationsByTransactionId.get(operation.localId) ?? []),
        operation,
      ]);
    }
    const recordedTransactionIds = new Set(links.map((link) => link.localId));
    const recordedElsewhereIntentIds = new Set<string>();
    const receiptModificationIds = new Set<string>();
    for (const capture of captures) {
      const hasReceipt =
        recordedTransactionIds.has(capture.id) ||
        (operationsByTransactionId.get(capture.id) ?? []).some((operation) => operation.status !== "CANCELLED");
      // Round 4 (1a): a receipt that may be recording right now - one running,
      // or one that stored its decision (it sends that on its retry) - counts
      // as recording, as a linked one does.
      const recording =
        recordedTransactionIds.has(capture.id) ||
        (operationsByTransactionId.get(capture.id) ?? []).some(
          (operation) => operation.status === "RUNNING" || asRecord(operation.requestPayload)?.plan != null,
        );
      const changeId = captureChangeId({ bookingModificationId: capture.bookingModificationId ?? null, reason: capture.reason ?? null });
      if (recording && changeId) receiptModificationIds.add(changeId);
      if (hasReceipt) continue;
      const recorder = await readCaptureRecorder(
        {
          bookingId: booking.id,
          primaryInvoiceId,
          paymentIntentId: capture.stripePaymentIntentId,
          bookingModificationId: changeId,
        },
        store,
      );
      if (recorder.kind !== "receipt") recordedElsewhereIntentIds.add(capture.stripePaymentIntentId);
    }
    evidence.set(booking.id, {
      operationsByTransactionId,
      recordedTransactionIds,
      recordedElsewhereIntentIds,
      primaryCoverageKnown: figures?.atLink.paymentIntentIdsRecordedAtLink !== undefined,
      receiptModificationIds,
    });
  }
  return evidence;
}

const SUMMARY =
  "Card payment not recorded in Xero: the member paid this booking change by card after its Xero invoice was raised, and no Xero invoice records that payment, so the invoice shows as part-unpaid though Stripe holds the money.";

const REFUSED_SUMMARY =
  "Card payment not recorded in Xero: the app checked the booking's Xero invoices and could not record this booking change's card payment against either. Its Xero operation says why; record it by hand in Xero and mark the operation resolved, or fix the cause and retry it.";

/** Adds a finding for each change capture on this booking that Xero has no record of. */
export function addUnrecordedAdditionalCaptureFindings({
  findings,
  actionMap,
  booking,
  paymentId,
  captures,
  evidence,
}: {
  findings: MutableFinding[];
  actionMap: Map<string, BookingXeroRepairAction>;
  booking: { id: string; status: string };
  paymentId: string;
  /** A row with no id is a pre-ledger payment's synthesised one: never a change capture. */
  captures: ReadonlyArray<{ id: string | null; kind: string; stripePaymentIntentId: string | null; amountCents: number }>;
  evidence: AdditionalCaptureReceiptEvidence | undefined;
}): void {
  if (!evidence || booking.status === "CANCELLED") return;
  for (const capture of captures) {
    const paymentIntentId = capture.stripePaymentIntentId;
    if (capture.kind !== "ADDITIONAL" || !paymentIntentId || !capture.id) continue;
    if (evidence.recordedTransactionIds.has(capture.id)) continue;
    if (evidence.recordedElsewhereIntentIds.has(paymentIntentId)) continue;
    const details = { paymentId, paymentIntentId, paymentTransactionId: capture.id, capturedCents: capture.amountCents };
    const operations = evidence.operationsByTransactionId.get(capture.id) ?? [];
    if (operations.length > 0) {
      const blocking = getBlockingOperation(operations, "PAYMENT", "CREATE", {
        payloadQueueType: XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
      });
      if (blocking?.kind === "retryable" && blocking.operation.lastErrorCode !== ADDITIONAL_CAPTURE_RECEIPT_REFUSED_CODE) {
        const action = addAction(actionMap, buildRetryAction(booking.id, blocking));
        addFinding(findings, {
          code: "BLOCKED_BY_XERO_OPERATION",
          severity: "warning",
          summary: "A failed Xero operation recording a booking change's card payment needs retrying.",
          safeToAutoApply: true,
          details: { ...details, operationId: blocking.operation.id, operationStatus: blocking.operation.status },
          actionKeys: [action.key],
        });
      } else if (blocking && blocking.kind !== "resolved" && ["FAILED", "PARTIAL"].includes(blocking.operation.status)) {
        const action = addAction(actionMap, buildManualReviewAction(booking.id, REFUSED_SUMMARY));
        addFinding(findings, {
          code: "ADDITIONAL_CAPTURE_NOT_RECORDED_IN_XERO",
          severity: "manual_review",
          summary: REFUSED_SUMMARY,
          safeToAutoApply: false,
          details: { ...details, operationId: blocking.operation.id, reason: blocking.operation.lastErrorMessage },
          actionKeys: [action.key],
        });
      }
      // Queued, running, done, withdrawn, or resolved by an officer in Xero.
      continue;
    }
    const countedKnown = evidence.primaryCoverageKnown;
    const action = addAction(actionMap, {
      key: `queue:additional-capture-receipt:${paymentIntentId}`,
      bookingId: booking.id,
      type: "QUEUE_ADDITIONAL_CAPTURE_RECEIPT",
      description:
        "Queue the Xero payment that records this booking change's card capture against the invoice that bills it, after reading what Xero shows due.",
      safeToAutoApply: countedKnown,
      payload: { paymentIntentId },
    });
    addFinding(findings, {
      code: "ADDITIONAL_CAPTURE_NOT_RECORDED_IN_XERO",
      severity: countedKnown ? "critical" : "manual_review",
      summary: countedKnown
        ? SUMMARY
        : `${SUMMARY} This invoice was raised before the app recorded which card payments it counted, so check Xero first: the payment may already be on it.`,
      safeToAutoApply: countedKnown,
      details,
      actionKeys: [action.key],
    });
  }
}

/**
 * Applies the finding's action: the receipt is queued under the change's
 * anchor lock, once per capture (`enqueueAdditionalCaptureReceiptOperation`);
 * the worker reads Xero before it records anything.
 */
export async function applyAdditionalCaptureReceiptAction(
  action: BookingXeroRepairAction,
  deps: Pick<RepairDependencies, "enqueueAdditionalCaptureReceiptOperation">,
): Promise<void> {
  const result = await deps.enqueueAdditionalCaptureReceiptOperation(String(action.payload.paymentIntentId));
  action.status = result.outcome === "queued" ? "queued" : "skipped";
  action.resultMessage =
    result.outcome === "not-eligible"
      ? `Not queued: ${result.reason}.`
      : result.outcome === "queued"
        ? "Card payment receipt queued for background processing."
        : "Card payment receipt already queued.";
}
