import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { Prisma, type AgeTier } from "@prisma/client";
import { z } from "zod";
import {
  isOrganisationMember,
  resolveAccessRoleTokens,
} from "@/lib/access-roles";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  MEMBERSHIP_TYPE_BOOKING_BEHAVIORS,
  MEMBERSHIP_TYPE_AGE_TIERS,
  MEMBERSHIP_TYPE_SUBSCRIPTION_BEHAVIORS,
  membershipTypeForcedEditOffendingTiers,
  normalizeMembershipTypeAgeTiers,
  normalizeMembershipTypeText,
  replaceMembershipTypeRuleConfiguration,
  serializeMembershipType,
  validateMembershipTypeRuleConfiguration,
} from "@/lib/membership-types";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { clubTimeZone } from "@/lib/club-time/server";
import { clubSeasonYear } from "@/lib/financial-year";

const membershipTypeSelect = {
  id: true,
  key: true,
  name: true,
  description: true,
  publicDescription: true,
  publiclyListed: true,
  isActive: true,
  isBuiltIn: true,
  bookingBehavior: true,
  subscriptionBehavior: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  allowedAgeTiers: {
    select: { ageTier: true },
    orderBy: { ageTier: "asc" },
  },
  _count: { select: { assignments: true, annualFees: true } },
} satisfies Prisma.MembershipTypeSelect;

// Sentinel used to roll back the config-write transaction when the in-tx
// offending-assignee re-read (MAJOR-2 TOCTOU guard) finds a member the new
// allowed set would strand. The 409 body is built from `forcedEditConflict`
// after the transaction unwinds.
class ForcedEditConflictError extends Error {
  constructor() {
    super("membership type allowed-tiers edit would strand assignees");
    this.name = "ForcedEditConflictError";
  }
}

const paramsSchema = z.object({
  id: z.string().min(1),
});

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    publicDescription: z.string().trim().max(4000).nullable().optional(),
    publiclyListed: z.boolean().optional(),
    bookingBehavior: z.enum(MEMBERSHIP_TYPE_BOOKING_BEHAVIORS).optional(),
    subscriptionBehavior: z
      .enum(MEMBERSHIP_TYPE_SUBSCRIPTION_BEHAVIORS)
      .optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
    allowedAgeTiers: z.array(z.enum(MEMBERSHIP_TYPE_AGE_TIERS)).optional(),
  })
  .strict();

function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  return Object.keys(after).filter((key) => before[key] !== after[key]);
}

