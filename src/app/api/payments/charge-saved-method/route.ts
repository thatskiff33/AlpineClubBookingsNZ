import { NextRequest, NextResponse } from "next/server";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { isHostingCoverageParticipantRetry } from "@/lib/adult-member-hosting-queue-participants";
import { getDefaultLodgeId } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { chargePaymentMethod } from "@/lib/stripe";
import { stripeReferenceId } from "@/lib/stripe-references";
import {
  enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import { auth } from "@/lib/auth";
import { isValidCronSecret } from "@/lib/cron-auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { z } from "zod";
import logger from "@/lib/logger";
import { sendAdminPaymentFailureAlert } from "@/lib/email";
import { logAudit } from "@/lib/audit";
import { PaymentStatus, PaymentTransactionKind } from "@prisma/client";
import { markBookingPaymentSucceeded } from "@/lib/payment-reconciliation";
import { upsertPaymentIntentTransaction } from "@/lib/payment-transactions";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import { bookingHasCapacityOverride } from "@/lib/booking-status";
import { reusableSavedPaymentMethodOnRow } from "@/lib/saved-payment-method";
import { hasAdminAccess } from "@/lib/access-roles";
import { PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY } from "@/lib/payment-recovery-contract";

const ChargeSavedMethodSchema = z.object({
  bookingId: z.string().min(1),
});

/**
 * Charge a saved payment method for a pending booking.
 * Used by the cron job when a pending booking auto-confirms at the 7-day mark,
 * or by admin to manually confirm a pending booking.
 */
export async function POST(request: NextRequest) {
  let paymentSucceeded = false;
  let finalCapacityClaimed = false;
  let isAuthorizedCron = false;
  let isAdmin = false;
  let capturedPaymentIntentId: string | null = null;
  let capturedPaymentContext: {
    paymentIntentId: string;
    memberName: string;
    checkIn: Date;
    checkOut: Date;
    amountCents: number;
  } | null = null;

  try {
    // This endpoint is called by internal cron or admin
    isAuthorizedCron = isValidCronSecret(
      request.headers.get("x-cron-secret")
    );

    const session = await auth();

    if (session?.user?.id) {
      const inactiveResponse = await requireActiveSessionUser(session.user.id);
      if (inactiveResponse && !isAuthorizedCron) {
        return inactiveResponse;
      }

      if (!inactiveResponse) {
        isAdmin = hasAdminAccess(session.user);
      }
    }

    if (!isAuthorizedCron && !isAdmin) {
      return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    }

    const body = await request.json();
    const parsed = ChargeSavedMethodSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { bookingId } = parsed.data;

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { payment: true, member: true, guests: { include: { nights: true } } }, // per-night sets (issue #713)
    });

    if (!booking) {
      return NextResponse.json(
        { error: "Booking not found" },
        { status: 404 }
      );
    }

    if (booking.status !== "PENDING") {
      return NextResponse.json(
        { error: "Booking is not in PENDING status" },
        { status: 400 }
      );
    }

    // #3269 (`INV-PAY-053`): a card is chargeable off-session only with
    // SetupIntent provenance on this booking's OWN row, read through
    // `reusableSavedPaymentMethodOnRow` rather than the split-aware
    // `savedPaymentMethodForBooking`. This route records the capture against
    // the row it read (`booking.payment.id`, aliased `savedPayment` below) and
    // creates none, so it deliberately offers no split-parent fallback — the
    // settlement cron and the admin confirm-pending-guests route, which upsert
    // the child's row inside their claim, carry that fallback.
    const reusableCard = reusableSavedPaymentMethodOnRow(booking.payment);
    if (!booking.payment || !reusableCard) {
      return NextResponse.json(
        { error: "No saved payment method found for this booking" },
        { status: 400 }
      );
    }
    const savedPayment = booking.payment;

    const capacity = await checkCapacityForGuestRanges(
      booking.lodgeId ?? (await getDefaultLodgeId(prisma)),
      booking.checkIn,
      booking.checkOut,
      booking.guests,
      booking.id
    );

    if (!capacity.available && bookingHasCapacityOverride(booking)) {
      // Persisted capacity override (#1771): admitted above the ceiling by an
      // admin, so do not 409 the charge — proceed. The downstream
      // markBookingPaymentSucceeded re-check honours the same override centrally.
      logger.info(
        { bookingId: booking.id },
        "Charging an over-capacity booking with a persisted capacity override (#1771); skipping the capacity block"
      );
    }
    if (!capacity.available && !bookingHasCapacityOverride(booking)) {
      return NextResponse.json(
        {
          error:
            "Lodge capacity is no longer available for this booking.",
        },
        { status: 409 }
      );
    }

    // Charge the saved payment method
    const paymentIntent = await chargePaymentMethod({
      amountCents: booking.finalPriceCents,
      customerId: reusableCard.stripeCustomerId,
      paymentMethodId: reusableCard.stripePaymentMethodId,
      metadata: {
        bookingId: booking.id,
        memberId: booking.memberId,
      },
      idempotencyKey: `pending_charge_${booking.id}`,
    });

    // Update payment record and revert booking status if payment not yet succeeded
    if (paymentIntent.status === "succeeded") {
      paymentSucceeded = true;
      capturedPaymentIntentId = paymentIntent.id;
      capturedPaymentContext = {
        paymentIntentId: paymentIntent.id,
        memberName: `${booking.member.firstName} ${booking.member.lastName}`,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        amountCents: paymentIntent.amount,
      };
      try {
        await upsertPaymentIntentTransaction({
          paymentId: savedPayment.id,
          kind: PaymentTransactionKind.PRIMARY,
          paymentIntentId: paymentIntent.id,
          amountCents: paymentIntent.amount,
          status: PaymentStatus.SUCCEEDED,
          paymentMethodId:
            stripeReferenceId(paymentIntent.payment_method),
          stripeCustomerId: savedPayment.stripeCustomerId,
        });
      } catch (recordError) {
        logger.error(
          { err: recordError, bookingId: booking.id, paymentIntentId: paymentIntent.id },
          "Failed to pre-record captured saved-method charge",
        );
      }
      const reconciliation = await markBookingPaymentSucceeded({
        bookingId: booking.id,
        paymentIntentId: paymentIntent.id,
        amountCents: paymentIntent.amount,
        paymentMethodId:
          stripeReferenceId(paymentIntent.payment_method),
      });

      if (
        reconciliation.outcome === "cancelled_refunded" ||
        reconciliation.outcome === "cancelled_refund_failed"
      ) {
        return NextResponse.json(
          {
            error:
              "Payment succeeded, but lodge capacity is no longer available for this booking.",
            status: "CANCELLED",
            refunded: reconciliation.outcome === "cancelled_refunded",
          },
          { status: 409 }
        );
      }

      finalCapacityClaimed = true;

      logAudit({
        action: "booking.payment.confirmed",
        category: "payment",
        entityType: "Booking",
        entityId: booking.id,
        memberId: isAdmin ? session?.user?.id : undefined,
        targetId: booking.id,
        details: JSON.stringify({
          paymentIntentId: paymentIntent.id,
          amountCents: booking.finalPriceCents,
          source: isAuthorizedCron ? "cron" : "admin",
        }),
        ipAddress:
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          "unknown",
      });
    } else {
      // Payment requires additional action (e.g. 3D Secure/SCA) — revert to PENDING
      await prisma.$transaction(async (tx) => {
        await upsertPaymentIntentTransaction({
          paymentId: savedPayment.id,
          kind: PaymentTransactionKind.PRIMARY,
          paymentIntentId: paymentIntent.id,
          amountCents: paymentIntent.amount,
          status: PaymentStatus.PROCESSING,
          paymentMethodId:
            stripeReferenceId(paymentIntent.payment_method),
          reason: "pending_saved_method_charge",
          store: tx,
        });

        await tx.booking.update({
          where: { id: booking.id },
          data: { status: "PENDING" },
        });
      });
      // Alert admins so they can contact the member to complete payment manually
      logger.warn(
        { bookingId: booking.id, piStatus: paymentIntent.status, memberId: booking.memberId },
        "Off-session charge requires additional authentication (SCA/3DS) — booking reverted to PENDING"
      );
      sendAdminPaymentFailureAlert({
        memberName: `${booking.member.firstName} ${booking.member.lastName}`,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        amountCents: booking.finalPriceCents,
        errorMessage: "Card requires 3D Secure authentication — member must complete payment manually",
        paymentIntentId: paymentIntent.id,
      }).catch(() => {});
    }

    // Queue the invoice durably and try to kick the worker when payment succeeds.
    if (paymentIntent.status === "succeeded" && finalCapacityClaimed) {
      try {
        const queuedInvoice = await enqueueXeroBookingInvoiceOperation(booking.id, {
          createdByMemberId: session?.user?.id,
        });

        if (queuedInvoice.queueOperationId) {
          await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
          logger.info({ bookingId: booking.id }, "Xero invoice queued for booking");
        }
      } catch (xeroErr) {
        logger.error({ err: xeroErr, bookingId: booking.id }, "Failed to queue Xero invoice for booking");
      }
    }

    return NextResponse.json({
      success: true,
      paymentIntentId: paymentIntent.id,
      status: paymentIntent.status,
    });
  } catch (error) {
    logger.error({ err: error }, "Error charging saved method");

    const hostingParticipantRetry = isHostingCoverageParticipantRetry(error);
    if (hostingParticipantRetry && capturedPaymentContext) {
      sendAdminPaymentFailureAlert({
        ...capturedPaymentContext,
        errorMessage:
          "The saved-method charge succeeded but booking finalisation was deferred by a concurrent member change. The Stripe webhook will retry; review manually if it remains pending.",
      }).catch((alertError) =>
        logger.error(
          { err: alertError, paymentIntentId: capturedPaymentIntentId },
          "Failed to alert admins about captured saved-method charge awaiting finalisation",
        ),
      );
    }

    if (!hostingParticipantRetry && capturedPaymentContext) {
      sendAdminPaymentFailureAlert({
        ...capturedPaymentContext,
        errorMessage:
          "The saved-method charge succeeded, but the booking status could not be confirmed after a local error. Check the booking and payment status before retrying any charge.",
      }).catch((alertError) =>
        logger.error(
          { err: alertError, paymentIntentId: capturedPaymentIntentId },
          "Failed to alert admins about a captured saved-method charge with unconfirmed booking status",
        ),
      );
    }

    if (isAuthorizedCron && hostingParticipantRetry) {
      throw error;
    }

    if (isAdmin && paymentSucceeded && hostingParticipantRetry) {
      const hostingRetry = hostingCoverageParticipantRetryResponse(error, {
        paymentReceived: true,
        finalisationPending: true,
      });
      if (hostingRetry) return hostingRetry;
    }

    if (paymentSucceeded && capturedPaymentIntentId) {
      return NextResponse.json(PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY, {
        status: 409,
      });
    }

    if (!paymentSucceeded) {
      logAudit({
        action: "booking.payment.failed",
        category: "payment",
        details: JSON.stringify({
          errorMessage:
            error instanceof Error
              ? error.message
              : "Failed to charge saved payment method",
        }),
        ipAddress:
            request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
            "unknown",
      });
    }

    return NextResponse.json(
      { error: "Failed to charge saved payment method" },
      { status: 500 }
    );
  }
}
