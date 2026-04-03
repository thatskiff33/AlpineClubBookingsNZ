import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createSetupIntent, findOrCreateCustomer } from "@/lib/stripe";
import { CreateSetupIntentSchema } from "@/types/payments";
import { auth } from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const parsed = CreateSetupIntentSchema.safeParse(body);

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

    // Verify the requesting user owns this booking or is admin
    if (booking.memberId !== session.user.id && session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // SetupIntent is for pending bookings with non-member guests
    if (booking.status !== "PENDING") {
      return NextResponse.json(
        { error: "SetupIntent is only for pending bookings" },
        { status: 400 }
      );
    }

    if (!booking.hasNonMembers) {
      return NextResponse.json(
        { error: "SetupIntent is only needed for bookings with non-member guests" },
        { status: 400 }
      );
    }

    // Don't create a new SetupIntent if one already exists
    if (booking.payment?.stripeSetupIntentId) {
      return NextResponse.json(
        { error: "SetupIntent already created for this booking" },
        { status: 409 }
      );
    }

    // Find or create Stripe customer
    const customer = await findOrCreateCustomer({
      email: booking.member.email,
      name: `${booking.member.firstName} ${booking.member.lastName}`,
      memberId: booking.member.id,
    });

    // Create the SetupIntent
    const setupIntent = await createSetupIntent({
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
        stripeSetupIntentId: setupIntent.id,
        stripeCustomerId: customer.id,
        status: "PENDING",
      },
      update: {
        stripeSetupIntentId: setupIntent.id,
        stripeCustomerId: customer.id,
      },
    });

    return NextResponse.json({
      clientSecret: setupIntent.client_secret,
      setupIntentId: setupIntent.id,
    });
  } catch (error) {
    console.error("Error creating setup intent:", error);
    return NextResponse.json(
      { error: "Failed to create setup intent" },
      { status: 500 }
    );
  }
}
