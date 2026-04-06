import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";

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

  const { id } = await params;
  const group = await prisma.familyGroup.findUnique({
    where: { id },
    include: {
      members: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          ageTier: true,
          active: true,
          parentMemberId: true,
        },
        orderBy: { firstName: "asc" },
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

  return NextResponse.json(group);
}

/**
 * PUT /api/admin/family-groups/[id]
 * Update group name and/or member list.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
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
    include: { members: { select: { id: true } } },
  });

  if (!existing) {
    return NextResponse.json({ error: "Family group not found" }, { status: 404 });
  }

  const { name, memberIds } = parsed.data;

  if (memberIds) {
    const uniqueIds = [...new Set(memberIds)];

    // Validate new members
    const members = await prisma.member.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true, firstName: true, lastName: true, active: true, parentMemberId: true, familyGroupId: true },
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
          { error: `${m.firstName} ${m.lastName} is a dependent and cannot be in a family group` },
          { status: 422 }
        );
      }
      // Allow members already in THIS group, reject if in a different group
      if (m.familyGroupId && m.familyGroupId !== id) {
        return NextResponse.json(
          { error: `${m.firstName} ${m.lastName} is already in another family group` },
          { status: 422 }
        );
      }
    }

    const currentMemberIds = existing.members.map((m) => m.id);
    const toRemove = currentMemberIds.filter((mid) => !uniqueIds.includes(mid));
    const toAdd = uniqueIds.filter((mid) => !currentMemberIds.includes(mid));

    await prisma.$transaction(async (tx) => {
      if (name !== undefined) {
        await tx.familyGroup.update({ where: { id }, data: { name: name.trim() } });
      }
      if (toRemove.length > 0) {
        await tx.member.updateMany({
          where: { id: { in: toRemove } },
          data: { familyGroupId: null },
        });
      }
      if (toAdd.length > 0) {
        await tx.member.updateMany({
          where: { id: { in: toAdd } },
          data: { familyGroupId: id },
        });
      }
    });
  } else if (name !== undefined) {
    await prisma.familyGroup.update({ where: { id }, data: { name: name.trim() } });
  }

  const updated = await prisma.familyGroup.findUnique({
    where: { id },
    include: {
      members: {
        select: { id: true, firstName: true, lastName: true, email: true, ageTier: true },
        orderBy: { firstName: "asc" },
      },
    },
  });

  logAudit({
    action: "FAMILY_GROUP_UPDATED",
    memberId: session.user.id,
    targetId: id,
    details: JSON.stringify(parsed.data),
  });

  return NextResponse.json(updated);
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

  const { id } = await params;

  const existing = await prisma.familyGroup.findUnique({
    where: { id },
    select: { id: true },
  });

  if (!existing) {
    return NextResponse.json({ error: "Family group not found" }, { status: 404 });
  }

  await prisma.$transaction(async (tx) => {
    // Clear familyGroupId on all members
    await tx.member.updateMany({
      where: { familyGroupId: id },
      data: { familyGroupId: null },
    });
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
