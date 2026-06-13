/**
 * Tokenised public payment links (issue #707).
 *
 * A PaymentLink lets a verified, approved booking requester pay for their
 * booking without an account. Only SHA-256 token hashes are stored; the raw
 * token is emailed once. Every resolution path refuses politely without
 * leaking whether a token, booking, or request exists.
 */
import { BookingStatus, PaymentStatus, PaymentTransactionKind, Prisma } from "@prisma/client";
import { hashActionToken, isActionTokenFormat } from "@/lib/action-tokens";
import { buildInternetBankingPaymentReference } from "@/lib/booking-payment-methods";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import logger from "@/lib/logger";
import { markBookingPaymentSucceeded } from "@/lib/payment-reconciliation";
import { upsertPaymentIntentTransaction } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";
import {
  createPaymentIntent,
  findOrCreateCustomer,
  getPaymentIntent,
} from "@/lib/stripe";

/** Booking statuses a payment link can still pay for. */
export const PAYMENT_LINK_PAYABLE_BOOKING_STATUSES = [
  BookingStatus.PENDING,
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
] as const;

export class PaymentLinkError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PaymentLinkError";
    this.status = status;
  }
}

const INVALID_LINK_MESSAGE = "This payment link is not valid.";
const EXPIRED_LINK_MESSAGE =
  "This payment link has expired. Please contact the club if you still wish to pay for your stay.";
const USED_LINK_MESSAGE = "This payment link has already been used.";
const REVOKED_LINK_MESSAGE =
  "This payment link is no longer active. Please contact the club for help.";
const NOT_PAYABLE_MESSAGE =
  "This booking can no longer be paid online. Please contact the club for help.";

type ResolvedPaymentLink = Prisma.PaymentLinkGetPayload<{
  include: {
    booking: {
      include: {
        member: true;
        guests: true;
        payment: true;
      };
    };
  };
}>;

/**
 * Look up and validate a payment link by raw token. Throws PaymentLinkError
 * with a polite message for every failure mode. Returns the link with its
 * booking when the link is structurally valid (the booking may already be
 * paid — callers handle that explicitly).
 */
export async function resolvePaymentLink(token: string): Promise<ResolvedPaymentLink> {
  const trimmed = token.trim();
  if (!isActionTokenFormat(trimmed)) {
    throw new PaymentLinkError(INVALID_LINK_MESSAGE, 404);
  }

  const link = await prisma.paymentLink.findUnique({
    where: { tokenHash: hashActionToken(trimmed) },
    include: {
      booking: {
        include: {
          member: true,
          guests: true,
          payment: true,
        },
      },
    },
  });

  if (!link || link.booking.deletedAt) {
    throw new PaymentLinkError(INVALID_LINK_MESSAGE, 404);
  }
  if (link.revokedAt) {
    throw new PaymentLinkError(REVOKED_LINK_MESSAGE, 410);
  }
  if (link.usedAt && link.booking.status !== BookingStatus.PAID) {
    throw new PaymentLinkError(USED_LINK_MESSAGE, 410);
  }
  if (link.expiresAt < new Date() && link.booking.status !== BookingStatus.PAID) {
    throw new PaymentLinkError(EXPIRED_LINK_MESSAGE, 410);
  }

  return link;
}

export interface PaymentLinkContext {
  state: "payable" | "paid";
  booking: {
    checkIn: string;
    checkOut: string;
    guestCount: number;
    status: BookingStatus;
  };
  firstName: string;
  amountCents: number;
  internetBankingReference: string;
  expiresAt: string;
}

/**
 * Build the public payment page context for a raw token. Marks the link as
 * used (idempotently) once the booking is paid so it cannot be replayed.
 */
export async function getPaymentLinkContext(token: string): Promise<PaymentLinkContext> {
  const link = await resolvePaymentLink(token);
  const booking = link.booking;

  if (booking.status === BookingStatus.PAID || booking.status === BookingStatus.COMPLETED) {
    if (!link.usedAt) {
      await prisma.paymentLink
        .update({ where: { id: link.id }, data: { usedAt: new Date() } })
        .catch((err) =>
          logger.error({ err, paymentLinkId: link.id }, "Failed to mark payment link used")
        );
    }
    return buildContext(link, "paid");
  }

  if (
    !(PAYMENT_LINK_PAYABLE_BOOKING_STATUSES as readonly BookingStatus[]).includes(
      booking.status
    )
  ) {
    throw new PaymentLinkError(NOT_PAYABLE_MESSAGE, 410);
  }

  return buildContext(link, "payable");
}

function buildContext(
  link: ResolvedPaymentLink,
  state: PaymentLinkContext["state"]
): PaymentLinkContext {
  const booking = link.booking;
  return {
    state,
    booking: {
      checkIn: booking.checkIn.toISOString(),
      checkOut: booking.checkOut.toISOString(),
      guestCount: booking.guests.length,
      status: booking.status,
    },
    firstName: booking.member.firstName,
    amountCents: booking.finalPriceCents,
    internetBankingReference: buildInternetBankingPaymentReference(booking.id),
    expiresAt: link.expiresAt.toISOString(),
  };
}

