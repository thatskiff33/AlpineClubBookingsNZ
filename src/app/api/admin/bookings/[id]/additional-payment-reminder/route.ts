import { NextRequest, NextResponse } from "next/server";
import { resendAdditionalPaymentEmail } from "@/lib/additional-payment-resend-service";
import { getAuditRequestContext } from "@/lib/audit";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";

/**
 * POST /api/admin/bookings/[id]/additional-payment-reminder — re-send the email
 * asking the member to pay the extra amount still owing on the booking (#2350): a
 * booking change's, credit used elsewhere in the club's accounts (#4253), or both.
 *
 * Authorisation mirrors the sibling admin booking actions (no-emails,
 * capacity-hold, exclusive-hold): `bookings:edit`, and any other caller gets a
 * 403 from `requireAdmin`. The route changes nothing about the booking or the
 * amount owed — it only sends the message again — and it is audited like the
 * rest of them. It carries no request-rate limiter (no sibling admin booking
 * route does): what stops it being used to pester a member is the 60-minute
 * cooldown enforced inside the service by a guarded claim, which a burst of
 * concurrent requests cannot get past.
 *
 * Refusals are deliberately specific rather than a blanket 400, because each one
 * means something different to the officer looking at the screen: 409 nothing is
 * owed / the booking is not in a collectable state / it is silenced or deleted /
 * the amount changed under them, 422 the mailer withheld the message (a
 * suppressed or placeholder address), 429 the member was already emailed inside
 * the cooldown, 502 the mail transport failed and the stamp was handed back, and
 * 503 the "No emails" switch could not be read — our own uncertainty rather than
 * a fact about this booking, so the message was held back and queued for the
 * retry job instead of being sent or discarded.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id: bookingId } = await params;

  try {
    const result = await resendAdditionalPaymentEmail({
      bookingId,
      actorMemberId: session.user.id,
      auditRequest: getAuditRequestContext(request),
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status },
      );
    }

    return NextResponse.json({
      success: true,
      sentAt: result.sentAt,
      additionalAmountCents: result.additionalAmountCents,
    });
  } catch (err) {
    logger.error(
      { err, bookingId },
      "Failed to re-send the additional payment request email",
    );
    return NextResponse.json(
      { error: "Failed to send the payment request email" },
      { status: 500 },
    );
  }
}
