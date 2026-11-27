import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  createGroupBooking,
  GroupBookingError,
} from "@/lib/group-booking";
import {
  createGroupBookingSchema,
  type GroupBookingCreatedResponse,
} from "@/lib/group-booking-request-schemas";
import { GROUP_BOOKING_CREATED_CONNECTION_SHAPE } from "@/lib/connection-shapes-groups";
import { connectionJson } from "@/lib/mcp-connection-request";
import logger from "@/lib/logger";

/**
 * Open a group on one of the caller's own bookings and return the join code.
 * Members only; the service enforces booking ownership and an eligible state.
 * The owner check reads the session's member id and nothing else, so it has
 * no officer branch to narrow for an AI app.
 *
 * Also the AI app action `open_group_booking` (ALP-797), answered with the
 * join code and settings but not the group's internal id.
 */
export async function POST(request: NextRequest) {
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

  const parsed = createGroupBookingSchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  try {
    const group = await createGroupBooking(
      {
        organiserBookingId: parsed.data.organiserBookingId,
        paymentMode: parsed.data.paymentMode,
        joinDeadline: parsed.data.joinDeadline ?? null,
        maxJoiners: parsed.data.maxJoiners ?? null,
      },
      session.user.id
    );

    const created: GroupBookingCreatedResponse = {
      id: group.id,
      joinCode: group.joinCode,
      paymentMode: group.paymentMode,
      status: group.status,
      joinDeadline: group.joinDeadline?.toISOString() ?? null,
      maxJoiners: group.maxJoiners,
    };
    return connectionJson(request, created, GROUP_BOOKING_CREATED_CONNECTION_SHAPE, { status: 201 });
  } catch (err) {
    if (err instanceof GroupBookingError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logger.error({ err }, "Unexpected error creating group booking");
    return NextResponse.json(
      { error: "Unable to create the group booking right now" },
      { status: 500 }
    );
  }
}
