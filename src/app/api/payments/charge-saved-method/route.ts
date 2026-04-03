import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { chargePaymentMethod } from "@/lib/stripe";
import { isXeroConnected, createXeroInvoiceForBooking } from "@/lib/xero";
import { auth } from "@/lib/auth";
import { z } from "zod";

const ChargeSavedMethodSchema = z.object({
  bookingId: z.string().min(1),
});

/**
 * Charge a saved payment method for a pending booking.
 * Used by the cron job when a pending booking auto-confirms at the 7-day mark,
 * or by admin to manually confirm a pending booking.
 */
export async function POST(request: NextRequest) {
  try {
    // This endpoint is called by internal cron or admin
    const cronSecret = request.headers.get("x-cron-secret");
    const isAuthorizedCron = cronSecret === process.env.CRON_SECRET;

    const session = await auth();
    const isAdmin = session?.user?.role === "ADMIN";

    if (!isAuthorizedCron && !isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

    // Charge the saved payment method
    const paymentIntent = await chargePaymentMethod({
      amountCents: booking.finalPriceCents,
      customerId: booking.payment.stripeCustomerId,
      paymentMethodId: booking.payment.stripePaymentMethodId,
      metadata: {
        bookingId: booking.id,
        memberId: booking.memberId,
      },
    });

    // Update payment and booking records
    await prisma.$transaction([
      prisma.payment.update({
        where: { bookingId: booking.id },
        data: {
          stripePaymentIntentId: paymentIntent.id,
          status: paymentIntent.status === "succeeded" ? "SUCCEEDED" : "PROCESSING",
        },
      }),
      prisma.booking.update({
        where: { id: booking.id },
        data: {
          status: paymentIntent.status === "succeeded" ? "CONFIRMED" : "PENDING",
        },
      }),
    ]);

    // Create Xero invoice if connected and payment succeeded
    if (paymentIntent.status === "succeeded") {
      try {
        if (await isXeroConnected()) {
          await createXeroInvoiceForBooking(booking.id);
          console.log(`Xero invoice created for booking ${booking.id}`);
        }
      } catch (xeroErr) {
        console.error(`Failed to create Xero invoice for booking ${booking.id}:`, xeroErr);
      }
    }

    return NextResponse.json({
      success: true,
      paymentIntentId: paymentIntent.id,
      status: paymentIntent.status,
    });
  } catch (error) {
    console.error("Error charging saved method:", error);
    return NextResponse.json(
      { error: "Failed to charge saved payment method" },
      { status: 500 }
    );
  }
}
