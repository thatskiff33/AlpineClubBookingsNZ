import { NextRequest, NextResponse } from "next/server";
import { BookingStatus, PaymentStatus } from "@prisma/client";

import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { chargePaymentMethod } from "@/lib/stripe";
import { markBookingPaymentSucceeded } from "@/lib/payment-reconciliation";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import {
  enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import { sendBookingConfirmedEmail } from "@/lib/email";
import { createStructuredAuditLog, getAuditRequestContext } from "@/lib/audit";
import logger from "@/lib/logger";

/**
 * Admin override: "Confirm pending guests now".
 *
 * Reuses the pending-booking cron confirm logic for a single booking that
 * still has non-member guests on hold: charge the saved payment method (->
 * PAID), or, when there is no saved method (e.g. a #707 request-origin
 * booking), move it to a payment-owed status instead of charging. Either way
 * the hold is cleared so the non-member guests are locked in and the cron will
 * no longer bump them. Everything is pre-charge for the bump decision, so no
 * refund path is involved.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id: bookingId } = await params;

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      member: true,
      guests: true,
      payment: true,
      promoRedemption: { include: { promoCode: true } },
    },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  if (
    booking.status !== BookingStatus.PENDING ||
    !booking.hasNonMembers ||
    !booking.nonMemberHoldUntil
  ) {
    return NextResponse.json(
      { error: "This booking has no pending non-member guests to confirm" },
      { status: 409 }
    );
  }

  const previousRange = {
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
  };
  const promoEmailOptions = booking.promoRedemption?.promoCode
    ? {
        discountCents: booking.discountCents,
        promoAdjustmentCents: booking.promoAdjustmentCents,
        promoCode: booking.promoRedemption.promoCode.code,
      }
    : undefined;
  const hasSavedPaymentMethod = Boolean(
    booking.payment?.stripePaymentMethodId && booking.payment?.stripeCustomerId
  );

  const auditRequest = getAuditRequestContext(request);

  const audit = (outcome: string, charged: boolean) =>
    createStructuredAuditLog({
      action: "booking.confirm_pending_guests",
      actor: { memberId: session.user.id },
      subject: { memberId: booking.memberId },
      entity: { type: "booking", id: bookingId },
      category: "booking",
      severity: "important",
      summary: `Admin confirmed pending non-member guests (${outcome})`,
      metadata: {
        outcome,
        charged,
        guestCount: booking.guests.length,
        finalPriceCents: booking.finalPriceCents,
      },
      request: auditRequest,
    }).catch((err) =>
      logger.error({ err, bookingId }, "Failed to audit confirm-pending-guests")
    );

  const queueXeroInvoice = async () => {
    try {
      const queued = await enqueueXeroBookingInvoiceOperation(bookingId);
      if (queued.queueOperationId) {
        await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
      }
    } catch (xeroErr) {
      logger.error(
        { err: xeroErr, bookingId },
        "Failed to queue Xero invoice after admin confirm-pending-guests"
      );
    }
  };

  try {
    // Zero-dollar booking: confirm without Stripe.
    if (booking.finalPriceCents === 0) {
      const claimed = await prisma.booking.updateMany({
        where: { id: bookingId, status: BookingStatus.PENDING },
        data: { status: BookingStatus.PAID, nonMemberHoldUntil: null },
      });
      if (claimed.count === 0) {
        return NextResponse.json(
          { error: "Booking is no longer pending" },
          { status: 409 }
        );
      }
      await reconcileBedAllocationsForBooking({ bookingId, previousRange });
      await prisma.payment.upsert({
        where: { bookingId },
        create: { bookingId, amountCents: 0, status: PaymentStatus.SUCCEEDED },
        update: { amountCents: 0, status: PaymentStatus.SUCCEEDED },
      });
      await queueXeroInvoice();
      await audit("paid_zero", false);
      sendBookingConfirmedEmail(
        booking.member.email,
        booking.member.firstName,
        booking.checkIn,
        booking.checkOut,
        booking.guests.length,
        booking.finalPriceCents,
        promoEmailOptions
      ).catch((err) =>
        logger.error({ err, bookingId }, "Failed to send confirmation email")
      );
      return NextResponse.json({ success: true, status: "PAID", charged: false });
    }

    // No saved payment method (request-origin): never charge — move to a
    // payment-owed status and let payment be arranged separately.
    if (!hasSavedPaymentMethod) {
      const claimed = await prisma.booking.updateMany({
        where: { id: bookingId, status: BookingStatus.PENDING },
        data: {
          status: BookingStatus.PAYMENT_PENDING,
          nonMemberHoldUntil: null,
        },
      });
      if (claimed.count === 0) {
        return NextResponse.json(
          { error: "Booking is no longer pending" },
          { status: 409 }
        );
      }
      await reconcileBedAllocationsForBooking({ bookingId, previousRange });
      await audit("payment_owed", false);
      return NextResponse.json({
        success: true,
        status: "PAYMENT_PENDING",
        charged: false,
      });
    }

    // Charge the saved payment method (same path the cron uses).
    const paymentIntent = await chargePaymentMethod({
      amountCents: booking.finalPriceCents,
      customerId: booking.payment!.stripeCustomerId!,
      paymentMethodId: booking.payment!.stripePaymentMethodId!,
      metadata: {
        bookingId,
        memberId: booking.memberId,
        source: "admin_confirm_pending_guests",
      },
      idempotencyKey: `pending_charge_${bookingId}`,
    });

    if (paymentIntent.status !== "succeeded") {
      // Requires further action (e.g. 3DS); leave the booking pending for the
      // Stripe webhook to resolve rather than confirming optimistically.
      return NextResponse.json(
        {
          error:
            "The saved card needs further authorisation; the charge could not be completed automatically.",
          paymentStatus: paymentIntent.status,
        },
        { status: 409 }
      );
    }

    const reconciliation = await markBookingPaymentSucceeded({
      bookingId,
      paymentIntentId: paymentIntent.id,
      amountCents: paymentIntent.amount,
      paymentMethodId:
        typeof paymentIntent.payment_method === "string"
          ? paymentIntent.payment_method
          : paymentIntent.payment_method?.id ?? null,
    });

    if (reconciliation.outcome !== "paid" && reconciliation.outcome !== "already_paid") {
      logger.error(
        { bookingId, outcome: reconciliation.outcome },
        "Admin confirm-pending-guests: payment succeeded but reconciliation did not settle"
      );
      return NextResponse.json(
        { error: "Payment succeeded but the booking could not be finalised" },
        { status: 500 }
      );
    }

    await prisma.booking.update({
      where: { id: bookingId },
      data: { nonMemberHoldUntil: null },
    });
    await queueXeroInvoice();
    await audit("paid_charged", true);
    sendBookingConfirmedEmail(
      booking.member.email,
      booking.member.firstName,
      booking.checkIn,
      booking.checkOut,
      booking.guests.length,
      booking.finalPriceCents,
      promoEmailOptions
    ).catch((err) =>
      logger.error({ err, bookingId }, "Failed to send confirmation email")
    );
    return NextResponse.json({ success: true, status: "PAID", charged: true });
  } catch (err) {
    logger.error({ err, bookingId }, "Failed to confirm pending guests");
    return NextResponse.json(
      { error: "Failed to confirm pending guests" },
      { status: 500 }
    );
  }
}
