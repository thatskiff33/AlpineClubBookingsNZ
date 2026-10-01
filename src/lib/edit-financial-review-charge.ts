import "server-only";

import {
  PaymentSource,
  PaymentStatus,
} from "@prisma/client";

import { hasCapturedPayment } from "@/lib/booking-payment-state";
import {
  REVIEW_CHARGE_ANCHOR_MISSING_MESSAGE,
  REVIEW_CHARGE_NO_INSTRUMENT_MESSAGE,
  REVIEW_CHARGE_REQUEST_ALREADY_PAID_MESSAGE,
  REVIEW_CHARGE_REQUEST_CLOSED_MESSAGE,
} from "@/lib/edit-financial-review-charge-refusals";
import {
  findEditReviewChargeRequest,
  hasIssuedSupplementaryInvoice,
  sumEditReviewChargeSharesCents,
  type EditReviewChargeStore,
} from "@/lib/edit-financial-review-charge-request";
import { syncEditFinancialReviewChargeRequest } from "@/lib/edit-financial-review-charge-sync";
import logger from "@/lib/logger";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import { enqueueAdditionalPaymentIntentRecovery } from "@/lib/payment-recovery";
import {
  buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey,
  buildEditFinancialReviewAdditionalIntentStripeKey,
} from "@/lib/payment-recovery-keys";
import { isCapturedTransactionStatus } from "@/lib/payment-transactions";
import type { ClubFormat } from "@/lib/club-format";

// #3402: the sync moved to its own module with the raise claim around it;
// re-exported so the recovery replay and existing importers keep one path.
export { syncEditFinancialReviewChargeRequest };

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
 * ## AND IT CARRIES WHAT ITS MINT RETIRES (#3371, owner decision 13 Sep 2026)
 *
 * Those bullets cover two shares of ONE edit, the only case #3170 saw. A booking
 * can also carry an unpaid ask raised by a DIFFERENT edit, and minting this one
 * cancels it - which is how $260 across two parked edits collected $60. The ask
 * is now the share sum PLUS that balance, built by the module the ordinary path
 * has used since #3340 and stored beside the sum, never inside it. The rule is
 * `INV-PAY-098` and is not restated here.
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
  taskId, route, format,
}: {
  bookingId: string;
  taskId: string;
  route: EditReviewChargeRoute;
  format: ClubFormat; // #3565: resolved before any transaction by the caller
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
      format, bookingId, bookingModificationId: route.bookingModificationId,
      paymentId: route.paymentId,
      member: route.member,
      hasIssuedXeroInvoice: route.hasIssuedXeroInvoice,
    });
  } catch (err) {
    // Only the UPDATE arm's provider call (or a claim statement, #3402) reaches
    // here: the mint arm is
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
