import { NextRequest, NextResponse } from "next/server";
import { parseOptionalJsonRequestBody } from "@/lib/api-json";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { adminBookingRequestHoldBodySchema } from "@/lib/admin-bookings-schemas/requests";
import {
  BookingRequestQuoteError,
  holdBookingRequestSlots,
} from "@/lib/booking-request-quotes";
import { BookingRequestError } from "@/lib/booking-request";
import { AdultMemberHostingRequiredError } from "@/lib/adult-member-hosting-refusal";
import {
  BookingMemberNightConflictError,
  getBookingMemberNightConflictResponse,
} from "@/lib/booking-member-night-conflicts";
import { requireAdmin } from "@/lib/session-guards";
import {
  TRANSACTION_CONTENDED_STATUS_CHECK_MESSAGE,
  transactionContendedResponse,
} from "@/lib/transaction-contended-response";
import { clubFormatValues } from "@/lib/club-format-server";
import {
  ADMIN_BOOKING_REQUEST_HOLD_CONNECTION_SHAPE,
  type AdminBookingRequestHoldAnswer,
} from "@/lib/connection-shapes/bookings-requests";
import { connectionJson } from "@/lib/mcp-connection-request";

/**
 * POST /api/admin/booking-requests/[id]/hold — hold the request's beds as an
 * awaiting-review booking. Also the AI app action `hold_booking_request_beds`
 * (ALP-719).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // #1385: the manual "Hold slots" UI entry is restricted to SCHOOL booking
  // requests. The generic quote flow auto-holds the beds on quote send across the
  // whole quote lifecycle (#1280), so a separate manual hold is redundant there
  // and is hidden in the admin panel. This route stays in use for the SCHOOL hold
  // flow — school approval reuses the held booking (#1352) — so it must NOT be
  // removed. The restriction is UI-visibility only (Low-risk, #1385); no server-
  // side request.type check is enforced here on purpose (that would be a
  // behaviour/capability change beyond the issue's scope).
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const { id } = await params;
  const jsonBody = await parseOptionalJsonRequestBody(req, { whenAbsent: {} });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = adminBookingRequestHoldBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  try {
    const result = await holdBookingRequestSlots({
      requestId: id,
      adminMemberId: session.user.id,
      optionId: parsed.data.optionId,
      ownerContactMemberId: parsed.data.ownerContactMemberId,
    });

    if (result.type === "capacityExceeded") {
      return NextResponse.json(
        {
          error: "The lodge is at capacity for one or more of the requested nights",
          fullNights: result.fullNights,
        },
        { status: 409 }
      );
    }

    const answer: AdminBookingRequestHoldAnswer = {
      success: true,
      bookingId: result.bookingId,
      reused: result.reused,
    };
    return connectionJson(req, answer, ADMIN_BOOKING_REQUEST_HOLD_CONNECTION_SHAPE);
  } catch (err) {
    // `INV-LOCK-006`: the hold rolled back, but a stale hold pointer may
    // already have been detached, so the officer checks rather than assumes.
    const contended = transactionContendedResponse(
      err,
      "Booking request hold contended for the lock(1) budget",
      { message: TRANSACTION_CONTENDED_STATUS_CHECK_MESSAGE, context: { requestId: id } },
    );
    if (contended) return contended;
    const hostingRetry = hostingCoverageParticipantRetryResponse(err);
    if (hostingRetry) return hostingRetry;
    if (err instanceof BookingMemberNightConflictError) {
      return NextResponse.json(
        getBookingMemberNightConflictResponse(err.conflicts, await clubFormatValues()),
        { status: 409 },
      );
    }
    if (err instanceof BookingRequestError || err instanceof BookingRequestQuoteError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    // #2569 — see the same branch on the approve route beside this one. A hold is
    // a capacity-holding booking carrying the requested party, so an ENFORCED
    // lodge refuses it on the same terms, and the officer is told which rule
    // stopped it instead of getting a bare 500. The hold rolled back with the
    // throw, so the request is exactly as it was.
    if (err instanceof AdultMemberHostingRequiredError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    }
    throw err;
  }
}
