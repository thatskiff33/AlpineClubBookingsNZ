import { NextRequest, NextResponse } from "next/server";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { GroupBookingError } from "@/lib/group-booking";
import { createGroupSettlementIntent } from "@/lib/group-settlement";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import {
  BOOKING_PAYMENT_METHOD_VALUES,
  DEFAULT_BOOKING_PAYMENT_METHOD,
  type BookingPaymentMethod,
} from "@/lib/booking-payment-methods";
import logger from "@/lib/logger";
import {
  TRANSACTION_CONTENDED_STATUS_CHECK_MESSAGE,
  transactionContendedResponse,
} from "@/lib/transaction-contended-response";

/**
 * Organiser action: start (or resume) settling an ORGANISER_PAYS group as one
 * combined bill. Commits the joiners' child bookings to CONFIRMED (capacity
 * held), then either opens a Stripe PaymentIntent for the combined total or —
 * when the organiser chooses Internet Banking and the module is on — raises one
 * combined Xero invoice that is emailed for payment by bank transfer. Ownership
 * and payment mode are enforced in the service.
 *
 * Mutating, so POST: it both holds beds and opens a payment.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const rateLimited = await applyRateLimit(rateLimiters.groupBookingCreate, request);
  if (rateLimited) return rateLimited;

  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const body = await request.json().catch(() => ({}));
  const requestedMethod = (body as { paymentMethod?: unknown }).paymentMethod;
  const paymentMethod: BookingPaymentMethod =
    typeof requestedMethod === "string" &&
    (BOOKING_PAYMENT_METHOD_VALUES as readonly string[]).includes(requestedMethod)
      ? (requestedMethod as BookingPaymentMethod)
      : DEFAULT_BOOKING_PAYMENT_METHOD;

  // Re-gate Internet Banking server-side: the module can be off even when the
  // client asked for it (mirrors src/app/api/bookings/route.ts).
  if (paymentMethod === "internet_banking") {
    const modules = await loadEffectiveModuleFlags();
    if (!modules.xeroIntegration || !modules.internetBankingPayments) {
      return NextResponse.json(
        { error: "Internet Banking payments are not available." },
        { status: 400 }
      );
    }
  }

  const { code } = await params;
  try {
    const result = await createGroupSettlementIntent(
      code,
      session.user.id,
      paymentMethod
    );
    return NextResponse.json({
      outcome: result.outcome,
      amountCents: result.amountCents,
      childCount: result.childCount,
      clientSecret: result.clientSecret ?? null,
      paymentIntentId: result.paymentIntentId ?? null,
      reference: result.reference ?? null,
    });
  } catch (err) {
    // Settling commits the children, mints a Stripe intent, then attaches it in
    // a second lock(1) transaction, so an earlier step may have landed
    // (INV-LOCK-006).
    const contended = transactionContendedResponse(
      err,
      "Group settlement contended for the lock(1) budget",
      {
        message: TRANSACTION_CONTENDED_STATUS_CHECK_MESSAGE,
        context: { code, paymentMethod },
      },
    );
    if (contended) return contended;
    const hostingRetry = hostingCoverageParticipantRetryResponse(err);
    if (hostingRetry) return hostingRetry;
    if (err instanceof GroupBookingError) {
      return NextResponse.json(
        { error: err.message, code: err.code, details: err.details },
        { status: err.status }
      );
    }
    logger.error({ err }, "Unexpected error settling group booking");
    return NextResponse.json(
      { error: "Unable to settle the group booking right now" },
      { status: 500 }
    );
  }
}
