import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const modules = await loadEffectiveModuleFlags();
  if (!modules.bedAllocation) {
    return NextResponse.json({ enabled: false, rooms: [] });
  }

  const rooms = await prisma.lodgeRoom.findMany({
    where: { active: true },
    include: {
      beds: { where: { active: true }, select: { id: true } },
    },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
  });

  return NextResponse.json({
    enabled: true,
    rooms: rooms.map((room) => ({
      id: room.id,
      name: room.name,
      bedCount: room.beds.length,
    })),
  });
}
