import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createSetupIntent, findOrCreateCustomer, getSetupIntent } from "@/lib/stripe";
import { markBookingSetupIntentSucceeded } from "@/lib/payment-reconciliation";
import { CreateSetupIntentSchema } from "@/types/payments";
import { auth } from "@/lib/auth";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { requiresSavedPaymentMethod } from "@/lib/booking-payment-flow";

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    }

    const inactiveResponse = await requireActiveSessionUser(session.user.id);
    if (inactiveResponse) {
      return inactiveResponse;
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

    if (
      !requiresSavedPaymentMethod({
        status: booking.status,
        hasNonMembers: booking.hasNonMembers,
      })
    ) {
      return NextResponse.json(
        { error: "SetupIntent is only needed for bookings with non-member guests" },
        { status: 400 }
      );
    }

    if (booking.payment?.stripeSetupIntentId) {
      const existingIntent = await getSetupIntent(booking.payment.stripeSetupIntentId);

      if (existingIntent.status === "succeeded") {
        const paymentMethodId =
          typeof existingIntent.payment_method === "string"
            ? existingIntent.payment_method
            : existingIntent.payment_method?.id ?? null;

        if (paymentMethodId) {
          await markBookingSetupIntentSucceeded({
            bookingId: booking.id,
            setupIntentId: existingIntent.id,
            paymentMethodId,
          });
        }

        return NextResponse.json({
          alreadySaved: true,
          setupIntentId: existingIntent.id,
        });
      }

      if (existingIntent.client_secret && existingIntent.status !== "canceled") {
        return NextResponse.json({
          clientSecret: existingIntent.client_secret,
          setupIntentId: existingIntent.id,
        });
      }
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
      idempotencyKey: `seti_${booking.id}_${booking.payment?.stripeSetupIntentId ?? "initial"}`,
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
    logger.error({ err: error }, "Error creating setup intent");
    return NextResponse.json(
      { error: "Failed to create setup intent" },
      { status: 500 }
    );
  }
}
