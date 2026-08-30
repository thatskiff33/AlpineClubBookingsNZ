import "server-only";

import {
  BookingEventType,
  ManualRefundTaskDirection,
  ManualRefundTaskKind,
  PaymentSource,
  Prisma,
} from "@prisma/client";

import { recordBookingEvent } from "@/lib/booking-events";
import { hasCapturedPayment } from "@/lib/booking-payment-state";
import {
  chooseEditReviewChargeRoute,
  executeEditReviewCharge,
  type EditReviewChargeRoute,
} from "@/lib/edit-financial-review-charge";
import { REVIEW_CHARGE_WRONG_KIND_MESSAGE } from "@/lib/edit-financial-review-charge-refusals";
import { parseEditFinancialReviewContext } from "@/lib/edit-financial-review-context";
import logger from "@/lib/logger";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import {
  buildBookingModificationRefundMetadata,
  markEditFinancialReviewRefundRecoverySucceeded,
} from "@/lib/payment-recovery";
import { buildEditFinancialReviewRefundStripeKeyPrefix } from "@/lib/payment-recovery-keys";
import {
  planStripeRefundAllocation,
  refundPaymentTransactions,
  type RefundAllocationSlice,
} from "@/lib/payment-transactions";
import { dispatchEditReviewXeroSettlement } from "@/lib/edit-financial-review-xero-leg";

/**
 * #3032 (epic #2797): WHERE a confirmed review amount goes when the task is
 * closed, and what is refused before anything is claimed.
 *
 * ## Why this is a separate module from the completion itself
 *
 * `manual-refund-task-resolution.ts` is the completion DOOR: it validates the
 * operator's input, claims the task and audits the decision, and it ends at the
 * commit. Where an amount goes and how it gets there is a different question - a
 * question about the BOOKING's money rather than about the task's status - and it
 * is the one an adversarial reader needs to be able to check in isolation.
 *
 * ## Two halves, and the boundary between them is the CLAIM
 *
 * `chooseEditReviewSettlementRoute` runs BEFORE the claim, inside the caller's
 * transaction. It moves no money: it returns a plan or throws, and that is the
 * point - a refusal that fired after the claim would leave a task COMPLETED with
 * nothing moved, which is the "pretends money moved" failure `INV-PAY-051` exists
 * to prevent. (`planStripeRefundAllocation` may backfill legacy
 * `PaymentTransaction` rows as a side effect of reading them; that is a read made
 * durable on the caller's own transaction, not a settlement.)
 *
 * `executeEditReviewSettlement` runs AFTER the commit, and is where the provider
 * call, the member-facing events for the routes whose money moves out there, and
 * the Xero leg happen. Nothing between the two writes a settlement: the ledger
 * writes the transaction owns sit in the caller, immediately downstream of the
 * claim.
 *
 * ## WHY THIS IS NOT `calculateModificationSettlementOptions`
 *
 * `booking-modify-settlement.ts` already answers "where does a reduction's money
 * go" for a booking EDIT, and `INV-SSOT` says route to the existing answer rather
 * than write a second one. It was weighed and it cannot serve this path, for one
 * decisive reason: that function TIERS the amount. It takes a price delta, caps
 * it at the refundable balance and then runs it through
 * `calculateDualRefundAmounts`, so on a 50% tier a $50 basis becomes a $25 card
 * refund. Here the $50 IS the answer - an authorised admin priced it from the
 * booking's own evidence under owner decision D2, with the club's policy already
 * in their hand, and the figure is recorded in the audit entry. Tier it again and
 * the club silently hands back half of what the person who decided it authorised.
 * No argument reaches the right number through that function, so this is a
 * different question rather than a duplicated one.
 *
 * FOUR OF THE FIVE PROTECTIONS THAT FUNCTION CARRIES ARE STILL HERE, and this is
 * where they live now:
 *
 *  1. `hasSettledPayment && source === STRIPE` - the card route is taken only
 *     when the card money is genuinely there. Enforced below through
 *     `planStripeRefundAllocation`'s refundable total, which is derived from the
 *     captured `PaymentTransaction` rows themselves rather than from the
 *     `Payment.source` column - whose schema DEFAULT is `STRIPE`, so a
 *     hand-settled booking can carry it with nothing captured behind it.
 *  2. the cap at the refundable balance - enforced below, BEFORE the claim, so an
 *     over-cap amount leaves the task OPEN rather than COMPLETED-and-unpaid.
 *  3. the Xero delta - queued by the caller after the commit, from this same
 *     confirmed amount and the same `BookingModification` anchor.
 *  4. an explicit card-vs-credit `settlementMethod` - NOT reproduced, and this is
 *     the one deliberate omission. There is no choice to make here: the routes
 *     below are mutually exclusive on facts rather than on preference. Money that
 *     came in on a card goes back to that card; money with no card behind it can
 *     only become account credit, because there is nothing to reverse. The edit
 *     path needs an election because a captured card reduction may legitimately
 *     go either way at the member's choice; a review completion has one lawful
 *     destination per task, and offering a choice there would let an admin turn a
 *     member's card refund into club credit with no policy basis at all.
 *  5. the cancellation-policy tier itself - deliberately omitted, for the reason
 *     above: the confirmed amount has already been decided by a person.
 */

