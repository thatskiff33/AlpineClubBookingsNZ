import "server-only";

import { type PaymentStatus, type Prisma } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import {
  editReviewChargeRequestCriteria,
  editReviewChargeShareTaskSelect,
  editReviewChargeShareTaskWhere,
  sumEditReviewChargeSharesByAnchor,
} from "@/lib/edit-financial-review-charge-shape";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";
import {
  enqueueXeroSecondSupplementaryInvoiceOperation,
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
 *
 * #3187 MOVED THE PURE SHAPES those questions are asked from - which review
 * tasks carry a settled share, how they total per edit, and which ledger row is
 * the combined request - into `edit-financial-review-charge-shape.ts`, which
 * carries no `server-only`. The booking-vs-Xero repair tool needs the same three
 * answers and runs from an operator CLI, which a `server-only` import kills at
 * startup. The answers stay single-sourced; only the file they live in changed.
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
      ...editReviewChargeRequestCriteria(bookingModificationId),
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
    where: { bookingId, ...editReviewChargeShareTaskWhere },
    select: editReviewChargeShareTaskSelect,
  });

  return sumEditReviewChargeSharesByAnchor(settled).get(bookingModificationId) ?? 0;
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
 * this much - an exact replay, or a stale smaller total arriving after a larger
 * one. Both mean "do not queue a second invoice", and the second writes nothing,
 * because that function refuses to lower an ask.
 *
 * WHAT THE ACCOUNTING LEG GUARANTEES - only raised and never lowered, at most
 * one invoice per anchor decided under an advisory lock, and a restate that
 * writes being one that goes out - is stated once, on
 * `restatePendingSupplementaryInvoiceAmount` and in `INV-PAY-051`, not restated
 * here. What matters to THIS caller is the one thing NOT guaranteed: that a
 * restate can land at all. A share settled after the worker claimed the
 * operation, or after the invoice was sent, meets an ask it cannot join. This
 * function then reports nothing restated, the caller falls through to the
 * ordinary enqueue, and `recordShortEditReviewChargeInvoice` below decides what
 * the enqueue's verdict means - which since #3193 is a second invoice for a sent
 * ask, and a record to check for an in-flight one.
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
 * different windows, and an officer reading the audit log has to be told which.
 *
 *   * `payment-request` - the card side. The member's additional PaymentIntent
 *     was already PAID when this share arrived, so the amount could not be added
 *     to it. The member owes the club the difference.
 *   * `xero-invoice` - the accounting side. This edit's supplementary invoice
 *     had been claimed for sending or already sent, so it bills the earlier
 *     figure. On the internet-banking route that invoice IS the ask, so this is
 *     money the club has not asked for; on the card route the card request is
 *     correct and it is the books that are short.
 */
export type UncollectedEditReviewChargeLeg = "payment-request" | "xero-invoice";

/**
 * WHY the settled share never reached that ask, which is a different question
 * from which ask it was and needs a different sentence (#3181).
 *
 *   * `ask-closed` - an ask EXISTS and could not take this share: the card
 *     request was already paid, or the supplementary invoice already claimed.
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
 * (its ask is the intent, which exists by then) and the accounting leg produces
 * all three. The rest are not refused, because a leg/cause pair describes what
 * happened rather than claiming what can.
 */
export type UncollectedEditReviewChargeCause =
  | "ask-closed"
  | "ask-not-raised"
  | "ask-owed-unknown";

