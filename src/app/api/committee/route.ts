import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/committee
 * Public endpoint: returns active committee members ordered by sortOrder.
 */
export async function GET() {
  const members = await prisma.committeeMember.findMany({
    where: { active: true },
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      role: true,
      name: true,
      phone: true,
      email: true,
      contactKey: true,
      description: true,
    },
  });

  return NextResponse.json({ members });
}
