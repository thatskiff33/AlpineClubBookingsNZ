import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { REVIEWED_REQUEST_TYPES } from "@/lib/admin-family-group-requests-service";
import {
  ADMIN_FAMILY_GROUP_MAX_MEMBERS,
  ADMIN_FAMILY_GROUP_NAME_MAX_LENGTH,
  createFamilyGroupWithMembers,
} from "@/lib/admin-family-group-create";

const createFamilyGroupSchema = z.object({
  name: z.string().min(1, "Name is required").max(ADMIN_FAMILY_GROUP_NAME_MAX_LENGTH),
  memberIds: z
    .array(z.string())
    .min(1, "At least one member is required")
    .max(ADMIN_FAMILY_GROUP_MAX_MEMBERS),
});

/**
 * GET /api/admin/family-groups
 * List all family groups with their members (via join table).
 *
 * #2568: this is the ROUTINE Family Group overview. It deliberately carries
 * neither a date of birth nor a calculated age — the member pills here are a
 * roster, not an identity check, and age belongs only on the screens where an
 * administrator is acting on one specific member record. Do not add either.
 */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const groups = await prisma.familyGroup.findMany({
    include: {
      memberships: {
        where: { member: { archivedAt: null } },
        // #2520: `select`, not `include` — an `include` on the join table
        // projects every FamilyGroupMember scalar, which is how the retired
        // `role` column stayed in this SQL long after the last reader went
        // (20260803030000 has since dropped it). Only the member is read from
        // these rows, so the narrowing stays.
        select: {
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
              // Shared with the admin review queue so every admin-reviewed
              // request type (including GROUP_CREATE, #1681) counts toward
              // the group's "pending" badge and has-pending filter.
              type: { in: [...REVIEWED_REQUEST_TYPES] },
            },
          },
        },
      },
    },
    orderBy: { name: "asc" },
  });

  const result = groups.map((g) => {
    // #2520: the payload no longer carries a per-membership `role`. The column
    // is retired (#2284 removed the last authorisation reader) and nothing in
    // the admin UI ever read the value out of this response.
    const allMembers = g.memberships.map((m) => m.member);
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
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
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
    const created = await createFamilyGroupWithMembers(tx, {
      name,
      memberIds: uniqueIds,
    });

    return tx.familyGroup.findUnique({
      where: { id: created.id },
      include: {
        memberships: {
          // #2520: `select`, not `include` — see the GET handler above.
          select: {
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
    category: "family",
    memberId: session.user.id,
    targetId: group?.id,
    entityType: "FamilyGroup",
    entityId: group?.id,
    details: JSON.stringify({ name, memberIds: uniqueIds }),
  });

  // INV-PRIV-011 (#2683): a family group's `name` is a household surname, so
  // the log line carries the group id and the size instead. The name is on the
  // audit row written just above, where reading it needs the permission.
  logger.info(
    { groupId: group?.id, memberCount: uniqueIds.length },
    "Family group created"
  );

  const response = group
    ? {
        ...group,
        members: group.memberships.map((m) => m.member),
      }
    : group;

  return NextResponse.json(response, { status: 201 });
}