/**
 * WHAT HAPPENED TO THE DIFFERENCE a settled share could not add to this edit's
 * Xero invoice (#3193).
 *
 *   * `raised` - it is being billed, on a second small invoice of its own.
 *   * `failed` - a second invoice was owed and could not be queued. Somebody has
 *     to bill it by hand.
 *   * `withheld` - a second invoice was DELIBERATELY not raised, because the
 *     change's own invoice had not gone out yet and can still be raised to
 *     cover this share (#3193 fix round; the mechanism is on
 *     `XeroSupplementaryInvoiceEnqueueOutcome`). Which way it went is not
 *     knowable here, so the record says what to check rather than what to do.
 *   * `unavailable` - the caller holds no single settled share to bill, so
 *     raising anything would mean inventing a figure. The recovery replay is the
 *     one caller in that position: it holds the edit's COMBINED total and cannot
 *     say which part the sent invoice already carries. Named rather than folded
 *     into `failed`, because only one of the two can be retried.
 *   * `nothing-to-bill` - the share is not a positive amount, so there is no
 *     difference to carry. Separate from `unavailable`, whose sentence sends an
 *     officer to work a difference out.
 */
export type EditReviewSecondAskOutcome =
  | "raised"
  | "failed"
  | "withheld"
  | "unavailable"
  | "nothing-to-bill";

/**
 * The accounting leg's half of that record, decided from the enqueue's own
 * verdict (#3170 fix round, F2) - and, since #3193, the place the difference is
 * BILLED rather than merely recorded.
 * Both short outcomes are the enqueue saying it found an ask for this edit and
 * could NOT raise it - correctly, because the figure is already with the member
 * or on its way. Until #3193 the difference was then billed nowhere; the owner's
 * 31 Aug 2026 decision is that it becomes its own ask, a second and separate
 * supplementary invoice for THIS SHARE alone.
 *
 * ONLY `short-sent` BUYS THAT SECOND INVOICE (#3193 fix round). A sent invoice
 * is fixed forever, so adding this share beside it adds exactly what is missing.
 * `short-in-flight` is a row the outbox has merely CLAIMED: nothing has reached
 * Xero, it can come back un-attempted, and the next settlement would then raise
 * it to the combined total - which already contains this share. That refusal
 * therefore takes the recorded-shortfall path instead. The mechanism, and the
 * worked $310-for-$280 sequence, are on
 * `XeroSupplementaryInvoiceEnqueueOutcome`; they are not restated here.
 *
 * THE SHARE, NOT THE TOTAL, is the rest of the safety argument. `short-sent`
 * follows a restate that found nothing restatable and nothing already covering,
 * so this share is provably absent from the invoice that went out. Billing the
 * total would ask for money the member has already been asked for - strictly
 * worse than the defect being fixed. `shareCents` is null on the caller holding
 * only a combined total, and that caller raises nothing.
 *
 * It lives HERE rather than at the dispatch site because the question and its
 * answer are one idea: `covers-total` and `none` are silence, either shortfall is
 * a record and one of them is also an ask, and a caller re-deriving that mapping
 * is how the two legs come to disagree about what counts as a shortfall.
 *
 * Returns whether this share needed anything doing about it, so a test can tell
 * "no shortfall" from "never asked".
 */
export async function recordShortEditReviewChargeInvoice({
  outcome,
  bookingId,
  bookingModificationId,
  reviewTaskId,
  memberId,
  totalCents,
  shareCents,
  createdByMemberId,
}: {
  outcome: XeroSupplementaryInvoiceEnqueueOutcome;
  bookingId: string;
  bookingModificationId: string;
  /**
   * The review task whose settled share this is, which becomes the second ask's
   * anchor. Null on the recovery replay, which holds a combined total and no
   * single share.
   */
  reviewTaskId: string | null;
  memberId: string | null;
  totalCents: number;
  /**
   * THIS TASK'S OWN SETTLED SHARE - the amount the second invoice bills, and the
   * only amount it may bill. Null with `reviewTaskId`, and the two are checked
   * together so a caller cannot supply an anchor without a figure or a figure
   * without an anchor.
   */
  shareCents: number | null;
  createdByMemberId?: string;
}): Promise<boolean> {
  if (outcome !== "short-sent" && outcome !== "short-in-flight") return false;

  // #3193 fix round: an in-flight ask is not evidence that this share went
  // unbilled, so it buys no second invoice. Docblock above.
  const secondAsk: EditReviewSecondAskOutcome =
    outcome === "short-in-flight"
      ? "withheld"
      : await raiseSecondEditReviewChargeInvoice({
          bookingId,
          bookingModificationId,
          reviewTaskId,
          shareCents,
          createdByMemberId,
        });

  if (secondAsk === "raised" && shareCents !== null) {
    await recordSecondEditReviewChargeInvoice({
      bookingId,
      bookingModificationId,
      memberId,
      derivedTotalCents: totalCents,
      shareCents,
    });
    return true;
  }

  await recordUncollectedEditReviewChargeShare({
    leg: "xero-invoice",
    // Both short outcomes are an ask that exists and could not be raised. Which
    // one travels in `secondAsk`, because that is what changes the officer's
    // next move rather than the shape of the fact.
    cause: "ask-closed",
    secondAsk,
    bookingId,
    bookingModificationId,
    memberId,
    derivedTotalCents: totalCents,
    // Unknowable by design - the handler replaces this ask's payload with the
    // Xero invoice body when it sends - so the record says "short of this total"
    // rather than inventing the difference.
    requestedTotalCents: null,
  });
  return true;
}

