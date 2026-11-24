import { NextRequest, NextResponse } from "next/server";
import { adminNoEmailsBodySchema } from "@/lib/admin-bookings-schemas/bookings";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  ADMIN_NO_EMAILS_CONNECTION_SHAPE,
  type AdminNoEmailsAnswer,
} from "@/lib/connection-shapes/bookings-bookings";
import { connectionJson } from "@/lib/mcp-connection-request";
import { requireAdmin } from "@/lib/session-guards";
import { getAuditRequestContext } from "@/lib/audit";
import { setBookingNoEmails } from "@/lib/booking-no-emails-service";
import logger from "@/lib/logger";

/**
 * POST /api/admin/bookings/[id]/no-emails — turn the per-booking "No emails"
 * switch on or off (#2258, owner decision D10).
 *
 * While the switch is on, the mailer withholds EVERY member-facing message that
 * belongs to this booking — confirmation, modification, payment, reminders,
 * arrival information, cancellation, waitlist offers, chore rosters, and the
 * invoice email Xero would send on our behalf. Admin-audience alerts and all
 * account/security mail are unaffected: the switch is keyed on the booking, not
 * on the recipient's address.
 *
 * Authorisation mirrors the sibling exclusive-hold / capacity-hold routes and the
 * `notifyMember` contract (docs/DOMAIN_INVARIANTS.md): admin-only, and any
 * non-admin caller gets a 403 from `requireAdmin`. Enabling additionally
 * requires `acknowledged: true`; without it the request is refused with 400 and
 * nothing is written. Both set and clear are audited (who and when). The body
 * is `adminNoEmailsBodySchema`. Also the AI app action `set_booking_no_emails`
 * (ALP-719).
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

  const jsonBody = await parseJsonRequestBody(request);
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;
  const parsed = adminNoEmailsBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }

  const auditRequest = getAuditRequestContext(request);

  try {
    const result = await setBookingNoEmails({
      bookingId,
      noEmails: parsed.data.noEmails,
      acknowledged: parsed.data.acknowledged === true,
      actorMemberId: session.user.id,
      auditRequest,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    // The withheld list is deliberately NOT returned. #2259's client refreshes
    // the server-rendered booking page after a successful write, so the banner
    // re-reads it there — returning a second copy here only added a query whose
    // result was discarded, and a second shape of the same truth to keep in
    // step with the banner.
    const answer: AdminNoEmailsAnswer = {
      success: true,
      noEmails: result.noEmails,
      noEmailsAt: result.noEmailsAt,
      noEmailsByMemberId: result.noEmailsByMemberId,
      changed: result.changed,
      // #2258: the caller warns the admin that a live waitlist offer keeps
      // ticking down while the member will not be told (#2259's dialog).
      hasLiveWaitlistOffer: result.hasLiveWaitlistOffer,
    };
    return connectionJson(request, answer, ADMIN_NO_EMAILS_CONNECTION_SHAPE);
  } catch (err) {
    logger.error({ err, bookingId }, 'Failed to update the booking "No emails" switch');
    return NextResponse.json(
      { error: "Failed to update the No emails setting" },
      { status: 500 },
    );
  }
}