/**
 * The settlement paths that already exist, and this issue picks between rather
 * than adding a new one.
 *
 * #3170 ADDED A DIRECTION, NOT A MECHANISM. The three routes below all hand money
 * BACK, which was sufficient while only guest REMOVALS could park - a removal can
 * only ever owe the member. #3170 is the first change that parks an edit which
 * can move the price UP, so a fourth route, `additional-charge`, asks for money
 * instead; it re-enters `createModificationAdditionalPaymentIntent`, which is the
 * same function every ordinary price increase already goes through, so the
 * instrument, the ledger row, the chasing and the Xero leg are all the existing
 * ones - and, since the fix round, one such request per EDIT rather than per
 * task. Which route a completion takes is a function of the officer's stated
 * direction and the booking's own facts, never of a preference:
 *
 *  - `stripe-refund` - the booking was paid by card, so the money goes back the
 *    way it came. `executeBookingModificationRefund` owns the provider call, its
 *    Stripe idempotency key (`${prefix}_${bookingModificationId}`) and its
 *    recovery enqueue. It writes the ledger allocation ITSELF, through
 *    `refundPaymentTransactions`, which is why this route writes none in the
 *    transaction - doing both would consume the refundable headroom twice.
 *  - `local-allocation` - a payment the club settles by hand (internet banking,
 *    or a cash hand-back). Only the ledger mirror moves, which is exactly what
 *    every pre-#3032 task did and is left byte-identical.
 *  - `account-credit` - no captured card charge behind the adjustment, so the
 *    money is returned as account credit through
 *    `createBookingModificationCredit`, whose exactly-once key is the
 *    `BookingModification` id (owner decision D-3032-1).
 *
 * `null` is the fourth outcome and means "nothing moves": a DISMISSED task, and
 * a legacy hand-back with no payment behind it.
 */
