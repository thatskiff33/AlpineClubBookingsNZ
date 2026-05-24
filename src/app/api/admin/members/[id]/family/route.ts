import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/admin/members/[id]/family
 * Returns the target member's family group members for admin booking-on-behalf.
 * Same shape as /api/members/family but for any member (admin only).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id: memberId } = await params;

  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      ageTier: true,
      active: true,
      archivedAt: true,
      familyGroupMemberships: {
        select: {
          familyGroupId: true,
          familyGroup: { select: { id: true, name: true } },
        },
      },
    },
  });

  if (!member || !member.active || member.archivedAt) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  const seen = new Set<string>();
  const familyMembers: {
    id: string;
    firstName: string;
    lastName: string;
    ageTier: string;
    relationship: "self" | "partner" | "dependent";
  }[] = [];

  function addMember(
    m: { id: string; firstName: string; lastName: string; ageTier: string },
    relationship: "self" | "partner" | "dependent"
  ) {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    familyMembers.push({ ...m, relationship });
  }

  // Include the target member as "self"
  addMember(
    { id: member.id, firstName: member.firstName, lastName: member.lastName, ageTier: member.ageTier },
    "self"
  );

  // All members from the target member's family groups
  const groupIds = member.familyGroupMemberships.map((m) => m.familyGroupId);

  if (groupIds.length > 0) {
    const groupMemberships = await prisma.familyGroupMember.findMany({
      where: {
        familyGroupId: { in: groupIds },
        memberId: { not: memberId },
        member: { active: true, archivedAt: null },
      },
      include: {
        member: {
          select: { id: true, firstName: true, lastName: true, ageTier: true },
        },
      },
      orderBy: { member: { firstName: "asc" } },
    });
    for (const gm of groupMemberships) {
      const rel = gm.member.ageTier === "ADULT" ? "partner" : "dependent";
      addMember(gm.member, rel);
    }
  }

  const firstGroup = member.familyGroupMemberships[0]?.familyGroup ?? null;

  return NextResponse.json({
    familyGroupId: firstGroup?.id ?? null,
    familyGroupName: firstGroup?.name ?? null,
    familyGroupIds: groupIds,
    familyMembers,
  });
}
