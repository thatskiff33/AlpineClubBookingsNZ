import { NextRequest, NextResponse } from "next/server";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { z } from "zod";
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

const holdSchema = z.object({
  optionId: z.string().min(1).max(40).optional().nullable(),
  // Optional map-to-existing-contact decision (issue #1255). The authoritative
  // guard runs inside the hold transaction.
  ownerContactMemberId: z.string().min(1).max(64).optional().nullable(),
});

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
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const parsed = holdSchema.safeParse(body);
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

    return NextResponse.json({
      success: true,
      bookingId: result.bookingId,
      reused: result.reused,
    });
  } catch (err) {
    const hostingRetry = hostingCoverageParticipantRetryResponse(err);
    if (hostingRetry) return hostingRetry;
    if (err instanceof BookingMemberNightConflictError) {
      return NextResponse.json(
        getBookingMemberNightConflictResponse(err.conflicts),
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