export type EditReviewSettlementRoute =
  | {
      kind: "stripe-refund";
      paymentId: string;
      bookingModificationId: string;
      /**
       * The per-transaction slices frozen INSIDE the completion transaction,
       * before any Stripe call (booking-cancel's #1349 pattern). The caller
       * persists them on a recovery operation in that same transaction and then
       * executes exactly these slices inline, so the inline attempt and any cron
       * replay send byte-identical Stripe requests and converge on one refund.
       */
      allocation: RefundAllocationSlice[];
    }
  | {
      kind: "local-allocation";
      paymentId: string;
      /**
       * The `BookingModification` anchor, for the Xero credit note the caller
       * queues after the commit. NULL on every pre-#3032 task kind, keeping their
       * behaviour byte-identical: they were raised for bookings with no edit
       * behind them and no invoice line to correct.
       */
      bookingModificationId: string | null;
    }
  | {
      kind: "account-credit";
      bookingModificationId: string;
      /**
       * The booking's captured payment, when it has one. An account credit
       * consumes refundable value exactly like a card refund does, so the
       * allocation has to be written or a later cancellation refunds the same
       * cents a second time (#1031, and the reason
       * `createBookingModificationCredit` takes a payment id at all). Null when
       * there is no captured payment to allocate against.
       */
      allocateAgainstPaymentId: string | null;
    }
  /**
   * #3170: the direction that did not exist before this issue - the MEMBER owes
   * the CLUB. Defined in `edit-financial-review-charge.ts`, which is the whole of
   * what a charge is; the three above are the whole of what a refund is; and this
   * union is the one place that picks between them.
   */
  | EditReviewChargeRoute;

/**
 * Raised when the review carries no `BookingModification` to settle against -
 * either because none was recorded, or because the stored `reviewContext` cannot
 * be read back at all. Two of the three routes key their exactly-once on that
 * id, so without one the only alternatives are to guess which row to settle
 * against or to mint a second anchor silently. Both are worse than telling the
 * operator plainly and leaving the task open.
 */
export const REVIEW_SETTLEMENT_ANCHOR_MISSING_MESSAGE =
  "This review is not linked to the booking change it came from, so the amount cannot be settled automatically. Hand the amount back another way, then dismiss this task with a note recording what you paid and how - the note is the record that the money was settled outside the system.";

/**
 * Owner decision D-3032-1 obliges this case to be handled deliberately rather
 * than discovered at runtime. A confirmed review amount settles against the
 * ORIGINAL edit's `BookingModification` row, and
 * `MemberCredit.sourceBookingModificationId` is `@unique` - so if that edit had
 * already issued a credit of its own, a second credit against the same row
 * cannot be represented.
 *
 * Left unhandled it is not a clean failure: `createBookingModificationCredit`
 * would reach `assertMatchingBookingModificationCredit` and throw an untyped
 * `Error`, which falls past the route's `instanceof ManualBookingPaymentError`
 * check and reaches the operator as "Could not close the refund task" with a 500
 * in monitoring - for a database doing exactly what it was asked to.
 *
 * ANY pre-existing credit on the anchor is refused, including one whose amount
 * happens to equal the confirmed figure. That is not over-caution: a matching
 * amount is indistinguishable from a coincidence, and treating it as a replay
 * would mark the task COMPLETED having moved nothing - money lost in silence,
 * which is the failure this epic exists to prevent. A genuine replay never gets
 * here, because a second completion of a COMPLETED task is refused by the status
 * check in the caller.
 *
 * It is a DEFENSIVE refusal rather than a routine one: an edit whose amount
 * could not be proven computes no settlement, so it issues no credit of its own
 * and leaves the anchor free.
 *
 * WHAT THE OPERATOR IS TOLD TO DO WITH IT, and why that leaves an honest row.
 * The amount IS owed, so "dismiss it" would be wrong under a reading of DISMISSED
 * as "no adjustment is due". That is not what DISMISSED means here: the epic's
 * requirement is that a dismissal must not PRETEND MONEY MOVED, and the note is
 * REQUIRED on every dismissal precisely so the row says which decision it was.
 * The wording below therefore asks for the note to record the hand-back, and the
 * DISMISSED definition in `manual-refund-task-resolution.ts` and `INV-PAY-051` is
 * stated to match. Leaving the task OPEN instead would be the dishonest option:
 * it would hold a money question that has already been answered, and the
 * pending-review fence would keep refusing the member's edits for as long as it
 * stayed there.
 */
export const REVIEW_CREDIT_ANCHOR_TAKEN_MESSAGE =
  "The booking change behind this review has already issued account credit, so a second credit cannot be recorded against it. Hand the amount back another way, then dismiss this task with a note recording what you paid and how - the note is the record that the money was settled outside the system.";

