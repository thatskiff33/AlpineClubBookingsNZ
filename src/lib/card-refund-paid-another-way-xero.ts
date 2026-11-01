import "server-only";

import type { Prisma } from "@prisma/client";

import type { ClubTimeZone } from "@/lib/club-time";
import { decideLateCapture } from "@/lib/late-capture-kept-xero-rules";
import {
  findKeptLateCaptureInvoiceIdForPayment,
  readPaidAnotherWayLateCaptureXeroReceipt,
} from "@/lib/late-capture-xero-receipt";
import type { PaidAnotherWayXeroNote } from "@/lib/manual-refund-task-settlement-rules";
import { lateCaptureIntentOfCardRefundOperation } from "@/lib/late-capture-paid-another-way";
import { cardRefundSliceFailedRefundIds, parseRefundAllocationPlan } from "@/lib/open-card-refund-owed";
import { cardRefundFailedLaterRefundId } from "@/lib/payment-recovery-keys";
import { resolveRefundNoteEligibleCash } from "@/lib/refund-note-eligible-cash";
import { readResolvedRefundCreditNoteCoverage, sumRefundCreditNoteCoverageCents } from "@/lib/xero-resolved-in-xero-fences";
import {
  enqueueXeroKeptLateCaptureInvoiceOperation,
  keptLateCaptureDocumentDate,
  lockKeptLateCaptureTask,
} from "@/lib/xero-kept-late-capture-invoice";
import { keptReceiptHeldForOfficer } from "@/lib/kept-late-capture-receipt-rows";
import { lockKeptCaptureAnchor } from "@/lib/kept-late-capture-change-receipt";
import { paidAnotherWayReceiptRetryInstruction } from "@/lib/paid-another-way-receipt-retry-wording";
import { enqueueXeroRefundCreditNoteOperation } from "@/lib/xero-operation-outbox";
import { xeroDocumentDateFromInstant } from "@/lib/xero-provider-dates";

/**
 * #3372 / #3924 rounds 5 and 6 (`INV-PAY-122`): WHAT A "PAID ANOTHER WAY" CLOSE
 * RECORDS IN XERO - decided before the close's record, whose key carries the
 * answer (`PaidAnotherWayXeroNote`), and queued on the close's transaction
 * after it. The close itself, its locks and its money are
 * `card-refund-paid-another-way.ts`'s.
 */

type XeroPlanStore = Prisma.TransactionClient;

/** What a close of this card refund records in Xero (`paidAnotherWayXeroPlan`). */
export type PaidAnotherWayXeroPlan =
  | {
      xeroRefundNote: "now";
      /**
       * Round 7 (money M5): the invoice the note credits, where the plan read
       * it - a late capture's recorded receipt. Absent, the note executor names
       * the payment's (`createXeroCreditNote`).
       */
      creditsInvoiceId?: string;
      /**
       * #4104 (`failedLaterCardNoteCoverCents`): how much of what this row owes
       * a card refund note already in Xero answers - raised while a refund
       * Stripe failed later still counted. That much of the bank transfer takes
       * no note of its own; the close's note is for the rest. Absent for none.
       */
      cardNoteCoversCents?: number;
    }
  | { xeroRefundNote: "none" }
  | {
      xeroRefundNote: "after-receipt";
      /**
       * The late capture's receipt the close queues first, on its approval
       * task; null (#3924 round 8) when the receipt is already on its way - a
       * change's released invoice for the capture, queued, sending or FAILED -
       * so the close queues nothing and the note follows that invoice.
       */
      receipt: { manualRefundTaskId: string; paymentIntentId: string; capturedCents: number; raisedAt: Date } | null;
      /**
       * #3924 round 9: with `receipt: null`, that change's invoice FAILED
       * (`invoiceFailed`): it reaches Xero only once an officer retries it.
       */
      receiptFailed?: true;
      /**
       * #3924 round 9: the receipt the close would queue is a FAILED row that
       * may already be in Xero (`keptReceiptHeldForOfficer`): the close leaves
       * it for an officer to check Xero and retry, and the note follows that.
       * Round 10: also, with `receipt: null`, a change's FAILED invoice that
       * attempted `createInvoices` (`invoiceMayBeInXero`) - the same check of
       * Xero comes first.
       */
      receiptHeldForOfficer?: true;
    };

