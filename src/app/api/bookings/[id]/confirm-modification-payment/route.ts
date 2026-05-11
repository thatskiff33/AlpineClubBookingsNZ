import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getPaymentIntent } from "@/lib/stripe";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { z } from "zod";
import {
  findPaymentTransactionByIntentId,
  markPaymentIntentTransactionSucceeded,
} from "@/lib/payment-transactions";

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
      include: { booking: { select: { memberId: true } } },
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

    if (payment.additionalPaymentIntentId !== paymentIntentId) {
      return NextResponse.json(
        { error: "PaymentIntent does not match booking" },
        { status: 400 }
      );
    }

    const paymentTransaction = await findPaymentTransactionByIntentId({
      paymentIntentId,
    });
    if (!paymentTransaction) {
      return NextResponse.json({ error: "Payment transaction not found" }, { status: 404 });
    }

    if (
      paymentTransaction.status === "SUCCEEDED" ||
      paymentTransaction.status === "PARTIALLY_REFUNDED" ||
      paymentTransaction.status === "REFUNDED"
    ) {
      return NextResponse.json({ success: true });
    }

    const pi = await getPaymentIntent(paymentIntentId);
    if (pi.status !== "succeeded") {
      return NextResponse.json(
        { error: `Payment has not succeeded (status: ${pi.status})` },
        { status: 400 }
      );
    }

    if (pi.amount !== paymentTransaction.amountCents) {
      return NextResponse.json(
        { error: "Payment amount does not match booking modification" },
        { status: 400 }
      );
    }

    await markPaymentIntentTransactionSucceeded({
      paymentIntentId: pi.id,
      amountCents: pi.amount,
      paymentMethodId:
        typeof pi.payment_method === "string"
          ? pi.payment_method
          : pi.payment_method?.id ?? null,
    });

    logAudit({
      action: "booking.modification.payment.confirmed",
      memberId: session.user.id,
      targetId: bookingId,
      subjectMemberId: payment.booking.memberId,
      entityType: "Booking",
      entityId: bookingId,
      category: "payment",
      outcome: "success",
      summary: "Booking modification payment confirmed",
      details: JSON.stringify({
        paymentIntentId,
        additionalAmountCents: paymentTransaction.amountCents,
      }),
      metadata: {
        paymentIntentId,
        paymentTransactionId: paymentTransaction.id,
        additionalAmountCents: paymentTransaction.amountCents,
      },
      ipAddress,
    });

    logger.info(
      { bookingId, paymentIntentId, additionalAmountCents: paymentTransaction.amountCents },
      "Modification additional payment confirmed"
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to confirm payment";
    logger.error({ err, bookingId }, "Failed to confirm modification payment");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