/**
 * Queue the second ask, or say why it could not be queued (#3193).
 *
 * Best-effort like everything else on this leg: the settlement's money question
 * is already answered and committed, so a Xero outage must leave a RECORD rather
 * than undo the completion. A failure falls through to the uncollected-share
 * audit row, which is the officer's instrument.
 *
 * It asks the outbox no question of its own: whether this share already has an
 * invoice going out is decided inside
 * `enqueueXeroSecondSupplementaryInvoiceOperation`'s advisory-locked
 * transaction, scoped to the task anchor. A caller-side copy of that question is
 * how two answers came to disagree in #3170.
 *
 * EVERY non-`none` outcome means the share is billed, which reads oddly until
 * the anchor is held in mind: on a TASK anchor a shortfall says "this share's
 * own invoice has already gone out", not "this share is short" - there is
 * nothing behind it to fall short of. Only `none` means no invoice exists.
 */
async function raiseSecondEditReviewChargeInvoice({
  bookingId,
  bookingModificationId,
  reviewTaskId,
  shareCents,
  createdByMemberId,
}: {
  bookingId: string;
  bookingModificationId: string;
  reviewTaskId: string | null;
  shareCents: number | null;
  createdByMemberId?: string;
}): Promise<EditReviewSecondAskOutcome> {
  // Both or neither. A share with no anchor could not be made idempotent and an
  // anchor with no share has nothing to bill, so neither half alone gets here.
  if (reviewTaskId === null || shareCents === null) return "unavailable";
  // A DIFFERENT ANSWER, deliberately: `unavailable` sends an officer to work
  // out a difference, and here there is none. Sharing the value handed an inline
  // caller the recovery replay's instruction for a figure nobody needs.
  if (shareCents <= 0) return "nothing-to-bill";

  try {
    const queued = await enqueueXeroSecondSupplementaryInvoiceOperation(
      {
        bookingId,
        bookingModificationId,
        reviewTaskId,
        shareCents,
      },
      { createdByMemberId },
    );
    return queued.outcome === "none" ? "failed" : "raised";
  } catch (err) {
    logger.error(
      { err, bookingId, bookingModificationId, reviewTaskId },
      "Failed to queue the second Xero supplementary invoice for a settled edit-financial-review share",
    );
    return "failed";
  }
}

/**
 * The durable record that the difference IS being billed (#3193).
 *
 * A member receiving two invoices for one booking change will ask why, and the
 * booking's history is where an officer looks to answer them. It is also the
 * counterpart to `recordUncollectedEditReviewChargeShare` below: between them,
 * every settled share that could not join this edit's invoice leaves a trace
 * saying which happened, so "no record" is never read as "probably fine".
 *
 * `info` and `success`, not `important`/`failure`: nothing is owed outside the
 * system and nobody has to act. Best-effort and never rethrown, for the same
 * reason as its counterpart - the invoice is already queued, and an audit insert
 * failing must not undo a completion whose money question is settled.
 */
