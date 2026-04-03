import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { BookingStatus } from "@prisma/client";
import { processRefund } from "@/lib/stripe";
import { isXeroConnected, createXeroCreditNote } from "@/lib/xero";
import {
  calculateRefundAmount,
  daysUntilDate,
  loadCancellationPolicy,
} from "@/lib/cancellation";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const booking = await prisma.booking.findUnique({
    where: { id },
    include: { payment: true },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  if (booking.memberId !== session.user.id && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (
    booking.status !== BookingStatus.CONFIRMED &&
    booking.status !== BookingStatus.PENDING
  ) {
    return NextResponse.json(
      { error: "Booking cannot be cancelled in its current state" },
      { status: 400 }
    );
  }

  // Handle PENDING bookings (no payment taken yet)
  if (booking.status === BookingStatus.PENDING) {
    await prisma.booking.update({
      where: { id },
      data: { status: BookingStatus.CANCELLED },
    });

    return NextResponse.json({
      success: true,
      refundAmountCents: 0,
      refundPercentage: 0,
      message: "Pending booking cancelled. No payment was taken.",
    });
  }

  // Handle CONFIRMED bookings with payment
  if (!booking.payment || booking.payment.status !== "SUCCEEDED") {
    await prisma.booking.update({
      where: { id },
      data: { status: BookingStatus.CANCELLED },
    });

    return NextResponse.json({
      success: true,
      refundAmountCents: 0,
      refundPercentage: 0,
      message: "Booking cancelled. No refund applicable.",
    });
  }

  // Calculate refund based on cancellation policy
  const paidAmountCents =
    booking.payment.amountCents - booking.payment.refundedAmountCents;
  const days = daysUntilDate(booking.checkIn);
  const policy = await loadCancellationPolicy();
  const { refundAmountCents, refundPercentage } = calculateRefundAmount(
    paidAmountCents,
    days,
    policy
  );

  // Process Stripe refund if applicable
  if (refundAmountCents > 0 && booking.payment.stripePaymentIntentId) {
    const refund = await processRefund({
      paymentIntentId: booking.payment.stripePaymentIntentId,
      amountCents: refundAmountCents,
      metadata: {
        bookingId: booking.id,
        reason: "cancellation",
        refundPercentage: refundPercentage.toString(),
      },
    });

    const newRefundedTotal =
      booking.payment.refundedAmountCents + refundAmountCents;
    const newStatus =
      newRefundedTotal >= booking.payment.amountCents
        ? "REFUNDED"
        : "PARTIALLY_REFUNDED";

    await prisma.$transaction([
      prisma.payment.update({
        where: { bookingId: booking.id },
        data: {
          refundedAmountCents: newRefundedTotal,
          status: newStatus,
        },
      }),
      prisma.booking.update({
        where: { id },
        data: { status: BookingStatus.CANCELLED },
      }),
    ]);

    // Create Xero credit note if connected
    try {
      if (await isXeroConnected()) {
        await createXeroCreditNote(booking.payment.id, refundAmountCents);
      }
    } catch (xeroErr) {
      console.error(
        `Failed to create Xero credit note for payment ${booking.payment.id}:`,
        xeroErr
      );
    }

    return NextResponse.json({
      success: true,
      refundAmountCents,
      refundPercentage,
      stripeRefundId: refund.id,
      message: `Booking cancelled. ${refundPercentage}% refund of $${(refundAmountCents / 100).toFixed(2)} processed.`,
    });
  }

  // No refund (0% policy or no payment intent)
  await prisma.booking.update({
    where: { id },
    data: { status: BookingStatus.CANCELLED },
  });

  return NextResponse.json({
    success: true,
    refundAmountCents: 0,
    refundPercentage: 0,
    message: "Booking cancelled. No refund applicable per cancellation policy.",
  });
}
