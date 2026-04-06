import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/members/family
 * Returns the full quick-add list for the booking wizard:
 * self + family group peers from ALL groups the member belongs to + all dependents (own + peers').
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const self = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      ageTier: true,
      parentMemberId: true,
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

  // 2. Family group peers from ALL groups the member belongs to (via join table)
  const groupIds = self.familyGroupMemberships.map((m) => m.familyGroupId);
  let peerIds: string[] = [];

  if (groupIds.length > 0) {
    const peerMemberships = await prisma.familyGroupMember.findMany({
      where: {
        familyGroupId: { in: groupIds },
        memberId: { not: session.user.id },
        member: { active: true, parentMemberId: null },
      },
      include: {
        member: {
          select: { id: true, firstName: true, lastName: true, ageTier: true },
        },
      },
      orderBy: { member: { firstName: "asc" } },
    });
    for (const pm of peerMemberships) {
      addMember(pm.member, "partner");
    }
    peerIds = [...new Set(peerMemberships.map((pm) => pm.member.id))];
  } else if (self.familyGroupMemberships.length === 0) {
    // Fallback: check legacy familyGroupId field for backward compatibility
    const selfWithLegacy = await prisma.member.findUnique({
      where: { id: session.user.id },
      select: { familyGroupId: true },
    });
    if (selfWithLegacy?.familyGroupId) {
      const peers = await prisma.member.findMany({
        where: {
          familyGroupId: selfWithLegacy.familyGroupId,
          id: { not: session.user.id },
          active: true,
          parentMemberId: null,
        },
        select: { id: true, firstName: true, lastName: true, ageTier: true },
        orderBy: { firstName: "asc" },
      });
      for (const p of peers) {
        addMember(p, "partner");
      }
      peerIds = peers.map((p) => p.id);
    }
  }

  // 3. Own dependents
  const ownDependents = await prisma.member.findMany({
    where: {
      OR: [
        { parentMemberId: session.user.id },
        { secondaryParentId: session.user.id },
      ],
      active: true,
    },
    select: { id: true, firstName: true, lastName: true, ageTier: true },
    orderBy: { firstName: "asc" },
  });
  for (const d of ownDependents) {
    addMember(d, "dependent");
  }

  // 4. Dependents of family group peers
  if (peerIds.length > 0) {
    const peerDependents = await prisma.member.findMany({
      where: {
        OR: [
          { parentMemberId: { in: peerIds } },
          { secondaryParentId: { in: peerIds } },
        ],
        active: true,
      },
      select: { id: true, firstName: true, lastName: true, ageTier: true },
      orderBy: { firstName: "asc" },
    });
    for (const d of peerDependents) {
      addMember(d, "dependent");
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
