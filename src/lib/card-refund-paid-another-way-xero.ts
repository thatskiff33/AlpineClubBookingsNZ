import "server-only";

import type { Prisma } from "@prisma/client";

import type { ClubTimeZone } from "@/lib/club-time";
import { decideLateCapture } from "@/lib/late-capture-kept-xero-rules";
import {
  findKeptLateCaptureInvoiceIdForPayment,
  readLateCaptureXeroReceipt,
} from "@/lib/late-capture-xero-receipt";
import type { PaidAnotherWayXeroNote } from "@/lib/manual-refund-task-settlement-rules";
import { lateCaptureIntentOfApprovalRefundRecoveryKey } from "@/lib/payment-recovery-keys";
import {
  enqueueXeroKeptLateCaptureInvoiceOperation,
  keptLateCaptureDocumentDate,
  lockKeptLateCaptureTask,
} from "@/lib/xero-kept-late-capture-invoice";
import { enqueueXeroRefundCreditNoteOperation } from "@/lib/xero-operation-outbox";
import { xeroDocumentDateFromInstant } from "@/lib/xero-provider-dates";

/**
 * #3372 / #3924 rounds 5 and 6 (`INV-PAY-122`): WHAT A "PAID ANOTHER WAY" CLOSE
 * RECORDS IN XERO - decided before the close's record, whose key carries the
 * answer (`PaidAnotherWayXeroNote`), and queued on the close's transaction
 * after it. The close itself, its locks and its money are
 * `card-refund-paid-another-way.ts`'s.
 */

type XeroPlanStore = Pick<
  Prisma.TransactionClient,
  "$executeRaw" | "manualRefundTask" | "paymentTransaction" | "xeroObjectLink" | "xeroSyncOperation"
>;

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
    };

/**
 * What the dialog promises before the close (#3924 round 8): the plan's note,
 * with a receipt already on its way to Xero told apart from one the close
 * queues, since the treasurer reads different words for each.
 */
export type PaidAnotherWayXeroPromise = PaidAnotherWayXeroNote | "after-receipt-on-its-way";

export function paidAnotherWayXeroPromise(plan: PaidAnotherWayXeroPlan): PaidAnotherWayXeroPromise {
  return plan.xeroRefundNote === "after-receipt" && plan.receipt === null
    ? "after-receipt-on-its-way"
    : plan.xeroRefundNote;
}

/**
 * #3924 round 5 (F4; owner, 8 Oct 2026: "Raise a refund note for all") and
 * round 6 (owner, 8 Oct 2026: "Record receipt, then credit"): HOW A CLOSE OF
 * THIS CARD REFUND IS RECORDED IN XERO. Its bank-transfer refund note credits
 * the invoice the note executor names (`createXeroCreditNote`), so the dialog
 * never promises a note that will fail:
 *
 * - a treasurer-approved late capture's refund: the capture's own receipt.
 *   Recorded by the app (`readLateCaptureXeroReceipt`, `INV-PAY-110`): the note
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
 * invoice is in Xero (`noteWaitingPaidAnotherWayCloseAfterChangeInvoice`).
 *
 * `lockApprovalTask` (the close only): the approval task's row is taken BEFORE
 * the receipt is read; see the module's LOCKS.
 *
 * STATED LIMIT: a payment that is not a late capture's, whose invoice is still
 * on its way to Xero, reads as having none, and its close queues no note; the
 * toast says to check Xero.
 */
export async function paidAnotherWayXeroPlan(
  db: XeroPlanStore,
  operation: { idempotencyKey: string },
  payment: { id: string; xeroInvoiceId: string | null },
  { lockApprovalTask }: { lockApprovalTask: boolean },
): Promise<PaidAnotherWayXeroPlan> {
  const lateCaptureIntent = lateCaptureIntentOfApprovalRefundRecoveryKey(operation.idempotencyKey);
  if (lateCaptureIntent === null) {
    const hasInvoice =
      payment.xeroInvoiceId !== null || (await findKeptLateCaptureInvoiceIdForPayment(payment.id, db)) !== null;
    return hasInvoice ? { xeroRefundNote: "now" } : { xeroRefundNote: "none" };
  }
  const task = await db.manualRefundTask.findUnique({
    where: { lateCaptureApprovalIntentId: lateCaptureIntent },
    select: { id: true, status: true, createdAt: true },
  });
  if (task && lockApprovalTask) await lockKeptLateCaptureTask(db, task.id);
  const receipt = await readLateCaptureXeroReceipt(lateCaptureIntent, db);
  // Round 7 (money M5, `INV-PAY-122`): the note credits THIS receipt, named by
  // its invoice id - never by `paymentIntentId`, which would count the bank
  // note as the capture's card refund note. Round 8: a receipt recorded but
  // not yet in Xero (a change's released invoice queued, sending or FAILED)
  // has no id to name yet, so the note waits for it.
  if (receipt.kind === "recorded") {
    if (receipt.invoiceId !== null) return { xeroRefundNote: "now", creditsInvoiceId: receipt.invoiceId };
    return task ? { xeroRefundNote: "after-receipt", receipt: null } : { xeroRefundNote: "none" };
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
  };
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
 * (round 8), or nothing.
 */
export type PaidAnotherWayXeroQueued =
  | "refund-note"
  | "receipt-then-refund-note"
  | "refund-note-after-receipt"
  | "nothing";

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
 *   worker queues the note once it is in Xero;
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
    const queued = await enqueueXeroRefundCreditNoteOperation(close.paymentId, close.amountCents, {
      createdByMemberId: close.actingMemberId,
      refundMethod: "internet-banking",
      paidAnotherWayTaskId: close.recordId,
      // Round 7 (money M4): the club day of the close, as the receipt's worker
      // dates a waiting close's note (`notePaidAnotherWayCloseOnReceipt`).
      documentDate: xeroDocumentDateFromInstant(close.closedAt, close.clubZone),
      ...(plan.creditsInvoiceId ? { creditsInvoiceId: plan.creditsInvoiceId } : {}),
      store: tx,
    });
    return queued.queueOperationId !== null ? "refund-note" : "nothing";
  }
  if (plan.xeroRefundNote === "none") return "nothing";
  if (plan.receipt === null) return "refund-note-after-receipt";
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
    // follows that retry.
    requeueFailedUnsent: true,
    store: tx,
  });
  if (queued.queueOperationId === null) {
    if (queued.changedByOfficer) throw new PaidAnotherWayXeroChangedError(queued.message);
    throw new Error(
      `Paid-another-way close ${close.operationId}: the late charge's Xero receipt could not be queued (${queued.message})`,
    );
  }
  return "receipt-then-refund-note";
}
