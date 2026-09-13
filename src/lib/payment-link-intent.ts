/**
 * Token-authenticated Stripe PaymentIntent creation for a payment link.
 * Extracted from `payment-link.ts` by responsibility (#2956): this is the one
 * card-settlement door a `/pay` token opens, and it runs the same status and
 * capacity revalidation as the session-gated payment-intent route. Token
 * resolution and the refusal vocabulary it throws stay in `payment-link.ts`.
 */
import { PaymentStatus, PaymentTransactionKind } from "@prisma/client";
import { acquireLodgeCapacityLock, checkCapacityForGuestRanges } from "@/lib/capacity";
import { bookingHasCapacityOverride } from "@/lib/booking-status";
import { getDefaultLodgeId } from "@/lib/lodges";
import { sendAdminPaymentFailureAlert } from "@/lib/email";
import { formatCents } from "@/lib/utils";
import logger from "@/lib/logger";
import { markBookingPaymentSucceeded } from "@/lib/payment-reconciliation";
import {
  findPaymentTransactionByIntentId,
  upsertPaymentIntentTransaction,
} from "@/lib/payment-transactions";
import { isHostingCoverageParticipantRetry } from "@/lib/adult-member-hosting-queue-participants";
import { queueSupersededPrimaryIntentCancellations } from "@/lib/booking-payment-cleanup";
import {
  NOT_PAYABLE_MESSAGE,
  PaymentLinkError,
  REVOKED_LINK_MESSAGE,
  USED_LINK_MESSAGE,
  isPaidLikeStatus,
  isPayableByLink,
  resolvePaymentLink,
} from "@/lib/payment-link";
import { prisma } from "@/lib/prisma";
import {
  createPaymentIntent,
  findOrCreateCustomer,
  getPaymentIntent,
} from "@/lib/stripe";
import { queueXeroInvoiceForPaidBooking } from "@/lib/xero-booking-invoice-queue";

export type PaymentLinkPaymentRecoveryKind =
  | "payment_received_finalisation_pending"
  | "payment_received_status_unconfirmed"
  | "existing_card_status_unconfirmed"
  | "cancelled_refunded"
  | "cancelled_refund_pending";

/**
 * Provider-safe recovery signal for failures after Stripe reports a successful
 * intent. The public route maps only these fixed phases and never exposes the
 * intent id or the underlying provider/database error.
 */
export class PaymentLinkPaymentRecoveryError extends Error {
  constructor(readonly kind: PaymentLinkPaymentRecoveryKind) {
    super("Payment-link card status requires recovery");
    this.name = "PaymentLinkPaymentRecoveryError";
  }
}

/**
 * #2265 (#2319 door 1). Deliberately vague to the payer, who is often not the
 * member whose credit is involved: it says the booking needs to be paid another
 * way and points at the club, without disclosing that a member holds an account
 * credit balance or how much of it they elected to spend. The operator alert
 * raised alongside carries the full detail.
 */
const CREDIT_ELECTION_PENDING_MESSAGE =
  "This booking has to be paid from the member's own account rather than through this link. Please contact the club and they'll sort it out.";

/**
 * Signals the unconsumed-credit-election refusal from inside the revalidation
 * transaction (#2265). Thrown, rather than returned, so the transaction rolls
 * back; caught immediately outside it, where the operator alert can be sent
 * without an SES call sitting inside an open transaction.
 */
class UnconsumedCreditElectionError extends Error {
  constructor(readonly electionCents: number) {
    super("Booking carries an unconsumed credit election");
    this.name = "UnconsumedCreditElectionError";
  }
}

export type PaymentLinkIntentResult =
  | { type: "alreadyPaid" }
  | { type: "clientSecret"; clientSecret: string; paymentIntentId: string };

/**
 * Token-authenticated Stripe payment intent creation. Runs the SAME
 * status and capacity revalidation as the session-gated
 * /api/payments/create-payment-intent path before any Stripe call:
 *   1. booking must still be payable (status check)
 *   2. existing PaymentIntents are reused/reconciled, not duplicated
 *   3. capacity is revalidated under the booking advisory lock
 * Final capacity claiming happens in markBookingPaymentSucceeded exactly
 * as it does for session payments and webhooks.
 */
