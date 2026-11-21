import type { PaymentStatus } from "@prisma/client";

import {
  decideLateCapture,
  keptLateCaptureInvoiceAsked,
  keptReceiptMayHaveReachedXero,
} from "@/lib/late-capture-kept-xero-rules";
import { cardNoteMayBeInXeroSentence, cardRefundAboveRecordedSentence } from "@/lib/late-capture-card-note-wording";
import type {
  BlockingOperationMatch,
  BookingClassificationContext,
  BookingXeroRepairAction,
  LateCaptureCardRefundsByHandEntry,
  MutableFinding,
} from "./xero-booking-repair-types";
import { addAction, addFinding, buildRetryAction } from "./xero-booking-repair-findings";

type LateCaptureTask = BookingClassificationContext["lateCaptureTasks"] extends Map<string, infer Task> ? Task : never;

/**
 * #3924 round 7 (money M2, `INV-PAY-122`; owner, 8 Oct 2026: "Record receipt,
 * then credit"): THE REPAIR TOOL'S HALF OF A LATE CAPTURE'S REFUND PAID ANOTHER
 * WAY. Adds the finding and its action, and says whether it did, so the caller
 * looks no further at this capture.
 */
export function addPaidAnotherWayReceiptFinding({
  findings,
  actionMap,
  booking,
  paymentId,
  transaction,
  lateTask,
  keptInvoice,
}: {
  findings: MutableFinding[];
  actionMap: Map<string, BookingXeroRepairAction>;
  booking: { id: string; status: string };
  paymentId: string;
  transaction: { stripePaymentIntentId: string | null; status: PaymentStatus; amountCents: number };
  lateTask: LateCaptureTask;
  keptInvoice: BlockingOperationMatch | null;
}): boolean {
  // An APPROVED capture whose card refund was closed as paid another way, with
  // its note waiting for the receipt. The charge is still in the Stripe account
  // and the close's bank-transfer note follows the receipt, so a receipt that
  // failed, or was never queued, leaves both undone. Retried or queued
  // automatically only where that cannot raise a second receipt: the worker
  // and the enqueue both re-read the task and the close under the task's row
  // lock before anything is sent.
  const close = lateTask.status === "COMPLETED" ? lateTask.paidAnotherWayClose : undefined;
  if (!close) return false;
  const details = {
    paymentId,
    manualRefundTaskId: lateTask.taskId,
    paymentIntentId: transaction.stripePaymentIntentId,
  };
  // Round 11: a receipt resolved by hand, whatever the close planned. Read by
  // the paid-another-way verdict (`readPaidAnotherWayLateCaptureXeroReceipt`),
  // so a row resolved after the app sent it, or a change linked in Xero, is
  // the app's receipt and the CLOSE's note follows - the close's share is never
  // recorded by hand. The capture's card refunds are another matter (round
  // 12): every card-refund path reads such a row resolved by hand, so they are
  // `LATE_CAPTURE_CARD_REFUND_RECORD_BY_HAND`'s. The close's finding answers
  // its capture in place of the kept invoice's
  // `KEPT_LATE_CAPTURE_REFUND_RECORD_BY_HAND`, which the caller never reaches
  // for a close. Report-only, so the caller still looks at a PARTIAL row.
  if (close.receiptState?.receipt.kind === "resolved-by-hand") {
    addRecordByHandFinding(findings, close, details);
    return false;
  }
  if (close.xeroRefundNote !== "after-receipt") return false;
  const receiptCents = decideLateCapture({
    taskStatus: "COMPLETED",
    bookingStatus: booking.status,
    superseded: false,
    capture: transaction,
    refundClosedPaidAnotherWay: true,
  }).recordCents;
  if (receiptCents <= 0) return false;
  const state = close.receiptState;
  if (!state) return false;
  const failed =
    keptInvoice?.kind === "retryable" && keptInvoice.operation.status === "FAILED" ? keptInvoice : null;

  // Round 8 (money review, wording by the invoice link): the receipt's invoice
  // is in Xero and linked, and its row failed after that - the note step, most
  // likely. Its retry sends nothing again: it finishes the row and queues the
  // note.
  if (failed && state.invoiceLinked) {
    const action = addAction(actionMap, buildRetryAction(booking.id, failed));
    addFinding(findings, {
      code: "PAID_ANOTHER_WAY_LATE_CAPTURE_WITHOUT_XERO_RECEIPT",
      severity: "critical",
      summary:
        "A late card payment whose refund was paid another way has its Xero receipt in Xero, but the receipt's operation failed after it was recorded; retrying it finishes the operation and queues the bank-transfer refund note.",
      safeToAutoApply: action.safeToAutoApply,
      details: { ...details, operationId: failed.operation.id, operationStatus: "FAILED", receiptInXero: true },
      actionKeys: [action.key],
    });
    return true;
  }

  // Round 8 (owner, 8 Oct 2026: "Raise a refund note for all"): the receipt is
  // in Xero - a change's invoice sent after the close, whose own note step
  // failed - and the close's note was never asked for. The one note step
  // queues it.
  if (state.receipt.kind === "recorded" && state.receipt.invoiceId !== null) {
    if (state.noteAsked) return false;
    const action = addAction(actionMap, {
      key: `queue:paid-another-way-refund-note:${lateTask.taskId}`,
      bookingId: booking.id,
      type: "QUEUE_PAID_ANOTHER_WAY_REFUND_NOTE",
      description:
        "Queue the bank-transfer Xero refund note of a late card payment's refund paid another way, against its receipt now in Xero.",
      safeToAutoApply: true,
      payload: { paymentIntentId: transaction.stripePaymentIntentId },
    });
    addFinding(findings, {
      code: "PAID_ANOTHER_WAY_REFUND_NOTE_NOT_QUEUED",
      severity: "critical",
      summary:
        "A late card payment whose refund was paid another way has its Xero receipt in Xero, but the bank-transfer refund note that waits for it was never queued.",
      safeToAutoApply: true,
      details: { ...details, receiptInvoiceId: state.receipt.invoiceId },
      actionKeys: [action.key],
    });
    return true;
  }
  // On its way to Xero (a change's invoice queued, sending or failed, which is
  // its own operation to retry): the note follows it, and no second receipt
  // is queued beside it.
  if (state.receipt.kind === "recorded") return true;

  if (!failed && keptLateCaptureInvoiceAsked(lateTask.operations)) return false;
  // Round 8 (money review): a FAILED receipt row that may have reached Xero -
  // its Stripe payment linked, or `createInvoices` attempted - is never retried
  // automatically, or Xero could hold two receipts. An officer checks Xero first.
  const mayHaveReachedXero =
    failed !== null &&
    keptReceiptMayHaveReachedXero({ requestPayload: failed.operation.requestPayload, paymentLinked: state.paymentLinked });
  const action = failed
    ? addAction(
        actionMap,
        mayHaveReachedXero
          ? { ...buildRetryAction(booking.id, failed), safeToAutoApply: false }
          : buildRetryAction(booking.id, failed),
      )
    : addAction(actionMap, {
        key: `queue:kept-late-capture-invoice:${lateTask.taskId}`,
        bookingId: booking.id,
        type: "QUEUE_KEPT_LATE_CAPTURE_INVOICE",
        description:
          "Queue the Xero receipt, paid from the Stripe account on the capture day, of a late card payment whose refund was paid another way; the refund note follows it.",
        safeToAutoApply: true,
        payload: {
          manualRefundTaskId: lateTask.taskId,
          bookingId: booking.id,
          paymentIntentId: transaction.stripePaymentIntentId,
          capturedCents: receiptCents,
          capturedAt: close.raisedAt.toISOString(),
        },
      });
  addFinding(findings, {
    code: "PAID_ANOTHER_WAY_LATE_CAPTURE_WITHOUT_XERO_RECEIPT",
    severity: "critical",
    summary: !failed
      ? "A late card payment whose refund was paid another way has no Xero receipt queued; its bank-transfer refund note waits for it."
      : mayHaveReachedXero
        ? "A late card payment whose refund was paid another way has a Xero receipt that failed after it may have reached Xero. Check Xero for the receipt before retrying it; its bank-transfer refund note waits for it."
        : "A late card payment whose refund was paid another way has a Xero receipt that failed before reaching Xero; its bank-transfer refund note waits for it.",
    safeToAutoApply: action.safeToAutoApply,
    details: {
      ...details,
      ...(failed ? { operationId: failed.operation.id, operationStatus: "FAILED" } : {}),
    },
    actionKeys: [action.key],
  });
  return true;
}

