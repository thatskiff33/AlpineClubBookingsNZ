import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { hasMemberCompletedAccountSetup } from "@/lib/password-reset";

const updateFamilyGroupSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  memberIds: z.array(z.string()).min(1).max(10).optional(),
});

/**
 * GET /api/admin/family-groups/[id]
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id } = await params;
  const group = await prisma.familyGroup.findUnique({
    where: { id },
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
              canLogin: true,
              inheritEmailFromId: true,
              inheritEmailFrom: {
                select: { email: true },
              },
              passwordHash: true,
              passwordChangedAt: true,
              lastLoginAt: true,
            },
          },
        },
        orderBy: { member: { firstName: "asc" } },
      },
      joinRequests: {
        where: { status: "PENDING" },
        include: {
          requester: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
        },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!group) {
    return NextResponse.json({ error: "Family group not found" }, { status: 404 });
  }

  return NextResponse.json({
    ...group,
    members: group.memberships.map((m) => {
      const { passwordHash, passwordChangedAt, lastLoginAt, ...member } = m.member;
      return {
        ...member,
        role: m.role,
        hasPassword: Boolean(passwordHash) && hasMemberCompletedAccountSetup({
          passwordChangedAt,
          lastLoginAt,
        }),
      };
    }),
  });
}

/**
 * PUT /api/admin/family-groups/[id]
 * Update group name and/or member list (via join table).
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateFamilyGroupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const existing = await prisma.familyGroup.findUnique({
    where: { id },
    include: { memberships: { select: { memberId: true } } },
  });

  if (!existing) {
    return NextResponse.json({ error: "Family group not found" }, { status: 404 });
  }

  const { name, memberIds } = parsed.data;

  if (memberIds) {
    const uniqueIds = [...new Set(memberIds)];

    // Validate new members exist and are active
    const members = await prisma.member.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true, firstName: true, lastName: true, active: true },
    });

    if (members.length !== uniqueIds.length) {
      return NextResponse.json({ error: "One or more members not found" }, { status: 404 });
    }

    const currentMemberIds = existing.memberships.map((m) => m.memberId);
    const toRemove = currentMemberIds.filter((mid) => !uniqueIds.includes(mid));
    const toAdd = uniqueIds.filter((mid) => !currentMemberIds.includes(mid));

    await prisma.$transaction(async (tx) => {
      if (name !== undefined) {
        await tx.familyGroup.update({ where: { id }, data: { name: name.trim() } });
      }
      if (toRemove.length > 0) {
        await tx.familyGroupMember.deleteMany({
          where: { familyGroupId: id, memberId: { in: toRemove } },
        });
      }
      if (toAdd.length > 0) {
        await tx.familyGroupMember.createMany({
          data: toAdd.map((mid) => ({ familyGroupId: id, memberId: mid, role: "MEMBER" })),
          skipDuplicates: true,
        });
      }
    });
  } else if (name !== undefined) {
    await prisma.familyGroup.update({ where: { id }, data: { name: name.trim() } });
  }

  const updated = await prisma.familyGroup.findUnique({
    where: { id },
    include: {
      memberships: {
        include: {
          member: {
            select: { id: true, firstName: true, lastName: true, email: true, ageTier: true },
          },
        },
        orderBy: { member: { firstName: "asc" } },
      },
    },
  });

  logAudit({
    action: "FAMILY_GROUP_UPDATED",
    memberId: session.user.id,
    targetId: id,
    details: JSON.stringify(parsed.data),
  });

  return NextResponse.json({
    ...updated,
    members: updated?.memberships.map((m) => ({ ...m.member, role: m.role })) ?? [],
  });
}

/**
 * DELETE /api/admin/family-groups/[id]
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id } = await params;

  const existing = await prisma.familyGroup.findUnique({
    where: { id },
    select: { id: true },
  });

  if (!existing) {
    return NextResponse.json({ error: "Family group not found" }, { status: 404 });
  }

  await prisma.$transaction(async (tx) => {
    // Delete join table rows (cascade would also handle this, but be explicit)
    await tx.familyGroupMember.deleteMany({ where: { familyGroupId: id } });
    // Delete the group (cascades to join requests)
    await tx.familyGroup.delete({ where: { id } });
  });

  logAudit({
    action: "FAMILY_GROUP_DELETED",
    memberId: session.user.id,
    targetId: id,
  });

  logger.info({ groupId: id }, "Family group deleted");

  return NextResponse.json({ success: true });
}
