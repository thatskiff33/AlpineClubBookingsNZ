import { NextRequest, NextResponse } from "next/server";
import { bookingOwner } from "@/lib/booking-owner";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { getPaymentIntent } from "@/lib/stripe";
import logger from "@/lib/logger";
import { hasAdminAccess } from "@/lib/access-roles";
import { resolveAdditionalPaymentDoor } from "@/lib/additional-payment-chase";
import {
  intentCurrencyDiffers,
  reissueAdditionalIntentInClubCurrency,
  staleIntentAction,
} from "@/lib/additional-intent-currency";
import { restateAdditionalAsk } from "@/lib/additional-payment-ask";
import { clubFormatValues } from "@/lib/club-format-server";
import { findPaymentTransactionByIntentId } from "@/lib/payment-transactions";
import {
  chargeCurrencyRefusal,
  UNSUPPORTED_CHARGE_CURRENCY_MEMBER_BODY,
} from "@/lib/stripe-charge-currency";
import {
  ADDITIONAL_PAYMENT_ALREADY_MADE_BODY,
  PAYMENT_PROCESSING_BODY,
} from "@/lib/payment-recovery-contract";

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
 *
 * #3635: EVERY 409 HERE CARRIES A `code`, and the card branches on it, never on
 * the bare status — `UNSUPPORTED_CHARGE_CURRENCY` (an error; the ask is still
 * owing), `PAYMENT_PROCESSING` (wait) and `ADDITIONAL_PAYMENT_ALREADY_MADE`
 * (paid). A bare 409 once read as "paid" for all three.
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
  // The club's format, resolved once before any Stripe call (#3565, #3567).
  const format = await clubFormatValues();
  if (chargeCurrencyRefusal(format)) {
    return NextResponse.json(UNSUPPORTED_CHARGE_CURRENCY_MEMBER_BODY, {
      status: 409,
    });
  }

  try {
    const payment = await prisma.payment.findUnique({
      where: { bookingId },
      include: { booking: { select: { memberId: true, status: true, deletedAt: true } } },
    });

    if (!payment) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    }

    if (
      bookingOwner(payment.booking).memberId !== session.user.id &&
      !hasAdminAccess(session.user)
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // #3641 (`INV-PAY-104`): the member's pay door, shared with the Xero
    // outbox reaper, which keeps a supplementary invoice waiting for exactly as
    // long as this door answers `payable`. Stripe's half is part of it: an intent
    // cancelled at the provider still carries a client secret, and handing it
    // out showed a form Stripe.js then rejected.
    const door = await resolveAdditionalPaymentDoor(
      {
        bookingStatus: payment.booking.status,
        bookingDeletedAt: payment.booking.deletedAt,
        payment,
      },
      getPaymentIntent,
    );
    if (door.state === "closed") {
      return NextResponse.json(
        { error: "No pending additional payment" },
        { status: 404 }
      );
    }
    if (door.state === "captured-at-provider") {
      // #3635: the door keeps a `processing` intent's invoice (the reaper relies
      // on that), but the member is not told it is paid: a processing payment
      // can still fail and come back payable. They are told to wait.
      if (door.intent.status === "processing") {
        return NextResponse.json(PAYMENT_PROCESSING_BODY, { status: 409 });
      }
      return NextResponse.json(ADDITIONAL_PAYMENT_ALREADY_MADE_BODY, {
        status: 409,
      });
    }

    let pi = door.intent;
    const action = intentCurrencyDiffers(pi, format) ? staleIntentAction(pi) : null;
    // #3567 re-review: a paid, paying or cancelled old-currency intent is never
    // superseded; the door above answers each of those states itself (#3641).
    // On a `payable` intent `staleIntentAction` says `reissue` for every status
    // Stripe documents, so this line only fails closed on a status Stripe adds
    // later: it hands out no old-currency secret.
    if (action !== null && action !== "reissue") {
      return NextResponse.json({ error: "No pending additional payment" }, { status: 404 });
    }
    if (action === "reissue") {
      /*
        #3567: this ask was minted before the club changed its currency. Its
        secret would charge the OLD currency while the page shows the new one,
        so it is re-issued unchanged on an intent in the club's currency and the
        old one is superseded (queued for cancellation). A retry converges on
        the same new intent: its key is discriminated by the old intent, the new
        currency and the amount.
      */
      const row = await findPaymentTransactionByIntentId({ paymentIntentId: pi.id });
      pi = await reissueAdditionalIntentInClubCurrency({
        format,
        bookingId,
        paymentId: payment.id,
        staleIntentId: pi.id,
        ask: restateAdditionalAsk({
          amountCents: pi.amount,
          carriedAskCents: row?.carriedAskCents ?? 0,
        }),
        reason: row?.reason ?? null,
        customerId: payment.stripeCustomerId,
      });
    }
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
