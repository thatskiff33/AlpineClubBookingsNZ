import { NextRequest, NextResponse } from "next/server";
import { bookingOwner } from "@/lib/booking-owner";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getPaymentIntent } from "@/lib/stripe";
import { markBookingPaymentSucceeded } from "@/lib/payment-reconciliation";
import { sendBookingConfirmedEmail } from "@/lib/email";
import { getProvisionalNonMemberChildSummary } from "@/lib/booking-split-summary";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { z } from "zod";
import { canCreateImmediatePaymentIntent } from "@/lib/booking-payment-flow";
import { queueXeroInvoiceForPaidBooking } from "@/lib/xero-booking-invoice-queue";
import { hasAdminAccess } from "@/lib/access-roles";
import { deriveBookingAppliedCreditCents } from "@/lib/member-credit";
import { findPaymentTransactionByIntentId } from "@/lib/payment-transactions";
import { PaymentStatus } from "@prisma/client";
import {
  EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_BODY,
  PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY,
  REFUNDED_CARD_TRANSACTION_REPAYMENT_REQUIRED_BODY,
} from "@/lib/payment-recovery-contract";
import { clubFormatValues } from "@/lib/club-format-server";

const schema = z.object({
  paymentIntentId: z.string().min(1),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id: bookingId } = await params;
  const body = await request.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { paymentIntentId } = parsed.data;
  // The club's format (#3565), resolved once, before any transaction or
  // lock below — never per amount and never inside a transaction.
  const format = await clubFormatValues();
  const ipAddress =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  let succeededPaymentIntentObserved = false;
  let successfulIntentClassificationPending = false;

  try {
    const payment = await prisma.payment.findUnique({
      where: { bookingId },
      include: {
        booking: {
          select: {
            memberId: true,
            finalPriceCents: true,
            status: true,
            hasNonMembers: true,
          },
        },
      },
    });

    if (!payment) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    }

    if (
      bookingOwner(payment.booking).memberId !== session.user.id &&
      !hasAdminAccess(session.user)
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (payment.stripePaymentIntentId !== paymentIntentId) {
      return NextResponse.json(
        { error: "PaymentIntent does not match booking" },
        { status: 400 }
      );
    }

    if (
      !canCreateImmediatePaymentIntent({
        status: payment.booking.status,
        hasNonMembers: payment.booking.hasNonMembers,
      })
    ) {
      return NextResponse.json(
        {
          error:
            "This booking cannot be confirmed through the immediate-charge flow while it is still pending non-member review",
        },
        { status: 400 }
      );
    }

    if (payment.status === "SUCCEEDED" && payment.booking.status === "PAID") {
      await queueXeroInvoiceForPaidBooking({
        bookingId,
        createdByMemberId: session.user.id,
      });
      return NextResponse.json({ success: true });
    }

    const pi = await getPaymentIntent(paymentIntentId);
    if (pi.status !== "succeeded") {
      return NextResponse.json(
        { error: `Payment has not succeeded (status: ${pi.status})` },
        { status: 400 }
      );
    }
    successfulIntentClassificationPending = true;
    const pointedTransaction = await findPaymentTransactionByIntentId({
      paymentIntentId: pi.id,
    });
    const refundedHistory = pointedTransaction
      ? pointedTransaction.status === PaymentStatus.REFUNDED ||
        pointedTransaction.status === PaymentStatus.PARTIALLY_REFUNDED
      : payment.status === PaymentStatus.REFUNDED ||
        payment.status === PaymentStatus.PARTIALLY_REFUNDED;

    if (refundedHistory) {
      return NextResponse.json(
        REFUNDED_CARD_TRANSACTION_REPAYMENT_REQUIRED_BODY,
        { status: 409 },
      );
    }
    successfulIntentClassificationPending = false;
    // Stripe is authoritative for capture. From this point onward, an
    // unexpected local failure must never send the member back through an
    // ordinary payment-error path where they could try to pay again.
    succeededPaymentIntentObserved = true;

    // #1641 — accept the credit-reduced effective price (new intents) as well as
    // the full price (legacy in-flight intents). markBookingPaymentSucceeded
    // re-derives and enforces the same split under the capacity lock. The ledger
    // read is skipped for a full-price capture.
    if (
      pi.amount !== payment.booking.finalPriceCents &&
      pi.amount !==
        payment.booking.finalPriceCents -
          (await deriveBookingAppliedCreditCents(bookingId, prisma))
    ) {
      // Stripe has already confirmed that money moved. An amount drift means
      // we cannot safely promote the booking from the snapshot above, but it
      // must never look like an ordinary validation failure that invites a
      // second payment. Keep the response provider-safe and use the same
      // status-unconfirmed contract as every unexpected post-capture failure.
      logger.error(
        {
          bookingId,
          capturedAmountCents: pi.amount,
          bookingAmountCents: payment.booking.finalPriceCents,
        },
        "Succeeded payment amount no longer matches booking total",
      );
      return NextResponse.json(PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY, {
        status: 409,
      });
    }

    const reconciliation = await markBookingPaymentSucceeded({
      format,
      bookingId,
      paymentIntentId: pi.id,
      amountCents: pi.amount,
      paymentMethodId:
        typeof pi.payment_method === "string"
          ? pi.payment_method
          : pi.payment_method?.id ?? null,
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

    // Send the confirmation email only on a fresh transition to PAID. If the
    // Stripe webhook reconciled this payment first, markBookingPaymentSucceeded
    // returns "already_paid" here and we skip the send, so the email goes out
    // exactly once whichever path wins the race (issue #772).
    if (reconciliation.outcome === "paid") {
      try {
        const booking = await prisma.booking.findUnique({
          where: { id: bookingId },
          include: {
            member: true,
            // #3369: the owner may be an Organisation; bookingOwner() reads both.
            organisation: { select: { name: true, email: true } },
            guests: true,
            promoRedemption: { include: { promoCode: true } },
          },
        });
        if (booking) {
          // Split-booking parent (#738): describe the provisional non-member
          // child so the confirmation explains the separate later charge.
          const provisionalGuests = await getProvisionalNonMemberChildSummary({
            id: booking.id,
            memberId: bookingOwner(booking).memberId,
          });
          await sendBookingConfirmedEmail(
            { bookingId: booking.id, recipientMemberId: bookingOwner(booking).memberId },
            bookingOwner(booking).member.email,
            bookingOwner(booking).member.firstName,
            booking.checkIn,
            booking.checkOut,
            booking.guests.length,
            booking.finalPriceCents,
            format,
            {
              lodgeId: booking.lodgeId,
              ...(provisionalGuests ? { provisionalGuests } : {}),
              ...(booking.promoRedemption?.promoCode
                ? {
                    discountCents: booking.discountCents,
                    promoAdjustmentCents: booking.promoAdjustmentCents,
                    promoCode: booking.promoRedemption.promoCode.code,
                  }
                : {}),
            }
          );
        }
      } catch (emailErr) {
        logger.error(
          { err: emailErr, bookingId },
          "Failed to send confirmation email"
        );
      }
    }

    await queueXeroInvoiceForPaidBooking({
      bookingId,
      createdByMemberId: session.user.id,
    });

    logAudit({
      action: "booking.payment.confirmed",
      memberId: session.user.id,
      targetId: bookingId,
      subjectMemberId: bookingOwner(payment.booking).memberId,
      entityType: "Booking",
      entityId: bookingId,
      category: "payment",
      outcome: "success",
      summary: "Booking payment confirmed",
      details: JSON.stringify({
        paymentIntentId,
        amountCents: pi.amount,
      }),
      metadata: {
        paymentIntentId,
        amountCents: pi.amount,
        reconciliationOutcome: reconciliation.outcome,
      },
      ipAddress,
    });

    logger.info(
      { bookingId, paymentIntentId, amountCents: pi.amount },
      "Primary booking payment confirmed"
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    if (successfulIntentClassificationPending) {
      logger.error(
        { err, bookingId },
        "Could not classify an existing successful card transaction",
      );
      return NextResponse.json(
        EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_BODY,
        { status: 409 },
      );
    }
    const hostingRetry = hostingCoverageParticipantRetryResponse(
      err,
      succeededPaymentIntentObserved
        ? {
            paymentReceived: true,
            finalisationPending: true,
          }
        : undefined,
    );
    if (hostingRetry) return hostingRetry;
    // #1888 — never echo an unexpected error's message to the client (it can
    // carry Prisma constraint names or infrastructure detail); the raw error
    // stays in the log only.
    logger.error({ err, bookingId }, "Failed to confirm primary booking payment");
    if (succeededPaymentIntentObserved) {
      return NextResponse.json(PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY, {
        status: 409,
      });
    }
    return NextResponse.json(
      { error: "Failed to confirm payment" },
      { status: 500 }
    );
  }
}
