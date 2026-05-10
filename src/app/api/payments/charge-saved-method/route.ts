import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";
import { chargePaymentMethod } from "@/lib/stripe";
import {
  enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { z } from "zod";
import logger from "@/lib/logger";
import { sendAdminPaymentFailureAlert } from "@/lib/email";
import { logAudit } from "@/lib/audit";
import { PaymentStatus, PaymentTransactionKind } from "@prisma/client";
import { markBookingPaymentSucceeded } from "@/lib/payment-reconciliation";
import { upsertPaymentIntentTransaction } from "@/lib/payment-transactions";

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

  try {
    // This endpoint is called by internal cron or admin
    const cronSecret = request.headers.get("x-cron-secret");
    const expected = process.env.CRON_SECRET;
    const isAuthorizedCron = !!(cronSecret && expected &&
      cronSecret.length === expected.length &&
      timingSafeEqual(Buffer.from(cronSecret), Buffer.from(expected)));

    const session = await auth();
    let isAdmin = false;

    if (session?.user?.id) {
      const inactiveResponse = await requireActiveSessionUser(session.user.id);
      if (inactiveResponse && !isAuthorizedCron) {
        return inactiveResponse;
      }

      if (!inactiveResponse) {
        isAdmin = session.user.role === "ADMIN";
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
      include: { payment: true, member: true },
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

    if (!booking.payment?.stripePaymentMethodId || !booking.payment?.stripeCustomerId) {
      return NextResponse.json(
        { error: "No saved payment method found for this booking" },
        { status: 400 }
      );
    }
    const savedPayment = booking.payment;

    // Charge the saved payment method
    const paymentIntent = await chargePaymentMethod({
      amountCents: booking.finalPriceCents,
      customerId: booking.payment.stripeCustomerId,
      paymentMethodId: booking.payment.stripePaymentMethodId,
      metadata: {
        bookingId: booking.id,
        memberId: booking.memberId,
      },
      idempotencyKey: `pending_charge_${booking.id}`,
    });

    // Update payment record and revert booking status if payment not yet succeeded
    if (paymentIntent.status === "succeeded") {
      paymentSucceeded = true;
      const reconciliation = await markBookingPaymentSucceeded({
        bookingId: booking.id,
        paymentIntentId: paymentIntent.id,
        amountCents: paymentIntent.amount,
        paymentMethodId:
          typeof paymentIntent.payment_method === "string"
            ? paymentIntent.payment_method
            : paymentIntent.payment_method?.id ?? null,
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
            typeof paymentIntent.payment_method === "string"
              ? paymentIntent.payment_method
              : paymentIntent.payment_method?.id ?? null,
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

    if (!paymentSucceeded) {
      logAudit({
        action: "booking.payment.failed",
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
