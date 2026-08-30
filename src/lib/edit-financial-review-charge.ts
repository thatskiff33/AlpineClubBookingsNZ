import "server-only";

import { PaymentSource } from "@prisma/client";

import { hasCapturedPayment } from "@/lib/booking-payment-state";
import { createModificationAdditionalPaymentIntent } from "@/lib/booking-modification-settlement";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import {
  buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey,
  buildEditFinancialReviewAdditionalIntentStripeKey,
} from "@/lib/payment-recovery-keys";

/**
 * #3170 (epic #2797): the one direction of a settled review that ASKS FOR MONEY.
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
 * ## What it is NOT
 *
 * It is not a fourth settlement mechanism, which the epic forbids outright.
 * `createModificationAdditionalPaymentIntent` is the same function every ordinary
 * booking-edit price increase goes through, so the instrument, the PENDING
 * `ADDITIONAL` PaymentTransaction row, the chase reminders, the member's pay link
 * and the Xero supplementary invoice's wait-for-payment are all the existing
 * ones.
 *
 * And NOTHING IS TAKEN FROM THE MEMBER'S CARD HERE. The completion mints the
 * REQUEST; the member pays it themselves, exactly as they would for an ordinary
 * extension. That is why a provider failure is recoverable rather than a lost
 * charge, and why the admin copy is allowed to say so.
 */

/** How the club will ask, decided from the booking's own facts rather than offered as a choice. */
export type EditReviewChargeRoute = {
  kind: "additional-charge";
  bookingModificationId: string;
  /**
   * `stripe` when the booking has a CAPTURED card payment: an additional
   * PaymentIntent is minted against it. `invoice` otherwise, which is the
   * internet-banking booking: there is no intent to mint, so the supplementary
   * Xero invoice is the ask and the club's existing additional-payment chasing
   * carries it.
   */
  collectVia: "stripe" | "invoice";
  /**
   * The booking's payment row, when there is one to hang an `ADDITIONAL`
   * transaction off.
   */
  paymentId: string | null;
  /** Read inside the completion transaction, for `findOrCreateCustomer`. */
  member: {
    id: string;
    email: string;
    name: string;
    stripeCustomerId: string | null;
  } | null;
};

/**
 * #3170: the officer said the CLUB is owed, on a task kind that can only ever
 * mean the club owes the MEMBER.
 *
 * The three pre-#2797 kinds are all hand-backs by definition - a cancelled
 * cash-settled booking, a late capture on a deleted booking, the record of a
 * capture Stripe already refunded. There is no shape of any of them in which the
 * member owes money, so a charge direction on one is a mistake rather than an
 * unusual case, and it is refused before anything is claimed.
 */
export const REVIEW_CHARGE_WRONG_KIND_MESSAGE =
  "This task is money the club owes the member, so it cannot be used to collect money from them. If the member owes the club for a booking change, make that change on the booking itself.";

/**
 * #3170: the officer said the club is owed, and there is no way to ask for it.
 *
 * The club collects a price increase in exactly two ways: an additional card
 * payment against a captured Stripe payment, or a supplementary invoice on a
 * booking that already has one. A booking with neither has no instrument at all -
 * inventing one here would be the fourth settlement mechanism the epic forbids,
 * and pretending the money was collected would be the "claims money moved"
 * failure `INV-PAY-051` exists to stop.
 *
 * Refused BEFORE the claim, so the task stays OPEN and still holds the money
 * question.
 */
export const REVIEW_CHARGE_NO_INSTRUMENT_MESSAGE =
  "There is no card payment on this booking and no invoice to add this to, so the club cannot ask for the money automatically. Collect it another way, then dismiss this task with a note recording what was collected and how - the note is the record that the money was settled outside the system.";

/**
 * #3170: a charge with no `BookingModification` to hang it on.
 *
 * The same anchor the refund side needs, and needed for the same reason plus one
 * more: the supplementary invoice that corrects an issued Xero invoice is queued
 * against that row, so a charge with no anchor would collect money the club's
 * accounts never show as owed. Told plainly rather than guessed at.
 */
