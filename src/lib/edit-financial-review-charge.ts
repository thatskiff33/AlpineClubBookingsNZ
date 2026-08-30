import "server-only";

import {
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
} from "@prisma/client";

import { hasCapturedPayment } from "@/lib/booking-payment-state";
import {
  REVIEW_CHARGE_ANCHOR_MISSING_MESSAGE,
  REVIEW_CHARGE_NO_INSTRUMENT_MESSAGE,
  REVIEW_CHARGE_REQUEST_ALREADY_PAID_MESSAGE,
  REVIEW_CHARGE_REQUEST_CLOSED_MESSAGE,
} from "@/lib/edit-financial-review-charge-refusals";
import { createModificationAdditionalPaymentIntent } from "@/lib/booking-modification-settlement";
import {
  findEditReviewChargeRequest,
  hasIssuedSupplementaryInvoice,
  recordUncollectedEditReviewChargeShare,
  sumEditReviewChargeSharesCents,
  type EditReviewChargeStore,
} from "@/lib/edit-financial-review-charge-request";
import logger from "@/lib/logger";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import { prisma } from "@/lib/prisma";
import { enqueueAdditionalPaymentIntentRecovery } from "@/lib/payment-recovery";
import {
  buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey,
  buildEditFinancialReviewAdditionalIntentStripeKey,
  buildEditFinancialReviewChargeReason,
} from "@/lib/payment-recovery-keys";
import {
  isCapturedTransactionStatus,
  upsertPaymentIntentTransaction,
} from "@/lib/payment-transactions";
import { updatePaymentIntentAmount } from "@/lib/stripe";

/**
 * #3170 (epic #2797): the one direction of a settled review that ASKS FOR MONEY,
 * and the rule that ONE BOOKING EDIT RAISES ONE REQUEST.
 *
 * ## Why this is its own module
 *
 * `edit-financial-review-settlement.ts` answers "where does a confirmed review
 * amount GO", and until this issue every answer was a way of handing money back:
 * a card refund, a ledger mirror of a hand-back, or account credit. #3032 parked
 * only guest REMOVALS, which can only ever owe the member, so refund-shaped was
 * enough. #3170 is the first child that parks an edit which moves the price UP -
 * a check-out extension, or a guest added - and a charge shares none of that
 * machinery: no refund allocation, no cap against captured cash, no credit
 * anchor, and no `REFUNDED` event.
 *
 * Keeping it beside them as a fourth branch was tried and is what the file-size
 * ratchet caught. It is also the worse arrangement on its merits: the one thing
 * that must never happen here is a charge quietly taking a refund path, and the
 * strongest guard against that is that the two live in different modules and
 * share no code at all. The union that picks between them is still ONE function,
 * in the settlement module, so there is still exactly one place that decides.
 *
 * ## ONE EDIT, ONE REQUEST (owner decision, #3170, 30 Aug 2026)
 *
 * One edit can raise TWO review tasks - one per guest strand whose history could
 * not be read - and an officer may settle both as money owed to the club. The
 * first #3170 round minted one request per TASK, and that lost money outright:
 * minting an additional PaymentIntent queues every OTHER outstanding `ADDITIONAL`
 * transaction on that payment for cancellation, and `reconcilePaymentAggregates`
 * carries a single `additionalAmountCents` rather than a sum. $200 then $30
 * collected $30 of $230, with both tasks COMPLETED and both audited as settled.
 *
 * The owner's answer: both reviews contribute to a SINGLE request for the total,
 * each task recording its own share. So:
 *
 *   * THE REQUEST is anchored to the EDIT. One `BookingModification`, one Stripe
 *     PaymentIntent, one PENDING `ADDITIONAL` PaymentTransaction, one figure on
 *     the member's pay link. A second settlement RAISES that request's amount
 *     rather than minting a second one, which is why nothing is superseded and
 *     `queueSupersededAdditionalIntentCancellations` never runs between two shares
 *     of one edit.
 *   * THE SHARE stays anchored to the TASK: its `amountCents`, its
 *     `settlementDirection` and its audit entry are untouched by this, so the
 *     combined figure stays explainable back to the two decisions that produced
 *     it.
 *   * THE TOTAL IS DERIVED, NEVER INCREMENTED - `sumEditReviewChargeSharesCents`
 *     re-reads the settled shares every time. Two officers closing two tasks at
 *     the same moment therefore cannot double-count: each share is counted once
 *     because it is counted from the row it lives on. See
 *     `syncEditFinancialReviewChargeRequest` for why neither of them can lose a
 *     share either.
 *
 * ## What it is NOT
 *
 * It is not a fourth settlement mechanism, which the epic forbids outright.
 * `createModificationAdditionalPaymentIntent` is the same function every ordinary
 * booking-edit price increase goes through, so the instrument, the PENDING
 * `ADDITIONAL` PaymentTransaction row, the chase reminders, the member's pay link
 * and the Xero supplementary invoice's wait-for-payment are all the existing
 * ones.
 *
 * And NOTHING IS TAKEN FROM THE MEMBER'S CARD HERE. The completion mints or
 * raises the REQUEST; the member pays it themselves, exactly as they would for an
 * ordinary extension. That is why a provider failure is recoverable rather than a
 * lost charge, and why the admin copy is allowed to say so.
 */

