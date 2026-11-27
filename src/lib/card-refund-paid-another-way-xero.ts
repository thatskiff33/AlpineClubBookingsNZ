import "server-only";

import type { Prisma } from "@prisma/client";
import { cardRefundStillOwedOrigin } from "@/lib/card-refund-still-owed-origin";

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
import { readRefundNoteCoverageAboveCashCents } from "@/lib/refund-note-coverage-above-cash";
import {
  enqueueXeroKeptLateCaptureInvoiceOperation,
  keptLateCaptureDocumentDate,
  lockKeptLateCaptureTask,
} from "@/lib/xero-kept-late-capture-invoice";
import { keptReceiptHeldForOfficer } from "@/lib/kept-late-capture-receipt-rows";
import { lateCaptureReceiptOwed, lockKeptCaptureAnchor } from "@/lib/kept-late-capture-change-receipt";
import { paidAnotherWayReceiptRetryInstruction } from "@/lib/paid-another-way-receipt-retry-wording";
import { enqueueXeroRefundCreditNoteOperation } from "@/lib/xero-operation-outbox";
import {
  enqueueAdditionalCaptureReceiptOperation,
  paidAnotherWayCaptureReceiptRefusal,
} from "@/lib/additional-capture-receipt-enqueue";
import { readKeptCaptureRecord } from "@/lib/late-capture-kept-xero";
import { returnOutboxRowToPending, UNCLAIMED } from "@/lib/xero-outbox-pending-request";
import { asRecord } from "@/lib/xero-json";
import { enqueueCardRefundReversalInvoiceOperation } from "@/lib/xero-card-refund-reversal-invoice";
import { readPendingCardRefundReversalCents } from "@/lib/xero-card-refund-reversal-outbox";
import { readPaidAnotherWayUncoveredCents } from "@/lib/card-refund-paid-another-way-cash";
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
       * #4104, rewritten by #4369 (`INV-PAY-151`): how much of this close a card
       * refund note still answers, after live reversal invoices. When it is
       * more than zero the close queues a Stripe reversal for these cents and
       * a bank-transfer note for the whole close. Absent for none.
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
      receipt: {
        manualRefundTaskId: string;
        paymentIntentId: string;
        capturedCents: number;
        raisedAt: Date;
        /**
         * #4381 (`INV-PAY-144`): which document records the capture, split as
         * the keep splits it (`paidAnotherWayReceiptDocument`) - the
         * kept-capture invoice, or the capture's own receipt on the invoice
         * that already bills its change. Decided here so the queue never
         * decides again.
         */
        document: PaidAnotherWayReceiptDocument;
      } | null;
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
  const readTask = () =>
    db.manualRefundTask.findUnique({
      where: { lateCaptureApprovalIntentId: lateCaptureIntent },
      select: { id: true, status: true, createdAt: true, bookingId: true },
    });
  let task = await readTask();
  if (task && lockApprovalTask) {
    await lockKeptLateCaptureTask(db, task.id);
    // #4381: read again under the row, so a keep or a reopen that committed
    // while the close waited on it is the status the plan decides from.
    task = await readTask();
    // #4324 review CONC-1: a change capture's plan is read under its change's
    // anchor, after the task row, and held to the queue below.
    if (task) await lockKeptCaptureAnchor(db, { manualRefundTaskId: task.id, paymentIntentId: lateCaptureIntent }, { additionalOnly: true });
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
  return lateCaptureReceiptPlan(db, task, lateCaptureIntent, { lockAnchor: lockApprovalTask });
}

/**
 * The plan for a late capture Xero holds no receipt for yet: whether one is
 * owed (`decideLateCapture`, the refund closed paid another way), and which
 * document records it (`paidAnotherWayReceiptDocument`). Read by the close's
 * plan, and (#4381) again by the repair tool's queue of a close's missing
 * receipt (`queueMissingPaidAnotherWayReceipt`).
 */
