import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { z } from "zod";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { logAudit } from "@/lib/audit";

const requestedRoomSchema = z.object({
  requestedRoomId: z.string().min(1),
});

/**
 * PUT /api/admin/bookings/[id]/requested-room
 * Admin: set or update the requested room on a booking.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { id } = await params;

  const booking = await prisma.booking.findUnique({
    where: { id },
    select: { status: true },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  if (booking.status === "CANCELLED" || booking.status === "COMPLETED") {
    return NextResponse.json(
      { error: "Cannot update requested room for cancelled or completed bookings" },
      { status: 400 }
    );
  }

  const modules = await loadEffectiveModuleFlags();
  if (!modules.bedAllocation) {
    return NextResponse.json({ error: "Room requests are not available." }, { status: 400 });
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
    memberId: guard.session.user.id,
    targetId: id,
    details: `Admin set requested room to "${requestedRoom.name}"`,
    category: "booking",
  });

  return NextResponse.json(updated);
}

/**
 * DELETE /api/admin/bookings/[id]/requested-room
 * Admin: clear the requested room.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { id } = await params;

  const booking = await prisma.booking.findUnique({
    where: { id },
    select: { status: true },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  if (booking.status === "CANCELLED" || booking.status === "COMPLETED") {
    return NextResponse.json(
      { error: "Cannot update requested room for cancelled or completed bookings" },
      { status: 400 }
    );
  }

  const updated = await prisma.booking.update({
    where: { id },
    data: { requestedRoomId: null },
    select: { id: true, requestedRoomId: true, requestedRoom: true },
  });

  logAudit({
    action: "booking.requested_room.cleared",
    memberId: guard.session.user.id,
    targetId: id,
    details: "Admin cleared requested room",
    category: "booking",
  });

  return NextResponse.json(updated);
}
