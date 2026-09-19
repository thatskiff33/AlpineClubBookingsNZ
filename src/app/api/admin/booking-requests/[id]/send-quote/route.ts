import { NextRequest, NextResponse } from "next/server";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { BookingRequestError } from "@/lib/booking-request";
import {
  BookingRequestQuoteError,
  parseBookingRequestQuoteOptions,
  sendBookingRequestQuote,
} from "@/lib/booking-request-quotes";
import {
  BookingMemberNightConflictError,
  getBookingMemberNightConflictResponse,
} from "@/lib/booking-member-night-conflicts";
import { schoolChildCountsSchema } from "@/lib/school-booking-request";
import { requireAdmin } from "@/lib/session-guards";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const { id } = await params;

  // Optional map-to-existing-contact decision (issue #1255). Sending a quote
  // auto-holds capacity, which materialises the owner, so the decision rides in
  // the send body. The authoritative guard runs inside the hold transaction.
  const body = (await req.json().catch(() => ({}))) as {
    ownerContactMemberId?: unknown;
    childCounts?: unknown;
  };
  let ownerContactMemberId: string | undefined;
  if (body.ownerContactMemberId !== undefined && body.ownerContactMemberId !== null) {
    if (
      typeof body.ownerContactMemberId !== "string" ||
      body.ownerContactMemberId.trim().length === 0 ||
      body.ownerContactMemberId.length > 64
    ) {
      return NextResponse.json(
        { error: "Invalid contact selection" },
        { status: 422 }
      );
    }
    ownerContactMemberId = body.ownerContactMemberId;
  }

  // #3412 (review, B1): the school group numbers the officer currently has on
  // screen. Sending holds beds and emails the school from the party STORED on
  // the request, so the service refuses the send when these differ from it —
  // the same defect the issue fixes on Save quote, one button over. Same schema
  // saving and approving parse, so one shape of numbers reaches all three.
  let childCounts: ReturnType<typeof schoolChildCountsSchema.parse> | undefined;
  if (body.childCounts !== undefined && body.childCounts !== null) {
    const parsedCounts = schoolChildCountsSchema.safeParse(body.childCounts);
    if (!parsedCounts.success) {
      return NextResponse.json(
        { error: "Invalid group numbers" },
        { status: 422 }
      );
    }
    childCounts = parsedCounts.data;
  }

  try {
    const quote = await sendBookingRequestQuote({
      requestId: id,
      adminMemberId: session.user.id,
      ownerContactMemberId,
      childCounts,
    });

    return NextResponse.json({
      success: true,
      id: quote.id,
      version: quote.version,
      status: quote.status,
      expiresAt: quote.responseTokenExpiresAt?.toISOString() ?? null,
      emailDelivered: quote.emailDelivered,
      options: parseBookingRequestQuoteOptions(quote.options),
    });
  } catch (err) {
    const hostingRetry = hostingCoverageParticipantRetryResponse(err);
    if (hostingRetry) return hostingRetry;
    // Sending now auto-holds the beds (#1254), so the hold's guards can surface
    // here: a full lodge (BookingRequestQuoteError 409) or a linked-member
    // double-book (issue #1158). Return them as actionable 409s, not a 500.
    if (err instanceof BookingMemberNightConflictError) {
      return NextResponse.json(
        getBookingMemberNightConflictResponse(err.conflicts),
        { status: 409 },
      );
    }
    if (err instanceof BookingRequestError || err instanceof BookingRequestQuoteError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