/**
 * #3924 round 12: the words every record-by-hand finding ends with. Recording
 * a refund by hand in Xero writes no row the app reads, and the repair tool
 * has no way to acknowledge a finding, so it is raised again on every run.
 */
const RECORD_BY_HAND_REMINDER =
  "This finding is report-only and keeps appearing after the refund is recorded by hand, which is expected: the app cannot see what is recorded by hand in Xero.";

/** Round 14: the card refunds a note sent without a reply may answer, as a leading-space sentence, or nothing. */
function mayBeInXero(cents: number, amountLabel: string | undefined): string {
  return cents > 0 && amountLabel ? ` ${cardNoteMayBeInXeroSentence(amountLabel)}` : "";
}

/** Round 14: the same, in a finding's details - only when there is any. */
function mayBeInXeroDetail(cents: number): { cardNoteMayBeInXeroCents?: number } {
  return cents > 0 ? { cardNoteMayBeInXeroCents: cents } : {};
}

/**
 * Round 9 (`PAID_ANOTHER_WAY_REFUND_NOTE_RECORD_BY_HAND`): the capture's receipt
 * was resolved by hand, so the app raises no note for the close, and an
 * officer records its refunds by hand. Report-only. Round 10: not once the
 * close's note was asked for after all - any row of it, one an officer
 * resolved by hand included. Round 12: sized from the capture's own card
 * refunds less the notes naming it, plus what the close paid back
 * (`recordByHandCents`), and otherwise raised on every run
 * (`RECORD_BY_HAND_REMINDER`). Round 14: a card note sent to Xero without a
 * reply is named apart, to check in Xero first (`cardNoteMayBeInXeroSentence`).
 */
