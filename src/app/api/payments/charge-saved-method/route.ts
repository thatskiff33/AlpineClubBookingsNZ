import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";
import { chargePaymentMethod } from "@/lib/stripe";
import { isXeroConnected, createXeroInvoiceForBooking } from "@/lib/xero";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { z } from "zod";
import logger from "@/lib/logger";
import { sendAdminPaymentFailureAlert } from "@/lib/email";
import { notifyXeroSyncError } from "@/lib/xero-error-alert";

const ChargeSavedMethodSchema = z.object({
  bookingId: z.string().min(1),
});

/**
 * Charge a saved payment method for a pending booking.
 * Used by the cron job when a pending booking auto-confirms at the 7-day mark,
 * or by admin to manually confirm a pending booking.
 */
export async function POST(request: NextRequest) {
  // Track bookingId outside try so catch block can revert status on charge failure
  let claimedBookingId: string | null = null;
  let paymentSucceeded = false;

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

    // Atomically claim the booking to prevent double-charge with cron
    const claimed = await prisma.booking.updateMany({
      where: { id: bookingId, status: "PENDING" },
      data: { status: "CONFIRMED" },
    });
    if (claimed.count === 0) {
      return NextResponse.json(
        { error: "Booking is already being processed" },
        { status: 409 }
      );
    }
    claimedBookingId = bookingId;

    // Charge the saved payment method
    const paymentIntent = await chargePaymentMethod({
      amountCents: booking.finalPriceCents,
      customerId: booking.payment.stripeCustomerId,
      paymentMethodId: booking.payment.stripePaymentMethodId,
      metadata: {
        bookingId: booking.id,
        memberId: booking.memberId,
      },
      idempotencyKey: `charge_${booking.id}`,
    });

    // Update payment record and revert booking status if payment not yet succeeded
    if (paymentIntent.status === "succeeded") {
      paymentSucceeded = true;
      await prisma.$transaction([
        prisma.payment.update({
          where: { bookingId: booking.id },
          data: {
            stripePaymentIntentId: paymentIntent.id,
            status: "SUCCEEDED",
          },
        }),
        prisma.booking.update({
          where: { id: booking.id },
          data: { status: "PAID" },
        }),
      ]);
    } else {
      // Payment requires additional action (e.g. 3D Secure/SCA) — revert to PENDING
      await prisma.$transaction([
        prisma.payment.update({
          where: { bookingId: booking.id },
          data: {
            stripePaymentIntentId: paymentIntent.id,
            status: "PROCESSING",
          },
        }),
        prisma.booking.update({
          where: { id: booking.id },
          data: { status: "PENDING" },
        }),
      ]);
      claimedBookingId = null; // Already reverted
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

    // Create Xero invoice if connected and payment succeeded
    if (paymentIntent.status === "succeeded") {
      try {
        if (await isXeroConnected()) {
          await createXeroInvoiceForBooking(booking.id);
          logger.info({ bookingId: booking.id }, "Xero invoice created for booking");
        }
      } catch (xeroErr) {
        logger.error({ err: xeroErr, bookingId: booking.id }, "Failed to create Xero invoice for booking");
        await notifyXeroSyncError({
          errorType: "INVOICE_CREATION",
          operation: `Create invoice for booking ${booking.id} after saved-card charge`,
          errorMessage: xeroErr instanceof Error ? xeroErr.message : String(xeroErr),
        });
      }
    }

    claimedBookingId = null; // Success — no revert needed
    return NextResponse.json({
      success: true,
      paymentIntentId: paymentIntent.id,
      status: paymentIntent.status,
    });
  } catch (error) {
    logger.error({ err: error }, "Error charging saved method");

    // Only roll the booking back when Stripe never confirmed a successful charge.
    // If Stripe already succeeded, keep the claimed state so the webhook/manual
    // reconciliation path can finish local persistence safely.
    if (claimedBookingId && !paymentSucceeded) {
      try {
        await prisma.booking.updateMany({
          where: { id: claimedBookingId, status: "CONFIRMED" },
          data: { status: "PENDING" },
        });
        logger.info({ bookingId: claimedBookingId }, "Reverted booking to PENDING after charge failure");
      } catch (revertErr) {
        logger.error({ err: revertErr, bookingId: claimedBookingId }, "Failed to revert booking status after charge failure");
      }
    } else if (claimedBookingId) {
      logger.error(
        { bookingId: claimedBookingId },
        "Stripe charge succeeded but local booking reconciliation failed; leaving booking claimed for webhook recovery"
      );
    }

    return NextResponse.json(
      { error: "Failed to charge saved payment method" },
      { status: 500 }
    );
  }
}
