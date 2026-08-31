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
import { formatCents } from "@/lib/utils";
import {
  restatePendingSupplementaryInvoiceAmount,
  type XeroSupplementaryInvoiceEnqueueOutcome,
} from "@/lib/xero-operation-outbox";

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
 *   * A restate that WRITES is a restate that GOES OUT. The outbox worker used
 *     to read an operation's payload from its scan and claim the row a Xero
 *     round trip later; in that window the row is still PENDING, so a restate
 *     matched, wrote, and reported success while the send used the scanned
 *     figure - and this function's caller returned early believing the combined
 *     total was billed. The worker now re-reads after the claim, so `restated`
 *     means what it says (#3170 fix round, F1).
 *   * NOT guaranteed: that a restate can land AT ALL. Once the worker has
 *     claimed the operation it is RUNNING, and once the invoice has been sent
 *     the anchor carries an active `SUPPLEMENTARY_INVOICE` link; a share settled
 *     after either point meets an ask that has left the building. This function
 *     then reports nothing restated, the caller falls through to the ordinary
 *     enqueue, and the enqueue refuses to queue a second invoice - correctly,
 *     but the invoice bills the earlier figure and the difference has to be
 *     collected by hand. The enqueue says so in its `outcome`, and the
 *     settlement writes the audit row below with leg `xero-invoice`, so the
 *     shortfall is a record an officer can find rather than a silence.
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
 * WHICH ASK a settled share failed to join. There are two, they fail in
 * different windows, and an officer reading the audit log has to be told which
 * one so they know what to do next.
 *
 *   * `payment-request` - the card side. The member's additional PaymentIntent
 *     was already PAID when this share arrived, so the amount could not be added
 *     to it. The member owes the club the difference.
 *   * `xero-invoice` - the accounting side. This edit's supplementary invoice had
 *     already been claimed for sending, or already sent, so it bills the earlier
 *     figure. On the internet-banking route that invoice IS the ask, so this is
 *     money the club has not asked for; on the card route the card request is
 *     correct and it is the books that are short.
 */
export type UncollectedEditReviewChargeLeg = "payment-request" | "xero-invoice";

/**
 * WHY the settled share never reached that ask, which is a different question
 * from which ask it was and needs a different sentence (#3181).
 *
 *   * `ask-closed` - an ask EXISTS and could not take this share. The card
 *     request was already paid; the supplementary invoice was already claimed
 *     for sending. The club is short by the difference.
 *   * `ask-not-raised` - NO ask was made at all. The recovery replay that owed
 *     this edit a supplementary invoice could not queue one, so the accounts hold
 *     nothing for the charge rather than holding too little.
 *   * `ask-owed-unknown` - the club does not know whether an ask was owed, and
 *     says so rather than guessing (#3181 fix round). A recovery row enqueued
 *     before `hadIssuedXeroInvoice` existed carries NULL, and the replay's whole
 *     position on NULL is that it cannot tell whether the edit had a primary
 *     invoice to supplement. It must not borrow `ask-not-raised`'s sentence,
 *     which tells an officer to raise the invoice by hand: on a booking whose
 *     primary invoice had not been minted when the edit committed, that invoice
 *     bills the charge itself, and raising a second one BILLS THE MEMBER TWICE.
 *     The instrument here is the booking-vs-Xero repair pass, which compares the
 *     booking against Xero and can answer the question this record cannot.
 *
 * Four of the six combinations are produced today: the card leg only ever closes
 * (its ask is the intent, which exists by the time this can happen), and the
 * accounting leg produces all three. The rest are not refused, because a
 * leg/cause pair is a description of what happened rather than a claim about
 * what can.
 */
export type UncollectedEditReviewChargeCause =
  | "ask-closed"
  | "ask-not-raised"
  | "ask-owed-unknown";

/**
 * The accounting leg's half of that record, decided from the enqueue's own
 * verdict (#3170 fix round, F2).
 *
 * `short` is the enqueue saying it found an invoice for this edit and could NOT
 * raise it: the outbox has claimed the operation, or it has already been sent.
 * Refusing to queue a second invoice behind it is right - two invoices for one
 * edit is the failure this round removed - but the invoice then bills the earlier
 * figure and the club collects the difference by hand, so the difference has to
 * be findable.
 *
 * It lives HERE rather than at the dispatch site because the question and its
 * answer are one idea: `covers-total` and `none` are silence, `short` is a
 * record, and a caller re-deriving that mapping is how the two legs come to
 * disagree about what counts as a shortfall.
 *
 * Returns whether a record was written, so a test can tell "no shortfall" from
 * "never asked".
 */
export async function recordShortEditReviewChargeInvoice({
  outcome,
  bookingId,
  bookingModificationId,
  memberId,
  totalCents,
}: {
  outcome: XeroSupplementaryInvoiceEnqueueOutcome;
  bookingId: string;
  bookingModificationId: string;
  memberId: string | null;
  totalCents: number;
}): Promise<boolean> {
  if (outcome !== "short") return false;
  await recordUncollectedEditReviewChargeShare({
    leg: "xero-invoice",
    // `short` is by definition an ask that exists and could not be raised.
    cause: "ask-closed",
    bookingId,
    bookingModificationId,
    memberId,
    derivedTotalCents: totalCents,
    // Unknowable by design: the outbox handler overwrites the operation's
    // payload with the Xero invoice body when it sends, so the figure the invoice
    // actually bills is no longer on the row. The record says "short of this
    // total" rather than inventing the difference.
    requestedTotalCents: null,
  });
  return true;
}

/**
 * The durable, officer-findable record that a settled share could not be added to
 * this edit's request.
 *
 * #3170 fix round (F5, widened in F2). `logger.warn` is not a queue: nobody goes
 * looking through a log stream for money the club is owed. The audit log is the
 * record an officer can actually find, and it is where every other money decision
 * on this booking already is.
 *
 * ONE WRITE SITE FOR BOTH LEGS, deliberately. The card race and the accounting
 * race are the same fact about the same edit - a settled share that met an ask it
 * could not join - and splitting them would put the same money story in two
 * shapes an officer has to learn separately. The `leg` chooses the prose; the
 * action, category and severity are one answer.
 *
 * THE FIGURE IS IN THE PROSE, not only in the metadata. Audit prose is what an
 * officer reads in the list, and a summary saying "an amount" over a metadata
 * blob saying which one is a record they have to open twice.
 *
 * Best-effort and never rethrown: a settlement whose money question is already
 * answered must not be undone because an audit insert failed. The log line stays
 * as the second line.
 */
export async function recordUncollectedEditReviewChargeShare({
  leg,
  cause,
  bookingId,
  bookingModificationId,
  memberId,
  derivedTotalCents,
  requestedTotalCents,
}: {
  leg: UncollectedEditReviewChargeLeg;
  /**
   * #3181: whether the ask existed and could not take the share, or was never
   * made. Required rather than defaulted: `ask-closed` was the only case when
   * this function was written, and a default would have quietly told an officer
   * that an invoice they do not have bills too little.
   */
  cause: UncollectedEditReviewChargeCause;
  bookingId: string;
  bookingModificationId: string;
  memberId: string | null;
  derivedTotalCents: number;
  /**
   * What the ask actually holds, when that is knowable.
   *
   * The card leg reads it straight off the `ADDITIONAL` ledger row. The
   * accounting leg CANNOT: `createXeroSupplementaryInvoice` overwrites the
   * operation's `requestPayload` with the Xero invoice body at dispatch, so once
   * the row has been claimed the amount it was queued with is gone. Null says
   * "short by an amount this record cannot state" rather than inventing one -
   * the same refusal to guess a figure the whole epic is built on.
   */
  requestedTotalCents: number | null;
}) {
  const shortfallCents =
    requestedTotalCents === null
      ? null
      : Math.max(derivedTotalCents - requestedTotalCents, 0);
  const invoiceNeverRaised = leg === "xero-invoice" && cause === "ask-not-raised";
  const invoiceOwedUnknown =
    leg === "xero-invoice" && cause === "ask-owed-unknown";
  logger.warn(
    {
      leg,
      cause,
      bookingId,
      bookingModificationId,
      derivedTotalCents,
      requestedTotalCents,
    },
    leg === "payment-request"
      ? "Edit-financial-review charge request was paid before its combined total could be raised - the remaining share must be collected by hand"
      : invoiceOwedUnknown
        ? "Edit-financial-review charge carries no record of whether a supplementary Xero invoice was owed - none was raised, and only the booking-vs-Xero repair pass can say whether one is missing"
        : invoiceNeverRaised
          ? "Edit-financial-review supplementary invoice could not be queued at all - the whole settled total must be billed by hand"
          : "Edit-financial-review supplementary invoice had already left the queue before its combined total could be raised - the difference must be billed by hand",
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
        leg === "payment-request"
          ? `A settled review share of ${formatCents(shortfallCents ?? derivedTotalCents)} could not be added to this booking change's payment request`
          : invoiceOwedUnknown
            ? `Whether a Xero invoice was owed for this booking change's settled total of ${formatCents(derivedTotalCents)} is not recorded`
            : invoiceNeverRaised
              ? `No Xero invoice was raised for this booking change's settled total of ${formatCents(derivedTotalCents)}`
              : `This booking change's Xero invoice could not be raised to the settled total of ${formatCents(derivedTotalCents)}`,
      details:
        leg === "payment-request"
          ? `An admin settled a booking-change review as money the member owes the club, but the request for that change had already been paid, so ${formatCents(shortfallCents ?? derivedTotalCents)} was not added to it. The reviews settled to ${formatCents(derivedTotalCents)} in total and the member was asked for ${formatCents(requestedTotalCents ?? 0)}. Collect the difference another way and record what was collected.`
          : invoiceOwedUnknown
            ? `An admin settled a booking-change review as money the member owes the club, and the reviews for that change now total ${formatCents(derivedTotalCents)}. The member has been asked for it. Whether a Xero supplementary invoice was owed for the charge was never recorded, so none was raised - and one may not have been needed: if the booking's main Xero invoice had not yet been sent when the change was made, that invoice bills this charge itself, and adding a supplementary invoice on top would bill the member twice. Do not raise one by hand on the strength of this note. Run the booking-vs-Xero repair for this booking, which compares the booking against Xero and will say whether an invoice is actually missing, and record what was done.`
            : invoiceNeverRaised
              ? `An admin settled a booking-change review as money the member owes the club, and the reviews for that change now total ${formatCents(derivedTotalCents)}. The member has been asked for it, but no Xero supplementary invoice could be raised for the charge at all - so the club's accounts hold no record of it, rather than an out-of-date one. Raise the invoice by hand, or run the booking-vs-Xero repair for this booking, and record what was done.`
              : `An admin settled a booking-change review as money the member owes the club, and the reviews for that change now total ${formatCents(derivedTotalCents)}. The Xero supplementary invoice for the change had already been picked up for sending, so it bills the earlier, smaller figure and could not be raised. If the member is paying by internet banking that invoice is the ask, so this is money the club has not asked for; if they are paying by card the card request is correct and it is the Xero invoice that is short. Check the invoice, bill or correct the difference by hand, and record what was done.`,
      metadata: {
        leg,
        cause,
        bookingModificationId,
        derivedTotalCents,
        requestedTotalCents,
        uncollectedCents: shortfallCents,
      },
    });
  } catch (err) {
    logger.error(
      { err, leg, bookingId, bookingModificationId },
      "Failed to record the audit trace for an uncollected edit-financial-review charge share",
    );
  }
}
