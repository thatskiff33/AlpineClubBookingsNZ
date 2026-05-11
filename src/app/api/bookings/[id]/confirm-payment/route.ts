import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getPaymentIntent } from "@/lib/stripe";
import { markBookingPaymentSucceeded } from "@/lib/payment-reconciliation";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { z } from "zod";
import { canCreateImmediatePaymentIntent } from "@/lib/booking-payment-flow";

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
  const ipAddress =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

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
      payment.booking.memberId !== session.user.id &&
      session.user.role !== "ADMIN"
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
      return NextResponse.json({ success: true });
    }

    const pi = await getPaymentIntent(paymentIntentId);
    if (pi.status !== "succeeded") {
      return NextResponse.json(
        { error: `Payment has not succeeded (status: ${pi.status})` },
        { status: 400 }
      );
    }

    if (pi.amount !== payment.booking.finalPriceCents) {
      return NextResponse.json(
        { error: "Payment amount does not match booking total" },
        { status: 400 }
      );
    }

    const reconciliation = await markBookingPaymentSucceeded({
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

    logAudit({
      action: "booking.payment.confirmed",
      memberId: session.user.id,
      targetId: bookingId,
      subjectMemberId: payment.booking.memberId,
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
    const message =
      err instanceof Error ? err.message : "Failed to confirm payment";
    logger.error({ err, bookingId }, "Failed to confirm primary booking payment");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
