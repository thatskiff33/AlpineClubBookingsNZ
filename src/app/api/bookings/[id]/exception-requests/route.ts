import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { bookingOwner } from "@/lib/booking-owner";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { getDefaultLodgeId } from "@/lib/lodges";
import { storedDateOnly } from "@/lib/stored-calendar-day";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { checkRateLimit, getClientIp, rateLimiters } from "@/lib/rate-limit";
import { sendAdminBookingChangeRequestAlert } from "@/lib/email";
import { guestRequestSchemaError } from "@/lib/booking-guest-stay-range-input";
import { modificationExceptionRequestSchema } from "@/lib/booking-exception-request-schemas";
import { CREATED_EXCEPTION_REQUEST_CONNECTION_SHAPE } from "@/lib/connection-shapes-bookings";
import { connectionJson, memberOnlySessionUser } from "@/lib/mcp-connection-request";
import {
  dependantIdentitySpeaksOnBehalf,
} from "@/lib/booking-dependant-identity-doors";
import { getBookingEditPolicy } from "@/lib/booking-edit-policy";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { bookingHoldsCapacity } from "@/lib/booking-status";
import { bookingManagementAuthorizationRole } from "@/lib/admin-permissions";
import logger from "@/lib/logger";
import {
  buildModificationProposalParties,
  createModificationExceptionRequest,
  type LiveBookingGuestInput,
} from "@/lib/booking-exception-request-service";
import { mapExceptionRequestError } from "@/lib/booking-exception-request-http";
import {
  handleMemberGuestAddRefusal,
  startMemberGuestRefusalClock,
} from "@/lib/member-guest-probe-guard";
import { BookingGuestValidationError } from "@/lib/booking-guests";
import { transactionContendedResponse } from "@/lib/transaction-contended-response";

