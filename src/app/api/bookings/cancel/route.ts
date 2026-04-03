import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { processRefund } from "@/lib/stripe";
import { calculateRefundAmount, daysUntilDate, loadCancellationPolicy } from "@/lib/cancellation";
import { CancelBookingSchema } from "@/types/payments";
// import { auth } from "@/lib/auth";  // Will be available after Phase 1

export async function POST(request: NextRequest) {
  try {
    // TODO: Uncomment when auth is available
    // const session = await auth();
    // if (!session?.user?.id) {
    //   return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    // }

    const body = await request.json();
    const parsed = CancelBookingSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { bookingId } = parsed.data;

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { payment: true },
    });

    if (!booking) {
      return NextResponse.json(
        { error: "Booking not found" },
        { status: 404 }
      );
    }

    // TODO: Verify the requesting user owns this booking or is admin
    // if (booking.memberId !== session.user.id && session.user.role !== "ADMIN") {
    //   return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    // }

    // Handle PENDING bookings (no payment taken yet)
    if (booking.status === "PENDING") {
      await prisma.booking.update({
        where: { id: bookingId },
        data: { status: "CANCELLED" },
      });

      return NextResponse.json({
        success: true,
        refundAmountCents: 0,
        refundPercentage: 0,
        message: "Pending booking cancelled. No payment was taken.",
      });
    }

    // Handle CONFIRMED bookings (payment was taken, may need refund)
    if (booking.status !== "CONFIRMED") {
      return NextResponse.json(
        { error: "Only PENDING or CONFIRMED bookings can be cancelled" },
        { status: 400 }
      );
    }

    if (!booking.payment || booking.payment.status !== "SUCCEEDED") {
      // Confirmed but no successful payment - just cancel
      await prisma.booking.update({
        where: { id: bookingId },
        data: { status: "CANCELLED" },
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

      // Update payment record
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
          where: { id: bookingId },
          data: { status: "CANCELLED" },
        }),
      ]);

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
      where: { id: bookingId },
      data: { status: "CANCELLED" },
    });

    return NextResponse.json({
      success: true,
      refundAmountCents: 0,
      refundPercentage: 0,
      message: "Booking cancelled. No refund applicable per cancellation policy.",
    });
  } catch (error) {
    console.error("Error cancelling booking:", error);
    return NextResponse.json(
      { error: "Failed to cancel booking" },
      { status: 500 }
    );
  }
}