export async function createPaymentIntentForPaymentLink(
  token: string
): Promise<PaymentLinkIntentResult> {
  const link = await resolvePaymentLink(token);
  const booking = link.booking;

  if (isPaidLikeStatus(booking.status)) {
    throw new PaymentLinkError(USED_LINK_MESSAGE, 410);
  }

  if (!isPayableByLink(booking.status)) {
    throw new PaymentLinkError(NOT_PAYABLE_MESSAGE, 410);
  }

  // Reuse or reconcile an existing PaymentIntent before creating a new one
  // (same behaviour as the session payment-intent route).
  //
  // A refunded succeeded intent remains the current Payment pointer until the
  // fresh PRIMARY transaction below is recorded. Carry that exact intent id as
  // a repayment generation marker so the refunded intent cannot fall through
  // to the generic equal-amount/client-secret reuse arm, and so retries use a
  // Stripe idempotency key disjoint from every non-repayment generation.
  let repaySupersededIntentId: string | null = null;
  if (booking.payment?.stripePaymentIntentId) {
    const existingIntent = await getPaymentIntent(booking.payment.stripePaymentIntentId);

    if (existingIntent.status === "succeeded") {
      // A refunded PaymentIntent remains `succeeded` at Stripe. The immutable
      // local transaction row is therefore the discriminator between a
      // captured payment that needs reconciliation and refund history that
      // must lead to a fresh repayment intent.
      let refundedHistory: boolean;
      try {
        const pointedTransaction = await findPaymentTransactionByIntentId({
          paymentIntentId: existingIntent.id,
        });
        refundedHistory = pointedTransaction
          ? pointedTransaction.status === PaymentStatus.REFUNDED ||
            pointedTransaction.status === PaymentStatus.PARTIALLY_REFUNDED
          : booking.payment.status === PaymentStatus.REFUNDED ||
            booking.payment.status === PaymentStatus.PARTIALLY_REFUNDED;
      } catch (error) {
        logger.error(
          { err: error, bookingId: booking.id },
          "Could not classify an existing successful payment-link intent",
        );
        throw new PaymentLinkPaymentRecoveryError(
          "existing_card_status_unconfirmed",
        );
      }

      if (refundedHistory) {
        repaySupersededIntentId = existingIntent.id;
        await queueSupersededPrimaryIntentCancellations(prisma, {
          bookingId: booking.id,
          paymentId: booking.payment.id,
          newFinalPriceCents: booking.finalPriceCents,
        });
      } else {
      // #2265 (#2319 door 1, settle arm). The card money is already captured, so
      // a stored credit election can no longer be honoured here — but the clear
      // and its reporting live in `markBookingPaymentSucceeded` below, the single
      // settle door every card path funnels through, rather than being repeated
      // in this caller. When the payment is ALREADY SUCCEEDED this arm settles
      // nothing at all, so an earlier run through that same door has already
      // dealt with it.
        try {
          if (booking.payment.status !== PaymentStatus.SUCCEEDED) {
            const reconciliation = await markBookingPaymentSucceeded({
              bookingId: booking.id,
              paymentIntentId: existingIntent.id,
              amountCents: existingIntent.amount,
              paymentMethodId:
                typeof existingIntent.payment_method === "string"
                  ? existingIntent.payment_method
                  : existingIntent.payment_method?.id ?? null,
            });

            if (reconciliation.outcome === "cancelled_refunded") {
              throw new PaymentLinkPaymentRecoveryError("cancelled_refunded");
            }
            if (reconciliation.outcome === "cancelled_refund_failed") {
              throw new PaymentLinkPaymentRecoveryError(
                "cancelled_refund_pending",
              );
            }
          }

          await queueXeroInvoiceForPaidBooking({ bookingId: booking.id });
        } catch (error) {
          if (error instanceof PaymentLinkPaymentRecoveryError) throw error;
          logger.error(
            { err: error, bookingId: booking.id },
            "A captured payment-link payment could not finish locally",
          );
          throw new PaymentLinkPaymentRecoveryError(
            isHostingCoverageParticipantRetry(error)
              ? "payment_received_finalisation_pending"
              : "payment_received_status_unconfirmed",
          );
        }

        return { type: "alreadyPaid" };
      }
    }

    if (
      repaySupersededIntentId === null &&
      existingIntent.status !== "canceled" &&
      existingIntent.amount !== booking.finalPriceCents
    ) {
      // The booking was modified after this intent was minted (#1161): a
      // stale client_secret would capture the old total. Queue the stale
      // intent's cancellation and fall through to mint a fresh one.
      if (booking.payment) {
        await queueSupersededPrimaryIntentCancellations(prisma, {
          bookingId: booking.id,
          paymentId: booking.payment.id,
          newFinalPriceCents: booking.finalPriceCents,
        });
      }
    } else if (
      repaySupersededIntentId === null &&
      existingIntent.client_secret &&
      existingIntent.status !== "canceled"
    ) {
      return {
        type: "clientSecret",
        clientSecret: existingIntent.client_secret,
        paymentIntentId: existingIntent.id,
      };
    }
  }

  // Capacity/status revalidation under the shared booking advisory lock,
  // mirroring the session path's preflight before charging.
  await prisma.$transaction(async (tx) => {
    // Pre-lock read: only the lock key. lodgeId is immutable, so keying the
    // lock from this read is safe; the status re-validation and capacity check
    // consume ONLY the post-lock re-read below.
    const lockTarget = await tx.booking.findUnique({
      where: { id: booking.id },
      select: { lodgeId: true },
    });
    const bookingLodgeId = lockTarget?.lodgeId ?? (await getDefaultLodgeId(tx));
    await acquireLodgeCapacityLock(tx, bookingLodgeId);

    const freshBooking = await tx.booking.findUnique({
      where: { id: booking.id },
      // Load per-night sets (issue #713) so a non-contiguous booking is
      // capacity-checked on the nights it actually occupies.
      include: { guests: { include: { nights: true } } },
    });

    if (!freshBooking || !isPayableByLink(freshBooking.status)) {
      throw new PaymentLinkError(NOT_PAYABLE_MESSAGE, 410);
    }

    // #2265 (#2319 door 1, minting arm). A booking still carrying a stored
    // credit election must not be charged the full price through a public link.
    //
    // Refuse rather than consume, and the reason is authorisation, not scope. The
    // election is the member's standing request to spend money out of their own
    // account-credit balance; this route is authenticated by a bearer token that
    // is routinely held by SOMEONE ELSE (a booking requester, a group joiner, a
    // non-member guest paying for their beds), carries no member session, and has
    // no surface on which to show the member that their election was clamped by a
    // balance or a price that moved. Debiting a member's balance on a
    // third-party's token, with the outcome reportable to nobody, is a worse
    // property than declining to take the payment here.
    //
    // Refuse rather than CLEAR, too: nothing is lost by refusing, because the
    // election is still perfectly honourable — the pay step and the
    // switch-to-Internet-Banking route both consume it, and every booking that
    // can carry one belongs to a member with a login. Clearing would throw away
    // the member's request to make a charge convenient, which is #2265's original
    // bug wearing a different hat. Clearing is only right once the money is
    // actually taken, which is the succeeded-intent arm above.
    //
    // Read from the post-lock re-read, so a concurrent pay step that consumed the
    // election a moment ago is seen to have done so and the payer is not refused
    // for nothing. This state is not reachable by any flow that exists today —
    // no PaymentLink mint path attaches a link to a booking that can carry an
    // election — so the guard is an assertion of that invariant rather than a
    // routine branch, and it alerts loudly instead of failing quietly if some
    // future mint path breaks it.
    // The alert and the refusal are raised OUTSIDE this transaction (the SES
    // send must not sit inside a database transaction), so signal with a private
    // error the catch below translates.
    if (freshBooking.creditElectionCents != null) {
      throw new UnconsumedCreditElectionError(freshBooking.creditElectionCents);
    }

    // Re-read the link under the same lock (#1967 FIX-6): the auto-charge cron
    // revokes a booking's links inside its claim transaction (also under this
    // lodge lock) before charging the saved card, so a /pay request that
    // resolved the link just before that claim must not go on to mint an
    // intent — the saved-card charge now owns settlement.
    const freshLink = await tx.paymentLink.findUnique({
      where: { id: link.id },
      select: { revokedAt: true },
    });
    if (!freshLink || freshLink.revokedAt) {
      throw new PaymentLinkError(REVOKED_LINK_MESSAGE, 410);
    }

    const capacity = await checkCapacityForGuestRanges(
      bookingLodgeId,
      freshBooking.checkIn,
      freshBooking.checkOut,
      freshBooking.guests,
      booking.id,
      tx
    );

    if (!capacity.available && bookingHasCapacityOverride(freshBooking)) {
      // Persisted capacity override (#1771): the booking was deliberately
      // admitted above the ceiling by an admin, so a payment link must not 409
      // it — fall through and let the payment proceed.
      logger.info(
        { bookingId: booking.id },
        "Paying an over-capacity booking with a persisted capacity override (#1771); skipping the payment-link capacity block"
      );
    }
    if (!capacity.available && !bookingHasCapacityOverride(freshBooking)) {
      throw new PaymentLinkError(
        "Not enough beds remain available for these dates. Please contact the club.",
        409
      );
    }
  }).catch(async (err: unknown) => {
    // #2265 (#2319 door 1). The unconsumed-election refusal is signalled from
    // inside the transaction so it rolls back with everything else, and is turned
    // into the payer-facing 409 out here — where the operator alert can be sent
    // without holding a database transaction open across an SES call. Every other
    // error, including the route's own PaymentLinkErrors, propagates untouched.
    if (!(err instanceof UnconsumedCreditElectionError)) throw err;

    logger.error(
      {
        bookingId: booking.id,
        paymentLinkId: link.id,
        creditElectionCents: err.electionCents,
      },
      "Refused a payment-link intent for a booking carrying an unconsumed credit election: a public link must not charge the pre-credit price, nor spend a member's credit balance on a bearer token (#2265)"
    );
    await sendAdminPaymentFailureAlert({
      memberName: `${booking.member.firstName} ${booking.member.lastName}`,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      amountCents: err.electionCents,
      errorMessage: `This booking still has a saved account-credit choice of ${formatCents(err.electionCents)} on it, so the payment link declined to take a card payment: charging through the link would bill the full price and ignore the credit, and a public link must not spend a member's credit balance on its own authority. Nothing was charged and the saved choice is untouched. Ask the member to pay from their own bookings page, where the credit is applied and the card is charged only the remainder.`,
      // No intent exists — nothing was minted — so give the officer the booking
      // reference to search on instead.
      paymentIntentId: booking.id,
    }).catch((alertErr) =>
      logger.error(
        { err: alertErr, bookingId: booking.id },
        "Failed to alert admins about a payment link refused for an unconsumed credit election"
      )
    );

    throw new PaymentLinkError(CREDIT_ELECTION_PENDING_MESSAGE, 409);
  });

  // Stripe calls stay outside the database transaction.
  const customer = await findOrCreateCustomer({
    email: booking.member.email,
    name: `${booking.member.firstName} ${booking.member.lastName}`,
    memberId: booking.member.id,
  });

  const paymentIntent = await createPaymentIntent({
    amountCents: booking.finalPriceCents,
    customerId: customer.id,
    metadata: {
      bookingId: booking.id,
      memberId: booking.memberId,
      paymentLinkId: link.id,
    },
    idempotencyKey: repaySupersededIntentId
      ? `pl_pi_${booking.id}_repay_${repaySupersededIntentId}`
      : `pl_pi_${booking.id}_${booking.payment?.stripePaymentIntentId ?? "initial"}`,
  });

  const payment = await prisma.payment.upsert({
    where: { bookingId: booking.id },
    create: {
      bookingId: booking.id,
      amountCents: booking.finalPriceCents,
      stripeCustomerId: customer.id,
      status: PaymentStatus.PENDING,
    },
    update: {
      stripeCustomerId: customer.id,
    },
  });

  await upsertPaymentIntentTransaction({
    paymentId: payment.id,
    kind: PaymentTransactionKind.PRIMARY,
    paymentIntentId: paymentIntent.id,
    amountCents: booking.finalPriceCents,
    status: PaymentStatus.PROCESSING,
    reason: repaySupersededIntentId
      ? "payment_link_repay_after_refund"
      : "payment_link_booking_payment",
    stripeCustomerId: customer.id,
  });

  if (!paymentIntent.client_secret) {
    throw new PaymentLinkError("Unable to start the payment. Please try again.", 500);
  }

  return {
    type: "clientSecret",
    clientSecret: paymentIntent.client_secret,
    paymentIntentId: paymentIntent.id,
  };
}