/**
 * What the dialog promises before the close (#3924 round 8): the plan's note,
 * with a receipt already on its way to Xero told apart from one the close
 * queues, since the treasurer reads different words for each. Round 9: and a
 * receipt that will not reach Xero until an officer retries it - a change's
 * invoice that FAILED (`after-receipt-failed`), or a receipt row that failed
 * after it may have reached Xero (`after-receipt-held-for-officer`; round 10:
 * or a change's invoice that did).
 */
export type PaidAnotherWayXeroPromise =
  | PaidAnotherWayXeroNote
  | "covered-by-card-note"
  | "after-receipt-on-its-way"
  | "after-receipt-failed"
  | "after-receipt-held-for-officer";

export function paidAnotherWayXeroPromise(plan: PaidAnotherWayXeroPlan): PaidAnotherWayXeroPromise {
  if (plan.xeroRefundNote === "now" && plan.cardNoteCoversCents) return "covered-by-card-note";
  if (plan.xeroRefundNote !== "after-receipt") return plan.xeroRefundNote;
  if (plan.receiptHeldForOfficer) return "after-receipt-held-for-officer";
  if (plan.receipt === null) return plan.receiptFailed ? "after-receipt-failed" : "after-receipt-on-its-way";
  return "after-receipt";
}

/**
 * #3924 round 5 (F4; owner, 8 Oct 2026: "Raise a refund note for all") and
 * round 6 (owner, 8 Oct 2026: "Record receipt, then credit"): HOW A CLOSE OF
 * THIS CARD REFUND IS RECORDED IN XERO. Its bank-transfer refund note credits
 * the invoice the note executor names (`createXeroCreditNote`), so the dialog
 * never promises a note that will fail:
 *
 * - a treasurer-approved late capture's refund: the capture's own receipt.
 *   Recorded by the app (`readPaidAnotherWayLateCaptureXeroReceipt`, `INV-PAY-110`): the note
 *   is queued `now`. Not in Xero at all: the charge is still in the Stripe
 *   account, so the close queues its receipt and the note follows it
 *   (`after-receipt`) - as long as the capture was taken and has its approval
 *   task (`decideLateCapture`). Recorded and resolved by hand in Xero: `none`,
 *   the officer records its refunds by hand too (`INV-INT-025`). Never the
 *   booking's cleared pre-cancel invoice;
 * - any other: the payment's kept late-capture invoice, else its own invoice
 *   (`findKeptLateCaptureInvoiceIdForPayment` ?? `payment.xeroInvoiceId`):
 *   `now`, or `none` without one.
 *
 * A late capture's receipt the app recorded but which has not reached Xero yet
 * - a change's released invoice still queued, sending, or FAILED - has no
 * invoice to name (#3924 round 8; owner, 8 Oct 2026: "Raise a refund note for
 * all"): `after-receipt` with nothing to queue, and the note follows once that
 * invoice is in Xero (`queueWaitingPaidAnotherWayNote`). Round 9: a FAILED one
 * is flagged (`receiptFailed`), and so is a receipt the close would queue that
 * may already be in Xero (`receiptHeldForOfficer`): each reaches Xero only
 * through an officer's retry, and the note follows that retry.
 *
 * `lockApprovalTask` (the close only): the approval task's row, then (#4324)
 * a change capture's anchor, are taken BEFORE the receipt is read; see the
 * module's LOCKS.
 *
 * STATED LIMIT: a payment that is not a late capture's, whose invoice is still
 * on its way to Xero, reads as having none, and its close queues no note; the
 * toast says to check Xero.
 */
export async function paidAnotherWayXeroPlan(
  db: XeroPlanStore,
  operation: CardNoteCoverOperation & { paymentIntentId: string },
  payment: { id: string; xeroInvoiceId: string | null },
  { lockApprovalTask }: { lockApprovalTask: boolean },
): Promise<PaidAnotherWayXeroPlan> {
  const plan = await paidAnotherWayXeroRoute(db, operation, payment, { lockApprovalTask });
  if (plan.xeroRefundNote !== "now") return plan;
  const cardNoteCoversCents = await failedLaterCardNoteCoverCents(db, operation, payment.id);
  return cardNoteCoversCents > 0 ? { ...plan, cardNoteCoversCents } : plan;
}