function addRecordByHandFinding(
  findings: MutableFinding[],
  close: NonNullable<LateCaptureTask["paidAnotherWayClose"]>,
  details: { paymentId: string; manualRefundTaskId: string; paymentIntentId: string | null },
): void {
  const state = close.receiptState;
  if (!state || state.noteAsked || !state.close) return;
  if (state.recordByHandCents <= 0 && state.cardNoteMayBeInXeroCents <= 0) return;
  const amount = close.amountLabel ? `${close.amountLabel} ` : "";
  const record = state.recordByHandCents > 0 ? `: record the ${amount}refunded on it by hand in Xero.` : ".";
  addFinding(findings, {
    code: "PAID_ANOTHER_WAY_REFUND_NOTE_RECORD_BY_HAND",
    severity: "warning",
    summary: `A late card payment whose refund was paid another way has its Xero receipt - the change invoice or the late charge's own receipt - resolved by hand in Xero, so the app raises no refund note for it${record}${mayBeInXero(state.cardNoteMayBeInXeroCents, close.cardNoteMayBeInXeroLabel)} ${RECORD_BY_HAND_REMINDER}`,
    safeToAutoApply: false,
    details: {
      ...details,
      closeRecordId: state.close.id,
      closeAmountCents: state.close.amountCents,
      recordByHandCents: state.recordByHandCents,
      ...mayBeInXeroDetail(state.cardNoteMayBeInXeroCents),
    },
    actionKeys: [],
  });
}

/**
 * #3635 round-3 R5, #3924 round 13 (`KEPT_LATE_CAPTURE_REFUND_RECORD_BY_HAND`,
 * #4039): a kept invoice an officer resolved by hand, whose capture's card
 * refunds no note will answer. Only where every card-refund path reads the
 * receipt as resolved by hand - the capture is in `byHand`
 * (`readLateCaptureCardRefundsByHand`) - so a resolved PARTIAL row whose
 * invoice link stays active, and whose refunds therefore get the app's card
 * note, is never also told to record them by hand. Sized as that reader sizes
 * it, never by `PaymentTransaction.refundedAmountCents`. Report-only; names
 * the capture in place of `LATE_CAPTURE_CARD_REFUND_RECORD_BY_HAND`. Round
 * 14: a card note sent without a reply is named apart, to check in Xero first.
 */