export const REVIEW_CHARGE_ANCHOR_MISSING_MESSAGE =
  "This review is not linked to the booking change it came from, so the club cannot ask for the money automatically. Collect it another way, then dismiss this task with a note recording what was collected and how - the note is the record that the money was settled outside the system.";

/**
 * Decide how a charge will be collected, or throw the refusal that stops it.
 *
 * MUST be called BEFORE the caller's status claim and inside its transaction,
 * exactly as the refund routes are: a refusal that fired after the claim would
 * leave a task COMPLETED with nothing collected, which is the "pretends money
 * moved" failure `INV-PAY-051` forbids, in the direction where the club is the
 * one left short.
 */
export function chooseEditReviewChargeRoute({
  bookingModificationId,
  bookingPayment,
  member,
  hasIssuedXeroInvoice,
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
}): EditReviewChargeRoute {
  if (!bookingModificationId) {
    throw new ManualBookingPaymentError(
      REVIEW_CHARGE_ANCHOR_MISSING_MESSAGE,
      409,
    );
  }
  // The same test `applyPaymentAdjustments` uses to decide whether an ordinary
  // price increase mints an intent: a CAPTURED payment whose source is the card.
  // `Payment.source` alone is not enough - its schema DEFAULT is STRIPE, so a
  // hand-settled booking carries it with nothing captured behind it.
  const canChargeCard =
    hasCapturedPayment(bookingPayment) &&
    bookingPayment?.source === PaymentSource.STRIPE;
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
  return {
    kind: "additional-charge",
    bookingModificationId,
    collectVia: canChargeCard ? "stripe" : "invoice",
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
 * placement the refund side uses, and for the same reason: `createPaymentIntent`
 * is a provider round trip and the locking guide forbids one inside a
 * transaction.
 *
 * Returns the minted intent id, or null - including on the `invoice` route,
 * where there is no intent to mint, and on a provider failure, which the caller
 * turns into an honest message rather than a receipt.
 */
export async function executeEditReviewCharge({
  bookingId,
  taskId,
  actingMemberId,
  route,
  amountCents,
}: {
  bookingId: string;
  taskId: string;
  actingMemberId: string;
  route: EditReviewChargeRoute;
  amountCents: number;
}): Promise<string | null> {
  if (route.collectVia !== "stripe") return null;
  const minted = await createModificationAdditionalPaymentIntent({
    bookingId,
    result: {
      // Only the fields the minter reads. The rest of
      // `BookingModificationPaymentContext` describes a refund it will not make
      // (`pendingRefundAmountCents` 0) and a settlement it does not choose.
      pendingRefundAmountCents: 0,
      paymentId: route.paymentId,
      additionalAmountCents: amountCents,
      // The route already established a CAPTURED card payment on this booking;
      // saying so again here is what lets the minter's own guard stay the one
      // definition of "there is a card to charge".
      hasSucceededPayment: true,
      paymentCustomerId: route.member?.stripeCustomerId ?? null,
      memberEmail: route.member?.email ?? "",
      memberName: route.member?.name ?? "",
      memberId: route.member?.id ?? actingMemberId,
      bookingModificationId: route.bookingModificationId,
    },
    reason: "edit_financial_review_charge",
    // TASK-scoped, not modification-scoped, and for a sharper reason than the
    // refund side's: `createPaymentIntent` MINTS. Two reviews of one edit sharing
    // a key would have Stripe answer the second with the FIRST intent, leaving
    // the club one instrument for two amounts - collectable once, while both
    // tasks read as settled.
    idempotencyKey: buildEditFinancialReviewAdditionalIntentStripeKey(taskId),
    // Task-scoped for the same reason, and because the recovery row is where a
    // colliding key would rewrite an amount.
    recoveryIdempotencyKey:
      buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey(taskId),
    failureMessage:
      "Failed to create the additional PaymentIntent for a completed edit financial review - the persisted recovery operation will replay it",
  });
  return minted.additionalPaymentIntentId ?? null;
}