/**
 * The pre-claim cap on the card route.
 *
 * `refundPaymentTransactions` refuses an amount larger than the captured Stripe
 * total - but it runs AFTER the commit, where a refusal is the worst possible
 * outcome: the failure was swallowed, a recovery operation that could never
 * succeed was enqueued, no `REFUNDED` event was written, and the route still
 * answered "Refund recorded as paid back by hand" over a permanently COMPLETED
 * task with nothing moved. Asking the same question here, before the claim, turns
 * that into a refusal the operator can act on with the task still OPEN.
 *
 * It is the captured-payment check as well. `Payment.source` defaults to `STRIPE`
 * in the schema, so routing on that column alone sends a hand-settled booking
 * with nothing captured down the card path; the refundable total this cap is
 * measured against is zero there, so the same refusal catches it.
 */
export const REVIEW_REFUND_EXCEEDS_CAPTURED_MESSAGE =
  "That is more than this booking's card payment can give back - check the amount against the booking's payment history, or hand the money back another way and dismiss this task with a note saying what was done.";

/** Exactly what the route decision reads off the task, and nothing else. */
export type EditReviewSettlementTask = {
  paymentId: string | null;
  kind: ManualRefundTaskKind | null;
  reviewContext: unknown;
  payment: { source: PaymentSource } | null;
  booking: {
    payment: {
      id: string;
      status: string;
      amountCents: number | null;
      refundedAmountCents: number | null;
      /**
       * #3170: a CHARGE has no task payment to route on - the money is coming the
       * other way - so it asks the BOOKING's payment whether there is a card
       * behind it, and needs that payment's own source and Stripe customer.
       */
      source: PaymentSource;
      stripeCustomerId: string | null;
    } | null;
    /**
     * #3170: for `findOrCreateCustomer` when a charge has to mint a Stripe
     * customer. Read inside the completion transaction with everything else.
     */
    member: {
      id: string;
      email: string;
      firstName: string;
      lastName: string;
    } | null;
  };
};

/**
 * Choose the settlement route for a completion, or throw the refusal that stops
 * it.
 *
 * MUST be called BEFORE the status claim and inside the caller's transaction.
 * The first is what makes a refusal safe - the task is left OPEN, still holding
 * the money question. The second is because the anchor-collision read has to see
 * the same snapshot the credit write will.
 *
 * Every kind other than `EDIT_FINANCIAL_REVIEW` keeps its pre-#3032 behaviour
 * byte for byte: allocate against the task's payment when it has one, and
 * otherwise move nothing. Those tasks are raised for cash-settled bookings with
 * no card charge to reverse, so there is no Stripe route to send them down and
 * no anchor to credit against.
 */