/** The booking member a charge may need in order to mint a Stripe customer. */
export type EditReviewChargeMember = {
  id: string;
  email: string;
  name: string;
  stripeCustomerId: string | null;
};

/**
 * What actually happened to this edit's ONE request, as a value the caller has to
 * read rather than as an absence it has to infer.
 *
 * #3170 fix round: the sync used to answer with `paymentIntentId: string | null`,
 * and `null` meant THREE different things - "nothing is owed", "the ask exists
 * and is an invoice", and "the provider refused and the club minted nothing".
 * The recovery replay could not tell them apart, so it closed the operation on
 * all three, and the third is a debt the club then never asks for. A silent
 * success on a money path is not something to log; it is something to make
 * unrepresentable, so the sync now says which of them it means.
 *
 *   * `nothing-owed`   - no settled share against this edit. Nothing to ask for,
 *                        and nothing further will ever be owed by this row.
 *   * `raised`         - the request exists and asks for at least the derived
 *                        total. This is the only outcome that closes a replay.
 *   * `already-paid`   - the member paid before the combined total could be
 *                        raised. Terminal: the remaining share is collected by
 *                        hand, and the audit row written alongside it is how an
 *                        officer finds that out.
 *   * `not-raised`     - the ask does NOT exist and the money IS owed. The debt
 *                        is durable (a recovery row), and a replay that sees this
 *                        must leave its operation open.
 */
export type EditReviewChargeSyncOutcome =
  | "nothing-owed"
  | "raised"
  | "already-paid"
  | "not-raised";

/** What the sync did, and what the request now asks for. */
export type EditReviewChargeSyncResult = {
  outcome: EditReviewChargeSyncOutcome;
  paymentIntentId: string | null;
  totalCents: number;
};

/**
 * How the club will ask, decided from the booking's own facts rather than offered
 * as a choice.
 *
 * A DISCRIMINATED UNION on `collectVia`, and deliberately so: the card arm cannot
 * be constructed without a payment to hang the `ADDITIONAL` transaction off and a
 * member to bill, because both are things `createModificationAdditionalPaymentIntent`
 * requires. Before this they were nullable fields with `?? actingMemberId` and
 * `?? ""` fallbacks at the call site, which would have minted a Stripe customer
 * for the ADMIN with an empty email - dead in practice, because a booking's member
 * is required, but a wrong answer written down where a refusal belongs.
 */
export type EditReviewChargeRoute =
  | {
      kind: "additional-charge";
      /**
       * The booking has a CAPTURED card payment, so an additional PaymentIntent
       * is minted against it - or, when this edit already has one, raised to the
       * new total.
       */
      collectVia: "stripe";
      bookingModificationId: string;
      paymentId: string;
      member: EditReviewChargeMember;
      /**
       * #3181: whether this booking's PRIMARY Xero invoice had already been
       * issued when the route was chosen - carried rather than re-read, because
       * a mint failure freezes it on the recovery row and the replay bills what
       * the settlement decided rather than what is true when the cron arrives.
       * Only the card route carries it: the `invoice` route mints no intent, so
       * it enqueues no recovery row for a replay to read.
       */
      hasIssuedXeroInvoice: boolean;
    }
  | {
      kind: "additional-charge";
      /**
       * The internet-banking booking: there is no intent to mint, so the
       * supplementary Xero invoice IS the ask and the club's existing
       * additional-payment chasing carries it.
       */
      collectVia: "invoice";
      bookingModificationId: string;
      paymentId: string | null;
      member: EditReviewChargeMember | null;
    };

