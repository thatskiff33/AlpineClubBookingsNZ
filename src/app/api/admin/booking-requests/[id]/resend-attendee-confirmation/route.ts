import { NextRequest, NextResponse } from "next/server";
import {
  resendSchoolAttendeeConfirmation,
  SchoolAttendeeConfirmationError,
} from "@/lib/school-attendee-confirmation";
import { requireAdmin } from "@/lib/session-guards";
import {
  ADMIN_BOOKING_REQUEST_ATTENDEE_CONFIRMATION_CONNECTION_SHAPE,
  type AdminBookingRequestAttendeeConfirmationAnswer,
} from "@/lib/connection-shapes/bookings-requests";
import { connectionJson } from "@/lib/mcp-connection-request";

/**
 * Admin action (#1153): rotate the school attendee-confirmation token and
 * send the email now, outside the cron cadence. Also the AI app action
 * `resend_school_attendee_confirmation` (ALP-719).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const { id } = await params;

  try {
    const result = await resendSchoolAttendeeConfirmation({
      bookingRequestId: id,
      adminMemberId: session.user.id,
    });
    const answer: AdminBookingRequestAttendeeConfirmationAnswer = { success: true, sentTo: result.sentTo };
    return connectionJson(req, answer, ADMIN_BOOKING_REQUEST_ATTENDEE_CONFIRMATION_CONNECTION_SHAPE);
  } catch (err) {
    if (err instanceof SchoolAttendeeConfirmationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