async function lateCaptureReceiptPlan(
  db: XeroPlanStore,
  task: { id: string; status: "OPEN" | "COMPLETED" | "DISMISSED"; createdAt: Date; bookingId: string },
  paymentIntentId: string,
  { lockAnchor }: { lockAnchor: boolean },
): Promise<PaidAnotherWayXeroPlan> {
  const capture = await db.paymentTransaction.findFirst({
    where: { source: "STRIPE", stripePaymentIntentId: paymentIntentId },
    select: { status: true, amountCents: true, kind: true, paymentId: true, bookingModificationId: true, reason: true },
  });
  const { recordCents } = decideLateCapture({
    taskStatus: task.status,
    bookingStatus: "CANCELLED",
    superseded: false,
    capture,
    refundClosedPaidAnotherWay: true,
  });
  if (recordCents === 0 || !capture) return { xeroRefundNote: "none" };
  const document = await paidAnotherWayReceiptDocument(db, { task, paymentIntentId, capture, recordCents, lockAnchor });
  if (document.kind === "none") return { xeroRefundNote: "none" };
  if (document.kind === "recorded-elsewhere") return { xeroRefundNote: "after-receipt", receipt: null };
  return {
    xeroRefundNote: "after-receipt",
    receipt: {
      manualRefundTaskId: task.id,
      paymentIntentId,
      capturedCents: document.capturedCents,
      raisedAt: task.createdAt,
      document: document.kind,
    },
    // Round 9: the fact the kept invoice's enqueue answers `awaitingOfficerRetry` from.
    ...(document.kind === "kept-invoice" && (await keptReceiptHeldForOfficer(db, task.id))
      ? { receiptHeldForOfficer: true as const }
      : {}),
  };
}

/** The document a close's `after-receipt` plan queues (#4381). */
export type PaidAnotherWayReceiptDocument = "kept-invoice" | "capture-receipt";

/**
 * #4381 (owner, 25 Oct 2026 on #4324, applied to this door on #4381;
 * `INV-PAY-144`, `INV-SSOT`): WHICH DOCUMENT RECORDS A LATE CAPTURE WHOSE
 * APPROVED REFUND IS CLOSED AS PAID ANOTHER WAY, and that nothing in Xero has
 * recorded yet - the keep's split, from the keep's own reading
 * (`readKeptCaptureRecord`), so the two doors never record the same money
 * twice:
 *
 * - the booking's own payment, a change on a booking Xero never invoiced, or
 *   a kept-capture invoice already asked for: that invoice, for the gross
 *   capture, as before #4381;
 * - the capture's own receipt row still undecided: that receipt;
 * - otherwise by the change's evidence (`keptChangeCaptureRoute`):
 *   `change-invoice` the kept-capture invoice, as before; `change-unknown`
 *   nothing (the repair tool names it); `kept-invoice` that invoice for the
 *   capture less what other writers record, or, where they record all of it
 *   or the credit-release sweep holds it, nothing to queue and the note waits
 *   (`recorded-elsewhere`); `receipt` the capture's own receipt on the invoice
 *   that bills the change, capped at what Xero shows due (`INV-PAY-139`),
 *   where its enqueue would queue it (`paidAnotherWayCaptureReceiptRefusal`),
 *   `recorded-elsewhere` where another writer records it, else nothing.
 *
 * Read under the task row and the change's anchor for the close
 * (`lockAnchor`), and without either for the dialog's promise.
 */
