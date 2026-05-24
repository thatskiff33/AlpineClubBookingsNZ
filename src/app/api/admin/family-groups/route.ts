import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
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
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const groups = await prisma.familyGroup.findMany({
    include: {
      memberships: {
        where: { member: { archivedAt: null } },
        include: {
          member: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              ageTier: true,
              active: true,
              canLogin: true,
              archivedAt: true,
            },
          },
        },
        orderBy: { member: { firstName: "asc" } },
      },
      _count: {
        select: {
          joinRequests: {
            where: {
              status: "PENDING",
              type: { in: ["JOIN_REQUEST", "CHILD_REQUEST", "ADULT_REQUEST", "REMOVAL_REQUEST"] },
            },
          },
        },
      },
    },
    orderBy: { name: "asc" },
  });

  const result = groups.map((g) => {
    const allMembers = g.memberships
      .map((m) => ({ ...m.member, role: m.role }));
    const inactiveCount = allMembers.filter((m) => !m.active).length;
    return {
      id: g.id,
      name: g.name,
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
      members: allMembers,
      memberCount: allMembers.length,
      inactiveCount,
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
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
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

  // Validate all members exist and are not archived.
  const members = await prisma.member.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, firstName: true, lastName: true, active: true, archivedAt: true },
  });

  if (members.length !== uniqueIds.length) {
    return NextResponse.json({ error: "One or more members not found" }, { status: 404 });
  }
  if (members.some((member) => member.archivedAt)) {
    return NextResponse.json(
      { error: "Family groups cannot include archived members" },
      { status: 422 }
    );
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
