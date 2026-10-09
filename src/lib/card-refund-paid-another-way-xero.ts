import "server-only";

import type { Prisma } from "@prisma/client";

import type { ClubTimeZone } from "@/lib/club-time";
import { decideLateCapture } from "@/lib/late-capture-kept-xero-rules";
import {
  findKeptLateCaptureInvoiceIdForPayment,
  readLateCaptureXeroReceipt,
} from "@/lib/late-capture-xero-receipt";
import { lateCaptureIntentOfApprovalRefundRecoveryKey } from "@/lib/payment-recovery-keys";
import {
  enqueueXeroKeptLateCaptureInvoiceOperation,
  keptLateCaptureDocumentDate,
  lockKeptLateCaptureTask,
} from "@/lib/xero-kept-late-capture-invoice";
import { enqueueXeroRefundCreditNoteOperation } from "@/lib/xero-operation-outbox";
import { xeroDocumentDateFromInstant } from "@/lib/xero-provider-dates";

/**
 * #3372 / #3924 rounds 5 and 6 (`INV-PAY-121`): WHAT A "PAID ANOTHER WAY" CLOSE
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
      /** The late capture's receipt the close queues first, on its approval task. */
      receipt: { manualRefundTaskId: string; paymentIntentId: string; capturedCents: number; raisedAt: Date };
    };

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
 * `lockApprovalTask` (the close only): the approval task's row is taken BEFORE
 * the receipt is read; see the module's LOCKS.
 *
 * STATED LIMIT: a payment whose invoice is still on its way to Xero reads as
 * having none, and its close queues no note; the toast says to check Xero.
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
  // Round 7 (money M5, `INV-PAY-121`): the note credits THIS receipt, named by
  // its invoice id - never by `paymentIntentId`, which would count the bank
  // note as the capture's card refund note. A receipt recorded but not yet in
  // Xero (a change's released invoice still sending) has no id to name: the
  // stated limit below, as for any invoice still on its way.
  if (receipt.kind === "recorded") {
    return receipt.invoiceId !== null
      ? { xeroRefundNote: "now", creditsInvoiceId: receipt.invoiceId }
      : { xeroRefundNote: "none" };
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

/** What the close queued in Xero: its refund note, the late charge's receipt with the note to follow it, or nothing. */
export type PaidAnotherWayXeroQueued = "refund-note" | "receipt-then-refund-note" | "nothing";

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
 *   refusal is a fault and nothing commits;
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
  const queued = await enqueueXeroKeptLateCaptureInvoiceOperation({
    manualRefundTaskId: plan.receipt.manualRefundTaskId,
    bookingId: close.bookingId,
    paymentIntentId: plan.receipt.paymentIntentId,
    capturedCents: plan.receipt.capturedCents,
    capturedOn: keptLateCaptureDocumentDate(plan.receipt.raisedAt, close.clubZone),
    createdByMemberId: close.actingMemberId,
    // Round 7 (money M2): a receipt row that failed before it reached Xero is
    // put back to run, never left FAILED as if it were live.
    requeueFailedUnsent: true,
    store: tx,
  });
  if (queued.queueOperationId === null) {
    throw new Error(
      `Paid-another-way close ${close.operationId}: the late charge's Xero receipt could not be queued (${queued.message})`,
    );
  }
  return "receipt-then-refund-note";
}
