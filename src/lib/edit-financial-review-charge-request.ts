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

import { createAuditLog } from "@/lib/audit";
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
 *   * WHAT COULD NOT BE ASKED FOR - `recordUncollectedEditReviewChargeShare`, the
 *     durable record that a settled share met a request it could not join. It
 *     sits here rather than beside the writes because it is a fact ABOUT the
 *     request, and because a `logger.warn` is not a record anybody can find.
 *   * WHAT XERO IS BILLING - `restateEditReviewChargeSupplementaryInvoice`, which
 *     RAISES the queued invoice rather than letting a second one be queued behind
 *     it and silently dropped, and never lowers one. The enqueue makes the same
 *     decision under a per-anchor advisory lock, so the two together are what
 *     stop two concurrent settlements sending two invoices; this function alone
 *     never could.
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
 * Returns true when the Xero side is already asking for at least the combined
 * total and the caller must NOT queue anything further. False means this edit has
 * nothing queued - the first share's ordinary answer - and the caller enqueues
 * normally.
 *
 * TRUE COVERS TWO CASES, and conflating them was the bug. `restated` is an
 * invoice this call RAISED; `alreadyCovering` is one already asking for at least
 * this much, which happens on an exact replay and when a STALE, smaller total
 * arrives after a larger one. Both mean "do not queue a second invoice", and
 * neither writes anything in the second case, because
 * `restatePendingSupplementaryInvoiceAmount` refuses to lower an ask.
 *
 * WHAT THE ACCOUNTING LEG NOW GUARANTEES, stated exactly rather than as "never
 * two invoices":
 *
 *   * A queued supplementary invoice for one edit is only ever RAISED, never
 *     lowered, whichever order two concurrent settlements land in.
 *   * At most one supplementary invoice is queued per edit. The enqueue decides
 *     that under a per-anchor advisory lock and scoped to the anchor rather than
 *     to the amount, so a second settlement racing this one finds the first
 *     invoice and raises it instead of queueing its own.
 *   * NOT guaranteed: that a restate always lands. The outbox worker reads an
 *     operation's payload from its scan before it claims the row, so a restate
 *     arriving in that window is correctly refused and the invoice goes out at
 *     the earlier figure. The shortfall is recorded; nothing is overwritten
 *     behind a send, and no second invoice is raised.
 *
 * Best-effort: a Xero outage must not undo a completion whose money question is
 * already settled, so a failure is logged and treated as "nothing restated". The
 * ordinary enqueue that then runs then makes the same decision under the lock.
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
  const outcome = await restatePendingSupplementaryInvoiceAmount({
    bookingModificationId,
    priceDiffCents: totalCents,
    changeFeeCents: 0,
  }).catch((err) => {
    logger.error(
      { err, bookingId, taskId },
      "Failed to restate the queued Xero supplementary invoice for a completed edit financial review",
    );
    return { restated: 0, alreadyCovering: 0 };
  });
  return outcome.restated + outcome.alreadyCovering > 0;
}

/**
 * The durable, officer-findable record that a settled share could not be added to
 * this edit's request.
 *
 * #3170 fix round (F5). `logger.warn` is not a queue: nobody goes looking through
 * a log stream for money the club is owed. The audit log is the record an officer
 * can actually find, and it is where every other money decision on this booking
 * already is.
 *
 * Best-effort and never rethrown: a settlement whose money question is already
 * answered must not be undone because an audit insert failed. The log line stays
 * as the second line.
 */
export async function recordUncollectedEditReviewChargeShare({
  bookingId,
  bookingModificationId,
  memberId,
  derivedTotalCents,
  requestedTotalCents,
}: {
  bookingId: string;
  bookingModificationId: string;
  memberId: string | null;
  derivedTotalCents: number;
  requestedTotalCents: number;
}) {
  logger.warn(
    {
      bookingId,
      bookingModificationId,
      derivedTotalCents,
      requestedTotalCents,
    },
    "Edit-financial-review charge request was paid before its combined total could be raised - the remaining share must be collected by hand",
  );
  try {
    await createAuditLog({
      action: "booking.editFinancialReview.chargeShareUncollected",
      subjectMemberId: memberId,
      targetId: bookingId,
      entityType: "Booking",
      entityId: bookingId,
      category: "payment",
      severity: "important",
      outcome: "failure",
      summary:
        "A settled review share could not be added to this booking change's payment request",
      details:
        "An admin settled a booking-change review as money the member owes the club, but the request for that change had already been paid, so the extra amount was not added to it. Collect this amount another way and record what was collected.",
      metadata: {
        bookingModificationId,
        derivedTotalCents,
        requestedTotalCents,
        uncollectedCents: Math.max(derivedTotalCents - requestedTotalCents, 0),
      },
    });
  } catch (err) {
    logger.error(
      { err, bookingId, bookingModificationId },
      "Failed to record the audit trace for an uncollected edit-financial-review charge share",
    );
  }
}