async function paidAnotherWayXeroRoute(
  db: XeroPlanStore,
  operation: { idempotencyKey: string; paymentIntentId: string },
  payment: { id: string; xeroInvoiceId: string | null },
  { lockApprovalTask }: { lockApprovalTask: boolean },
): Promise<PaidAnotherWayXeroPlan> {
  // #4104 review (money 3): a late capture's refund that Stripe failed later
  // keeps `INV-PAY-110`'s routing, as its approval row's close would.
  const lateCaptureIntent = await lateCaptureIntentOfCardRefundOperation(operation, db);
  if (lateCaptureIntent === null) {
    const hasInvoice =
      payment.xeroInvoiceId !== null || (await findKeptLateCaptureInvoiceIdForPayment(payment.id, db)) !== null;
    return hasInvoice ? { xeroRefundNote: "now" } : { xeroRefundNote: "none" };
  }
  const task = await db.manualRefundTask.findUnique({
    where: { lateCaptureApprovalIntentId: lateCaptureIntent },
    select: { id: true, status: true, createdAt: true },
  });
  if (task && lockApprovalTask) {
    await lockKeptLateCaptureTask(db, task.id);
    // #4324 review CONC-1: a change capture's plan is read under its change's
    // anchor, after the task row, and held to the queue below.
    await lockKeptCaptureAnchor(db, { manualRefundTaskId: task.id, paymentIntentId: lateCaptureIntent }, { additionalOnly: true });
  }
  const receipt = await readPaidAnotherWayLateCaptureXeroReceipt(lateCaptureIntent, db);
  // Round 7 (money M5, `INV-PAY-122`): the note credits THIS receipt, named by
  // its invoice id - never by `paymentIntentId`, which would count the bank
  // note as the capture's card refund note. Round 8: a receipt recorded but
  // not yet in Xero (a change's released invoice queued, sending or FAILED)
  // has no id to name yet, so the note waits for it.
  if (receipt.kind === "recorded") {
    if (receipt.invoiceId !== null) return { xeroRefundNote: "now", creditsInvoiceId: receipt.invoiceId };
    if (!task) return { xeroRefundNote: "none" };
    if (!receipt.invoiceFailed) return { xeroRefundNote: "after-receipt", receipt: null };
    // Round 10: a failed change invoice that may be in Xero is checked first.
    return receipt.invoiceMayBeInXero
      ? { xeroRefundNote: "after-receipt", receipt: null, receiptFailed: true, receiptHeldForOfficer: true }
      : { xeroRefundNote: "after-receipt", receipt: null, receiptFailed: true };
  }
  if (receipt.kind === "resolved-by-hand" || !task) return { xeroRefundNote: "none" };
  const capture = await db.paymentTransaction.findFirst({
    where: { source: "STRIPE", stripePaymentIntentId: lateCaptureIntent },
    select: { status: true, amountCents: true },
  });
  const { recordCents } = decideLateCapture({
    taskStatus: task.status,
    bookingStatus: "CANCELLED",
    superseded: false,
    capture,
    refundClosedPaidAnotherWay: true,
  });
  if (recordCents === 0) return { xeroRefundNote: "none" };
  return {
    xeroRefundNote: "after-receipt",
    receipt: {
      manualRefundTaskId: task.id,
      paymentIntentId: lateCaptureIntent,
      capturedCents: recordCents,
      raisedAt: task.createdAt,
    },
    // Round 9: the fact the enqueue answers `awaitingOfficerRetry` from.
    ...((await keptReceiptHeldForOfficer(db, task.id)) ? { receiptHeldForOfficer: true as const } : {}),
  };
}

/** What `failedLaterCardNoteCoverCents` reads of the row being closed. */
type CardNoteCoverOperation = { idempotencyKey: string; amountCents: number; allocationPlan?: Prisma.JsonValue };

/**
 * #4104 (money 2; delta review MH, MM1, MM2, ML1): HOW MUCH OF WHAT THIS ROW
 * OWES A CARD REFUND NOTE ALREADY IN XERO ANSWERS. A refund Stripe failed later
 * took its card note while it counted, and the note stays when it fails. So the
 * cents this row owes for failed refunds - all of a failed-later row
 * (`card_refund_failed_later_<refund>`), or the slices of any other row that
 * record one (`failedRefundIds`, a re-plan) - may already be credited in Xero.
 * Notes are per payment, not per refund, so the payment says how much: refund
 * notes covering more than the cash still standing behind them
 * (`sumRefundCreditNoteCoverageCents` against `resolveRefundNoteEligibleCash`)
 * were raised for refunds that failed since. The answer is the smaller of the
 * two, in part where the excess is smaller.
 *
 * The close counts as noted for all it paid back (its key is the ordinary
 * `now`), and its own note is sized for the rest (`queuePaidAnotherWayXero`),
 * so the bank transfer takes that much of the excess, and a later card refund's
 * note is sized as it would have been. A close for less than this leaves the
 * rest of the excess: the Xero note credits more than went back, which the
 * Xero reconciliation report lists as refund coverage above the refunded total
 * (`stripe-refund-over-coverage`) for an officer to correct in Xero.
 *
 * An unreadable resolved note decides nothing here (0); the note's own enqueue
 * refuses on it.
 */
