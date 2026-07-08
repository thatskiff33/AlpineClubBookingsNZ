import { NextRequest, NextResponse } from "next/server";
import { getDefaultLodgeId } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { createPaymentIntent, findOrCreateCustomer, getPaymentIntent } from "@/lib/stripe";
import { markBookingPaymentSucceeded } from "@/lib/payment-reconciliation";
import { CreatePaymentIntentSchema } from "@/types/payments";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import logger from "@/lib/logger";
import { BookingStatus, PaymentSource } from "@prisma/client";
import { PaymentStatus, PaymentTransactionKind } from "@prisma/client";
import { canCreateImmediatePaymentIntent } from "@/lib/booking-payment-flow";
import { upsertPaymentIntentTransaction } from "@/lib/payment-transactions";
import {
  acquireLodgeCapacityLock,
  checkCapacityForGuestRanges,
} from "@/lib/capacity";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { parseJsonRequestBody } from "@/lib/api-json";
import { queueSupersededPrimaryIntentCancellations } from "@/lib/booking-payment-cleanup";
import { queueXeroInvoiceForPaidBooking } from "@/lib/xero-booking-invoice-queue";
import { hasAdminAccess } from "@/lib/access-roles";
import { deriveBookingAppliedCreditCents } from "@/lib/member-credit";

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

    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const parsed = CreatePaymentIntentSchema.safeParse(json.body);

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
        guests: true,
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

    // ORGANISER_PAYS group join: the organiser settles this booking as part of
    // one combined bill, so neither the joiner nor an admin pays it here.
    if (booking.organiserSettled) {
      return NextResponse.json(
        {
          error:
            "This booking is paid by the group organiser and cannot be paid individually",
        },
        { status: 400 }
      );
    }

    if (
      booking.status !== "PENDING" &&
      booking.status !== "PAYMENT_PENDING" &&
      booking.status !== "CONFIRMED" &&
      booking.status !== "DRAFT"
    ) {
      return NextResponse.json(
        { error: "Booking is not in a payable state" },
        { status: 400 }
      );
    }

    if (
      !canCreateImmediatePaymentIntent({
        status: booking.status,
        hasNonMembers: booking.hasNonMembers,
        organiserSettled: booking.organiserSettled,
      })
    ) {
      return NextResponse.json(
        {
          error:
            "This booking must stay in the saved-card flow until the non-member hold window expires",
        },
        { status: 400 }
      );
    }

    if (booking.payment?.source === PaymentSource.INTERNET_BANKING) {
      return NextResponse.json(
        {
          error:
            "This booking is already awaiting Internet Banking payment and cannot use the Stripe payment flow",
        },
        { status: 400 }
      );
    }

    // #1641 — the member may have applied account credit at booking-create (the
    // credit was consumed into the BOOKING_APPLIED ledger there). The card charge
    // must be the credit-reduced EFFECTIVE amount, not the full finalPriceCents, or
    // the member double-pays by the applied slice. Derive the applied total from the
    // ledger (the authoritative source; the booking row keeps the full price) and
    // mint / reconcile every intent against the effective amount.
    const appliedCreditCents = await deriveBookingAppliedCreditCents(booking.id);
    const effectivePriceCents = booking.finalPriceCents - appliedCreditCents;

    // A fully credit-covered booking is confirmed at $0 by the booking-create
    // zero-dollar path before any intent is ever requested; it never legitimately
    // reaches this route. Guard defensively rather than mint a $0 Stripe intent
    // (Stripe rejects those) — do NOT invent a new zero-payment shape here.
    if (effectivePriceCents <= 0) {
      return NextResponse.json(
        { error: "Fully credit-covered bookings do not take card payment." },
        { status: 400 }
      );
    }

    // Reuse or reconcile an existing PaymentIntent before creating a new one.
    if (booking.payment?.stripePaymentIntentId) {
      const existingIntent = await getPaymentIntent(booking.payment.stripePaymentIntentId);

      if (existingIntent.status === "succeeded") {
        if (booking.payment.status !== "SUCCEEDED") {
          const reconciliation = await markBookingPaymentSucceeded({
            bookingId: booking.id,
            paymentIntentId: existingIntent.id,
            amountCents: existingIntent.amount,
            paymentMethodId:
              typeof existingIntent.payment_method === "string"
                ? existingIntent.payment_method
                : existingIntent.payment_method?.id ?? null,
          });

          if (
            reconciliation.outcome === "cancelled_refunded" ||
            reconciliation.outcome === "cancelled_refund_failed"
          ) {
            return NextResponse.json(
              {
                error:
                  "Payment succeeded, but lodge capacity is no longer available for this booking.",
                status: BookingStatus.CANCELLED,
                refunded: reconciliation.outcome === "cancelled_refunded",
              },
              { status: 409 }
            );
          }
        }

        await queueXeroInvoiceForPaidBooking({
          bookingId: booking.id,
          createdByMemberId: session.user.id,
        });

        return NextResponse.json({
          alreadyPaid: true,
          paymentIntentId: existingIntent.id,
        });
      }

      if (
        existingIntent.status !== "canceled" &&
        existingIntent.amount !== effectivePriceCents
      ) {
        // The booking was modified after this intent was minted (#1161), or the
        // intent predates the #1641 effective-price fix (a legacy full-price
        // intent): handing back its client_secret would let Stripe capture the
        // wrong total and strand the booking in webhook reconciliation. Queue the
        // stale intent's cancellation and fall through to mint a fresh one at the
        // current effective price (this also corrects a not-yet-paid legacy
        // booking forward to the effective amount).
        if (booking.payment) {
          await queueSupersededPrimaryIntentCancellations(prisma, {
            bookingId: booking.id,
            paymentId: booking.payment.id,
            newFinalPriceCents: effectivePriceCents,
          });
        }
      } else if (
        existingIntent.client_secret &&
        existingIntent.status !== "canceled"
      ) {
        return NextResponse.json({
          clientSecret: existingIntent.client_secret,
          paymentIntentId: existingIntent.id,
        });
      }
    }

    // For DRAFT bookings: preflight capacity and transition to PAYMENT_PENDING before charging.
    // Payment success performs the final capacity claim.
    if (booking.status === "DRAFT") {
      await prisma.$transaction(async (tx) => {
        // The booking's lodge cannot change, so reading it for lock-key
        // selection before acquiring the lock is safe.
        const bookingLodgeId =
          booking.lodgeId ?? (await getDefaultLodgeId(tx));
        await acquireLodgeCapacityLock(tx, bookingLodgeId);

        // Re-fetch within transaction to ensure we have latest state
        const freshBooking = await tx.booking.findUnique({
          where: { id: bookingId },
          include: { guests: { include: { nights: true } } }, // per-night sets (issue #713)
        });

        if (!freshBooking || freshBooking.status !== BookingStatus.DRAFT) {
          throw new Error("Booking is no longer a draft");
        }

        const capacity = await checkCapacityForGuestRanges(
          bookingLodgeId,
          freshBooking.checkIn,
          freshBooking.checkOut,
          freshBooking.guests,
          bookingId,
          tx
        );

        if (!capacity.available) {
          throw new Error("Not enough beds available for your dates. Please choose different dates.");
        }

        // Transition DRAFT -> PAYMENT_PENDING
        await tx.booking.update({
          where: { id: bookingId },
          data: { status: BookingStatus.PAYMENT_PENDING, draftExpiresAt: null },
        });
        await reconcileBedAllocationsForBooking({
          bookingId,
          db: tx,
          previousRange: {
            checkIn: freshBooking.checkIn,
            checkOut: freshBooking.checkOut,
          },
        });
      });

      // The admin alert for review-flagged bookings is sent once at
      // creation time. Re-alerting here would double up.
    }

    // Find or create Stripe customer
    const customer = await findOrCreateCustomer({
      email: booking.member.email,
      name: `${booking.member.firstName} ${booking.member.lastName}`,
      memberId: booking.member.id,
    });

    // Create the PaymentIntent at the credit-reduced effective amount (#1641).
    const paymentIntent = await createPaymentIntent({
      amountCents: effectivePriceCents,
      customerId: customer.id,
      metadata: {
        bookingId: booking.id,
        memberId: booking.memberId,
      },
      idempotencyKey: `pi_${booking.id}_${booking.payment?.stripePaymentIntentId ?? "initial"}`,
    });

    // Mirror the effective split onto the Payment so the invariant
    // `amountCents + creditAppliedCents = finalPriceCents` holds (#1641). The
    // update branch also corrects a not-yet-paid legacy full-price payment forward
    // to the effective amount when a fresh intent is minted here.
    const payment = await prisma.payment.upsert({
      where: { bookingId: booking.id },
      create: {
        bookingId: booking.id,
        amountCents: effectivePriceCents,
        creditAppliedCents: appliedCreditCents,
        stripeCustomerId: customer.id,
        status: PaymentStatus.PENDING,
      },
      update: {
        amountCents: effectivePriceCents,
        creditAppliedCents: appliedCreditCents,
        stripeCustomerId: customer.id,
      },
    });

    await upsertPaymentIntentTransaction({
      paymentId: payment.id,
      kind: PaymentTransactionKind.PRIMARY,
      paymentIntentId: paymentIntent.id,
      amountCents: effectivePriceCents,
      status: PaymentStatus.PROCESSING,
      reason: "primary_booking_payment",
      stripeCustomerId: customer.id,
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
