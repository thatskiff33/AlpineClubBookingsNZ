import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";

const createFamilyGroupSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  memberIds: z.array(z.string()).min(1, "At least one member is required").max(10),
});

/**
 * GET /api/admin/family-groups
 * List all family groups with their members (via join table).
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const groups = await prisma.familyGroup.findMany({
    include: {
      memberships: {
        include: {
          member: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              ageTier: true,
              active: true,
              parentMemberId: true,
            },
          },
        },
        orderBy: { member: { firstName: "asc" } },
      },
      _count: { select: { joinRequests: { where: { status: "PENDING" } } } },
    },
    orderBy: { name: "asc" },
  });

  const result = groups.map((g) => {
    const activeMembers = g.memberships
      .filter((m) => m.member.active)
      .map((m) => ({ ...m.member, role: m.role }));
    return {
      id: g.id,
      name: g.name,
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
      members: activeMembers,
      memberCount: activeMembers.length,
      pendingRequests: g._count.joinRequests,
    };
  });

  return NextResponse.json({ familyGroups: result });
}

/**
 * POST /api/admin/family-groups
 * Create a new family group with the given members (via join table).
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createFamilyGroupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const { name, memberIds } = parsed.data;
  const uniqueIds = [...new Set(memberIds)];

  // Validate all members exist and are active primary members
  const members = await prisma.member.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, firstName: true, lastName: true, active: true, parentMemberId: true },
  });

  if (members.length !== uniqueIds.length) {
    return NextResponse.json({ error: "One or more members not found" }, { status: 404 });
  }

  for (const m of members) {
    if (!m.active) {
      return NextResponse.json(
        { error: `Member ${m.firstName} ${m.lastName} is inactive` },
        { status: 422 }
      );
    }
    if (m.parentMemberId) {
      return NextResponse.json(
        { error: `${m.firstName} ${m.lastName} is a dependent and cannot be added to a family group` },
        { status: 422 }
      );
    }
  }

  const group = await prisma.$transaction(async (tx) => {
    const created = await tx.familyGroup.create({
      data: { name: name.trim() },
    });

    await tx.familyGroupMember.createMany({
      data: uniqueIds.map((mid) => ({
        familyGroupId: created.id,
        memberId: mid,
        role: "MEMBER",
      })),
      skipDuplicates: true,
    });

    return tx.familyGroup.findUnique({
      where: { id: created.id },
      include: {
        memberships: {
          include: {
            member: {
              select: { id: true, firstName: true, lastName: true, email: true, ageTier: true },
            },
          },
        },
      },
    });
  });

  logAudit({
    action: "FAMILY_GROUP_CREATED",
    memberId: session.user.id,
    targetId: group?.id,
    details: JSON.stringify({ name, memberIds: uniqueIds }),
  });

  logger.info({ groupId: group?.id, name, memberCount: uniqueIds.length }, "Family group created");

  const response = group
    ? {
        ...group,
        members: group.memberships.map((m) => ({ ...m.member, role: m.role })),
      }
    : group;

  return NextResponse.json(response, { status: 201 });
}
