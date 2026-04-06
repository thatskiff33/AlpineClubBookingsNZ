import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/members/family
 * Returns the full quick-add list for the booking wizard:
 * self + family group peers + all dependents (own + peers').
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
      familyGroupId: true,
      familyGroup: { select: { id: true, name: true } },
      parentMemberId: true,
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

  // 2. Family group peers (other primary members in same group)
  let peerIds: string[] = [];
  if (self.familyGroupId) {
    const peers = await prisma.member.findMany({
      where: {
        familyGroupId: self.familyGroupId,
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

  return NextResponse.json({
    familyGroupId: self.familyGroupId,
    familyGroupName: self.familyGroup?.name ?? null,
    familyMembers,
  });
}