export async function chooseEditReviewSettlementRoute({
  task,
  amountCents,
  hasIssuedXeroInvoice,
  direction,
  store,
}: {
  task: EditReviewSettlementTask;
  /**
   * The confirmed amount this completion will settle, in integer cents. Always a
   * POSITIVE magnitude: `direction` says which way it goes, so no amount on this
   * path is ever negative and the sign is never overloaded to mean a direction
   * (`INV-MONEY-001`, and the magic-value rule this epic is built on).
   *
   * The card route needs it before the claim: the cap and the frozen allocation
   * are both functions of it, and both have to be answered while a refusal is
   * still free.
   */
  amountCents: number;
  /**
   * #3170: whether this booking already has an issued primary Xero invoice, from
   * the caller's own `hasIssuedPrimaryXeroInvoice` read on the same transaction.
   * The CHARGE direction needs it BEFORE the claim, because it is one of the two
   * instruments a charge can use and its absence is a refusal rather than a
   * silent no-op.
   */
  hasIssuedXeroInvoice: boolean;
  /**
   * #3170: WHICH WAY the money goes, and it is the officer's decision rather than
   * anything the system can derive - the amount is precisely the figure it could
   * not work out. It arrives as an explicit value with no default: before this
   * issue the direction was implicit in the word "refund", which is exactly how
   * an officer who correctly concluded "they owe us $200" could have $200 sent to
   * the member's card.
   */
  direction: ManualRefundTaskDirection;
  store: Prisma.TransactionClient;
}): Promise<EditReviewSettlementRoute | null> {
  if (task.kind !== ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW) {
    if (direction === ManualRefundTaskDirection.CHARGE_TO_MEMBER) {
      throw new ManualBookingPaymentError(REVIEW_CHARGE_WRONG_KIND_MESSAGE, 400);
    }
    return task.paymentId !== null
      ? {
          kind: "local-allocation",
          paymentId: task.paymentId,
          bookingModificationId: null,
        }
      : null;
  }

  // Parsed through the one parser (`INV-SSOT`, #3030) rather than indexed into
  // as JSON. Null here means the row's evidence is unreadable, which is a
  // legitimate state for a task an admin must still be able to SEE - but not one
  // that can be settled automatically, so it falls into the anchor-missing
  // refusal below with a message that says what to do instead.
  const reviewContext = parseEditFinancialReviewContext(task.reviewContext);
  const bookingModificationId = reviewContext?.bookingModificationId ?? null;

  if (direction === ManualRefundTaskDirection.CHARGE_TO_MEMBER) {
    // #3170. Everything below hands money BACK; this is the one arm that asks for
    // it, and it delegates rather than branching inline - a charge shares none of
    // the refund machinery, and the strongest guard against one quietly taking a
    // refund path is that the two share no code at all.
    return chooseEditReviewChargeRoute({
      bookingModificationId,
      bookingPayment: task.booking.payment,
      member: task.booking.member,
      hasIssuedXeroInvoice,
      // #3170: the same transaction the claim runs in, because the charge route
      // asks whether this EDIT already has a request open to a further share and
      // that read must see the snapshot the claim commits against - the reason
      // the credit-anchor read below takes the store too.
      store,
    });
  }

  if (task.paymentId !== null && task.payment?.source === PaymentSource.STRIPE) {
    if (!bookingModificationId) {
      throw new ManualBookingPaymentError(
        REVIEW_SETTLEMENT_ANCHOR_MISSING_MESSAGE,
        409,
      );
    }
    // Freeze the allocation and cap the amount in ONE read, on the caller's
    // transaction and before its claim. Once the cap has passed the planned total
    // cannot be short of `amountCents`, because the planner allocates
    // newest-first across exactly the transactions the cap totalled.
    const { slices, totalRefundableCents } = await planStripeRefundAllocation({
      paymentId: task.paymentId,
      amountCents,
      store,
    });
    if (amountCents > totalRefundableCents) {
      throw new ManualBookingPaymentError(
        REVIEW_REFUND_EXCEEDS_CAPTURED_MESSAGE,
        400,
      );
    }
    return {
      kind: "stripe-refund",
      paymentId: task.paymentId,
      bookingModificationId,
      allocation: slices,
    };
  }

  if (task.paymentId !== null) {
    // Internet banking, or any non-card capture: the club moves the money by hand
    // and this records the ledger mirror of it, exactly as the legacy hand-back
    // does. The cap lives inside `applyLocalRefundAllocation`, which runs INSIDE
    // the caller's transaction - so its refusal rolls the claim back and leaves
    // the task OPEN, which is the guarantee the pre-claim card cap above has to
    // buy by hand.
    return {
      kind: "local-allocation",
      paymentId: task.paymentId,
      bookingModificationId,
    };
  }

  if (!bookingModificationId) {
    throw new ManualBookingPaymentError(
      REVIEW_SETTLEMENT_ANCHOR_MISSING_MESSAGE,
      409,
    );
  }

  // Owner decision D-3032-1's obliged edge case - see
  // `REVIEW_CREDIT_ANCHOR_TAKEN_MESSAGE` for why any pre-existing credit on the
  // anchor is refused rather than treated as a replay.
  const anchorCredit = await store.memberCredit.findUnique({
    where: { sourceBookingModificationId: bookingModificationId },
    select: { id: true },
  });
  if (anchorCredit) {
    throw new ManualBookingPaymentError(REVIEW_CREDIT_ANCHOR_TAKEN_MESSAGE, 409);
  }

  return {
    kind: "account-credit",
    bookingModificationId,
    allocateAgainstPaymentId: hasCapturedPayment(task.booking.payment)
      ? (task.booking.payment?.id ?? null)
      : null,
  };
}

