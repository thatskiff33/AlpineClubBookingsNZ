import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { hasMemberCompletedAccountSetup } from "@/lib/password-reset";
import { formatMemberIdentityAge } from "@/lib/member-age";
import { clubTime } from "@/lib/club-time/server";

const updateFamilyGroupSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  memberIds: z.array(z.string()).min(1).max(10).optional(),
});

/**
 * GET /api/admin/family-groups/[id]
 *
 * Backs the family-group EDITOR, where an administrator picks a specific member
 * to keep, add or remove. Each member therefore carries the calculated age
 * (#2568) — and never the stored date of birth.
 *
 * The membership-view permission is named explicitly rather than inferred from
 * the request path, so the identity information cannot be served to a general
 * administrator on a request that reaches the handler without the path header.
 *
 * The response is built field by field — never by spreading the Prisma row. A
 * spread of the group re-exported the raw `memberships` relation alongside the
 * sanitised `members` array, so every member's `passwordHash`,
 * `passwordChangedAt`, `lastLoginAt` and (once #2568 selected it)
 * `dateOfBirth` reached the browser even though the mapping below strips all
 * four. A whitelist cannot leak a field a later `select` adds; a spread can, and
 * did.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const group = await prisma.familyGroup.findUnique({
    where: { id },
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
              inheritEmailFromId: true,
              inheritEmailFrom: {
                select: { email: true },
              },
              passwordHash: true,
              passwordChangedAt: true,
              lastLoginAt: true,
              // #2568: read to calculate the age below, then dropped — the
              // response names its fields explicitly and this is not one of them.
              dateOfBirth: true,
            },
          },
        },
        orderBy: { member: { firstName: "asc" } },
      },
      // No `joinRequests` relation is read: the editor loads the review queue
      // from `GET /api/admin/family-groups/requests`, and this route's copy was
      // never consumed. Dropping it keeps the SQL and the payload to what the
      // screen actually uses.
    },
  });

  if (!group) {
    return NextResponse.json({ error: "Family group not found" }, { status: 404 });
  }

  // #3123: one club "today" for the whole payload, resolved once. Asking per
  // member would let two rows of the SAME group be aged against different days
  // across club midnight, on the screen whose purpose is telling two similar
  // member records apart (#2568). `clubTime()` is request-scoped and memoised,
  // and this route is reachable from no CLI entry point, so the `server-only`
  // reader is the right one here.
  const clubToday = (await clubTime()).today();

  return NextResponse.json({
    id: group.id,
    name: group.name,
    createdAt: group.createdAt,
    // #2520: no per-membership `role` in the payload — the column is dropped
    // (20260803030000) and nothing in the admin UI read it out of this response.
    members: group.memberships.map(({ member }) => ({
      id: member.id,
      firstName: member.firstName,
      lastName: member.lastName,
      email: member.email,
      ageTier: member.ageTier,
      active: member.active,
      canLogin: member.canLogin,
      archivedAt: member.archivedAt,
      inheritEmailFromId: member.inheritEmailFromId,
      inheritEmailFrom: member.inheritEmailFrom,
      // #2568: the calculated age, never the stored date of birth.
      ageLabel: formatMemberIdentityAge(member.dateOfBirth, clubToday),
      // The only thing the UI needs from the credential columns: whether this
      // member has finished account setup. The hash itself stays server-side.
      hasPassword:
        Boolean(member.passwordHash) &&
        hasMemberCompletedAccountSetup({
          passwordChangedAt: member.passwordChangedAt,
          lastLoginAt: member.lastLoginAt,
        }),
    })),
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
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
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

    // Validate new members exist and are not archived.
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
        // Billing-family removal sweep (#1932, E6): a removed member who had
        // chosen THIS group as their billing family loses that selection in the
        // same transaction, so it can never point at a family they left.
        await tx.member.updateMany({
          where: { id: { in: toRemove }, billingFamilyGroupId: id },
          data: { billingFamilyGroupId: null },
        });
      }
      if (toAdd.length > 0) {
        await tx.familyGroupMember.createMany({
          data: toAdd.map((mid) => ({ familyGroupId: id, memberId: mid })),
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
        // #2520: `select`, not `include` — see the GET handler above.
        select: {
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
    category: "family",
    memberId: session.user.id,
    targetId: id,
    entityType: "FamilyGroup",
    entityId: id,
    details: JSON.stringify(parsed.data),
  });

  // Field by field, for the same reason as the GET above: a spread of the row
  // would re-export the raw `memberships` relation beside the flattened
  // `members` array. Nothing reads the duplicate.
  return NextResponse.json({
    id,
    name: updated?.name ?? null,
    createdAt: updated?.createdAt ?? null,
    members: updated?.memberships.map((m) => m.member) ?? [],
  });
}

/**
 * DELETE /api/admin/family-groups/[id]
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
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
    // Billing-family removal sweep (#1932, E6): clear any selection pointing at
    // this group in-transaction. The onDelete:SetNull FK would also cover this
    // on the delete below, but we NULL explicitly so the sweep is visible and
    // does not depend solely on the FK.
    await tx.member.updateMany({
      where: { billingFamilyGroupId: id },
      data: { billingFamilyGroupId: null },
    });
    // Delete the group (cascades to join requests)
    await tx.familyGroup.delete({ where: { id } });
  });

  logAudit({
    action: "FAMILY_GROUP_DELETED",
    category: "family",
    memberId: session.user.id,
    targetId: id,
    entityType: "FamilyGroup",
    entityId: id,
  });

  logger.info({ groupId: id }, "Family group deleted");

  return NextResponse.json({ success: true });
}
