import "server-only";

import { ManualRefundTaskKind, PaymentSource, Prisma } from "@prisma/client";

import { hasCapturedPayment } from "@/lib/booking-payment-state";
import { parseEditFinancialReviewContext } from "@/lib/edit-financial-review-context";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";

/**
 * #3032 (epic #2797): WHERE a confirmed review amount goes when the task is
 * closed, and what is refused before anything is claimed.
 *
 * ## Why this is a separate module from the completion itself
 *
 * `manual-refund-task-resolution.ts` is the completion DOOR: it validates the
 * operator's input, claims the task, audits the decision and records the
 * member-facing event. Choosing which of the club's settlement paths an amount
 * belongs to is a different question - a question about the BOOKING's money
 * rather than about the task's status - and it is the one an adversarial reader
 * needs to be able to check in isolation. Keeping it here also keeps the
 * completion door inside the file-size budget rather than growing a
 * two-responsibility module past it.
 *
 * ## What it deliberately does not do
 *
 * It moves no money and writes no row. Every function here either returns a
 * plan or throws; the writes happen in the caller, downstream of the
 * status-guarded claim, which is what makes them exactly-once. Splitting the
 * DECISION from the WRITE is the point: a refusal that fired after the claim
 * would leave a task COMPLETED with nothing moved, which is the "pretends money
 * moved" failure `INV-PAY-051` exists to prevent.
 */

/**
 * The three settlement paths that already exist, and this issue picks between
 * rather than adding a fourth:
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
    }
  | { kind: "local-allocation"; paymentId: string }
  | {
      kind: "account-credit";
      bookingModificationId: string;
      /**
       * The booking's captured payment, when it has one. An account credit
       * consumes refundable value exactly like a card refund does, so the
       * allocation has to be written or a later cancellation refunds the same
       * cents a second time (#1031, and the reason
       * `createBookingModificationCredit` takes a payment id at all). Null when
       * the booking has no captured payment, where there is nothing to allocate
       * against.
       */
      allocateAgainstPaymentId: string | null;
    };

/**
 * Raised when the review carries no `BookingModification` to settle against -
 * either because none was recorded, or because the stored `reviewContext` cannot
 * be read back at all. Two of the three routes key their exactly-once on that
 * id, so without one the only alternatives are to guess which row to settle
 * against or to mint a second anchor silently. Both are worse than telling the
 * operator plainly and leaving the task open.
 */
export const REVIEW_SETTLEMENT_ANCHOR_MISSING_MESSAGE =
  "This review is not linked to the booking change it came from, so the amount cannot be settled automatically. Record the hand-back against the booking's payment and dismiss this task with a note saying so.";

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
 */
export const REVIEW_CREDIT_ANCHOR_TAKEN_MESSAGE =
  "The booking change behind this review has already issued account credit, so a second credit cannot be recorded against it. Hand the amount back another way and dismiss this task with a note saying what was done.";

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
export async function chooseEditReviewSettlementRoute(
  task: EditReviewSettlementTask,
  store: Prisma.TransactionClient,
): Promise<EditReviewSettlementRoute | null> {
  if (task.kind !== ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW) {
    return task.paymentId !== null
      ? { kind: "local-allocation", paymentId: task.paymentId }
      : null;
  }

  // Parsed through the one parser (`INV-SSOT`, #3030) rather than indexed into
  // as JSON. Null here means the row's evidence is unreadable, which is a
  // legitimate state for a task an admin must still be able to SEE - but not one
  // that can be settled automatically, so it falls into the anchor-missing
  // refusal below with a message that says what to do instead.
  const reviewContext = parseEditFinancialReviewContext(task.reviewContext);
  const bookingModificationId = reviewContext?.bookingModificationId ?? null;

  if (task.paymentId !== null && task.payment?.source === PaymentSource.STRIPE) {
    if (!bookingModificationId) {
      throw new ManualBookingPaymentError(
        REVIEW_SETTLEMENT_ANCHOR_MISSING_MESSAGE,
        409,
      );
    }
    return {
      kind: "stripe-refund",
      paymentId: task.paymentId,
      bookingModificationId,
    };
  }

  if (task.paymentId !== null) {
    // Internet banking, or any non-card capture: the club moves the money by
    // hand and this records the ledger mirror of it, exactly as the legacy
    // hand-back does.
    return { kind: "local-allocation", paymentId: task.paymentId };
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