/**
 * #3032: everything a completed review has to do AFTER its transaction commits.
 *
 * The transaction is closed by the time this runs, which is the point:
 * `AGENTS.md` and `docs/CONCURRENCY_AND_LOCKING.md` both forbid a provider round
 * trip inside a database transaction, and this path is the one the locking guide
 * singles out as deliberately holding no advisory lock for exactly that reason.
 * The single-flight guarantee is the caller's status claim, which has already
 * committed: a second completion of the task is refused by the status check, so
 * nothing here can run twice for one task.
 *
 * A crash between that commit and these calls is NOT an accepted loss. The card
 * route persisted its refund debt - the frozen per-transaction slices and the
 * task-scoped Stripe key prefix - inside the caller's transaction, so the
 * recovery cron replays exactly what this function would have sent. That is
 * booking-cancel's #1349 arrangement and the reasoning transfers verbatim.
 *
 * Returns the Stripe refund id when one actually issued, and `null` otherwise -
 * including when the provider call failed, because the caller turns that null
 * into an honest message rather than a receipt. #3170 returns the additional
 * PaymentIntent id on the same terms, for the same reason: "the member has been
 * asked for $200" over an intent that was never minted is a false receipt in the
 * opposite direction.
 */
export async function executeEditReviewSettlement({
  bookingId,
  taskId,
  actingMemberId,
  route,
  amountCents,
  hasIssuedXeroInvoice,
  bookingPaymentStatus,
}: {
  bookingId: string;
  taskId: string;
  actingMemberId: string;
  route: EditReviewSettlementRoute | null;
  amountCents: number | null;
  hasIssuedXeroInvoice: boolean;
  bookingPaymentStatus: string | null;
}): Promise<{
  stripeRefundId: string | null;
  additionalPaymentIntentId: string | null;
}> {
  let stripeRefundId: string | null = null;

  if (route?.kind === "stripe-refund") {
    const refundAmountCents = amountCents ?? 0;
    try {
      const refundResult = await refundPaymentTransactions({
        paymentId: route.paymentId,
        amountCents: refundAmountCents,
        // #1507: the body is rebuilt byte-identically by a recovery replay from
        // the stored key prefix, so the reason is a fixed discriminator, never
        // prose. `bookingModificationRefundReasonForKeyPrefix` maps this task's
        // prefix back to exactly this string.
        metadata: buildBookingModificationRefundMetadata(
          bookingId,
          "edit_financial_review",
        ),
        // TASK-scoped, not modification-scoped. Owner decision D-3032-1 settles a
        // review against the ORIGINAL edit's `BookingModification`, and one edit
        // can raise TWO review tasks - two unpriceable strands, one modification
        // row. A modification-scoped prefix would give both the same per-slice
        // key, Stripe would answer the second with the FIRST refund, and the
        // caller would take the replayed id as success and tell the member their
        // money came back when half of it never left.
        idempotencyKeyPrefix:
          buildEditFinancialReviewRefundStripeKeyPrefix(taskId),
        // The slices frozen inside the transaction, so an inline attempt and a
        // cron replay send byte-identical requests.
        allocation: route.allocation,
      });
      stripeRefundId = refundResult.refunds[0]?.refundId ?? null;
      // Best-effort close, exactly as #1349's is: a lost close leaves the
      // operation PENDING and the cron replays the identical frozen slices, which
      // Stripe answers with the original refunds.
      await markEditFinancialReviewRefundRecoverySucceeded({ taskId }).catch(
        (err) =>
          logger.error(
            { err, bookingId, taskId },
            "Failed to close the edit-financial-review refund recovery operation after an inline refund succeeded",
          ),
      );
    } catch (err) {
      // The debt is already durable, so there is nothing to enqueue here and
      // nothing is lost: the operation stays PENDING and the cron replays it.
      logger.error(
        { err, bookingId, taskId, amountCents: refundAmountCents },
        "Stripe refund failed after an edit financial review was completed - the persisted recovery operation will replay it",
      );
    }
    if (stripeRefundId) {
      // Only on a refund that actually issued. A failure records NO event: a
      // REFUNDED row is member-facing through `booking-narrative.ts`, so writing
      // one for money still sitting in the club's account would tell the member
      // their refund had happened.
      await recordBookingEvent({
        bookingId,
        type: BookingEventType.REFUNDED,
        actorMemberId: actingMemberId,
        amountCents: refundAmountCents,
        reason: "edit_financial_review_completed",
      });
    }
  }

  /**
   * #3170: the charge direction, executed AFTER the commit for the same reason
   * the refund is - the Stripe call is a provider round trip and the locking
   * guide forbids one inside a transaction.
   *
   * NOTHING IS TAKEN FROM THE MEMBER'S CARD HERE. This raises the REQUEST: one
   * additional PaymentIntent per EDIT and the PENDING `ADDITIONAL`
   * PaymentTransaction row the club's whole additional-payment machinery keys off
   * - the chase reminders, the resend service, the member's pay link. The member
   * pays it themselves, exactly as they would for an ordinary check-out
   * extension. That is why a failure here is recoverable rather than a lost
   * charge: the debt is durable and the recovery cron replays the same
   * re-derivation under the same edit-scoped key.
   */
  let additionalPaymentIntentId: string | null = null;
  // #3170 (owner decision, 30 Aug 2026): the combined total of every share
  // settled as money owed to the club against THIS EDIT - not `amountCents`,
  // which is this one task's share. Both legs of the edit read it, so they can
  // never disagree. Null on every route that is not a charge.
  let chargeTotalCents: number | null = null;
  if (route?.kind === "additional-charge") {
    const charged = await executeEditReviewCharge({
      bookingId,
      taskId,
      route,
    });
    additionalPaymentIntentId = charged.paymentIntentId;
    chargeTotalCents = charged.totalCents;
  }

  if (route?.kind === "account-credit") {
    // `INV-PAY-051` asks for the booking event to be written where the money
    // moves, and this is that place: the credit row is committed, so the claim
    // the member reads is one the ledger can be pointed at.
    await recordBookingEvent({
      bookingId,
      type: BookingEventType.CREDITED,
      actorMemberId: actingMemberId,
      amountCents: amountCents ?? 0,
      reason: "edit_financial_review_credited",
    });
  }

  /**
   * The Xero leg, which the issue's "through the existing canonical settlement
   * path" includes: the officer's direction becomes a signed delta, an invoice
   * this edit already has queued is raised rather than duplicated, and a share
   * the accounting ask could not take is recorded. It lives in
   * `edit-financial-review-xero-leg.ts` because those three are one decision
   * about one edit's one invoice, while everything above here is money MOVING.
   *
   * Awaited, but nothing inside it holds the request open: the dispatch itself
   * is fire-and-forget, exactly as it was inline.
   */
  await dispatchEditReviewXeroSettlement({
    bookingId,
    taskId,
    actingMemberId,
    route,
    amountCents,
    chargeTotalCents,
    hasIssuedXeroInvoice,
    bookingPaymentStatus,
    additionalPaymentIntentId,
  });

  return { stripeRefundId, additionalPaymentIntentId };
}
