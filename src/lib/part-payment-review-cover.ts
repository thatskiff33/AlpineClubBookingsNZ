/**
 * #3643 (`INV-PAY-108`, ORCHESTRATOR DECISION 3 on the thread): a later PAID
 * invoice event for a payment whose cancel raised a part-payment review.
 *
 * The review is the treasurer's instruction to settle, in Xero, the cash
 * recorded against the invoice when the booking was cancelled as unpaid. When
 * the invoice later reports PAID - because the treasurer cleared the rest with
 * a credit note, as the review tells them to, or because more cash arrived -
 * the inbound sync's late-cash arms would otherwise size a hand-back (an
 * organisation's booking) or mint account credit (a member's) from the
 * invoice's whole cash, which includes the reviewed part payment: the same
 * money handed back twice.
 *
 * Sizing "only the cash beyond the review" was tried and rejected: it assumes
 * the reviewed payment is still on the invoice, and the review tells the
 * treasurer to refund it or apply it, which usually takes it off. So while a
 * review exists, OPEN or DISMISSED, both arms size nothing and mint nothing.
 * This module writes the fact onto the review instead, in the arm's own
 * transaction: when the sync learned the invoice was paid, and the invoice's
 * cash in cents. A DISMISSED review is put back on the queue; an OPEN one stays
 * open. The email the caller sends is best-effort; this note is the record.
 *
 * ONCE PER REVIEW. The note is written only while it is empty, under
 * `pg_advisory_xact_lock(1)` (held by the arm, and taken by the officer's
 * reopen too), with the emptiness in the status-fenced `updateMany`'s `where`,
 * so a replayed or re-polled event adds nothing. In practice the arm is not
 * even reached again: its first run flips the payment to SUCCEEDED.
 *
 * The review is found by its marker (`partPaymentReviewPaymentId`), never by
 * `paymentId`, which a review leaves NULL on purpose (migration
 * 20261014010000).
 */
import { ManualRefundTaskStatus, type Prisma } from "@prisma/client";

import { bookingOwner } from "@/lib/booking-owner";
import { recordManualRefundTaskReopenAudit } from "@/lib/manual-refund-task-reopen-audit";

export type PartPaymentReviewRouting =
  | { routed: false }
  | {
      routed: true;
      taskId: string;
      /** A DISMISSED review was put back on the queue by this event. */
      reopened: boolean;
      /** This event wrote the note; false on a replay that found one. */
      noted: boolean;
    };

export async function routeLateCashToPartPaymentReview(
  tx: Prisma.TransactionClient,
  input: {
    paymentId: string;
    /** The invoice this PAID event is for, for the audit entry. */
    eventInvoiceId: string;
    /** The invoice's cash at this read, as the arm quantified it. */
    cashCents: number;
  },
): Promise<PartPaymentReviewRouting> {
  const review = await tx.manualRefundTask.findUnique({
    where: { partPaymentReviewPaymentId: input.paymentId },
    select: {
      id: true,
      bookingId: true,
      kind: true,
      amountCents: true,
      raisedAmountCents: true,
      status: true,
      completedAt: true,
      completedByMemberId: true,
      note: true,
      partPaymentReviewXeroPaidAt: true,
      booking: { select: { memberId: true } },
    },
  });
  if (!review) return { routed: false };
  if (review.partPaymentReviewXeroPaidAt !== null) {
    return { routed: true, taskId: review.id, reopened: false, noted: false };
  }

  const note = {
    partPaymentReviewXeroPaidAt: new Date(),
    partPaymentReviewXeroPaidCents: input.cashCents,
  };
  const reopen = review.status === ManualRefundTaskStatus.DISMISSED;
  // The dismissing officer's own note is left as they wrote it; the reopen's
  // reason goes in the audit entry, as on the officer's reopen.
  const claimed = await tx.manualRefundTask.updateMany({
    where: {
      id: review.id,
      status: review.status,
      partPaymentReviewXeroPaidAt: null,
    },
    data: reopen
      ? {
          ...note,
          status: ManualRefundTaskStatus.OPEN,
          completedAt: null,
          completedByMemberId: null,
        }
      : note,
  });
  const noted = claimed.count > 0;
  if (noted && reopen) {
    await recordManualRefundTaskReopenAudit({
      task: review,
      subjectMemberId: bookingOwner(review.booking).memberId,
      actingMemberId: null,
      summary: "Part-payment review put back on the queue: Xero reported the invoice paid",
      details:
        "Xero reported this cancelled booking's invoice as paid while a part-payment review existed, so nothing was credited or handed back automatically; the review carries the date and the invoice's cash.",
      extraMetadata: {
        partPaymentReviewPaymentId: input.paymentId,
        xeroInvoiceId: input.eventInvoiceId,
        xeroPaidCents: input.cashCents,
      },
      store: tx,
    });
  }
  return { routed: true, taskId: review.id, reopened: noted && reopen, noted };
}