export function addKeptLateCaptureRefundByHandFinding(
  findings: MutableFinding[],
  details: { paymentId: string; manualRefundTaskId: string; paymentIntentId: string; operationId: string },
  byHand: ReadonlyMap<string, LateCaptureCardRefundsByHandEntry> | undefined,
): void {
  const left = byHand?.get(details.paymentIntentId);
  if (!left || (left.cents <= 0 && left.mayBeInXeroCents <= 0)) return;
  const record = left.cents > 0 ? `: record the ${left.amountLabel} refunded by hand in Xero too.` : ".";
  addFinding(findings, {
    code: "KEPT_LATE_CAPTURE_REFUND_RECORD_BY_HAND",
    severity: "warning",
    summary: `A late card payment an officer recorded by hand in Xero was refunded. The app raises no refund credit note for it${record}${mayBeInXero(left.mayBeInXeroCents, left.mayBeInXeroLabel)} ${RECORD_BY_HAND_REMINDER}`,
    safeToAutoApply: false,
    details: { ...details, recordByHandCents: left.cents, ...mayBeInXeroDetail(left.mayBeInXeroCents) },
    actionKeys: [],
  });
}

/**
 * #3924 round 12 (`LATE_CAPTURE_CARD_REFUND_RECORD_BY_HAND`, `INV-PAY-122`): a
 * late capture's card refunds no note will answer - its receipt row was
 * resolved by hand, so no card-refund path raises a note
 * (`readLateCaptureCardRefundsByHand`). Most often a linked change invoice an
 * officer marked resolved, as its retry's 409 said to; round 13, also one
 * resolved before the app sent it (#4038), and a close whose own note row
 * exists. Report-only, and only where no other record-by-hand finding already
 * names the capture: the kept invoice's names its card refunds, and the
 * close's them with the close. So each capture is named once. Round 14: a
 * card note sent without a reply is named apart, to check in Xero first.
 *
 * #4383: a receipt the app recorded for only part of the capture, refunded
 * above that part (`aboveRecordedCents`), is named here too, with the
 * conditional sentence (`cardRefundAboveRecordedSentence`) - even where
 * another finding names the capture, since none of them says it.
 */
export function addLateCaptureCardRefundByHandFindings(
  findings: MutableFinding[],
  paymentId: string,
  byHand: ReadonlyMap<string, LateCaptureCardRefundsByHandEntry> | undefined,
): void {
  for (const [paymentIntentId, entry] of byHand ?? []) {
    const { cents, amountLabel, mayBeInXeroCents, mayBeInXeroLabel, aboveRecordedCents, aboveRecordedLabel } = entry;
    const named = findings.some(
      (finding) =>
        (finding.code === "KEPT_LATE_CAPTURE_REFUND_RECORD_BY_HAND" ||
          finding.code === "PAID_ANOTHER_WAY_REFUND_NOTE_RECORD_BY_HAND") &&
        finding.details.paymentIntentId === paymentIntentId,
    );
    const unnoted = !named && (cents > 0 || mayBeInXeroCents > 0);
    if (!unnoted && aboveRecordedCents <= 0) continue;
    const sentences: string[] = [];
    if (unnoted) {
      const record = cents > 0 ? `: record the ${amountLabel} refunded to the card by hand in Xero.` : ".";
      sentences.push(
        `A late card payment's Xero receipt was resolved by hand, so the app raises no refund note for the card refunds of it${record}${mayBeInXero(mayBeInXeroCents, mayBeInXeroLabel)}`,
      );
    }
    if (aboveRecordedCents > 0) sentences.push(cardRefundAboveRecordedSentence(aboveRecordedLabel));
    addFinding(findings, {
      code: "LATE_CAPTURE_CARD_REFUND_RECORD_BY_HAND",
      severity: "warning",
      summary: `${sentences.join(" ")} ${RECORD_BY_HAND_REMINDER}`,
      safeToAutoApply: false,
      details: {
        paymentId,
        paymentIntentId,
        recordByHandCents: unnoted ? cents : 0,
        ...mayBeInXeroDetail(unnoted ? mayBeInXeroCents : 0),
        ...(aboveRecordedCents > 0 ? { aboveRecordedCents } : {}),
      },
      actionKeys: [],
    });
  }
}