/*
 * Ask an officer to allow an edit the club's rules would refuse. Also the AI
 * app action `request_booking_change_exception` (ALP-794), which acts as the
 * member only: the officer role below reads the member-only user, so a
 * connection never asks on another member's booking or under an officer's
 * edit policy.
 */

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // #3770: taken at the top, as on the booking add paths (#2388), so the
  // collapsed-refusal timing floor covers the whole request.
  const startedAt = startMemberGuestRefusalClock();
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) return inactiveResponse;
  const actorRole = bookingManagementAuthorizationRole(memberOnlySessionUser(req, session.user));
  const isAdmin = actorRole === "ADMIN";

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

  const { id: bookingId } = await params;
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      // #2526: guests carry their stored explicit night set so the frozen
      // proposal preserves a sparse stay exactly as the canonical planner will,
      // instead of flattening it to its envelope and claiming beds nobody books.
      guests: { include: { nights: { select: { stayDate: true } } } },
      member: true,
      // #3369: the owner may be an Organisation; bookingOwner() reads both.
      organisation: { select: { name: true, email: true } },
      // Whether the live booking holds capacity decides the reservation footprint
      // (#2525 FIX 7); `originBookingRequest` is the #1254 converted-quote signal
      // that `bookingHoldsCapacity` reads for a PENDING booking.
      originBookingRequest: { select: { id: true } },
    },
  });
  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }
  if (bookingOwner(booking).memberId !== session.user.id && !isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // A policy-exception request is only meaningful for a booking a modification
  // could otherwise be applied to; defer the full hard-constraint revalidation to
  // #2525's approve-and-execute, but refuse an un-modifiable booking up front.
  const editPolicy = getBookingEditPolicy({
    status: booking.status,
    role: actorRole,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    // #3123 — the CLUB's day, from its persisted zone.
    today: await clubTodayDateOnlyInstant(),
  });
  if (!editPolicy.canModify) {
    return NextResponse.json(
      { error: editPolicy.reason ?? "This booking cannot be modified" },
      { status: 400 },
    );
  }

  const jsonBody = await parseJsonRequestBody(req, { error: "Invalid JSON" });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;
  const parsed = modificationExceptionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: guestRequestSchemaError(parsed.error, "Validation failed"), details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const {
    checkIn,
    checkOut,
    addGuests,
    removeGuestIds,
    guestStayRanges,
    memberMessage,
    supersedeRequestId,
    dependantIdentityDeclarations,
  } = parsed.data;

  const removeSet = new Set(removeGuestIds ?? []);
  const invalidRemoveIds = [...removeSet].filter(
    (gid) => !booking.guests.some((g) => g.id === gid),
  );
  const invalidRangeIds = (guestStayRanges ?? [])
    .map((r) => r.guestId)
    .filter((gid) => !booking.guests.some((g) => g.id === gid));
  if (invalidRemoveIds.length > 0 || invalidRangeIds.length > 0) {
    return NextResponse.json(
      { error: "One or more guests were not found on this booking" },
      { status: 400 },
    );
  }

  const liveGuests: LiveBookingGuestInput[] = booking.guests.map((g) => ({
    id: g.id,
    firstName: g.firstName,
    lastName: g.lastName,
    ageTier: g.ageTier,
    isMember: g.isMember,
    memberId: g.memberId,
    stayStart: storedDateOnly(g.stayStart),
    stayEnd: storedDateOnly(g.stayEnd),
    nights: g.nights.map((night) => ({
      stayDate: storedDateOnly(night.stayDate),
    })),
  }));

  const { base, proposed } = buildModificationProposalParties({
    bookingCheckIn: storedDateOnly(booking.checkIn),
    bookingCheckOut: storedDateOnly(booking.checkOut),
    liveGuests,
    delta: {
      checkIn,
      checkOut,
      addGuests,
      removeGuestIds,
      guestStayRanges,
    },
  });

  const effectiveLodgeId = booking.lodgeId ?? (await getDefaultLodgeId(prisma));
  const summaryParts: string[] = [];
  if (checkIn) summaryParts.push(`check-in to ${checkIn}`);
  if (checkOut) summaryParts.push(`check-out to ${checkOut}`);
  if (addGuests?.length) summaryParts.push(`add ${addGuests.length} guest(s)`);
  if (removeSet.size) summaryParts.push(`remove ${removeSet.size} guest(s)`);
  if (guestStayRanges?.length)
    summaryParts.push(`update ${guestStayRanges.length} stay range(s)`);
  const requestedSummary = summaryParts.length
    ? summaryParts.join("; ")
    : "Booking-policy exception on modification";

  try {
    const created = await createModificationExceptionRequest({
      requestedByMemberId: session.user.id,
      bookingId,
      lodgeId: effectiveLodgeId,
      base,
      proposed,
      memberMessage,
      requestedSummary,
      // #2526: freeze the RAW delta alongside the proposal so the approval can
      // replay it against the canonical modification service. It is re-verified
      // against the proposal hash at approval time, never trusted as stored.
      delta: {
        checkIn,
        checkOut,
        addGuests,
        removeGuestIds,
        guestStayRanges,
      },
      supersedeRequestId: supersedeRequestId ?? null,
      bookingOwnerMemberId: bookingOwner(booking).memberId,
      dependantIdentityDeclarations,
      // Drives the provisional reservation footprint (#2525 FIX 7): a non-holding
      // base (DRAFT / generic PENDING / un-held PAYMENT_PENDING / WAITLISTED /
      // BUMPED) reserves the FULL proposed footprint, a holding base only the delta.
      baseHoldsCapacity: bookingHoldsCapacity({
        status: booking.status,
        isRequestConverted: Boolean(booking.originBookingRequest),
        hasAdminCapacityHold: booking.adminCapacityHoldAt != null,
      }),
    });

    logAudit({
      action: "booking-policy-exception-request.create",
      memberId: session.user.id,
      targetId: bookingId,
      subjectMemberId: bookingOwner(booking).memberId,
      entityType: "BookingChangeRequest",
      entityId: created.id,
      category: "booking",
      outcome: "success",
      summary: "Modification policy exception request submitted",
      details: created.reasonCodes.join(", "),
      metadata: {
        source: "MODIFICATION",
        bookingId,
        requestId: created.id,
        proposalHash: created.proposalHash,
        reasonCodes: created.reasonCodes,
        aggregateCapacityMode: created.aggregateCapacityMode,
      },
      ipAddress: getClientIp(req),
    });

    // Post-commit, fire-and-forget: never fail the request on an alert error.
    sendAdminBookingChangeRequestAlert({
      memberName: `${bookingOwner(booking).member.firstName} ${bookingOwner(booking).member.lastName}`,
      memberEmail: bookingOwner(booking).member.email,
      bookingId,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      requestedSummary: `Policy exception (${created.reasonCodes.join(", ")}): ${requestedSummary}`,
      reason: memberMessage,
      requestId: created.id,
    }).catch((err) =>
      logger.error(
        { err, bookingId, requestId: created.id },
        "Failed to send modification policy exception request admin alert",
      ),
    );

    return connectionJson(req, created, CREATED_EXCEPTION_REQUEST_CONNECTION_SHAPE, { status: 201 });
  } catch (error) {
    // The request is created in one lock(1) transaction (INV-LOCK-006).
    const contended = transactionContendedResponse(
      error,
      "Modification exception request create contended for the lock(1) budget",
      { context: { bookingId } },
    );
    if (contended) return contended;
    // #3770: a collapsed member-guest refusal owes the add paths' throttle unit,
    // audit row and timing floor; no boundary hook here, so it charges on exit.
    if (error instanceof BookingGuestValidationError) {
      await handleMemberGuestAddRefusal({
        request: req,
        actorMemberId: session.user.id,
        error,
        route: "bookings/[id]/exception-requests",
        startedAt,
        throttle: "CHARGE_NOW",
      });
    }
    return mapExceptionRequestError(error, {
      onBehalf: dependantIdentitySpeaksOnBehalf({
        actorIsAdmin: isAdmin,
        actorId: session.user.id,
        ownerMemberId: bookingOwner(booking).memberId,
      }),
      surface: "edit",
    });
  }
}
