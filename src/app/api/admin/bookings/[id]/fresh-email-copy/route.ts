import { NextRequest, NextResponse } from "next/server";
import { adminFreshEmailCopyBodySchema } from "@/lib/admin-bookings-schemas/bookings";
import { parseJsonRequestBody } from "@/lib/api-json";
import { getAuditRequestContext } from "@/lib/audit";
import { sendBookingFreshEmailCopy } from "@/lib/booking-fresh-email-copy";
import {
  ADMIN_FRESH_EMAIL_COPY_CONNECTION_SHAPE,
  type AdminFreshEmailCopyAnswer,
} from "@/lib/connection-shapes/bookings-bookings";
import { connectionJson } from "@/lib/mcp-connection-request";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";

/**
 * POST /api/admin/bookings/[id]/fresh-email-copy — send a freshly rendered copy
 * of a booking email whose body is never kept: the booking confirmation, the
 * pre-arrival reminder, or the split guests' payment link.
 *
 * Authorisation mirrors the sibling admin booking actions: `bookings:edit`, and
 * any other caller gets a 403 from `requireAdmin`. Refusals say what really
 * happened: 404 no booking, 409 the booking cannot be sent this email (deleted,
 * wrong status, no address, "No emails" on, or a non-live installation), 422
 * the address is suppressed or a placeholder, 429 a copy just went out, 502 the
 * mail transport failed, and 503 a setting could not be read or is incomplete.
 * Only a 200 means the member was sent the message.
 *
 * The body is the template alone (`adminFreshEmailCopyBodySchema`, strict): a
 * caller can never name a recipient, a body, a token or an amount. Also the AI
 * app action `send_fresh_booking_email_copy` (ALP-719).
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
  const parsed = adminFreshEmailCopyBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Choose which booking email to send a fresh copy of." },
      { status: 400 },
    );
  }

  try {
    const result = await sendBookingFreshEmailCopy({
      bookingId,
      template: parsed.data.template,
      actorMemberId: session.user.id,
      auditRequest: getAuditRequestContext(request),
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    const answer: AdminFreshEmailCopyAnswer = {
      success: true,
      template: result.template,
      sentTo: result.sentTo,
      archivedFailureCount: result.archivedFailureCount,
      warning: result.warning,
    };
    return connectionJson(request, answer, ADMIN_FRESH_EMAIL_COPY_CONNECTION_SHAPE);
  } catch (err) {
    logger.error(
      { err, bookingId, template: parsed.data.template },
      "Failed to send a fresh copy of a booking email",
    );
    return NextResponse.json(
      {
        error:
          "The fresh copy could not be sent. Nothing is retried automatically for this email, so please try again.",
      },
      { status: 500 },
    );
  }
}