async function recordSecondEditReviewChargeInvoice({
  bookingId,
  bookingModificationId,
  memberId,
  derivedTotalCents,
  shareCents,
}: {
  bookingId: string;
  bookingModificationId: string;
  memberId: string | null;
  derivedTotalCents: number;
  shareCents: number;
}) {
  logger.info(
    { bookingId, bookingModificationId, derivedTotalCents, shareCents },
    "Raised a second Xero supplementary invoice for an edit-financial-review share the change's invoice had already gone out without",
  );
  try {
    await createAuditLog({
      action: "booking.editFinancialReview.chargeShareReinvoiced",
      subjectMemberId: memberId,
      targetId: bookingId,
      entityType: "Booking",
      entityId: bookingId,
      category: "payment",
      severity: "info",
      outcome: "success",
      summary: `A second Xero invoice for ${formatCents(shareCents)} was raised for this booking change`,
      // Written when the second invoice is QUEUED, not when it is sent, so it
      // must not promise that it went out (#3193 fix round). A Xero rejection
      // now leaves a findable, retryable row against this booking review.
      details: `An admin settled a booking-change review as money the member owes the club, and the reviews for that change now total ${formatCents(derivedTotalCents)}. The Xero invoice for the change had already been sent, so it could not be raised to include this ${formatCents(shareCents)}. A second, separate invoice for that amount alone has been raised instead - the first invoice is unchanged and still stands. The member will receive two invoices for this one change, and the second one says why. Nothing needs collecting by hand, unless that second invoice fails to reach Xero: it is queued rather than sent, and a failure shows up in the Xero operations screen against this booking review, where it can be retried.`,
      metadata: {
        leg: "xero-invoice",
        bookingModificationId,
        derivedTotalCents,
        shareCents,
      },
    });
  } catch (err) {
    logger.error(
      { err, bookingId, bookingModificationId },
      "Failed to record the audit trace for a second edit-financial-review supplementary invoice",
    );
  }
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
  secondAsk,
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
  /**
   * #3193: what happened to the second ask, when this record is about the
   * accounting leg's closed ask. Required rather than defaulted, and on BOTH
   * legs, for the reason `cause` is - the officer instruction turns on it, and a
   * default would hand them whichever sentence was written first. The values and
   * what each one tells an officer to do are on `EditReviewSecondAskOutcome`.
   * `null` on the card leg, where a second Xero invoice is not the remedy: the
   * member's card request is the ask that closed, and the books are correct.
   */
  secondAsk: EditReviewSecondAskOutcome | null;
  bookingId: string;
  bookingModificationId: string;
  memberId: string | null;
  derivedTotalCents: number;
  /**
   * What the ask actually holds, when that is knowable. The card leg reads it
   * off the `ADDITIONAL` ledger row; the accounting leg CANNOT, because
   * `createXeroSupplementaryInvoice` replaces THIS ask's `requestPayload` with
   * the Xero invoice body at dispatch, so once the row is claimed the queued
   * amount is gone. (A second ask keeps its own; a different row, not this one.) Null says "short by an amount this record cannot
   * state" rather than inventing one.
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
  // #3193: the closed-ask case has several endings needing different
  // instructions. `unavailable` is the recovery replay, holding a combined total
  // and unable to say which part the sent invoice carries. `withheld` (fix
  // round) is the invoice that had not actually gone out yet, where billing
  // separately could bill the same money twice.
  const secondAskWithheld = secondAsk === "withheld";
  const secondAskSentence =
    leg !== "xero-invoice" || cause !== "ask-closed"
      ? ""
      : secondAsk === "unavailable"
        ? " A second invoice for the difference was NOT raised: the difference cannot be worked out automatically. What the sent invoice bills is in Xero rather than in this record, so the two have to be compared by a person. Do not raise one for the full total - the member has already been invoiced for most of it. Run the booking-vs-Xero repair for this booking, which compares the booking against Xero, and record what was done. If that report shows nothing, compare this booking against Xero by hand: it cannot yet see a booking whose charge came from a review of this kind."
        : secondAskWithheld
          ? " No second invoice was raised, and that is deliberate rather than a failure. The invoice for this change had been picked up for sending but had not gone out, and an invoice in that state can still come back to the queue and be raised to the full amount by the next settlement - so raising a separate one now risks billing this amount twice. Check the Xero invoices for this booking against the total above: if they already come to that total, nothing is owed. If they fall short, bill the difference by hand and record what was done."
          : secondAsk === "nothing-to-bill"
            ? " No second invoice was raised because this share is not a positive amount, so there is no difference for one to carry."
            : " A second invoice for the difference should have been raised automatically and could not be. Raise one by hand for the difference only, and record what was done.";
  logger.warn(
    {
      leg,
      cause,
      secondAsk,
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
          : secondAskWithheld
            ? "Edit-financial-review supplementary invoice was being sent when a further share settled, so no second invoice was raised for it - whether the sent invoice covers the settled total has to be checked against Xero"
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
              : secondAskWithheld
                ? `This booking change's Xero invoice was being sent and could not be raised to the settled total of ${formatCents(derivedTotalCents)}`
                : `This booking change's Xero invoice could not be raised to the settled total of ${formatCents(derivedTotalCents)}`,
      details:
        leg === "payment-request"
          ? `An admin settled a booking-change review as money the member owes the club, but the request for that change had already been paid, so ${formatCents(shortfallCents ?? derivedTotalCents)} was not added to it. The reviews settled to ${formatCents(derivedTotalCents)} in total and the member was asked for ${formatCents(requestedTotalCents ?? 0)}. Collect the difference another way and record what was collected.`
          : invoiceOwedUnknown
            ? `An admin settled a booking-change review as money the member owes the club, and the reviews for that change now total ${formatCents(derivedTotalCents)}. The member has been asked for it. Whether a Xero supplementary invoice was owed for the charge was never recorded, so none was raised - and one may not have been needed: if the booking's main Xero invoice had not yet been sent when the change was made, that invoice bills this charge itself, and adding a supplementary invoice on top would bill the member twice. Do not raise one by hand on the strength of this note. Run the booking-vs-Xero repair for this booking, which compares the booking against Xero and will say whether an invoice is actually missing, and record what was done.`
            : invoiceNeverRaised
              ? `An admin settled a booking-change review as money the member owes the club, and the reviews for that change now total ${formatCents(derivedTotalCents)}. The member has been asked for it, but no Xero supplementary invoice could be raised for the charge at all - so the club's accounts hold no record of it, rather than an out-of-date one. Raise the invoice by hand, or run the booking-vs-Xero repair for this booking, and record what was done.`
              : secondAskWithheld
                ? `An admin settled a booking-change review as money the member owes the club, and the reviews for that change now total ${formatCents(derivedTotalCents)}. The Xero supplementary invoice for the change had just been picked up for sending, so it could not be raised to include this. It may have gone out at the earlier, smaller figure, or it may have come back to the queue and been raised since - this record cannot tell which. If the member is paying by internet banking that invoice is the ask, so any shortfall is money the club has not asked for; if they are paying by card the card request is correct and it is the Xero invoice that would be short.${secondAskSentence}`
                : `An admin settled a booking-change review as money the member owes the club, and the reviews for that change now total ${formatCents(derivedTotalCents)}. The Xero supplementary invoice for the change had already been sent, so it bills the earlier, smaller figure and could not be raised. If the member is paying by internet banking that invoice is the ask, so this is money the club has not asked for; if they are paying by card the card request is correct and it is the Xero invoice that is short.${secondAskSentence}`,
      metadata: {
        leg,
        cause,
        secondAsk,
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
