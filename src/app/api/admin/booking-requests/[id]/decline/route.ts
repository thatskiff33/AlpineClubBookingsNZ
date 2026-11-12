import { NextRequest, NextResponse } from "next/server";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { z } from "zod";
import {
  BookingRequestDeclineCommittedError,
  BookingRequestError,
  declineBookingRequest,
  serializeBookingRequestForAdmin,
} from "@/lib/booking-request";
import { requireAdmin } from "@/lib/session-guards";
import { getClientIp } from "@/lib/rate-limit";
import { requireRecentAuth } from "@/lib/require-recent-auth";

const declineSchema = z.object({
  reason: z.string().max(2000).optional().nullable(),
  // #1791: admin per-action email choice. Absent/undefined = notify the
  // requester (default), false = suppress the decline email; non-boolean 400s
  // via this parse. Only the decline email is gated — approve/quote emails
  // carry the payment/quote link and stay always-send.
  notifyMember: z.boolean().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const { id } = await params;
  let body: unknown = {};
  const recent = await requireRecentAuth();
  if (!recent.ok) return recent.response;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const parsed = declineSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const updated = await declineBookingRequest({
      requestId: id,
      adminMemberId: session.user.id,
      reason: parsed.data.reason,
      // #1791: thread the admin's notify choice through to gate the decline
      // email; absent = notify (default).
      notifyMember: parsed.data.notifyMember,
      // #1365: declining releases any capacity hold via cancelBooking, which
      // needs the actor's client IP for its cancellation audit.
      ipAddress: getClientIp(req),
    });

    return NextResponse.json(serializeBookingRequestForAdmin(updated!));
  } catch (err) {
    const committedRecovery =
      err instanceof BookingRequestDeclineCommittedError
        ? {
            requestDeclined: true,
            holdReleasePending: err.holdReleasePending,
            holdReleaseStatusUnconfirmed: err.holdReleaseStatusUnconfirmed,
          }
        : undefined;
    const hostingRetry = hostingCoverageParticipantRetryResponse(
      err,
      committedRecovery,
    );
    if (hostingRetry) return hostingRetry;
    if (err instanceof BookingRequestDeclineCommittedError) {
      return NextResponse.json(
        { error: err.message, ...committedRecovery },
        { status: err.status },
      );
    }
    if (err instanceof BookingRequestError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
