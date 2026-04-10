import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/members/family
 * Returns the quick-add list for the booking wizard:
 * self + all members from all family groups the user belongs to.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const self = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      ageTier: true,
      familyGroupMemberships: {
        select: {
          familyGroupId: true,
          familyGroup: { select: { id: true, name: true } },
        },
      },
    },
  });

  if (!self) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  // Build the family members list with deduplication
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

  // 1. Always include self
  addMember(
    { id: self.id, firstName: self.firstName, lastName: self.lastName, ageTier: self.ageTier },
    "self"
  );

  // 2. All members from all family groups the user belongs to
  const groupIds = self.familyGroupMemberships.map((m) => m.familyGroupId);

  if (groupIds.length > 0) {
    const groupMemberships = await prisma.familyGroupMember.findMany({
      where: {
        familyGroupId: { in: groupIds },
        memberId: { not: session.user.id },
        member: { active: true },
      },
      include: {
        member: {
          select: { id: true, firstName: true, lastName: true, ageTier: true },
        },
      },
      orderBy: { member: { firstName: "asc" } },
    });
    for (const gm of groupMemberships) {
      // Adults are "partner", youth/children are "dependent"
      const rel = gm.member.ageTier === "ADULT" ? "partner" : "dependent";
      addMember(gm.member, rel);
    }
  }

  // Return the first group's info for backward compat (or null if no groups)
  const firstGroup = self.familyGroupMemberships[0]?.familyGroup ?? null;

  return NextResponse.json({
    familyGroupId: firstGroup?.id ?? null,
    familyGroupName: firstGroup?.name ?? null,
    familyGroupIds: groupIds,
    familyMembers,
  });
}
