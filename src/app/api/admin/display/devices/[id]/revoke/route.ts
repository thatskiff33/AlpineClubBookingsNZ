import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";

// Revoke a lobby display device (fork issue hoppers99/AlpineClubBookingsNZ#33, ADR-001): sets revokedAt —
// checkDisplayAuth rejects the device's token on its very next request and
// the display returns to the pairing screen within one poll. Idempotent.

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const device = await prisma.lodgeDisplayDevice.findUnique({
    where: { id },
    select: { id: true, name: true, lodgeId: true, revokedAt: true },
  });
  if (!device) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  if (!device.revokedAt) {
    await prisma.lodgeDisplayDevice.update({
      where: { id },
      data: { revokedAt: new Date(), pairingCode: null, pairingCodeExpiresAt: null },
    });
    logAudit({
      action: "LODGE_DISPLAY_DEVICE_REVOKED",
      category: "lodge",
      entityType: "LodgeDisplayDevice",
      entityId: device.id,
      targetId: device.id,
      actorMemberId: guard.session.user.id,
      details: `Revoked lobby display device "${device.name}" (lodge ${device.lodgeId})`,
    });
  }

  return NextResponse.json({ ok: true });
}