function auditActionForUpdate(
  before: { isActive: boolean },
  data: { isActive?: boolean },
) {
  if (data.isActive === false && before.isActive) {
    return {
      action: "MEMBERSHIP_TYPE_ARCHIVED",
      summary: "Membership type archived",
    };
  }
  if (data.isActive === true && !before.isActive) {
    return {
      action: "MEMBERSHIP_TYPE_REACTIVATED",
      summary: "Membership type reactivated",
    };
  }
  return {
    action: "MEMBERSHIP_TYPE_UPDATED",
    summary: "Membership type updated",
  };
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) {
    return guard.response;
  }
  const session = guard.session;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: "Invalid route parameters", details: parsedParams.error.flatten() },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json(
      { error: "At least one membership type field is required" },
      { status: 400 },
    );
  }

  const existing = await prisma.membershipType.findUnique({
    where: { id: parsedParams.data.id },
    select: membershipTypeSelect,
  });
  if (!existing) {
    return NextResponse.json(
      { error: "Membership type not found" },
      { status: 404 },
    );
  }

  const data: Prisma.MembershipTypeUpdateInput = {};
  if (parsed.data.name !== undefined) {
    const name = parsed.data.name.trim();
    // Reject renames that collide with another type's display name
    // (case-insensitive exact match). Renaming a type to a case variant of
    // its own name stays allowed because the type itself is excluded.
    const duplicate = await prisma.membershipType.findFirst({
      where: {
        id: { not: existing.id },
        name: { equals: name, mode: "insensitive" },
      },
      select: { id: true, name: true },
    });
    if (duplicate) {
      return NextResponse.json(
        {
          error: `A membership type named "${duplicate.name}" already exists.`,
        },
        { status: 409 },
      );
    }
    data.name = name;
  }
  if (parsed.data.description !== undefined) {
    data.description = normalizeMembershipTypeText(parsed.data.description);
  }
  if (parsed.data.publicDescription !== undefined) {
    data.publicDescription = normalizeMembershipTypeText(parsed.data.publicDescription);
  }
  if (parsed.data.publiclyListed !== undefined) {
    data.publiclyListed = parsed.data.publiclyListed;
  }
  if (parsed.data.bookingBehavior !== undefined) {
    data.bookingBehavior = parsed.data.bookingBehavior;
  }
  if (parsed.data.subscriptionBehavior !== undefined) {
    data.subscriptionBehavior = parsed.data.subscriptionBehavior;
  }
  if (parsed.data.isActive !== undefined) {
    data.isActive = parsed.data.isActive;
  }
  if (parsed.data.sortOrder !== undefined) {
    data.sortOrder = parsed.data.sortOrder;
  }
  const previousAllowedAgeTiers = existing.allowedAgeTiers.map(
    (item) => item.ageTier,
  );
  const allowedAgeTiers =
    parsed.data.allowedAgeTiers === undefined
      ? previousAllowedAgeTiers
      : normalizeMembershipTypeAgeTiers(parsed.data.allowedAgeTiers);
  // The subscription behaviour after this edit gates whether N/A may be offered.
  const effectiveSubscriptionBehavior =
    parsed.data.subscriptionBehavior ?? existing.subscriptionBehavior;
  const configurationError = validateMembershipTypeRuleConfiguration({
    allowedAgeTiers,
    subscriptionBehavior: effectiveSubscriptionBehavior,
  });
  if (configurationError) {
    return NextResponse.json({ error: configurationError }, { status: 400 });
  }

  // Owner decision (#2106): block an allowed-tiers edit that would strand a
  // current/future-season member — becoming FORCED (only-N/A) while a person-tier
  // member is assigned, or removing N/A while a NON-ORG member is still on N/A
  // (org members are globally forced to N/A and exempt). See
  // membershipTypeForcedEditOffendingTiers. The admin must reassign or reclassify
  // those members individually first.
  //
  // The offending-assignee read is repeated INSIDE the write transaction below
  // so a concurrent assignment/tier change between this check and the config
  // write cannot slip a now-stranded member past the guard (MAJOR-2 TOCTOU).
  // Residual: the assignment-save side of the race is still pre-tx (this route
  // only serialises the type-config write); that surface is admin-only and
  // self-heals at the enforcement sites, so a briefly-inconsistent tier is
  // corrected on the next member/assignment write rather than persisted silently.
  const buildForcedEditOffendingTiers = async (
    db: Pick<Prisma.TransactionClient, "seasonalMembershipAssignment">,
  ): Promise<AgeTier[]> => {
    if (parsed.data.allowedAgeTiers === undefined) {
      return [];
    }
    const affectedAssignments = await db.seasonalMembershipAssignment.findMany({
      where: {
        membershipTypeId: existing.id,
        seasonYear: { gte: clubSeasonYear(await clubTimeZone()) },
      },
      select: {
        member: {
          select: {
            ageTier: true,
            role: true,
            accessRoles: { select: { role: true } },
          },
        },
      },
    });
    return membershipTypeForcedEditOffendingTiers({
      previousAllowedAgeTiers,
      nextAllowedAgeTiers: allowedAgeTiers,
      affectedMembers: affectedAssignments.map((assignment) => ({
        ageTier: assignment.member.ageTier,
        isOrganisation: isOrganisationMember({
          accessRoleTokens: resolveAccessRoleTokens(assignment.member),
          legacyRole: assignment.member.role,
        }),
      })),
    });
  };

  const describeForcedEditBlock = (offendingTiers: AgeTier[]) => {
    const offending = offendingTiers
      .map((tier) => (tier === "NOT_APPLICABLE" ? "N/A" : tier))
      .join(", ");
    return `This change to the age-exempt (N/A) configuration is blocked: current or future-season members hold age tier(s) ${offending} that the new allowed set does not cover. Reassign or reclassify those members before changing this type's N/A status.`;
  };

  // Pre-transaction check: fail fast with a clean 409 for the common case.
  if (parsed.data.allowedAgeTiers !== undefined) {
    const offendingTiers = await buildForcedEditOffendingTiers(prisma);
    if (offendingTiers.length > 0) {
      return NextResponse.json(
        { error: describeForcedEditBlock(offendingTiers) },
        { status: 409 },
      );
    }
  }

  const relationUpdates = {
    ...(parsed.data.allowedAgeTiers !== undefined ? { allowedAgeTiers } : {}),
  };

  const auditAction = auditActionForUpdate(existing, parsed.data);
  let forcedEditConflict: AgeTier[] | null = null;
  const updated = await prisma.$transaction(async (tx) => {
    // MAJOR-2: re-read the offending assignees on the tx client immediately
    // before the config write so a race since the pre-tx check is caught.
    const txOffendingTiers = await buildForcedEditOffendingTiers(tx);
    if (txOffendingTiers.length > 0) {
      forcedEditConflict = txOffendingTiers;
      throw new ForcedEditConflictError();
    }
    const membershipType = await tx.membershipType.update({
      where: { id: existing.id },
      data,
      select: membershipTypeSelect,
    });
    await replaceMembershipTypeRuleConfiguration(
      tx,
      membershipType.id,
      relationUpdates,
    );
    const membershipTypeWithRules = await tx.membershipType.findUniqueOrThrow({
      where: { id: existing.id },
      select: membershipTypeSelect,
    });

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: auditAction.action,
        actor: { memberId: session.user.id },
        entity: { type: "MembershipType", id: existing.id },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: auditAction.summary,
        metadata: {
          changedFields: changedFields(existing, {
            ...(data as Record<string, unknown>),
            ...(parsed.data.allowedAgeTiers !== undefined
              ? { allowedAgeTiers }
              : {}),
          }),
          previousMembershipType: serializeMembershipType(existing),
          newMembershipType: serializeMembershipType(membershipTypeWithRules),
        },
        request: getAuditRequestContext(request),
      }),
    );

    return membershipTypeWithRules;
  }).catch((error) => {
    if (error instanceof ForcedEditConflictError && forcedEditConflict) {
      return NextResponse.json(
        { error: describeForcedEditBlock(forcedEditConflict) },
        { status: 409 },
      );
    }
    throw error;
  });
  if (updated instanceof NextResponse) {
    return updated;
  }
  revalidatePath("/", "layout");

  return NextResponse.json({
    membershipType: serializeMembershipType(updated),
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) {
    return guard.response;
  }
  const session = guard.session;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: "Invalid route parameters", details: parsedParams.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await prisma.membershipType.findUnique({
    where: { id: parsedParams.data.id },
    select: membershipTypeSelect,
  });
  if (!existing) {
    return NextResponse.json(
      { error: "Membership type not found" },
      { status: 404 },
    );
  }

  if (existing.isBuiltIn) {
    return NextResponse.json(
      { error: "Built-in membership types cannot be deleted" },
      { status: 409 },
    );
  }

  if ((existing._count?.assignments ?? 0) > 0) {
    return NextResponse.json(
      {
        error:
          "Membership types with seasonal assignments cannot be deleted directly. Merge its members into another type, or archive it instead.",
      },
      { status: 409 },
    );
  }

  if ((existing._count?.annualFees ?? 0) > 0) {
    return NextResponse.json(
      { error: "Membership types with fee history cannot be deleted. Archive the type instead." },
      { status: 409 },
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.membershipType.delete({ where: { id: existing.id } });
    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "MEMBERSHIP_TYPE_DELETED",
        actor: { memberId: session.user.id },
        entity: { type: "MembershipType", id: existing.id },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Membership type deleted",
        metadata: {
          previousMembershipType: serializeMembershipType(existing),
        },
        request: getAuditRequestContext(request),
      }),
    );
  });
  revalidatePath("/", "layout");

  return NextResponse.json({ ok: true });
}
