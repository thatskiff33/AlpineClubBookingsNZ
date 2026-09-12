import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { getPaymentIntent } from "@/lib/stripe";
import logger from "@/lib/logger";
import { hasAdminAccess } from "@/lib/access-roles";
import { isAdditionalPayableBookingStatus } from "@/lib/additional-payment-chase";

/**
 * GET /api/bookings/[id]/additional-payment-secret
 * Returns the clientSecret for a pending additional modification payment.
 * Used by the booking detail page to render the Stripe payment form.
 *
 * #2350: the booking's LIFECYCLE is part of the gate, not context around it.
 * Cancelling a booking marks the additional intent FAILED without zeroing
 * `additionalAmountCents`, and the cancel path only asks Stripe to cancel an
 * intent that was still outstanding — an intent that had ALREADY failed (a
 * declined card) is left confirmable at Stripe. So an intent-id-and-status gate
 * handed the owner of a cancelled booking a live client secret they could
 * confirm with a different card. The late-capture backstop (#1350) then
 * auto-refunds and alerts, but the member has still been charged for a booking
 * that no longer exists. This is the door that keeps shut.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id: bookingId } = await params;

  try {
    const payment = await prisma.payment.findUnique({
      where: { bookingId },
      include: { booking: { select: { memberId: true, status: true, deletedAt: true } } },
    });

    if (!payment) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    }

    if (
      payment.booking.memberId !== session.user.id &&
      !hasAdminAccess(session.user)
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (
      !payment.additionalPaymentIntentId ||
      payment.additionalPaymentStatus === "SUCCEEDED" ||
      payment.booking.deletedAt !== null ||
      !isAdditionalPayableBookingStatus(payment.booking.status)
    ) {
      return NextResponse.json(
        { error: "No pending additional payment" },
        { status: 404 }
      );
    }

    const pi = await getPaymentIntent(payment.additionalPaymentIntentId);
    if (!pi.client_secret) {
      return NextResponse.json(
        { error: "PaymentIntent has no client secret" },
        { status: 500 }
      );
    }

    // #3340: the amount is THE INTENT'S OWN, not the Payment column's mirror of
    // it, and the intent's id ships beside it. The page renders what this
    // response says and confirms the secret this response carries, so the figure
    // a member reads and the figure Stripe charges are the same intent's amount
    // BY CONSTRUCTION - there is no second source for the two to drift between.
    // Before this, a second edit re-rendered the card from a fresh server prop
    // while the browser still held the first edit's secret, and a member was
    // charged $65 against a page reading $300.
    return NextResponse.json({
      clientSecret: pi.client_secret,
      amountCents: pi.amount,
      paymentIntentId: pi.id,
    });
  } catch (err) {
    // #1888 — never echo an unexpected error's message to the client; the raw
    // error stays in the log only.
    logger.error({ err, bookingId }, "Failed to retrieve additional payment secret");
    return NextResponse.json(
      { error: "Failed to get payment secret" },
      { status: 500 }
    );
  }
}
