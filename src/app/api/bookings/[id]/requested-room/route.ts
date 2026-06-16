import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { z } from "zod";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { isBookingBedAllocationLocked } from "@/lib/admin-bed-allocation";
import { logAudit } from "@/lib/audit";

const requestedRoomSchema = z.object({
  requestedRoomId: z.string().min(1),
});

const LOCKED_MESSAGE =
  "Your beds have been allocated by the lodge and can no longer be changed here.";

/**
 * Loads the booking and runs the shared owner/status/module/lock guards that
 * apply to both PUT and DELETE. Returns either an error response to return as
 * is, or the resolved booking so the caller can proceed.
 */
async function resolveRequestableBooking(
  bookingId: string,
  memberId: string,
  role: string
): Promise<
  | { error: NextResponse }
  | { booking: { memberId: string; status: string } }
> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { memberId: true, status: true },
  });

  if (!booking) {
    return { error: NextResponse.json({ error: "Booking not found" }, { status: 404 }) };
  }

  // Booking owner only — this is the member-facing route. Admins use the
  // dedicated admin route, which is not blocked by the allocation lock.
  if (booking.memberId !== memberId && role !== "ADMIN") {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

  if (booking.status === "CANCELLED" || booking.status === "COMPLETED") {
    return {
      error: NextResponse.json(
        { error: "Cannot update requested room for cancelled or completed bookings" },
        { status: 400 }
      ),
    };
  }

  // Mirror the bedAllocation module gate used by /api/bookings/rooms.
  const modules = await loadEffectiveModuleFlags();
  if (!modules.bedAllocation) {
    return {
      error: NextResponse.json(
        { error: "Room requests are not available." },
        { status: 400 }
      ),
    };
  }

  // Once an admin has confirmed beds the request is read-only (issue #776).
  const locked = await isBookingBedAllocationLocked({ bookingId });
  if (locked) {
    return { error: NextResponse.json({ error: LOCKED_MESSAGE }, { status: 409 }) };
  }

  return { booking };
}

/**
 * PUT /api/bookings/[id]/requested-room
 * Booking owner: set or update their requested room (a preference), allowed
 * before and after payment until an admin confirms the bed allocation.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id } = await params;
  const resolved = await resolveRequestableBooking(
    id,
    session.user.id,
    session.user.role
  );
  if ("error" in resolved) {
    return resolved.error;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = requestedRoomSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const requestedRoom = await prisma.lodgeRoom.findUnique({
    where: { id: parsed.data.requestedRoomId },
    select: { id: true, name: true },
  });
  if (!requestedRoom) {
    return NextResponse.json({ error: "Invalid requested room" }, { status: 400 });
  }

  const updated = await prisma.booking.update({
    where: { id },
    data: { requestedRoomId: parsed.data.requestedRoomId },
    select: {
      id: true,
      requestedRoomId: true,
      requestedRoom: { select: { id: true, name: true, active: true } },
    },
  });

  logAudit({
    action: "booking.requested_room.updated",
    memberId: session.user.id,
    targetId: id,
    details: `Member set requested room to "${requestedRoom.name}"`,
    category: "booking",
  });

  return NextResponse.json(updated);
}

/**
 * DELETE /api/bookings/[id]/requested-room
 * Booking owner: clear their requested room.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id } = await params;
  const resolved = await resolveRequestableBooking(
    id,
    session.user.id,
    session.user.role
  );
  if ("error" in resolved) {
    return resolved.error;
  }

  const updated = await prisma.booking.update({
    where: { id },
    data: { requestedRoomId: null },
    select: { id: true, requestedRoomId: true, requestedRoom: true },
  });

  logAudit({
    action: "booking.requested_room.cleared",
    memberId: session.user.id,
    targetId: id,
    details: "Member cleared requested room",
    category: "booking",
  });

  return NextResponse.json(updated);
}
