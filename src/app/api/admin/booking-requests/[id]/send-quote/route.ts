import { NextRequest, NextResponse } from "next/server";
import { parseOptionalJsonRequestBody } from "@/lib/api-json";
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
import type { z } from "zod";
import {
  adminBookingRequestSendQuoteBodySchema,
  bookingRequestOwnerContactIdSchema,
  schoolChildCountsSchema,
  type SchoolChildCounts,
} from "@/lib/admin-bookings-schemas/requests";
import {
  ADMIN_BOOKING_REQUEST_QUOTE_SENT_CONNECTION_SHAPE,
  type AdminBookingRequestQuoteSentAnswer,
} from "@/lib/connection-shapes/bookings-requests";
import { connectionJson } from "@/lib/mcp-connection-request";
import { requireAdmin } from "@/lib/session-guards";
import {
  TRANSACTION_CONTENDED_STATUS_CHECK_MESSAGE,
  transactionContendedResponse,
} from "@/lib/transaction-contended-response";
import { clubFormatValues } from "@/lib/club-format-server";

/**
 * POST /api/admin/booking-requests/[id]/send-quote — hold the beds and email
 * the requester the latest saved quote. The body's fields are read with the
 * schemas `adminBookingRequestSendQuoteBodySchema` composes. Also the AI app
 * action `send_booking_request_quote` (ALP-719).
 */
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
  const jsonBody = await parseOptionalJsonRequestBody(req, { whenAbsent: {}, objectOnly: true });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body as Partial<
    Record<keyof z.input<typeof adminBookingRequestSendQuoteBodySchema>, unknown>
  >;
  let ownerContactMemberId: string | undefined;
  if (body.ownerContactMemberId !== undefined && body.ownerContactMemberId !== null) {
    const parsedContact = bookingRequestOwnerContactIdSchema.safeParse(body.ownerContactMemberId);
    if (!parsedContact.success) {
      return NextResponse.json(
        { error: "Invalid contact selection" },
        { status: 422 }
      );
    }
    ownerContactMemberId = parsedContact.data;
  }

  // #3412 (review, B1): the school group numbers the officer currently has on
  // screen. Sending holds beds and emails the school from the party STORED on
  // the request, so the service refuses the send when these differ from it —
  // the same defect the issue fixes on Save quote, one button over. Same schema
  // saving and approving parse, so one shape of numbers reaches all three.
  let childCounts: SchoolChildCounts | undefined;
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

    const answer: AdminBookingRequestQuoteSentAnswer = {
      success: true,
      id: quote.id,
      version: quote.version,
      status: quote.status,
      expiresAt: quote.responseTokenExpiresAt?.toISOString() ?? null,
      emailDelivered: quote.emailDelivered,
      options: parseBookingRequestQuoteOptions(quote.options),
    };
    return connectionJson(req, answer, ADMIN_BOOKING_REQUEST_QUOTE_SENT_CONNECTION_SHAPE);
  } catch (err) {
    // `INV-LOCK-006`: sending holds the beds in one transaction and claims the
    // quote in another, so the hold may already stand.
    const contended = transactionContendedResponse(
      err,
      "Booking request quote send contended for the lock(1) budget",
      { message: TRANSACTION_CONTENDED_STATUS_CHECK_MESSAGE, context: { requestId: id } },
    );
    if (contended) return contended;
    const hostingRetry = hostingCoverageParticipantRetryResponse(err);
    if (hostingRetry) return hostingRetry;
    // Sending now auto-holds the beds (#1254), so the hold's guards can surface
    // here: a full lodge (BookingRequestQuoteError 409) or a linked-member
    // double-book (issue #1158). Return them as actionable 409s, not a 500.
    if (err instanceof BookingMemberNightConflictError) {
      return NextResponse.json(
        getBookingMemberNightConflictResponse(err.conflicts, await clubFormatValues()),
        { status: 409 },
      );
    }
    if (err instanceof BookingRequestError || err instanceof BookingRequestQuoteError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
