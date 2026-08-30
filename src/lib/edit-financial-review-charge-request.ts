import "server-only";

import {
  ManualRefundTaskDirection,
  ManualRefundTaskKind,
  ManualRefundTaskStatus,
  PaymentSource,
  PaymentTransactionKind,
  type PaymentStatus,
  type Prisma,
} from "@prisma/client";

import { parseEditFinancialReviewContext } from "@/lib/edit-financial-review-context";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { buildEditFinancialReviewChargeReason } from "@/lib/payment-recovery-keys";
import { restatePendingSupplementaryInvoiceAmount } from "@/lib/xero-operation-outbox";

/**
 * #3170 (epic #2797): WHAT ONE BOOKING EDIT'S SINGLE CHARGE REQUEST IS, and what
 * it is owed.
 *
 * The reads, kept apart from `edit-financial-review-charge.ts`, which is the
 * WRITES - choosing the route, minting or raising the intent. The seam is worth
 * having on its own merits and not only for the file-size ratchet: every
 * question here is asked from three places that must all get the same answer -
 * the pre-claim refusal, the post-commit sync, and the recovery replay - and a
 * second spelling of any of them is how two of those three come to disagree
 * about whether an edit already has a request.
 *
 * The owner's 30 Aug 2026 decision on #3170 is that two review tasks over one
 * booking edit contribute to a SINGLE request for the total, each task recording
 * its own share. So there are two facts to establish and one to restate:
 *
 *   * WHAT IS OWED - `sumEditReviewChargeSharesCents`, derived from the settled
 *     shares and never incremented.
 *   * WHAT THE REQUEST IS - `findEditReviewChargeRequest` on the card side and
 *     `hasIssuedSupplementaryInvoice` on the invoice side, both keyed on the edit.
 *   * WHAT XERO IS BILLING - `restateEditReviewChargeSupplementaryInvoice`, which
 *     raises the queued invoice rather than letting a second one be queued behind
 *     it and silently dropped.
 */

export type EditReviewChargeStore = Prisma.TransactionClient | typeof prisma;

/** This edit's combined request as the ledger currently holds it. */
export type EditReviewChargeRequest = {
  paymentTransactionId: string;
  stripePaymentIntentId: string | null;
  amountCents: number;
  status: PaymentStatus;
};

/**
 * The combined request for ONE edit, found from the edit alone.
 *
 * Identified by the `reason` the charge module stamps on the `ADDITIONAL`
 * PaymentTransaction (`buildEditFinancialReviewChargeReason`), matched on exact
 * equality. A later share knows its `BookingModification` and nothing about the
 * share that came before it, so the request has to be findable from the anchor;
 * the ledger row carries no anchor column, and the payment's "latest additional"
 * is the WRONG answer because an ORDINARY edit's price increase sits in the same
 * place - same payment, same kind - and restating that as if it were part of this
 * review would erase an unrelated ask.
 */
export async function findEditReviewChargeRequest({
  paymentId,
  bookingModificationId,
  store = prisma,
}: {
  paymentId: string;
  bookingModificationId: string;
  store?: EditReviewChargeStore;
}): Promise<EditReviewChargeRequest | null> {
  const row = await store.paymentTransaction.findFirst({
    where: {
      paymentId,
      kind: PaymentTransactionKind.ADDITIONAL,
      source: PaymentSource.STRIPE,
      reason: buildEditFinancialReviewChargeReason(bookingModificationId),
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      stripePaymentIntentId: true,
      amountCents: true,
      status: true,
    },
  });
  if (!row) return null;
  return {
    paymentTransactionId: row.id,
    stripePaymentIntentId: row.stripePaymentIntentId,
    amountCents: row.amountCents,
    status: row.status,
  };
}

/**
 * Has this edit's supplementary Xero invoice already been issued?
 *
 * An issued supplementary invoice is an ask that has left the building. The
 * outbox refuses to queue a second one for the same anchor (an active
 * `SUPPLEMENTARY_INVOICE` link) and returns a MESSAGE rather than an error, so a
 * later share queued behind it would be dropped SILENTLY - the failure this whole
 * issue exists to remove. Asked before the claim, so the answer is a refusal the
 * officer can act on instead.
 */
export async function hasIssuedSupplementaryInvoice({
  bookingModificationId,
  store = prisma,
}: {
  bookingModificationId: string;
  store?: EditReviewChargeStore;
}): Promise<boolean> {
  const link = await store.xeroObjectLink.findFirst({
    where: {
      localModel: "BookingModification",
      localId: bookingModificationId,
      xeroObjectType: "INVOICE",
      role: "SUPPLEMENTARY_INVOICE",
      active: true,
    },
    select: { id: true },
  });
  return Boolean(link);
}

/**
 * The combined total this edit's request must ask for: the SUM of every share
 * already settled as money owed to the club against this same edit.
 *
 * DERIVED, NEVER INCREMENTED, and that is the whole concurrency argument. A
 * running figure raised by `+= share` double-counts a retry and loses a share to
 * a lost update; a sum over the rows that carry the shares can do neither,
 * because each task contributes exactly once and contributes from the row its own
 * status-fenced claim wrote.
 *
 * The shares are found by `bookingId` + kind + status + direction and then
 * filtered on the anchor through `parseEditFinancialReviewContext` - the one
 * parser (`INV-SSOT`, #3030) - rather than by indexing into the stored JSON in a
 * query. A booking has a handful of these rows, never a page of them.
 */
export async function sumEditReviewChargeSharesCents({
  bookingId,
  bookingModificationId,
  store = prisma,
}: {
  bookingId: string;
  bookingModificationId: string;
  store?: EditReviewChargeStore;
}): Promise<number> {
  const settled = await store.manualRefundTask.findMany({
    where: {
      bookingId,
      kind: ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW,
      status: ManualRefundTaskStatus.COMPLETED,
      settlementDirection: ManualRefundTaskDirection.CHARGE_TO_MEMBER,
      amountCents: { not: null },
    },
    select: { id: true, amountCents: true, reviewContext: true },
  });

  let total = 0;
  for (const task of settled) {
    const anchor = parseEditFinancialReviewContext(task.reviewContext)
      ?.bookingModificationId;
    if (anchor !== bookingModificationId) continue;
    total += task.amountCents ?? 0;
  }
  return total;
}

/**
 * Raise what this edit's ALREADY-QUEUED supplementary invoice will bill, when it
 * has one.
 *
 * Returns true when the Xero side is now asking for the combined total and the
 * caller must NOT queue anything further. False means this edit has nothing
 * queued - the first share's ordinary answer - and the caller enqueues normally.
 *
 * Best-effort: a Xero outage must not undo a completion whose money question is
 * already settled, so a failure is logged and treated as "nothing restated". The
 * ordinary enqueue that then runs is itself deduped by the outbox, so the worst
 * case is an invoice left at the earlier figure with the failure recorded, never
 * two invoices.
 */
export async function restateEditReviewChargeSupplementaryInvoice({
  bookingId,
  taskId,
  bookingModificationId,
  totalCents,
}: {
  bookingId: string;
  taskId: string;
  bookingModificationId: string;
  totalCents: number;
}): Promise<boolean> {
  const restated = await restatePendingSupplementaryInvoiceAmount({
    bookingModificationId,
    priceDiffCents: totalCents,
    changeFeeCents: 0,
  }).catch((err) => {
    logger.error(
      { err, bookingId, taskId },
      "Failed to restate the queued Xero supplementary invoice for a completed edit financial review",
    );
    return { restated: 0 };
  });
  return restated.restated > 0;
}