/**
 * Decide how a charge will be collected, or throw the refusal that stops it.
 *
 * MUST be called BEFORE the caller's status claim and inside its transaction,
 * exactly as the refund routes are: a refusal that fired after the claim would
 * leave a task COMPLETED with nothing collected, which is the "pretends money
 * moved" failure `INV-PAY-051` forbids, in the direction where the club is the
 * one left short.
 */
export async function chooseEditReviewChargeRoute({
  bookingModificationId,
  bookingPayment,
  member,
  hasIssuedXeroInvoice,
  store,
}: {
  bookingModificationId: string | null;
  bookingPayment: {
    id: string;
    status: string;
    amountCents: number | null;
    refundedAmountCents: number | null;
    source: PaymentSource;
    stripeCustomerId: string | null;
  } | null;
  member: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  } | null;
  hasIssuedXeroInvoice: boolean;
  store: EditReviewChargeStore;
}): Promise<EditReviewChargeRoute> {
  if (!bookingModificationId) {
    throw new ManualBookingPaymentError(
      REVIEW_CHARGE_ANCHOR_MISSING_MESSAGE,
      409,
    );
  }
  // The same test `applyPaymentAdjustments` uses to decide whether an ordinary
  // price increase mints an intent: a CAPTURED payment whose source is the card.
  // `Payment.source` alone is not enough - its schema DEFAULT is STRIPE, so a
  // hand-settled booking carries it with nothing captured behind it. A MEMBER is
  // part of the test rather than a fallback: minting needs somebody to bill, and
  // a booking with none has no card route - it falls to the invoice route, or to
  // the no-instrument refusal below.
  const canChargeCard =
    hasCapturedPayment(bookingPayment) &&
    bookingPayment?.source === PaymentSource.STRIPE &&
    Boolean(member);
  // An ISSUED Xero invoice is the other instrument. It has to be ISSUED rather
  // than merely possible - with no invoice to add to,
  // `classifyXeroBookingEditSettlement` takes its `none` branch, so the
  // completion would move nothing at all while recording that the club had
  // collected the money.
  if (!canChargeCard && !hasIssuedXeroInvoice) {
    throw new ManualBookingPaymentError(
      REVIEW_CHARGE_NO_INSTRUMENT_MESSAGE,
      409,
    );
  }

  // #3170: is this edit's ONE request still open to a further share? Both
  // answers below are refusals rather than a second request - see the two
  // message docblocks for why, and why that is not the "refuse until the first
  // is paid" option the owner rejected.
  const existing = bookingPayment
    ? await findEditReviewChargeRequest({
        paymentId: bookingPayment.id,
        bookingModificationId,
        store,
      })
    : null;
  if (existing) {
    if (isCapturedTransactionStatus(existing.status)) {
      throw new ManualBookingPaymentError(
        REVIEW_CHARGE_REQUEST_ALREADY_PAID_MESSAGE,
        409,
      );
    }
    if (
      existing.status !== PaymentStatus.PENDING &&
      existing.status !== PaymentStatus.PROCESSING
    ) {
      throw new ManualBookingPaymentError(
        REVIEW_CHARGE_REQUEST_CLOSED_MESSAGE,
        409,
      );
    }
  }
  if (await hasIssuedSupplementaryInvoice({ bookingModificationId, store })) {
    throw new ManualBookingPaymentError(
      REVIEW_CHARGE_REQUEST_CLOSED_MESSAGE,
      409,
    );
  }

  if (canChargeCard && bookingPayment && member) {
    return {
      kind: "additional-charge",
      collectVia: "stripe",
      bookingModificationId,
      paymentId: bookingPayment.id,
      // #3181: this function's own argument, carried forward rather than
      // re-derived downstream, so the charge and any replay of it answer the
      // same question with the same value.
      hasIssuedXeroInvoice,
      member: {
        id: member.id,
        email: member.email,
        name: `${member.firstName} ${member.lastName}`,
        stripeCustomerId: bookingPayment.stripeCustomerId,
      },
    };
  }
  return {
    kind: "additional-charge",
    collectVia: "invoice",
    bookingModificationId,
    paymentId: bookingPayment?.id ?? null,
    member: member
      ? {
          id: member.id,
          email: member.email,
          name: `${member.firstName} ${member.lastName}`,
          stripeCustomerId: bookingPayment?.stripeCustomerId ?? null,
        }
      : null,
  };
}

