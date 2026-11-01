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
import type { PaymentStatus } from "@prisma/client";
import { readKeptCaptureRecordedElsewhere, readKeptChangeCaptureEvidence } from "@/lib/late-capture-kept-xero";
import {
  decideLateCapture,
  keptChangeCaptureRoute,
  keptLateCaptureInvoiceAsked,
  type KeptChangeCaptureEvidence,
  type KeptChangeCaptureRoute,
} from "@/lib/late-capture-kept-xero-rules";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import {
  xeroOperationSelect,
  type BookingClassificationContext,
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

/**
 * #4324 (owner decision 25 Oct 2026, Q3 "apply automatically";
 * `INV-PAY-144`): THE REPAIR TOOL'S HALF OF A KEPT CHANGE CAPTURE - a late
 * card payment for a booking change that a treasurer kept on a cancelled
 * booking whose primary Xero invoice exists, which Xero never recorded.
 *
 * Before #4324 the keep released the change's supplementary invoice, and where
 * none waited on the capture nothing recorded it. This names each such
 * capture in the dry run, with the document that would record it
 * (`keptChangeCaptureRoute`): a payment on the invoice that bills the change
 * (its own receipt, `INV-PAY-139`), or the kept-capture invoice where nothing
 * bills it (`INV-PAY-110`). `--apply` records it automatically: the action
 * runs the keep's own decision (`planKeptLateCaptureXeroRecord`) under the
 * approval task's row lock and the change's anchor lock, which reads the
 * evidence again there and finds the capture's existing record first, so each
 * capture is recorded exactly once whatever the snapshot said.
 *
 * Never where a change invoice already answers the capture (the late-success
 * release owns it), or where another document records it
 * (`readCaptureRecorder`). A capture no change can be read from, or on a
 * booking not paid by card, is named for an officer and never applied.
 */
/** What the repair pass knows about one kept change capture. */
export type KeptChangeCaptureRepairEvidence = {
  evidence: KeptChangeCaptureEvidence;
  route: KeptChangeCaptureRoute;
  /** The capture's receipt rows (`ADDITIONAL_CAPTURE_RECEIPT`), newest first. */
  receiptOperations: XeroOperationRecord[];
  /** The receipt's Xero payment is linked. */
  receiptLinked: boolean;
  /** Another writer records the capture (`readKeptCaptureRecordedElsewhere`), read only where no receipt row exists. */
  recordedElsewhere: boolean;
  /** Review MF2: the cents of it another writer records, so the dry run lists what the apply records. */
  alreadyRecordedCents: number;
  /** Review D-F3: the payment holds its primary invoice's id, so the evidence was read in full. */
  primaryInvoiceIdSynced: boolean;
};

/**
 * Read-only: the evidence for every kept change capture on a cancelled booking,
 * by booking and then intent. Review D-F3: where the payment does not hold its
 * primary invoice's id, only what can be read without it.
 */
export async function loadKeptChangeCaptureEvidence(
  store: RecorderStore & Pick<RepairDependencies["prisma"], "xeroObjectLink">,
  bookings: readonly LoadBooking[],
  keptIntentsByBookingId: ReadonlyMap<string, ReadonlyMap<string, unknown>>,
): Promise<Map<string, Map<string, KeptChangeCaptureRepairEvidence>>> {
  const byBooking = new Map<string, Map<string, KeptChangeCaptureRepairEvidence>>();
  for (const booking of bookings) {
    const primaryInvoiceId = booking.payment?.xeroInvoiceId ?? null;
    const kept = keptIntentsByBookingId.get(booking.id);
    if (booking.status !== "CANCELLED" || !booking.payment || !kept) continue;
    const captures = booking.payment.transactions.filter(
      (row): row is typeof row & { id: string; stripePaymentIntentId: string } =>
        row.kind === "ADDITIONAL" && row.id !== null && row.stripePaymentIntentId !== null && kept.has(row.stripePaymentIntentId),
    );
    const found = new Map<string, KeptChangeCaptureRepairEvidence>();
    for (const capture of captures) {
      const changeId = captureChangeId({ bookingModificationId: capture.bookingModificationId ?? null, reason: capture.reason ?? null });
      const [evidence, receiptOperations, link] = await Promise.all([
        readKeptChangeCaptureEvidence(store, { paymentIntentId: capture.stripePaymentIntentId, changeId, bookingId: booking.id, primaryInvoiceId }),
        store.xeroSyncOperation.findMany({
          where: {
            localModel: "PaymentTransaction",
            localId: capture.id,
            queueType: XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
          },
          select: xeroOperationSelect,
          orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
        }) as Promise<XeroOperationRecord[]>,
        store.xeroObjectLink.findFirst({
          where: {
            localModel: "PaymentTransaction",
            localId: capture.id,
            role: ADDITIONAL_CAPTURE_PAYMENT_ROLE,
            active: true,
          },
          select: { id: true },
        }),
      ]);
      const hasReceiptRow = receiptOperations.some((operation) => operation.status !== "CANCELLED");
      const elsewhere =
        hasReceiptRow || link !== null
          ? 0
          : await readKeptCaptureRecordedElsewhere(store, {
              bookingId: booking.id,
              primaryInvoiceId,
              paymentIntentId: capture.stripePaymentIntentId,
              changeId,
            });
      found.set(capture.stripePaymentIntentId, {
        evidence,
        route: keptChangeCaptureRoute(evidence),
        receiptOperations,
        receiptLinked: link !== null,
        recordedElsewhere: elsewhere === "all",
        alreadyRecordedCents: elsewhere === "all" ? 0 : elsewhere,
        primaryInvoiceIdSynced: primaryInvoiceId !== null,
      });
    }
    if (found.size > 0) byBooking.set(booking.id, found);
  }
  return byBooking;
}

/** The tool cannot acknowledge a finding, so one an officer answers by hand in Xero comes back (review D-F1). */
const RAISED_AGAIN = "This tool cannot mark it done, so this finding is raised again on every run after you record it.";

const UNKNOWN_CHANGE_SUMMARY = `A late card payment a treasurer kept on this cancelled booking names no booking change, so which Xero invoice bills it cannot be told, and Xero does not record it. Check Xero and record the payment by hand against the invoice that bills it, or raise one. ${RAISED_AGAIN}`;

const NOT_A_CARD_BOOKING_SUMMARY = `A late card payment a treasurer kept on this cancelled booking is not recorded in Xero, and the booking was paid by internet banking, so the app records no card payment against its invoice. Record it by hand in Xero. ${RAISED_AGAIN}`;

const PRIMARY_INVOICE_ID_NOT_SYNCED_SUMMARY =
  "A late card payment a treasurer kept for a booking change on this cancelled booking: this tool cannot tell yet whether Xero records it until the booking's primary invoice id is synced, because the booking's payment does not hold that invoice's id although the invoice is linked. Sync it first (this tool's SYNC_PAYMENT_PRIMARY_INVOICE_FIELD action); a later pass then lists the payment with the document that will record it, or nothing if one already does, and --apply records it.";

const KEPT_REFUSED_SUMMARY =
  "A late card payment a treasurer kept on this cancelled booking could not be recorded against the Xero invoice that bills it. Its Xero operation says why; record it by hand in Xero and mark the operation resolved, or fix the cause and retry it.";

/**
 * The finding for one kept change capture, or none. `kept` is the capture's
 * approval task; the caller has already left out a capture whose kept-capture
 * invoice was asked for (that has its own retry and resolved findings).
 */
export function addKeptChangeCaptureFinding({
  findings,
  actionMap,
  booking,
  payment,
  transaction,
  kept,
  found,
}: {
  findings: MutableFinding[];
  actionMap: Map<string, BookingXeroRepairAction>;
  booking: { id: string };
  payment: { id: string; source: string | null; xeroInvoiceId: string | null };
  transaction: { stripePaymentIntentId: string | null; status: PaymentStatus; amountCents: number };
  kept: { taskId: string };
  found: KeptChangeCaptureRepairEvidence | undefined;
}): void {
  const paymentIntentId = transaction.stripePaymentIntentId;
  if (!paymentIntentId || found?.route === "change-invoice") return;
  const { recordCents } = decideLateCapture({
    taskStatus: "DISMISSED",
    bookingStatus: "CANCELLED",
    superseded: false,
    capture: transaction,
  });
  if (recordCents === 0) return;
  // Review MF2: the figure the apply records - the kept invoice is sized net of
  // another writer's part, and the receipt records the rest, capped at Xero's AmountDue.
  const alreadyRecordedCents = found?.alreadyRecordedCents ?? 0;
  const details = {
    paymentId: payment.id,
    manualRefundTaskId: kept.taskId,
    paymentIntentId,
    bookingModificationId: found?.evidence.changeId ?? null,
    capturedCents: recordCents,
    alreadyRecordedCents,
    ...(found?.route === "kept-invoice" ? { recordsCents: recordCents - alreadyRecordedCents } : {}),
    ...(found?.route === "receipt"
      ? { recordsCents: recordCents - alreadyRecordedCents, recordsNote: "At most what Xero shows due on the invoice when the payment is sent." }
      : {}),
    recordedBy:
      found?.route === "kept-invoice"
        ? "KEPT_LATE_CAPTURE_INVOICE"
        : found?.route === "receipt"
          ? "ADDITIONAL_CAPTURE_RECEIPT"
          : null,
  };
  const manualReview = (summary: string, extra: Record<string, unknown> = {}) => {
    const action = addAction(actionMap, buildManualReviewAction(booking.id, summary));
    addFinding(findings, {
      code: "KEPT_LATE_CAPTURE_NOT_RECORDED_IN_XERO",
      severity: "manual_review",
      summary,
      safeToAutoApply: false,
      details: { ...details, ...extra },
      actionKeys: [action.key],
    });
  };
  // Its receipt, whichever route the evidence reads now, is its record; and
  // (review M-F1) another writer's, the #4253 sweep's included, is too.
  if (found?.receiptLinked || found?.recordedElsewhere) return;
  // Review D-F3: the booking counts as invoiced by its active link, but the
  // payment lacks the invoice's id, so nothing more can be read until it is synced.
  if (!found?.primaryInvoiceIdSynced) return payment.xeroInvoiceId ? undefined : manualReview(PRIMARY_INVOICE_ID_NOT_SYNCED_SUMMARY);
  if (found.route === "change-unknown") return manualReview(UNKNOWN_CHANGE_SUMMARY);
  if (found.receiptOperations.some((operation) => operation.status !== "CANCELLED")) {
    const blocking = getBlockingOperation(found.receiptOperations, "PAYMENT", "CREATE", {
      payloadQueueType: XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
    });
    if (blocking?.kind === "retryable" && blocking.operation.lastErrorCode !== ADDITIONAL_CAPTURE_RECEIPT_REFUSED_CODE) {
      const action = addAction(actionMap, buildRetryAction(booking.id, blocking));
      addFinding(findings, {
        code: "BLOCKED_BY_XERO_OPERATION",
        severity: "warning",
        summary: "A failed Xero operation recording a late card payment a treasurer kept needs retrying.",
        safeToAutoApply: action.safeToAutoApply,
        details: { ...details, operationId: blocking.operation.id, operationStatus: blocking.operation.status },
        actionKeys: [action.key],
      });
    } else if (blocking && blocking.kind !== "resolved" && ["FAILED", "PARTIAL"].includes(blocking.operation.status)) {
      manualReview(KEPT_REFUSED_SUMMARY, { operationId: blocking.operation.id, reason: blocking.operation.lastErrorMessage });
    }
    // Queued, running, done, or resolved by an officer in Xero.
    return;
  }
  if (found.route === "receipt" && payment.source !== "STRIPE") return manualReview(NOT_A_CARD_BOOKING_SUMMARY);
  if (found.route === "kept-invoice" && !keptChangeCaptureQueuesKeptInvoice(found, transaction)) return;

  const action = addAction(actionMap, {
    key: `queue:kept-late-capture-record:${kept.taskId}`,
    bookingId: booking.id,
    type: "QUEUE_KEPT_LATE_CAPTURE_RECORD",
    description:
      found.route === "receipt"
        ? "Record the kept card payment as a payment on the Xero invoice that bills its booking change, capped at what Xero shows still due. The keep's own decision runs again under its locks first, so it is recorded once."
        : "Queue the Xero invoice, paid from the Stripe account on the capture day, that records a kept card payment for a booking change nothing in Xero bills. The keep's own decision runs again under its locks first, so it is recorded once.",
    safeToAutoApply: true,
    payload: {
      manualRefundTaskId: kept.taskId,
      bookingId: booking.id,
      paymentIntentId,
    },
  });
  addFinding(findings, {
    code: "KEPT_LATE_CAPTURE_NOT_RECORDED_IN_XERO",
    severity: "critical",
    summary:
      found.route === "receipt"
        ? "A treasurer kept a late card payment for a booking change on this cancelled booking, and Xero does not record it: the booking's Xero invoice still shows that change as owing though Stripe holds the money."
        : "A treasurer kept a late card payment for a booking change on this cancelled booking, and Xero does not record it: nothing in Xero bills that change, so the kept-payment invoice records it.",
    safeToAutoApply: true,
    details,
    actionKeys: [action.key],
  });
}

/**
 * Review I11 (round 3): WHETHER THIS PASS RAISES THE KEPT-CAPTURE INVOICE for a
 * kept change capture - the one predicate {@link addKeptChangeCaptureFinding}
 * raises its action on and {@link keptInvoiceBillsChange} reads: the evidence
 * routes it there, the primary invoice's id is synced, no receipt records it or
 * is live, no other writer records all of it, and something is left to record.
 */
export function keptChangeCaptureQueuesKeptInvoice(
  found: KeptChangeCaptureRepairEvidence,
  transaction: { status: PaymentStatus; amountCents: number },
): boolean {
  const { recordCents } = decideLateCapture({
    taskStatus: "DISMISSED",
    bookingStatus: "CANCELLED",
    superseded: false,
    capture: transaction,
  });
  return (
    found.route === "kept-invoice" &&
    found.primaryInvoiceIdSynced &&
    !found.receiptLinked &&
    !found.recordedElsewhere &&
    !found.receiptOperations.some((operation) => operation.status !== "CANCELLED") &&
    recordCents - found.alreadyRecordedCents > 0
  );
}

/**
 * #4324 (`INV-PAY-144`): whether a late capture of this change is recorded by
 * its kept-capture invoice: one asked for on its approval task, or one this
 * pass raises ({@link keptChangeCaptureQueuesKeptInvoice}). That invoice bills
 * the change's money as well as recording it, so a supplementary invoice for
 * the change would count it twice - as income on both, or as a receivable left
 * open for ever - and the repair tool raises none.
 *
 * Review F1 (concurrency, `INV-SSOT`): the asked-for half is the in-memory
 * reading of the supplementary enqueue's own refusal
 * (`keptInvoiceBillsChangeCapture`): a live kept-capture invoice on the
 * approval task of ANY capture of the change (`captureChangeId`), whatever
 * that task's status now - a paid-another-way close queues one on a COMPLETED
 * task - so the dry run never lists an invoice the enqueue refuses.
 */
export function keptInvoiceBillsChange(
  context: Pick<BookingClassificationContext, "booking" | "lateCaptureTasks" | "keptChangeCaptures">,
  modificationId: string,
  captures: ReadonlyArray<{ stripePaymentIntentId: string | null; status: PaymentStatus; amountCents: number }>,
): boolean {
  for (const row of context.booking.payment?.transactions ?? []) {
    if (row.kind !== "ADDITIONAL" || !row.stripePaymentIntentId) continue;
    if (captureChangeId({ bookingModificationId: row.bookingModificationId ?? null, reason: row.reason ?? null }) !== modificationId) continue;
    const task = context.lateCaptureTasks.get(row.stripePaymentIntentId);
    if (task && keptLateCaptureInvoiceAsked(task.operations)) return true;
  }
  for (const [paymentIntentId, found] of context.keptChangeCaptures ?? []) {
    if (found.evidence.changeId !== modificationId) continue;
    const transaction = captures.find((capture) => capture.stripePaymentIntentId === paymentIntentId);
    if (transaction && keptChangeCaptureQueuesKeptInvoice(found, transaction)) return true;
  }
  return false;
}

/**
 * Applies the finding's action: the keep's own decision, on a transaction of
 * its own, under the approval task's row lock and then the change's anchor
 * lock - it reads the task (still DISMISSED), the capture's existing record
 * and the evidence again there, so a stale snapshot records nothing twice.
 */
export async function applyKeptChangeCaptureRecordAction(
  action: BookingXeroRepairAction,
  deps: Pick<RepairDependencies, "prisma" | "planKeptLateCaptureXeroRecord">,
): Promise<void> {
  const clubZone = await readClubTimeZoneOutsideRequest();
  const plan = await deps.prisma.$transaction((tx) =>
    deps.planKeptLateCaptureXeroRecord({
      manualRefundTaskId: String(action.payload.manualRefundTaskId),
      bookingId: String(action.payload.bookingId),
      paymentIntentId: String(action.payload.paymentIntentId),
      clubZone,
      store: tx,
    }),
  );
  const queued =
    (plan.kind === "receipt-queued" || plan.kind === "kept-invoice-queued") && plan.queueOperationId ? plan : null;
  action.status = queued ? "queued" : "skipped";
  action.resultMessage = queued
    ? plan.kind === "receipt-queued"
      ? `The kept card payment's receipt is queued or sent (operation ${queued.queueOperationId}).`
      : `The kept card payment's Xero invoice is queued or sent (operation ${queued.queueOperationId}).`
    : plan.kind === "change-payment"
      ? "Nothing queued: a change invoice already answers this payment, and the late-success release owns it."
      : "Nothing queued: the payment is no longer kept, another Xero document records it, or no booking change can be read from it.";
}
