import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import {
  SameOwnerCoverageOverrideRequiredError,
  SameOwnerCoverageWouldBreakError,
  buildSameOwnerCoverageOverrideRequiredBody,
  buildSameOwnerCoverageRefusalBody,
} from "@/lib/adult-member-hosting-same-owner";
import { auth } from "@/lib/auth";
import { cancelBooking } from "@/lib/booking-cancel";
import { cancelBookingMutationSchema, bookingIdParamsSchema } from "@/lib/booking-cancel-schema";
import { getClientIp } from "@/lib/rate-limit";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { authorizationRoleFromAccessRoles } from "@/lib/access-roles";
import {
  bookingManagementAuthorizationRole,
  hasAdminAreaAccess,
} from "@/lib/admin-permissions";
import { clubFormatValues } from "@/lib/club-format-server";
import { arrivesAsMcpConnection, connectionJson, memberOnlySessionUser } from "@/lib/mcp-connection-request";
import { CANCEL_BOOKING_CONNECTION_SHAPE } from "@/lib/connection-shapes";
import {
  TRANSACTION_CONTENDED_STATUS_CHECK_MESSAGE,
  transactionContendedResponse,
} from "@/lib/transaction-contended-response";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const parsedParams = bookingIdParamsSchema.safeParse(await params);
    if (!parsedParams.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsedParams.error.flatten() },
        { status: 400 }
      );
    }

    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    }

    const inactiveResponse = await requireActiveSessionUser(session.user.id);
    if (inactiveResponse) {
      return inactiveResponse;
    }

    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const parsed = cancelBookingMutationSchema.safeParse(json.body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    // Issue #1705 (#1696 semantics): only a booking-management ADMIN (Full
    // Admin or Booking Officer) may carry the notify flag; any other caller —
    // including the booking owner cancelling their own booking — is refused
    // before the service runs, so a member can never suppress their own
    // cancellation email.
    // ALP-653 (INV-MCP-006): stage 1's `cancel_my_booking` cancels the
    // member's OWN booking. An AI app connection never carries an officer's
    // authority here (`memberOnlySessionUser`), so for it the Full Admin role
    // and the Booking Officer flag are both off and the service applies the
    // member rules: owner only, the started-stay block and the member door.
    // Nor may it send an officer's hosting-coverage override (ALP-718).
    // Officer booking actions are a later stage (ALP-719).
    const actor = memberOnlySessionUser(request, session.user);
    if (arrivesAsMcpConnection(request) && parsed.data.hostingCoverageOverride !== undefined) {
      return NextResponse.json(
        { error: "Admin override is not available for this account" },
        { status: 403 }
      );
    }
    if (
      parsed.data.notifyMember !== undefined &&
      bookingManagementAuthorizationRole(actor) !== "ADMIN"
    ) {
      return NextResponse.json(
        { error: "Admin override is not available for this account" },
        { status: 403 }
      );
    }

    // The club's format (#3565), resolved once, before any transaction or
    // lock below — never per amount and never inside a transaction.
    const format = await clubFormatValues();
    const result = await cancelBooking(
      parsedParams.data.id,
      session.user.id,
      authorizationRoleFromAccessRoles(actor),
      getClientIp(request),
      format,
      parsed.data.refundMethod,
      {
        // Issue #1313 (owner-approved option A2): a Booking Officer
        // (bookings:edit) may cancel any member's booking with the SAME
        // authority — and byte-identical refund / Stripe path / cancellation
        // email / audit — as a Full Admin acting on-behalf. The actor's real
        // authorization role stays honest ("USER" for an officer); this flag
        // ONLY widens the internal authorization gate, never the refund
        // computation (which keys off booking state + policy tier only).
        hasBookingsEditAccess:
          hasAdminAreaAccess(actor, {
            area: "bookings",
            level: "edit",
          }),
        // Issue #1705: the admin's explicit per-cancel member-email choice.
        // Absent means notify; the service additionally forces notify for any
        // non-admin actor (defence in depth behind the 403 gate above).
        notifyMember: parsed.data.notifyMember,
        // #2576 §7: threaded so the incident records WHO overrode the refusal and
        // WHY, rather than recording an officer's deliberate act as an anonymous
        // system change.
        hostingCoverageOverride: parsed.data.hostingCoverageOverride,
        // #2029: this is the self-service (member / Booking Officer) cancel
        // surface, so enforce the started-stay block. A Full Admin acting
        // through the same route is exempted inside the service; every
        // internal/admin caller leaves this false.
        enforceStartedStayBlock: true,
        // #3497: the same surface is the member-facing cancel DOOR, so refuse the
        // statuses a member may not cancel from (a booking under club review),
        // before the service's wider set admits it. Internal and officer callers
        // leave this false.
        enforceMemberCancelDoor: true,
      }
    );

    if (result.status === 200) {
      return connectionJson(request, result.data, CANCEL_BOOKING_CONNECTION_SHAPE);
    }
    return NextResponse.json(
      { error: result.error },
      { status: result.status }
    );
  } catch (error) {
    // A cancel commits in steps - Stripe intent cancels before its lock(1)
    // claim, card refunds and linked-child cancels after it - so a contended
    // transaction (INV-LOCK-006) asks the member to check before retrying.
    const contended = transactionContendedResponse(
      error,
      "Booking cancel contended for the lock(1) budget",
      {
        message: TRANSACTION_CONTENDED_STATUS_CHECK_MESSAGE,
        context: { bookingId: (await params).id },
      },
    );
    if (contended) return contended;
    const hostingRetry = hostingCoverageParticipantRetryResponse(error);
    if (hostingRetry) return hostingRetry;
    // #2576 §6. ABOVE the generic branch, and that position is the whole point:
    // this refusal is a 409 the member can act on — it names which of their own
    // bookings, which lodge and which nights would be left without adult-member
    // cover — and below a `Failed to cancel booking` 500 it would read as a bug in
    // the site rather than as a decision they can respond to.
    if (error instanceof SameOwnerCoverageWouldBreakError) {
      return NextResponse.json(
        buildSameOwnerCoverageRefusalBody(error),
        { status: error.status }
      );
    }
    // #2576 §7, and above the generic branch for the same reason. The officer is
    // not being refused: they are being shown which bookings and nights the cancel
    // would strand and asked to confirm it with a reason. `requiresOverrideReason`
    // is the flag the client keys on to prompt for one.
    if (error instanceof SameOwnerCoverageOverrideRequiredError) {
      return NextResponse.json(
        buildSameOwnerCoverageOverrideRequiredBody(error),
        { status: error.status }
      );
    }
    logger.error({ err: error }, "Error cancelling booking");
    return NextResponse.json(
      { error: "Failed to cancel booking" },
      { status: 500 }
    );
  }
}