/**
 * Bring this EDIT's one request up to the total of the shares settled against it.
 *
 * THE SINGLE ENTRY POINT for both the inline completion and the recovery cron,
 * which is what makes a crash between them converge rather than diverge: the
 * replay is not "re-send what the route would have sent", it is this same
 * function asking the same question of the same rows.
 *
 * ## Why two officers closing two tasks at once neither double-count nor lose a
 * share
 *
 * The total is DERIVED from the settled shares (`sumEditReviewChargeSharesCents`)
 * at the moment this runs, and this runs AFTER the caller's transaction has
 * committed. So:
 *
 *   * NO DOUBLE COUNT. Each task contributes its share exactly once because the
 *     share is read from the task row, and a task's status-fenced claim writes
 *     that row exactly once. Two runs of this function for two tasks compute the
 *     same kind of sum, never a sum plus an increment.
 *   * NO LOST SHARE. Whichever completion COMMITS LAST necessarily reads after
 *     both commits, so at least one run always sees the full set and derives the
 *     true total. A run that started earlier may compute a smaller, stale total.
 *   * THE STALE ONE CANNOT WIN. A settled share is terminal, so the derived total
 *     only ever grows; a smaller figure is therefore always the older answer.
 *     The write below REFUSES TO LOWER the recorded request, so whichever order
 *     the two provider calls happen to land in, the request settles at the
 *     largest - which is the newest - total. That compare-and-set is the reason
 *     this needs no advisory lock, which matters because the completion path
 *     deliberately holds none (`docs/CONCURRENCY_AND_LOCKING.md` forbids holding
 *     `lock(1)` across a provider round trip).
 *
 * Returns the request's intent id and the total it now asks for.
 */