async function paidAnotherWayReceiptDocument(
  db: XeroPlanStore,
  input: {
    task: { id: string; bookingId: string };
    paymentIntentId: string;
    capture: { kind: "PRIMARY" | "ADDITIONAL"; paymentId: string; bookingModificationId: string | null; reason: string | null };
    recordCents: number;
    lockAnchor: boolean;
  },
): Promise<{ kind: PaidAnotherWayReceiptDocument; capturedCents: number } | { kind: "recorded-elsewhere" } | { kind: "none" }> {
  const keptInvoice = { kind: "kept-invoice" as const, capturedCents: input.recordCents };
  const reading = await readKeptCaptureRecord(db, {
    bookingId: input.task.bookingId,
    paymentIntentId: input.paymentIntentId,
    manualRefundTaskId: input.task.id,
    capture: input.capture,
    lockAnchor: input.lockAnchor,
  });
  if (reading.firstCut === "kept-invoice" || reading.liveKeptInvoice) return keptInvoice;
  if (reading.receiptRow) {
    // One that stored its decision reads as recorded above; one SUCCEEDED
    // with no payment link stood down for another writer.
    return reading.receiptRow.status === "SUCCEEDED"
      ? { kind: "none" }
      : { kind: "capture-receipt", capturedCents: input.recordCents };
  }
  const { route, elsewhere } = reading.decided;
  if (route === "change-invoice") return keptInvoice;
  if (route === "change-unknown") return { kind: "none" };
  if (route === "kept-invoice") {
    if (elsewhere === "all" || elsewhere >= input.recordCents) return { kind: "recorded-elsewhere" };
    return { kind: "kept-invoice", capturedCents: input.recordCents - elsewhere };
  }
  const refused = await paidAnotherWayCaptureReceiptRefusal(db, input.paymentIntentId);
  if (refused === null) return { kind: "capture-receipt", capturedCents: input.recordCents };
  return refused.startsWith("recorded-by-") ? { kind: "recorded-elsewhere" } : { kind: "none" };
}

/** What `failedLaterCardNoteCoverCents` reads of the row being closed. */
type CardNoteCoverOperation = { idempotencyKey: string; amountCents: number; allocationPlan?: Prisma.JsonValue };

/** The cents a row owes for refunds Stripe failed later: all of a failed-later row, or the slices recording one. */
function failedRefundCentsOf(operation: CardNoteCoverOperation): number {
  return cardRefundFailedLaterRefundId(operation.idempotencyKey) !== null
    ? operation.amountCents
    : (parseRefundAllocationPlan(operation.allocationPlan ?? null) ?? [])
        // Every slice that recorded one, made again since or not - unlike
        // what a row still owes (`cardRefundSliceOwesFailedLaterRefund`): the
        // question here is which notes in Xero answer failed refunds, and a
        // re-made slice's failed refund keeps its note too. The answer is
        // bounded by the notes' excess, and by what the close paid back.
        .filter((slice) => cardRefundSliceFailedRefundIds(operation, slice).length > 0)
        .reduce((sum, slice) => sum + slice.amountCents, 0);
}

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
 * `now`). When this is more than zero, the close queues a Stripe reversal for
 * these cents and a bank note for the whole close (`INV-PAY-151`). A close for
 * less than the card note leaves the rest of the excess: the Xero note credits
 * more than went back, which the Xero reconciliation report lists as refund
 * coverage above the refunded total (`stripe-refund-over-coverage`) for an
 * officer to correct in Xero.
 *
 * An unreadable resolved note decides nothing here (0); the note's own enqueue
 * refuses on it.
 */
