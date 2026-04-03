import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createPaymentIntent, findOrCreateCustomer } from "@/lib/stripe";
import { CreatePaymentIntentSchema } from "@/types/payments";
// import { auth } from "@/lib/auth";  // Will be available after Phase 1

export async function POST(request: NextRequest) {
  try {
    // TODO: Uncomment when auth is available from Phase 1
    // const session = await auth();
    // if (!session?.user?.id) {
    //   return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    // }

    const body = await request.json();
    const parsed = CreatePaymentIntentSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { bookingId } = parsed.data;

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        member: true,
        payment: true,
      },
    });

    if (!booking) {
      return NextResponse.json(
        { error: "Booking not found" },
        { status: 404 }
      );
    }

    // Don't create a new PaymentIntent if one already exists
    if (booking.payment?.stripePaymentIntentId) {
      return NextResponse.json(
        { error: "Payment already initiated for this booking" },
        { status: 409 }
      );
    }

    // Only allow PaymentIntent for bookings that should be immediately confirmed
    if (booking.status !== "PENDING" && booking.status !== "CONFIRMED") {
      return NextResponse.json(
        { error: "Booking is not in a payable state" },
        { status: 400 }
      );
    }

    // Find or create Stripe customer
    const customer = await findOrCreateCustomer({
      email: booking.member.email,
      name: `${booking.member.firstName} ${booking.member.lastName}`,
      memberId: booking.member.id,
    });

    // Create the PaymentIntent
    const paymentIntent = await createPaymentIntent({
      amountCents: booking.finalPriceCents,
      customerId: customer.id,
      metadata: {
        bookingId: booking.id,
        memberId: booking.memberId,
      },
    });

    // Create or update Payment record
    await prisma.payment.upsert({
      where: { bookingId: booking.id },
      create: {
        bookingId: booking.id,
        amountCents: booking.finalPriceCents,
        stripePaymentIntentId: paymentIntent.id,
        stripeCustomerId: customer.id,
        status: "PROCESSING",
      },
      update: {
        stripePaymentIntentId: paymentIntent.id,
        stripeCustomerId: customer.id,
        status: "PROCESSING",
      },
    });

    return NextResponse.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    });
  } catch (error) {
    console.error("Error creating payment intent:", error);
    return NextResponse.json(
      { error: "Failed to create payment intent" },
      { status: 500 }
    );
  }
}