export async function syncEditFinancialReviewChargeRequest({
  bookingId,
  bookingModificationId,
  paymentId,
  member,
  hasIssuedXeroInvoice,
}: {
  bookingId: string;
  bookingModificationId: string;
  paymentId: string;
  member: EditReviewChargeMember | null;
  /**
   * #3181: the EDIT's answer to "did this booking already have a primary Xero
   * invoice", carried in rather than derived here. Frozen on the recovery row
   * when the mint fails, so the replay raises the supplementary invoice the edit
   * would have raised rather than one the passage of time invented. `null` from
   * the recovery replay's own re-entry, where the row already exists and this
   * value is therefore never written - it is not a third answer, it is "the row
   * that would carry it is already there".
   */
  hasIssuedXeroInvoice: boolean | null;
}): Promise<EditReviewChargeSyncResult> {
  const totalCents = await sumEditReviewChargeSharesCents({
    bookingId,
    bookingModificationId,
  });
  if (totalCents <= 0) {
    // No settled share to ask for. Reachable only from a recovery replay of an
    // operation whose task was never claimed; minting for zero would be the
    // magic-value failure this epic exists to remove.
    return { outcome: "nothing-owed", paymentIntentId: null, totalCents: 0 };
  }

  const existing = await findEditReviewChargeRequest({
    paymentId,
    bookingModificationId,
  });
  const reason = buildEditFinancialReviewChargeReason(bookingModificationId);

  if (existing?.stripePaymentIntentId) {
    if (isCapturedTransactionStatus(existing.status)) {
      // Paid while this was in flight. The pre-claim refusal is the ordinary
      // guard; this is the race behind it, and it must not restate a paid ask.
      //
      // #3170 fix round: a log line is not a queue. An officer has to be able to
      // FIND a share that was settled into a request the member had already
      // paid, and the durable, officer-readable record of a money decision in
      // this repository is the audit log. Written before the return, so the
      // trace exists whether or not anybody is watching a log stream.
      await recordUncollectedEditReviewChargeShare({
        // The CARD leg: the member's additional PaymentIntent is paid, so the
        // share could not be added to it. The accounting leg has its own window
        // and its own call, and the `leg` is what tells the two apart in the
        // audit list.
        leg: "payment-request",
        // The ask exists and is paid: closed, not missing (#3181).
        cause: "ask-closed",
        bookingId,
        bookingModificationId,
        memberId: member?.id ?? null,
        derivedTotalCents: totalCents,
        requestedTotalCents: existing.amountCents,
      });
      return {
        outcome: "already-paid",
        paymentIntentId: existing.stripePaymentIntentId,
        totalCents: existing.amountCents,
      };
    }
    if (totalCents <= existing.amountCents) {
      // Either an exact replay (equal), which must change nothing at all, or a
      // stale, smaller total, which must never lower a live ask. Either way the
      // ask that already exists covers the total this run derived, so this is
      // `raised` rather than a second write.
      return {
        outcome: "raised",
        paymentIntentId: existing.stripePaymentIntentId,
        totalCents: existing.amountCents,
      };
    }
    // The one write that makes a second share join the first: the SAME intent,
    // asking for more. Nothing is minted, so nothing is superseded, so
    // `queueSupersededAdditionalIntentCancellations` never fires between two
    // shares of one edit.
    await updatePaymentIntentAmount(
      existing.stripePaymentIntentId,
      totalCents,
    );
    await upsertPaymentIntentTransaction({
      paymentId,
      kind: PaymentTransactionKind.ADDITIONAL,
      paymentIntentId: existing.stripePaymentIntentId,
      amountCents: totalCents,
      status: PaymentStatus.PENDING,
      reason,
    });
    return {
      outcome: "raised",
      paymentIntentId: existing.stripePaymentIntentId,
      totalCents,
    };
  }

  // No request yet: mint through the same function every ordinary booking-edit
  // price increase uses. Its guard on a captured card payment is answered with
  // the payment as it stands NOW, re-read after the commit, rather than with a
  // literal `true` - a constant there would make the minter's own guard
  // permanently dead for this caller, which is the opposite of letting it remain
  // the one definition.
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: {
      id: true,
      status: true,
      amountCents: true,
      refundedAmountCents: true,
      source: true,
      stripeCustomerId: true,
    },
  });
  const minted = await createModificationAdditionalPaymentIntent({
    bookingId,
    result: {
      // Only the fields the minter reads. The rest of
      // `BookingModificationPaymentContext` describes a refund it will not make
      // (`pendingRefundAmountCents` 0) and a settlement it does not choose.
      pendingRefundAmountCents: 0,
      paymentId,
      additionalAmountCents: totalCents,
      hasSucceededPayment:
        hasCapturedPayment(payment) && payment?.source === PaymentSource.STRIPE,
      paymentCustomerId: payment?.stripeCustomerId ?? null,
      memberEmail: member?.email ?? "",
      memberName: member?.name ?? "",
      memberId: member?.id ?? "",
      bookingModificationId,
      // #3181: carried, not re-read. See this function's parameter docblock.
      hasIssuedXeroInvoice,
    },
    // #3170: the request's identity in the ledger. A later share finds this row
    // by exact match on it, which is why it is built rather than spelled.
    reason,
    // EDIT-scoped on both keys, which INVERTS the first #3170 round - see
    // `payment-recovery-keys.ts` for the full reasoning and for which of the two
    // (request vs share) each key belongs to. In short: the request is the thing
    // being identified, there is one per edit, and a replay converging on the
    // first intent is now the point rather than the hazard.
    idempotencyKey:
      buildEditFinancialReviewAdditionalIntentStripeKey(bookingModificationId),
    recoveryIdempotencyKey:
      buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey(
        bookingModificationId,
      ),
    failureMessage:
      "Failed to create the additional PaymentIntent for a completed edit financial review - the persisted recovery operation will replay it",
  });
  if (!minted.additionalPaymentIntentId) {
    /**
     * THE MINT PRODUCED NOTHING, AND THE MONEY IS STILL OWED.
     *
     * `createModificationAdditionalPaymentIntent` cannot throw this back at us:
     * it SWALLOWS a provider failure by design, because the ordinary edit path
     * that shares it must still return the member's saved change while the
     * recovery row carries the debt. That design is right there and wrong here,
     * so this caller reads the RESULT rather than relying on an exception -
     * which is why the fix is here and not in the minter's contract.
     *
     * Two ways to arrive, and the enqueue below covers both:
     *
     *   * the provider refused - the minter's own `catch` has already written
     *     the recovery row, and this upsert is a no-op on it;
     *   * its `hasSucceededPayment` / `paymentId` guard answered false on the
     *     re-read - it returns BEFORE its `try`, so nothing at all was written.
     *     That was the one path that settled a task, minted nothing, and left no
     *     trace of any kind.
     */
    await enqueueAdditionalPaymentIntentRecovery({
      bookingId,
      paymentId,
      idempotencyKey:
        buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey(
          bookingModificationId,
        ),
      // Advisory only, exactly as in `executeEditReviewCharge`: the replay
      // re-derives the total from the settled shares.
      amountCents: totalCents,
      stripeIdempotencyKey:
        buildEditFinancialReviewAdditionalIntentStripeKey(bookingModificationId),
      // #3181: NOT advisory. The replay reads this back to decide whether the
      // edit had an invoice to supplement at all.
      hadIssuedXeroInvoice: hasIssuedXeroInvoice,
    });
    return { outcome: "not-raised", paymentIntentId: null, totalCents };
  }
  return {
    outcome: "raised",
    paymentIntentId: minted.additionalPaymentIntentId,
    totalCents,
  };
}

