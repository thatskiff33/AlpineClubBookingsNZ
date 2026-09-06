import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createSetupIntent, findOrCreateCustomer, getSetupIntent } from "@/lib/stripe";
import { classifySucceededSetupIntentCard } from "@/lib/setup-intent-card";
import { markBookingSetupIntentSucceeded } from "@/lib/payment-reconciliation";
import { CreateSetupIntentSchema } from "@/types/payments";
import { auth } from "@/lib/auth";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { requiresSavedPaymentMethod } from "@/lib/booking-payment-flow";
import { hasAdminAccess } from "@/lib/access-roles";

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
    if (booking.memberId !== session.user.id && !hasAdminAccess(session.user)) {
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
        // #3266 — a succeeded intent is not, by itself, proof of a chargeable
        // card (`INV-PAY-052`). The one rule shared with the webhook decides:
        // a row already carrying this intent's own card skips Stripe; a row
        // with no card, or a different card, is answered by the PROVIDER —
        // the card may be seconds old with the webhook still in flight, or
        // retired after a terminal refusal (#3268) — and never re-adopted
        // once Stripe no longer holds it for this customer.
        const verdict = await classifySucceededSetupIntentCard({
          bookingId: booking.id,
          setupIntent: existingIntent,
          row: booking.payment,
        });

        if (verdict.outcome === "already_on_row" || verdict.outcome === "attached") {
          // The stamp is guarded on the row still naming this intent, and it
          // writes this intent's own card, so it can never be the write that
          // re-adopts a retired one.
          await markBookingSetupIntentSucceeded({
            bookingId: booking.id,
            setupIntentId: existingIntent.id,
            paymentMethodId: verdict.paymentMethodId,
          });
          if (verdict.outcome === "attached") {
            logger.info(
              {
                bookingId: booking.id,
                setupIntentId: existingIntent.id,
                paymentMethodId: verdict.paymentMethodId,
              },
              "Re-adopted a succeeded SetupIntent's card that the webhook had not yet stamped",
            );
          }

          return NextResponse.json({
            alreadySaved: true,
            setupIntentId: existingIntent.id,
          });
        }

        logger.info(
          {
            bookingId: booking.id,
            setupIntentId: existingIntent.id,
            outcome: verdict.outcome,
          },
          "Succeeded SetupIntent's card cannot be re-adopted; minting a replacement",
        );
        // Fall through and mint. The idempotency key below chains from this
        // intent's id, so the replacement is a distinct Stripe object.
      } else if (
        existingIntent.client_secret &&
        existingIntent.status !== "canceled"
      ) {
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

    // Create or update Payment record. #3266 — minting a replacement RETIRES
    // the previous card (`INV-PAY-052`): `stripePaymentMethodId` is cleared
    // here, and only `markBookingSetupIntentSucceeded` (the webhook, or the
    // re-adopt arm above) puts one back. Left in place, the old — possibly
    // dead — card stayed chargeable by the cron and both admin charge routes
    // for as long as the member took to finish re-saving (in production:
    // never, and 24 consecutive cron failures). Same convention as
    // `booking-modify-settlement.ts`; the one deliberate exception
    // (`booking-credit-election.ts`, a settled split parent's card kept for
    // the child's deferred charge) is a settled row this route never reaches.
    //
    // Stated limit, accepted: a duplicate of this request that stalls in
    // flight until AFTER the member has confirmed the replacement card and the
    // webhook has stamped it would clear that just-saved card here. It needs
    // tens of seconds of delay on one request and the member then re-opens
    // the form, which shows the card is gone; nothing is charged in between.
    await prisma.payment.upsert({
      where: { bookingId: booking.id },
      create: {
        bookingId: booking.id,
        amountCents: booking.finalPriceCents,
        stripeSetupIntentId: setupIntent.id,
        stripeCustomerId: customer.id,
        stripePaymentMethodId: null,
        status: "PENDING",
      },
      update: {
        stripeSetupIntentId: setupIntent.id,
        stripeCustomerId: customer.id,
        stripePaymentMethodId: null,
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
