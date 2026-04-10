import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getPaymentIntent } from "@/lib/stripe";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { z } from "zod";

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

    if (payment.additionalPaymentStatus === "SUCCEEDED") {
      // Already confirmed - idempotent
      return NextResponse.json({ success: true });
    }

    // Verify with Stripe that the PaymentIntent actually succeeded
    const pi = await getPaymentIntent(paymentIntentId);
    if (pi.status !== "succeeded") {
      return NextResponse.json(
        { error: `Payment has not succeeded (status: ${pi.status})` },
        { status: 400 }
      );
    }

    if (pi.amount !== payment.additionalAmountCents) {
      return NextResponse.json(
        { error: "Payment amount does not match booking modification" },
        { status: 400 }
      );
    }

    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        additionalPaymentStatus: "SUCCEEDED",
        amountCents: payment.amountCents + payment.additionalAmountCents,
      },
    });

    logAudit({
      action: "booking.modification.payment.confirmed",
      memberId: session.user.id,
      targetId: bookingId,
      details: JSON.stringify({
        paymentIntentId,
        additionalAmountCents: payment.additionalAmountCents,
      }),
      ipAddress,
    });

    logger.info(
      { bookingId, paymentIntentId, additionalAmountCents: payment.additionalAmountCents },
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
