import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { resolveOptionalActiveLodgeId } from "@/lib/lodges";
import {
  handleMemberGuestAddRefusal,
  startMemberGuestRefusalClock,
} from "@/lib/member-guest-probe-guard";
import { BookingGuestValidationError } from "@/lib/booking-guests";
import { parseDateOnly, formatDateOnly } from "@/lib/date-only";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { checkRateLimit, getClientIp, rateLimiters } from "@/lib/rate-limit";
import { sendAdminBookingChangeRequestAlert } from "@/lib/email";
import { guestRequestSchemaError } from "@/lib/booking-guest-stay-range-input";
import logger from "@/lib/logger";
import {
  createNewBookingExceptionRequest,
  readMemberExceptionRequests,
} from "@/lib/booking-exception-request-service";
import { mapExceptionRequestError } from "@/lib/booking-exception-request-http";
import { newBookingExceptionRequestSchema } from "@/lib/booking-exception-request-schemas";
import {
  CREATED_EXCEPTION_REQUEST_CONNECTION_SHAPE,
  MEMBER_EXCEPTION_REQUEST_LIST_CONNECTION_SHAPE,
} from "@/lib/connection-shapes-bookings";
import { arrivesAsMcpConnection, connectionJson } from "@/lib/mcp-connection-request";

/*
 * The member's booking-policy exception requests. Also the AI app actions
 * `request_booking_exception` (POST) and `list_my_exception_requests` (GET),
 * ALP-794. Both read only the signed-in member's own requests; neither has an
 * officer branch.
 */

export async function POST(req: NextRequest) {
  // #3770: taken at the top, as on the booking add paths (#2388), so the
  // collapsed-refusal timing floor covers the whole request.
  const startedAt = startMemberGuestRefusalClock();
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) return inactiveResponse;

  const rl = await checkRateLimit(
    rateLimiters.bookingChangeRequest,
    session.user.id,
  );
  if (!rl.success) {
    const retryAfter = Math.ceil((rl.resetAt - Date.now()) / 1000);
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const jsonBody = await parseJsonRequestBody(req, { error: "Invalid JSON" });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = newBookingExceptionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: guestRequestSchemaError(parsed.error, "Validation failed"), details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const {
    lodgeId,
    checkIn,
    checkOut,
    guests,
    memberMessage,
    dependantIdentityDeclarations,
    supersedeRequestId,
  } = parsed.data;

  const parsedCheckIn = parseDateOnly(checkIn);
  const parsedCheckOut = parseDateOnly(checkOut);
  if (
    Number.isNaN(parsedCheckIn.getTime()) ||
    Number.isNaN(parsedCheckOut.getTime())
  ) {
    return NextResponse.json({ error: "Invalid booking date" }, { status: 400 });
  }
  if (parsedCheckOut <= parsedCheckIn) {
    return NextResponse.json(
      { error: "Check-out must be after check-in" },
      { status: 400 },
    );
  }

  // #3770: refused here in the create route's words, not as a foreign-key 500
  // that only a party whose members all resolved could reach.
  const effectiveLodgeId = await resolveOptionalActiveLodgeId(prisma, lodgeId);
  if (!effectiveLodgeId) {
    return NextResponse.json(
      { error: "Unknown or inactive lodgeId" },
      { status: 400 },
    );
  }

  try {
    const created = await createNewBookingExceptionRequest({
      requestedByMemberId: session.user.id,
      lodgeId: effectiveLodgeId,
      checkIn: parsedCheckIn,
      checkOut: parsedCheckOut,
      guests,
      memberMessage,
      ...(dependantIdentityDeclarations
        ? { dependantIdentityDeclarations }
        : {}),
      supersedeRequestId: supersedeRequestId ?? null,
    });

    logAudit({
      action: "booking-policy-exception-request.create",
      memberId: session.user.id,
      targetId: created.id,
      subjectMemberId: session.user.id,
      entityType: "NewBookingPolicyExceptionRequest",
      entityId: created.id,
      category: "booking",
      outcome: "success",
      summary: "New-booking policy exception request submitted",
      details: created.reasonCodes.join(", "),
      metadata: {
        source: "NEW_BOOKING",
        requestId: created.id,
        lodgeId: effectiveLodgeId,
        proposalHash: created.proposalHash,
        reasonCodes: created.reasonCodes,
        aggregateCapacityMode: created.aggregateCapacityMode,
      },
      ipAddress: getClientIp(req),
    });

    // Post-commit, fire-and-forget: an alert failure must never fail the request.
    const summary = `New-booking policy exception (${created.reasonCodes.join(", ")}): ${formatDateOnly(parsedCheckIn)} to ${formatDateOnly(parsedCheckOut)}, ${guests.length} guest(s)`;
    sendAdminBookingChangeRequestAlert({
      memberName: session.user.name ?? session.user.email,
      memberEmail: session.user.email,
      bookingId: `new-booking-request:${created.id}`,
      checkIn: parsedCheckIn,
      checkOut: parsedCheckOut,
      requestedSummary: summary,
      reason: memberMessage,
      requestId: created.id,
    }).catch((err) =>
      logger.error(
        { err, requestId: created.id },
        "Failed to send new-booking policy exception request admin alert",
      ),
    );

    return connectionJson(req, created, CREATED_EXCEPTION_REQUEST_CONNECTION_SHAPE, { status: 201 });
  } catch (error) {
    // #3770: a collapsed member-guest refusal owes the add paths' throttle unit,
    // audit row and timing floor; no boundary hook here, so it charges on exit.
    if (error instanceof BookingGuestValidationError) {
      await handleMemberGuestAddRefusal({
        request: req,
        actorMemberId: session.user.id,
        error,
        route: "bookings/exception-requests",
        startedAt,
        throttle: "CHARGE_NOW",
      });
    }
    return mapExceptionRequestError(error);
  }
}

/**
 * The member's OWN booking-policy exception requests — BOTH flavours (#2562).
 *
 * #2524 shipped this as a raw read of the new-booking table alone, which was all
 * its own scope needed. The member's request area has to show every request they
 * raised, including the ones against a live booking, and it must show the exact
 * frozen proposal rather than a hash — so the read is now the unified,
 * requester-scoped one, projected through the single member DTO in
 * `src/lib/member-exception-requests.ts`.
 *
 * That projection is the privacy boundary: a strict allowlist with no slot for the
 * officer's internal note (#2562), and the service's select does not even read the
 * column, so there is nothing in memory for a later edit to leak. The officer's
 * MEMBER-FACING explanation (`adminNotes`) IS carried — a refusal the member
 * cannot read is a refusal they cannot act on — and the officer UI tells them so
 * before they write it.
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) return inactiveResponse;

  const requests = await readMemberExceptionRequests(session.user.id);
  // A connection is answered `{ exceptionRequests }`, an object its allow-list
  // can project; the website's answer is the bare list, unchanged.
  if (arrivesAsMcpConnection(request)) {
    return connectionJson(request, { exceptionRequests: requests }, MEMBER_EXCEPTION_REQUEST_LIST_CONNECTION_SHAPE);
  }
  return NextResponse.json(requests);
}
