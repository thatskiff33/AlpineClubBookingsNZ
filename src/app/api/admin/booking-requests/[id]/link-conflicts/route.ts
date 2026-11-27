import { NextRequest, NextResponse } from "next/server";
import { adminBookingRequestLinkConflictsBodySchema } from "@/lib/admin-bookings-schemas/requests";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  BookingRequestQuoteError,
  findLinkedGuestMemberNightConflicts,
} from "@/lib/booking-request-quotes";
import { BookingRequestError } from "@/lib/booking-request";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { requireAdmin } from "@/lib/session-guards";
import { ADMIN_BOOKING_REQUEST_LINK_CONFLICTS_CONNECTION_SHAPE } from "@/lib/connection-shapes/bookings-requests";
import { connectionJson } from "@/lib/mcp-connection-request";

/**
 * Advisory-only member-night conflict pre-check for the admin linking step
 * (issue #1226). Given the guest→member links the admin has picked, return any
 * overlapping member-night conflicts so the linking UI can warn early. This
 * never blocks: the authoritative 409 hard block stays at approve/hold time
 * (assertNoBookingMemberNightConflicts).
 *
 * Changes nothing, so the AI app action `check_booking_request_member_links`
 * (ALP-719) runs it as a read.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const { id } = await params;
  const jsonBody = await parseJsonRequestBody(req, {
    error: "Invalid JSON payload",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = adminBookingRequestLinkConflictsBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  try {
    const conflicts = await findLinkedGuestMemberNightConflicts({
      requestId: id,
      adminMemberId: session.user.id,
      links: parsed.data.links,
      // #3123 — the CLUB's day (`INV-CONFIG-002`), encoded at UTC midnight for
      // the `@db.Date` frame the guard compares against (`INV-DATE-026`). The
      // person-night guard never resolves one for itself: its authoritative
      // callers reach it mid-transaction (`INV-LOCK-004`).
      today: await clubTodayDateOnlyInstant(),
    });
    return connectionJson(req, { conflicts }, ADMIN_BOOKING_REQUEST_LINK_CONFLICTS_CONNECTION_SHAPE);
  } catch (err) {
    if (
      err instanceof BookingRequestError ||
      err instanceof BookingRequestQuoteError
    ) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