export async function failedLaterCardNoteCoverCents(
  db: XeroPlanStore,
  operation: CardNoteCoverOperation,
  paymentId: string,
): Promise<number> {
  // #4516 review M4: a still-owed rest is the rest of the row it was first owed
  // on, so the failed refunds that row owed are this rest's to answer too, up
  // to the rest. Read on its own, its fresh plan records none, and a bank note
  // would be queued for money a card note already credits.
  const origin = await cardRefundStillOwedOrigin(db, operation.idempotencyKey);
  const failedCents = Math.min(operation.amountCents, failedRefundCentsOf(origin ?? operation));
  if (failedCents <= 0) return 0;
  const payment = await db.payment.findUnique({ where: { id: paymentId }, select: { id: true, bookingId: true, refundedAmountCents: true } });
  if (!payment) return 0;
  const coveredAboveCashCents = await readRefundNoteCoverageAboveCashCents(payment, db);
  if (coveredAboveCashCents === null) return 0;
  // #5017 review (money M1): sized as if every earlier close's documents had
  // reached Xero, so the answer never depends on which worker ran first.
  // Eligible cash counts a `now` close once it commits, but coverage counts its
  // bank note only once linked: add back what the closes' own notes do not yet
  // cover. Coverage subtracts a reversal only once linked: take off those still
  // queued, sending or FAILED.
  const closesUnnotedCents = await readPaidAnotherWayUncoveredCents(db, paymentId);
  const pendingReversalCents = await readPendingCardRefundReversalCents(db, paymentId);
  const excessCents = coveredAboveCashCents + closesUnnotedCents - pendingReversalCents;
  return Math.min(failedCents, Math.max(0, excessCents));
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
  | "stripe-reversal-and-bank-note"
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
  if (queued === "stripe-reversal-and-bank-note") {
    return ". Xero will record an invoice for the failed card refund's money back in the Stripe account, and a bank-transfer refund credit note for the full amount paid back.";
  }
  return "";
}

/**
 * #4104 / #4369 (`INV-PAY-151`): how much of a close of `amountCents` a card
 * note still answers. That is the Stripe reversal the close queues. The bank
 * note is the whole close. 0 for any other plan. The close no longer stores
 * this on the record; a capacity-race shortfall still does.
 */
export function paidAnotherWayCardNoteCoversCents(plan: PaidAnotherWayXeroPlan, amountCents: number): number {
  return plan.xeroRefundNote === "now" ? Math.min(amountCents, plan.cardNoteCoversCents ?? 0) : 0;
}

/**
 * Queue what the plan says, on the close's transaction, after its record:
 *
 * - `now` (M3 / round 5, #4369): the bank-transfer refund note, for the whole
 *   amount paid back. When a card note still covers some of it, the same
 *   transaction also queues a Stripe reversal invoice for those cents
 *   (`INV-PAY-151`). Either enqueue refusing queues neither: the throw rolls
 *   the close back. A close with no cover queues only the bank note;
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
    const coveredCents = paidAnotherWayCardNoteCoversCents(plan, close.amountCents);
    const documentDate = xeroDocumentDateFromInstant(close.closedAt, close.clubZone);
    if (coveredCents > 0) {
      // #4369: both rows, or neither. The reversal is the covered cents; the
      // bank note, queued once below, is the whole close, not the remainder.
      const reversal = await enqueueCardRefundReversalInvoiceOperation({
        paymentId: close.paymentId,
        bookingId: close.bookingId,
        closeTaskId: close.recordId,
        amountCents: coveredCents,
        closedOn: documentDate,
        createdByMemberId: close.actingMemberId,
        store: tx,
      });
      if (!reversal.queueOperationId) {
        throw new Error(
          `Paid-another-way close ${close.operationId}: the Stripe reversal was not queued (${reversal.message}), so the bank note was not queued either.`,
        );
      }
    }
    const queued = await enqueueXeroRefundCreditNoteOperation(close.paymentId, close.amountCents, {
      createdByMemberId: close.actingMemberId,
      refundMethod: "internet-banking",
      paidAnotherWayTaskId: close.recordId,
      // Round 7 (money M4): the club day of the close, as the receipt's worker
      // dates a waiting close's note (`notePaidAnotherWayCloseOnReceipt`).
      documentDate,
      ...(plan.creditsInvoiceId ? { creditsInvoiceId: plan.creditsInvoiceId } : {}),
      store: tx,
    });
    if (coveredCents > 0) {
      if (!queued.queueOperationId) {
        throw new Error(
          `Paid-another-way close ${close.operationId}: the bank-transfer refund note was not queued (${queued.message}), so the Stripe reversal was not queued either.`,
        );
      }
      return "stripe-reversal-and-bank-note";
    }
    if (queued.queueOperationId === null) return "nothing";
    return "refund-note";
  }
  if (plan.xeroRefundNote === "none") return "nothing";
  if (plan.receipt === null) {
    // Round 10: a failed change invoice that may be in Xero waits on an
    // officer's check of Xero, as a held receipt row does.
    if (plan.receiptHeldForOfficer) return "receipt-held-for-officer";
    return plan.receiptFailed ? "refund-note-after-failed-receipt" : "refund-note-after-receipt";
  }
  return queueLateCaptureReceipt(tx, plan.receipt, close);
}

/** The late capture's receipt an `after-receipt` plan queues. */
type PlannedLateCaptureReceipt = NonNullable<Extract<PaidAnotherWayXeroPlan, { xeroRefundNote: "after-receipt" }>["receipt"]>;

