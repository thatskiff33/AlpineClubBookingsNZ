/**
 * #3643 (`INV-PAY-107`, task-queue review F1): what a later PAID invoice event
 * may still do for a payment whose cancel raised a part-payment review.
 *
 * The review is the treasurer's instruction to settle, in Xero, the cash
 * recorded against the invoice when the booking was cancelled as unpaid. When
 * the invoice later reports PAID - because the treasurer cleared the rest with
 * a credit note, as the review tells them to, or because more cash arrived -
 * the inbound sync's late-cash arms would otherwise size a hand-back (an
 * organisation's booking) or mint account credit (a member's) from the
 * invoice's WHOLE cash, which includes the reviewed part payment. That hands
 * the same money back twice: once by the treasurer in Xero, once here.
 *
 * So both arms ask this module first, and the answer is one of:
 *  - `none`: no review names this payment; the arm runs as it always has.
 *  - `beyond`: the review recorded the cash it covers exactly, and this event's
 *    cash is exact too, so the arm may act on the cash BEYOND the reviewed
 *    figure and nothing else (`beyondCents`, which may be zero).
 *  - `route`: either figure is unknown, so the arm moves no money at all and
 *    the event goes to the review: a dismissed review is put back on the queue
 *    (`reopened`), an open one already is.
 *
 * The review is found by its marker (`partPaymentReviewPaymentId`), never by
 * `paymentId`, which a review leaves NULL on purpose (migration
 * 20261014010000). Called inside the arm's transaction, under
 * `pg_advisory_xact_lock(1)`, which is also the lock the officer's reopen takes
 * (`manual-refund-task-reopen.ts`), so the reopen here serialises with it.
 */
import { ManualRefundTaskStatus, type Prisma } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";

export type PartPaymentReviewCover =
  | { kind: "none" }
  | { kind: "beyond"; taskId: string; reviewedCents: number; beyondCents: number }
  | { kind: "route"; taskId: string; reopened: boolean };

export async function readPartPaymentReviewCover(
  tx: Prisma.TransactionClient,
  input: {
    paymentId: string;
    bookingId: string;
    /** The invoice the review's figure was read from: the payment's own. */
    paymentInvoiceId: string | null;
    /** The invoice this PAID event is for. */
    eventInvoiceId: string;
    /** This event's cash, as the arm quantified it. */
    cash: { knownCents: number; complete: boolean };
    /** What the arm would otherwise act on (its face- and aggregate-capped figure). */
    mintableCents: number;
  },
): Promise<PartPaymentReviewCover> {
  const review = await tx.manualRefundTask.findUnique({
    where: { partPaymentReviewPaymentId: input.paymentId },
    select: {
      id: true,
      kind: true,
      status: true,
      partPaymentReviewRecordedCents: true,
      completedAt: true,
      completedByMemberId: true,
      note: true,
    },
  });
  if (!review) return { kind: "none" };

  const reviewedCents = review.partPaymentReviewRecordedCents;
  if (
    reviewedCents !== null &&
    input.cash.complete &&
    input.paymentInvoiceId === input.eventInvoiceId
  ) {
    const newCashCents = Math.max(0, input.cash.knownCents - reviewedCents);
    return {
      kind: "beyond",
      taskId: review.id,
      reviewedCents,
      beyondCents: Math.min(input.mintableCents, newCashCents),
    };
  }

  // Unsizable: the whole event is the review's. A dismissed review is put back
  // on the queue, status-fenced as the officer's reopen is; the dismissing
  // officer's note is left as they wrote it, and the audit entry says why.
  if (review.status !== ManualRefundTaskStatus.DISMISSED) {
    return { kind: "route", taskId: review.id, reopened: false };
  }
  const claimed = await tx.manualRefundTask.updateMany({
    where: { id: review.id, status: ManualRefundTaskStatus.DISMISSED },
    data: { status: ManualRefundTaskStatus.OPEN, completedAt: null, completedByMemberId: null },
  });
  if (claimed.count > 0) {
    await createAuditLog(
      {
        action: "booking-payment.manual-refund-task.reopen",
        targetId: input.bookingId,
        entityType: "ManualRefundTask",
        entityId: review.id,
        category: "payment",
        severity: "important",
        outcome: "success",
        summary: "Part-payment review put back on the queue: Xero reported the invoice paid",
        details:
          "Xero reported this cancelled booking's invoice as paid, and the amount the review covers is not known exactly, so nothing was credited or handed back automatically.",
        metadata: {
          taskId: review.id,
          bookingId: input.bookingId,
          kind: review.kind,
          partPaymentReviewPaymentId: input.paymentId,
          xeroInvoiceId: input.eventInvoiceId,
          dismissedByMemberId: review.completedByMemberId,
          dismissedAt: review.completedAt?.toISOString() ?? null,
          dismissalNote: review.note,
        },
      },
      tx,
    );
  }
  return { kind: "route", taskId: review.id, reopened: claimed.count > 0 };
}

/** The cents an arm may act on under a cover: all of it, the new cash, or none. */
export function coveredActionableCents(
  cover: PartPaymentReviewCover,
  mintableCents: number,
): number {
  if (cover.kind === "none") return mintableCents;
  if (cover.kind === "beyond") return cover.beyondCents;
  return 0;
}
