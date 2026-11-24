import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { parseOptionalJsonRequestBody } from "@/lib/api-json";
import { auth } from "@/lib/auth";
import { bookingIdParamsSchema } from "@/lib/booking-cancel-schema";
import { deleteBooking } from "@/lib/booking-delete";
import logger from "@/lib/logger";
import { mcpModuleOffResponse } from "@/lib/mcp/http";
import { getMemberBookingSummary } from "@/lib/member-self-read";
import { getClientIp } from "@/lib/rate-limit";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { authorizationRoleFromAccessRoles } from "@/lib/access-roles";
import { transactionContendedResponse } from "@/lib/transaction-contended-response";
import { DRAFT_DELETED_CONNECTION_SHAPE } from "@/lib/connection-shapes-bookings";
import { connectionJson, memberOnlySessionUser } from "@/lib/mcp-connection-request";

const deleteBookingBodySchema = z
  .object({
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict();

/**
 * GET /api/bookings/[id]
 *
 * One booking the signed-in member made or is a guest on. A booking that is
 * someone else's answers exactly as one that does not exist.
 *
 * Added for AI app connections (ALP-653), so it is absent while that module is
 * off (`INV-MCP-001`). DELETE below is older and is not.
 *
 * DELETE is also the AI app action `delete_my_draft_booking` (ALP-794). Its
 * role is read from the member-only user, so a connection deletes only the
 * member's own draft: a cancelled booking's soft delete is an officer's
 * (`deleteBooking`).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const off = await mcpModuleOffResponse();
  if (off) return off;

  const parsedParams = bookingIdParamsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const booking = await getMemberBookingSummary(session.user.id, parsedParams.data.id);
  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }
  return NextResponse.json({ booking });
}

export async function DELETE(
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

    // The reason is optional: an empty body deletes without one.
    const jsonBody = await parseOptionalJsonRequestBody(request, { whenAbsent: {} });
    if (!jsonBody.ok) return jsonBody.response;

    const parsedBody = deleteBookingBodySchema.safeParse(jsonBody.body);
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsedBody.error.flatten() },
        { status: 400 }
      );
    }

    const result = await deleteBooking({
      bookingId: parsedParams.data.id,
      actor: {
        memberId: session.user.id,
        role: authorizationRoleFromAccessRoles(memberOnlySessionUser(request, session.user)),
        ipAddress: getClientIp(request),
      },
      reason: parsedBody.data.reason,
    });

    if (result.status === 200) {
      return connectionJson(request, result.data, DRAFT_DELETED_CONNECTION_SHAPE);
    }

    return NextResponse.json(
      {
        error: result.error,
        ...(result.blockers ? { blockers: result.blockers } : {}),
      },
      { status: result.status }
    );
  } catch (error) {
    // The delete is one lock(1) transaction (INV-LOCK-006); its Stripe
    // clean-up runs only after it commits.
    const contended = transactionContendedResponse(
      error,
      "Booking delete contended for the lock(1) budget",
      { context: { bookingId: (await params).id } },
    );
    if (contended) return contended;
    logger.error({ err: error }, "Error deleting booking");
    return NextResponse.json(
      { error: "Failed to delete booking" },
      { status: 500 }
    );
  }
}
