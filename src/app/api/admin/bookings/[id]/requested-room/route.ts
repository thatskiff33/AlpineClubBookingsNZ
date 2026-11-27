import { NextRequest, NextResponse } from "next/server";
import { adminRequestedRoomBodySchema } from "@/lib/admin-bookings-schemas/bookings";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  ADMIN_REQUESTED_ROOM_CLEARED_CONNECTION_SHAPE,
  ADMIN_REQUESTED_ROOM_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/bookings-bookings";
import { connectionJson } from "@/lib/mcp-connection-request";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import {
  requestedRoomWriteErrorResponse,
  writeRequestedRoom,
} from "@/lib/requested-room-write";
import { requireAdmin } from "@/lib/session-guards";
import { transactionContendedResponse } from "@/lib/transaction-contended-response";

async function requireRoomRequestsEnabled() {
  const modules = await loadEffectiveModuleFlags();
  return modules.bedAllocation
    ? null
    : NextResponse.json(
        { error: "Room requests are not available." },
        { status: 400 },
      );
}

function errorResponse(error: unknown, bookingId: string) {
  // `INV-LOCK-006`: the write's one transaction rolled back.
  const contended = transactionContendedResponse(
    error,
    "Admin requested-room write contended for the lock(1) budget",
    { context: { bookingId } },
  );
  if (contended) return contended;
  const mapped = requestedRoomWriteErrorResponse(error);
  return NextResponse.json({ error: mapped.error }, { status: mapped.status });
}

/**
 * PUT /api/admin/bookings/[id]/requested-room — set the room a booking asks
 * for. Also the AI app action `set_booking_requested_room` (ALP-719).
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const disabled = await requireRoomRequestsEnabled();
  if (disabled) return disabled;

  const jsonBody = await parseJsonRequestBody(req, { error: "Invalid JSON" });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;
  const parsed = adminRequestedRoomBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { id } = await params;
  try {
    const updated = await writeRequestedRoom({
      bookingId: id,
      actorMemberId: guard.session.user.id,
      actorIsAdmin: true,
      requestedRoomId: parsed.data.requestedRoomId,
      auditActorLabel: "Admin",
    });
    return connectionJson(req, updated, ADMIN_REQUESTED_ROOM_CONNECTION_SHAPE);
  } catch (error) {
    return errorResponse(error, id);
  }
}

/**
 * DELETE /api/admin/bookings/[id]/requested-room — clear the room request.
 * Also the AI app action `clear_booking_requested_room` (ALP-719).
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const disabled = await requireRoomRequestsEnabled();
  if (disabled) return disabled;

  const { id } = await params;
  try {
    const updated = await writeRequestedRoom({
      bookingId: id,
      actorMemberId: guard.session.user.id,
      actorIsAdmin: true,
      requestedRoomId: null,
      auditActorLabel: "Admin",
    });
    return connectionJson(req, updated, ADMIN_REQUESTED_ROOM_CLEARED_CONNECTION_SHAPE);
  } catch (error) {
    return errorResponse(error, id);
  }
}
