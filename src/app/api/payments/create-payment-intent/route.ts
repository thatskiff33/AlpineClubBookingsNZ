import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createPaymentIntent, findOrCreateCustomer, getPaymentIntent } from "@/lib/stripe";
import { markBookingPaymentSucceeded } from "@/lib/payment-reconciliation";
import { CreatePaymentIntentSchema } from "@/types/payments";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import logger from "@/lib/logger";
import { BookingStatus } from "@prisma/client";

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

    // Verify the requesting user owns this booking or is admin
    if (booking.memberId !== session.user.id && session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Reuse or reconcile an existing PaymentIntent before creating a new one.
    if (booking.payment?.stripePaymentIntentId) {
      const existingIntent = await getPaymentIntent(booking.payment.stripePaymentIntentId);

      if (existingIntent.status === "succeeded") {
        if (booking.payment.status !== "SUCCEEDED" || booking.status !== "PAID") {
          await markBookingPaymentSucceeded({
            bookingId: booking.id,
            paymentIntentId: existingIntent.id,
            amountCents: existingIntent.amount,
            paymentMethodId:
              typeof existingIntent.payment_method === "string"
                ? existingIntent.payment_method
                : existingIntent.payment_method?.id ?? null,
          });
        }

        return NextResponse.json({
          alreadyPaid: true,
          paymentIntentId: existingIntent.id,
        });
      }

      if (existingIntent.client_secret && existingIntent.status !== "canceled") {
        return NextResponse.json({
          clientSecret: existingIntent.client_secret,
          paymentIntentId: existingIntent.id,
        });
      }
    }

    // Only allow PaymentIntent for bookings that should be immediately confirmed
    if (
      booking.status !== "PENDING" &&
      booking.status !== "CONFIRMED" &&
      booking.status !== "DRAFT"
    ) {
      return NextResponse.json(
        { error: "Booking is not in a payable state" },
        { status: 400 }
      );
    }

    // For DRAFT bookings: check capacity and transition to CONFIRMED before charging
    if (booking.status === "DRAFT") {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(1)`);

        // Re-fetch within transaction to ensure we have latest state
        const freshBooking = await tx.booking.findUnique({
          where: { id: bookingId },
          include: { guests: true },
        });

        if (!freshBooking || freshBooking.status !== BookingStatus.DRAFT) {
          throw new Error("Booking is no longer a draft");
        }

        // Check capacity
        const overlapping = await tx.booking.findMany({
          where: {
            id: { not: bookingId },
            checkIn: { lt: freshBooking.checkOut },
            checkOut: { gt: freshBooking.checkIn },
            status: { in: [BookingStatus.CONFIRMED, BookingStatus.PAID, BookingStatus.PENDING] },
          },
          include: { guests: true },
        });

        const { eachDayOfInterval, subDays } = await import("date-fns");
        const nights = eachDayOfInterval({
          start: new Date(freshBooking.checkIn),
          end: subDays(new Date(freshBooking.checkOut), 1),
        });

        const { LODGE_CAPACITY } = await import("@/lib/capacity");

        for (const night of nights) {
          const nightTime = night.getTime();
          let occupiedBeds = 0;
          for (const b of overlapping) {
            const bIn = new Date(b.checkIn).getTime();
            const bOut = new Date(b.checkOut).getTime();
            if (nightTime >= bIn && nightTime < bOut) {
              occupiedBeds += b.guests.length;
            }
          }
          if (occupiedBeds + freshBooking.guests.length > LODGE_CAPACITY) {
            throw new Error("Not enough beds available for your dates. Please choose different dates.");
          }
        }

        // Transition DRAFT -> CONFIRMED
        await tx.booking.update({
          where: { id: bookingId },
          data: { status: BookingStatus.CONFIRMED, draftExpiresAt: null },
        });
      });
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
      idempotencyKey: `pi_${booking.id}_${booking.payment?.stripePaymentIntentId ?? "initial"}`,
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
    logger.error({ err: error }, "Error creating payment intent");
    const message = error instanceof Error ? error.message : "Failed to create payment intent";
    return NextResponse.json(
      { error: message },
      { status: error instanceof Error && error.message.includes("Not enough beds") ? 409 : 500 }
    );
  }
}
