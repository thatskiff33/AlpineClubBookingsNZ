import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  closeGroupBooking,
  GroupBookingError,
  reopenGroupBooking,
  resolveGroupBookingByCode,
} from "@/lib/group-booking";
import { toGroupBookingSummaryResponse } from "@/lib/group-booking-summary-response";
import {
  groupBookingCodeParamsSchema,
  groupBookingJoinStatusSchema,
} from "@/lib/group-booking-request-schemas";
import {
  GROUP_BOOKING_JOIN_STATUS_CONNECTION_SHAPE,
  GROUP_BOOKING_SUMMARY_CONNECTION_SHAPE,
} from "@/lib/connection-shapes-groups";
import { connectionJson } from "@/lib/mcp-connection-request";
import logger from "@/lib/logger";
import { transactionContendedResponse } from "@/lib/transaction-contended-response";

/**
 * Public lookup of a group booking by its join code. Returns only safe summary
 * fields (no contact details, no roster, no internal ids) so the public join
 * page can show the event. Unknown codes return 404 uniformly.
 *
 * Also the AI app action `get_group_booking` (ALP-797).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const rateLimited = await applyRateLimit(rateLimiters.groupBookingLookup, request);
  if (rateLimited) return rateLimited;

  const parsedParams = groupBookingCodeParamsSchema.safeParse(await params);
  const summary = parsedParams.success
    ? await resolveGroupBookingByCode(parsedParams.data.code)
    : null;
  if (!summary) {
    return NextResponse.json({ error: "Group booking not found" }, { status: 404 });
  }

  // One serialiser, typed from the summary, so no field can be dropped here.
  return connectionJson(
    request,
    toGroupBookingSummaryResponse(summary),
    GROUP_BOOKING_SUMMARY_CONNECTION_SHAPE,
  );
}

/**
 * Organiser management: close or reopen the group to new joins. Ownership is
 * enforced in the service against the session's member id; there is no
 * officer branch. Existing child bookings are never touched here.
 *
 * Also the AI app action `set_group_booking_joining` (ALP-797).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const rateLimited = await applyRateLimit(rateLimiters.groupBookingCreate, request);
  if (rateLimited) return rateLimited;

  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;
  const parsed = groupBookingJoinStatusSchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const parsedParams = groupBookingCodeParamsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: "Group booking not found" }, { status: 404 });
  }
  const { code } = parsedParams.data;
  try {
    const group =
      parsed.data.action === "close"
        ? await closeGroupBooking(code, session.user.id)
        : await reopenGroupBooking(code, session.user.id);
    return connectionJson(request, { status: group.status }, GROUP_BOOKING_JOIN_STATUS_CONNECTION_SHAPE);
  } catch (err) {
    // The join-status write is one lock(1) transaction (INV-LOCK-006).
    const contended = transactionContendedResponse(
      err,
      "Group booking close/reopen contended for the lock(1) budget",
      { context: { code, action: parsed.data.action } },
    );
    if (contended) return contended;
    if (err instanceof GroupBookingError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logger.error({ err }, "Unexpected error updating group booking");
    return NextResponse.json(
      { error: "Unable to update the group booking right now" },
      { status: 500 }
    );
  }
}
