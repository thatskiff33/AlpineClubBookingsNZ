import { NextRequest, NextResponse } from "next/server";
import { hasAdminAccess } from "@/lib/access-roles";
import { parseJsonRequestBody } from "@/lib/api-json";
import { auth } from "@/lib/auth";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import {
  requestedRoomWriteErrorResponse,
  writeRequestedRoom,
} from "@/lib/requested-room-write";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { transactionContendedResponse } from "@/lib/transaction-contended-response";
import { requestedRoomUpdateSchema } from "@/lib/booking-detail-edit-schemas";
import { REQUESTED_ROOM_CONNECTION_SHAPE } from "@/lib/connection-shapes-bookings";
import { connectionJson, memberOnlySessionUser } from "@/lib/mcp-connection-request";

/*
 * The member's requested room. Also the AI app actions `set_my_requested_room`
 * and `clear_my_requested_room` (ALP-794): `actorIsAdmin` reads the
 * member-only user, so a connection never gets a Full Admin's reach to
 * another member's booking or past an approved bed allocation.
 */

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
  const mapped = requestedRoomWriteErrorResponse(error);
  // The write is one lock(1) transaction (INV-LOCK-006): retryable. A write
  // conflict keeps the sentence `requested-room-write.ts` gives it.
  const contended = transactionContendedResponse(
    error,
    "Requested room write contended for the lock(1) budget",
    {
      ...(mapped.status === 409 ? { message: mapped.error } : {}),
      context: { bookingId },
    },
  );
  if (contended) return contended;
  return NextResponse.json({ error: mapped.error }, { status: mapped.status });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) return inactiveResponse;
  const disabled = await requireRoomRequestsEnabled();
  if (disabled) return disabled;

  const jsonBody = await parseJsonRequestBody(req, { error: "Invalid JSON" });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;
  const parsed = requestedRoomUpdateSchema.safeParse(body);
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
      actorMemberId: session.user.id,
      actorIsAdmin: hasAdminAccess(memberOnlySessionUser(req, session.user)),
      requestedRoomId: parsed.data.requestedRoomId,
      auditActorLabel: "Member",
    });
    return connectionJson(req, updated, REQUESTED_ROOM_CONNECTION_SHAPE);
  } catch (error) {
    return errorResponse(error, id);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) return inactiveResponse;
  const disabled = await requireRoomRequestsEnabled();
  if (disabled) return disabled;

  const { id } = await params;
  try {
    const updated = await writeRequestedRoom({
      bookingId: id,
      actorMemberId: session.user.id,
      actorIsAdmin: hasAdminAccess(memberOnlySessionUser(req, session.user)),
      requestedRoomId: null,
      auditActorLabel: "Member",
    });
    return connectionJson(req, updated, REQUESTED_ROOM_CONNECTION_SHAPE);
  } catch (error) {
    return errorResponse(error, id);
  }
}