/** What queuing a planned receipt needs of the close (or of the repair tool's run of it, with no officer). */
type ReceiptQueueContext = { operationId: string; bookingId: string; actingMemberId: string | null; clubZone: ClubTimeZone };

/**
 * The planned receipt, by the document the plan chose: the capture's own
 * receipt (#4381, {@link queuePaidAnotherWayCaptureReceipt}), or the
 * kept-capture invoice.
 */
async function queueLateCaptureReceipt(
  tx: Prisma.TransactionClient,
  receipt: PlannedLateCaptureReceipt,
  close: ReceiptQueueContext,
): Promise<PaidAnotherWayXeroQueued> {
  // #4324 (review C4, CONC-1): a change capture's record is queued under its
  // change's anchor, after the task row, as the keep queues it - so the
  // supplementary enqueue's check for it (`anchorCaptureHasReceipt`) sees it.
  // The plan took both already (`lockApprovalTask`); re-taking them is a no-op.
  await lockKeptLateCaptureTask(tx, receipt.manualRefundTaskId);
  await lockKeptCaptureAnchor(tx, receipt, { additionalOnly: true });
  if (receipt.document === "capture-receipt") return queuePaidAnotherWayCaptureReceipt(tx, receipt, close);
  const queued = await enqueueXeroKeptLateCaptureInvoiceOperation({
    manualRefundTaskId: receipt.manualRefundTaskId,
    bookingId: close.bookingId,
    paymentIntentId: receipt.paymentIntentId,
    capturedCents: receipt.capturedCents,
    capturedOn: keptLateCaptureDocumentDate(receipt.raisedAt, close.clubZone),
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

/**
 * #4381 (`INV-PAY-144`): THE REPAIR TOOL'S QUEUE OF A CLOSE'S MISSING RECEIPT
 * - a late capture whose approved refund was closed as paid another way and
 * which Xero holds no receipt for. The close's own decision, run again on the
 * repair's transaction under the task row and the change's anchor: the task
 * still owes the receipt (`lateCaptureReceiptOwed`), nothing in Xero records
 * it yet, and the document is split as the close splits it
 * (`lateCaptureReceiptPlan`), so a stale snapshot queues nothing twice and
 * never the kept-capture invoice beside the invoice that bills the change.
 */
export async function queueMissingPaidAnotherWayReceipt(
  tx: Prisma.TransactionClient,
  input: { manualRefundTaskId: string; paymentIntentId: string; clubZone: ClubTimeZone },
): Promise<PaidAnotherWayXeroQueued> {
  await lockKeptLateCaptureTask(tx, input.manualRefundTaskId);
  await lockKeptCaptureAnchor(tx, input, { additionalOnly: true });
  const task = await tx.manualRefundTask.findUnique({
    where: { id: input.manualRefundTaskId },
    select: { id: true, status: true, createdAt: true, bookingId: true, lateCaptureApprovalIntentId: true },
  });
  if (!task || task.status !== "COMPLETED" || task.lateCaptureApprovalIntentId !== input.paymentIntentId) return "nothing";
  if (!(await lateCaptureReceiptOwed(tx, input.paymentIntentId))) return "nothing";
  if ((await readPaidAnotherWayLateCaptureXeroReceipt(input.paymentIntentId, tx)).kind !== "none") return "nothing";
  const plan = await lateCaptureReceiptPlan(tx, task, input.paymentIntentId, { lockAnchor: true });
  if (plan.xeroRefundNote !== "after-receipt" || plan.receipt === null) return "nothing";
  return queueLateCaptureReceipt(tx, plan.receipt, {
    operationId: `repair:${task.id}`,
    bookingId: task.bookingId,
    actingMemberId: null,
    clubZone: input.clubZone,
  });
}

/**
 * #4381 (`INV-PAY-144`): the close's `capture-receipt` - the capture's own
 * receipt (`ADDITIONAL_CAPTURE_RECEIPT`), a payment on the invoice that
 * already bills its change, queued by its one enqueue under the task row and
 * the change's anchor this transaction holds. The close's record is already
 * written, so the enqueue reads the receipt as owed (`lateCaptureReceiptOwed`)
 * and its worker queues the close's note once it is in Xero
 * (`answerKeptLateCaptureRefunds`).
 *
 * A row already there that FAILED before it stored its decision is put back
 * to run, status-guarded on the FAILED row read and on its request
 * (`returnOutboxRowToPending`), so a worker that claimed it meanwhile keeps
 * its claim; one that stored its decision may be in Xero and is left for an
 * officer (`receipt-held-for-officer`). A refusal the plan did not predict is
 * a fault: nothing commits.
 */
async function queuePaidAnotherWayCaptureReceipt(
  tx: Prisma.TransactionClient,
  receipt: { paymentIntentId: string },
  close: ReceiptQueueContext,
): Promise<PaidAnotherWayXeroQueued> {
  const queued = await enqueueAdditionalCaptureReceiptOperation(receipt.paymentIntentId, {
    store: tx,
    keptLateCapture: true,
    createdByMemberId: close.actingMemberId,
  });
  if (queued.outcome === "not-eligible") {
    throw new Error(
      `Paid-another-way close ${close.operationId}: the late charge's Xero receipt could not be queued (${queued.reason})`,
    );
  }
  if (queued.outcome === "queued") return "receipt-then-refund-note";
  const operationId = queued.queueOperationId;
  const row = await tx.xeroSyncOperation.findUnique({
    where: { id: operationId },
    select: { status: true, manuallyResolvedAt: true, requestPayload: true },
  });
  const changed = () =>
    new PaidAnotherWayXeroChangedError("An officer resolved or withdrew this payment's Xero receipt while it was being queued again.");
  if (!row || row.manuallyResolvedAt !== null || row.status === "CANCELLED" || row.status === "SUCCEEDED") throw changed();
  if (row.status !== "FAILED") return "receipt-then-refund-note";
  if (asRecord(row.requestPayload)?.plan != null) return "receipt-held-for-officer";
  const requeued = await returnOutboxRowToPending({
    operationId,
    store: tx,
    where: { status: "FAILED", manuallyResolvedAt: null },
    data: UNCLAIMED,
    request: { keep: true },
  });
  if (requeued.outcome === "pending") return "receipt-then-refund-note";
  if (requeued.outcome === "unclaimable") return "receipt-held-for-officer";
  // Lost: an officer's retry or the outbox's claim moved the row after the read. Answer what it is now.
  const now = await tx.xeroSyncOperation.findUnique({ where: { id: operationId }, select: { status: true, manuallyResolvedAt: true } });
  if (now && now.manuallyResolvedAt === null && (now.status === "PENDING" || now.status === "RUNNING")) return "receipt-then-refund-note";
  throw changed();
}