export async function failedLaterCardNoteCoverCents(
  db: XeroPlanStore,
  operation: CardNoteCoverOperation,
  paymentId: string,
): Promise<number> {
  const failedCents =
    cardRefundFailedLaterRefundId(operation.idempotencyKey) !== null
      ? operation.amountCents
      : (parseRefundAllocationPlan(operation.allocationPlan ?? null) ?? [])
          // Every slice that recorded one, made again since or not - unlike
          // what a row still owes (`cardRefundSliceOwesFailedLaterRefund`): the
          // question here is which notes in Xero answer failed refunds, and a
          // re-made slice's failed refund keeps its note too. The answer is
          // bounded by the notes' excess, and by what the close paid back.
          .filter((slice) => cardRefundSliceFailedRefundIds(operation, slice).length > 0)
          .reduce((sum, slice) => sum + slice.amountCents, 0);
  if (failedCents <= 0) return 0;
  const payment = await db.payment.findUnique({ where: { id: paymentId }, select: { id: true, bookingId: true, refundedAmountCents: true } });
  if (!payment) return 0;
  const resolved = await readResolvedRefundCreditNoteCoverage(paymentId, db);
  if (resolved.unreadableOperationIds.length > 0) return 0;
  const coveredCents = await sumRefundCreditNoteCoverageCents(paymentId, resolved, db);
  const { eligibleCashCents } = await resolveRefundNoteEligibleCash(payment, db);
  return Math.min(failedCents, Math.max(0, coveredCents - eligibleCashCents));
}

/**
 * #3924 round 8 (concurrency): an officer resolved or withdrew the late
 * charge's Xero receipt between the plan's read and its requeue - neither takes
 * the approval task's row. The plan no longer holds (a receipt resolved by hand
 * takes no note), so the close refuses with a 409 and nothing commits; asked
 * again, it plans from what is there now.
 */
export class PaidAnotherWayXeroChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaidAnotherWayXeroChangedError";
  }
}

/**
 * What the close queued in Xero: its refund note, the late charge's receipt with
 * the note to follow it, the note to follow a receipt already on its way
 * (round 8), or nothing. Round 9: or the note to follow a receipt that reaches
 * Xero only through an officer's retry - a change's invoice that FAILED
 * (`refund-note-after-failed-receipt`), or the late charge's own receipt row,
 * which failed after it may have reached Xero and which the close left FAILED
 * for an officer to check Xero first (`receipt-held-for-officer`; round 10:
 * also a change's FAILED invoice that may be in Xero). Neither is a queued
 * receipt.
 */
export type PaidAnotherWayXeroQueued =
  | "refund-note"
  | "receipt-then-refund-note"
  | "refund-note-after-receipt"
  | "refund-note-after-failed-receipt"
  | "receipt-held-for-officer"
  | "covered-by-card-note"
  | "refund-note-beyond-card-note"
  | "nothing";

/**
 * #3924 round 9: what the close's audit summary adds when its receipt reaches
 * Xero only through an officer's retry, so the record says what is left to do.
 */
export function paidAnotherWayXeroAuditFollowUp(queued: PaidAnotherWayXeroQueued): string {
  if (queued === "receipt-held-for-officer") {
    return `. ${paidAnotherWayReceiptRetryInstruction("held-for-officer", "the refund note follows")}`;
  }
  if (queued === "refund-note-after-failed-receipt") {
    return `. ${paidAnotherWayReceiptRetryInstruction("failed", "the refund note follows")}`;
  }
  return "";
}

/**
 * #4104: how much of a close of `amountCents` the plan's card note answers -
 * what the close's record keeps (`paidAnotherWayCardNoteCoverContext`) and its
 * own note leaves out (`queuePaidAnotherWayXero`). 0 for any other plan.
 */
export function paidAnotherWayCardNoteCoversCents(plan: PaidAnotherWayXeroPlan, amountCents: number): number {
  return plan.xeroRefundNote === "now" ? Math.min(amountCents, plan.cardNoteCoversCents ?? 0) : 0;
}