export type PaymentLinkIntentResult =
  | { type: "alreadyPaid"; paymentIntentId: string }
  | { type: "clientSecret"; clientSecret: string; paymentIntentId: string };

/**
 * Token-authenticated Stripe payment intent creation. Runs the SAME
 * status and capacity revalidation as the session-gated
 * /api/payments/create-payment-intent path before any Stripe call:
 *   1. booking must still be payable (status check)
 *   2. existing PaymentIntents are reused/reconciled, not duplicated
 *   3. capacity is revalidated under the booking advisory lock
 * Final capacity claiming happens in markBookingPaymentSucceeded exactly
 * as it does for session payments and webhooks.
 */
export async function createPaymentIntentForPaymentLink(
  token: string
): Promise<PaymentLinkIntentResult> {
  const link = await resolvePaymentLink(token);
  const booking = link.booking;

  if (booking.status === BookingStatus.PAID) {
    throw new PaymentLinkError(USED_LINK_MESSAGE, 410);
  }

  if (
    !(PAYMENT_LINK_PAYABLE_BOOKING_STATUSES as readonly BookingStatus[]).includes(
      booking.status
    )
  ) {
    throw new PaymentLinkError(NOT_PAYABLE_MESSAGE, 410);
  }

  // Reuse or reconcile an existing PaymentIntent before creating a new one
  // (same behaviour as the session payment-intent route).
  if (booking.payment?.stripePaymentIntentId) {
    const existingIntent = await getPaymentIntent(booking.payment.stripePaymentIntentId);

    if (existingIntent.status === "succeeded") {
      if (booking.payment.status !== PaymentStatus.SUCCEEDED) {
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
          throw new PaymentLinkError(
            "Payment succeeded, but lodge capacity is no longer available for this booking. The club will be in touch.",
            409
          );
        }
      }

      return { type: "alreadyPaid", paymentIntentId: existingIntent.id };
    }

    if (existingIntent.client_secret && existingIntent.status !== "canceled") {
      return {
        type: "clientSecret",
        clientSecret: existingIntent.client_secret,
        paymentIntentId: existingIntent.id,
      };
    }
  }

  // Capacity/status revalidation under the shared booking advisory lock,
  // mirroring the session path's preflight before charging.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

    const freshBooking = await tx.booking.findUnique({
      where: { id: booking.id },
      include: { guests: true },
    });

    if (
      !freshBooking ||
      !(PAYMENT_LINK_PAYABLE_BOOKING_STATUSES as readonly BookingStatus[]).includes(
        freshBooking.status
      )
    ) {
      throw new PaymentLinkError(NOT_PAYABLE_MESSAGE, 410);
    }

    const capacity = await checkCapacityForGuestRanges(
      freshBooking.checkIn,
      freshBooking.checkOut,
      freshBooking.guests,
      booking.id,
      tx
    );

    if (!capacity.available) {
      throw new PaymentLinkError(
        "Not enough beds remain available for these dates. Please contact the club.",
        409
      );
    }
  });

  // Stripe calls stay outside the database transaction.
  const customer = await findOrCreateCustomer({
    email: booking.member.email,
    name: `${booking.member.firstName} ${booking.member.lastName}`,
    memberId: booking.member.id,
  });

  const paymentIntent = await createPaymentIntent({
    amountCents: booking.finalPriceCents,
    customerId: customer.id,
    metadata: {
      bookingId: booking.id,
      memberId: booking.memberId,
      paymentLinkId: link.id,
    },
    idempotencyKey: `pl_pi_${booking.id}_${booking.payment?.stripePaymentIntentId ?? "initial"}`,
  });

  const payment = await prisma.payment.upsert({
    where: { bookingId: booking.id },
    create: {
      bookingId: booking.id,
      amountCents: booking.finalPriceCents,
      stripeCustomerId: customer.id,
      status: PaymentStatus.PENDING,
    },
    update: {
      stripeCustomerId: customer.id,
    },
  });

  await upsertPaymentIntentTransaction({
    paymentId: payment.id,
    kind: PaymentTransactionKind.PRIMARY,
    paymentIntentId: paymentIntent.id,
    amountCents: booking.finalPriceCents,
    status: PaymentStatus.PROCESSING,
    reason: "payment_link_booking_payment",
    stripeCustomerId: customer.id,
  });

  if (!paymentIntent.client_secret) {
    throw new PaymentLinkError("Unable to start the payment. Please try again.", 500);
  }

  return {
    type: "clientSecret",
    clientSecret: paymentIntent.client_secret,
    paymentIntentId: paymentIntent.id,
  };
}

/** Revoke all active payment links for a booking (e.g. when it is bumped). */
export async function revokePaymentLinksForBooking(
  bookingId: string,
  db: Pick<typeof prisma, "paymentLink"> = prisma
) {
  const revoked = await db.paymentLink.updateMany({
    where: { bookingId, revokedAt: null, usedAt: null },
    data: { revokedAt: new Date() },
  });
  return revoked.count;
}