/**
 * Raise the request, AFTER the caller's transaction has committed - the same
 * placement the refund side uses, and for the same reason: the Stripe call is a
 * provider round trip and the locking guide forbids one inside a transaction.
 *
 * Returns the request's intent id and the combined total it now asks for. The
 * intent id is null on the `invoice` route, where there is no intent to mint and
 * the supplementary Xero invoice IS the ask, and on a provider failure, which the
 * caller turns into an honest message rather than a receipt.
 */
export async function executeEditReviewCharge({
  bookingId,
  taskId,
  route,
}: {
  bookingId: string;
  taskId: string;
  route: EditReviewChargeRoute;
}): Promise<{ paymentIntentId: string | null; totalCents: number }> {
  // Derived here as well as inside the sync, because BOTH arms need it and the
  // failure arm needs it after the sync has thrown: the supplementary Xero
  // invoice the caller queues must bill the whole edit rather than this one share
  // of it, on the `invoice` route where there is no intent at all and on a
  // provider failure where the intent has not been raised yet.
  const totalCents = await sumEditReviewChargeSharesCents({
    bookingId,
    bookingModificationId: route.bookingModificationId,
  });
  if (route.collectVia !== "stripe") {
    return { paymentIntentId: null, totalCents };
  }
  try {
    return await syncEditFinancialReviewChargeRequest({
      bookingId,
      bookingModificationId: route.bookingModificationId,
      paymentId: route.paymentId,
      member: route.member,
      hasIssuedXeroInvoice: route.hasIssuedXeroInvoice,
    });
  } catch (err) {
    // Only the UPDATE arm reaches here: the mint arm is
    // `createModificationAdditionalPaymentIntent`, which swallows its own
    // provider failure and enqueues the identical recovery row itself. Either
    // way the debt becomes durable and the cron replays this same function,
    // which re-derives the total - so a failure costs a delay, never a share.
    logger.error(
      { err, bookingId, taskId, bookingModificationId: route.bookingModificationId },
      "Failed to raise the combined additional PaymentIntent for a completed edit financial review - the persisted recovery operation will replay it",
    );
    await enqueueAdditionalPaymentIntentRecovery({
      bookingId,
      paymentId: route.paymentId,
      idempotencyKey:
        buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey(
          route.bookingModificationId,
        ),
      // Advisory only: the replay re-derives the total from the settled shares,
      // so this figure is diagnostic rather than the debt.
      amountCents: totalCents,
      stripeIdempotencyKey:
        buildEditFinancialReviewAdditionalIntentStripeKey(
          route.bookingModificationId,
        ),
      // #3181: NOT advisory - the replay's answer to "was there an invoice to
      // supplement" is this value and nothing it can re-derive.
      hadIssuedXeroInvoice: route.hasIssuedXeroInvoice,
    }).catch((enqueueErr) =>
      logger.error(
        { err: enqueueErr, bookingId, taskId },
        "Failed to enqueue additional PaymentIntent recovery for a completed edit financial review",
      ),
    );
    return { paymentIntentId: null, totalCents };
  }
}