/**
 * Queue what the plan says, on the close's transaction, after its record:
 *
 * - `now` (M3 / round 5): the bank-transfer refund note, for exactly the amount
 *   paid back, keyed on the record so it is sized on its own beside any card
 *   note (the record is already in this transaction, so the cash evidence
 *   counts it);
 * - `after-receipt` (round 6): the late charge's receipt, on its approval task;
 *   the receipt's worker queues the note once it is in Xero. The record is
 *   already in this transaction, so the enqueue reads the refund as closed. The
 *   plan and the enqueue ask the same facts under the same row lock, so a
 *   refusal is a fault and nothing commits. Round 8: with the receipt already
 *   on its way (a change's invoice), nothing is queued here; that invoice's
 *   worker queues the note once it is in Xero. Round 9: a receipt that reaches
 *   Xero only through an officer's retry is answered as such
 *   (`refund-note-after-failed-receipt`, `receipt-held-for-officer`), never as
 *   queued;
 * - `none`: nothing.
 */
export async function queuePaidAnotherWayXero(
  tx: Prisma.TransactionClient,
  plan: PaidAnotherWayXeroPlan,
  close: {
    operationId: string;
    bookingId: string;
    paymentId: string;
    recordId: string;
    amountCents: number;
    actingMemberId: string;
    clubZone: ClubTimeZone;
    /** When the close committed its record: the note's date (round 7, money M4). */
    closedAt: Date;
  },
): Promise<PaidAnotherWayXeroQueued> {
  if (plan.xeroRefundNote === "now") {
    // #4104: what a card note already in Xero answers takes no second note.
    const coveredCents = paidAnotherWayCardNoteCoversCents(plan, close.amountCents);
    if (coveredCents >= close.amountCents) return "covered-by-card-note";
    const queued = await enqueueXeroRefundCreditNoteOperation(close.paymentId, close.amountCents - coveredCents, {
      createdByMemberId: close.actingMemberId,
      refundMethod: "internet-banking",
      paidAnotherWayTaskId: close.recordId,
      // Round 7 (money M4): the club day of the close, as the receipt's worker
      // dates a waiting close's note (`notePaidAnotherWayCloseOnReceipt`).
      documentDate: xeroDocumentDateFromInstant(close.closedAt, close.clubZone),
      ...(plan.creditsInvoiceId ? { creditsInvoiceId: plan.creditsInvoiceId } : {}),
      store: tx,
    });
    if (queued.queueOperationId === null) return "nothing";
    return coveredCents > 0 ? "refund-note-beyond-card-note" : "refund-note";
  }
  if (plan.xeroRefundNote === "none") return "nothing";
  if (plan.receipt === null) {
    // Round 10: a failed change invoice that may be in Xero waits on an
    // officer's check of Xero, as a held receipt row does.
    if (plan.receiptHeldForOfficer) return "receipt-held-for-officer";
    return plan.receiptFailed ? "refund-note-after-failed-receipt" : "refund-note-after-receipt";
  }
  // #4324 (review C4, CONC-1): a change capture's kept-capture invoice is
  // queued under its change's anchor, after the task row, as the keep queues
  // it - so the supplementary enqueue's check for it (`anchorCaptureHasReceipt`)
  // sees it. The plan took both already (`lockApprovalTask`); re-taking them is a no-op.
  await lockKeptLateCaptureTask(tx, plan.receipt.manualRefundTaskId);
  await lockKeptCaptureAnchor(tx, plan.receipt, { additionalOnly: true });
  const queued = await enqueueXeroKeptLateCaptureInvoiceOperation({
    manualRefundTaskId: plan.receipt.manualRefundTaskId,
    bookingId: close.bookingId,
    paymentIntentId: plan.receipt.paymentIntentId,
    capturedCents: plan.receipt.capturedCents,
    capturedOn: keptLateCaptureDocumentDate(plan.receipt.raisedAt, close.clubZone),
    createdByMemberId: close.actingMemberId,
    // Round 7 (money M2): a receipt row that failed before it reached Xero is
    // put back to run, never left FAILED as if it were live. Round 8: one that
    // may have reached Xero is left for an officer's retry, and the note
    // follows that retry (round 9: answered `awaitingOfficerRetry`).
    requeueFailedUnsent: true,
    store: tx,
  });
  if (queued.queueOperationId === null) {
    if (queued.changedByOfficer) throw new PaidAnotherWayXeroChangedError(queued.message);
    throw new Error(
      `Paid-another-way close ${close.operationId}: the late charge's Xero receipt could not be queued (${queued.message})`,
    );
  }
  // Round 9: the id is the FAILED row left for an officer, not a queued one.
  if (queued.awaitingOfficerRetry) return "receipt-held-for-officer";
  return "receipt-then-refund-note";
}
