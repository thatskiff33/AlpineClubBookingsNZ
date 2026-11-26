import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  DEFAULT_MEMBERSHIP_TYPE_AGE_TIERS,
  buildUniqueMembershipTypeKey,
  membershipTypeOrderBy,
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
import { clubFinancialYearEndMonth } from "@/lib/financial-year-server";
import { connectionJson } from "@/lib/mcp-connection-request";
import { MEMBERSHIP_TYPE_LIST_CONNECTION_SHAPE } from "@/lib/connection-shapes/membership-members";
import { MEMBERSHIP_TYPE_CONNECTION_SHAPE } from "@/lib/connection-shapes/membership-config";
import { membershipTypeCreateSchema } from "@/lib/admin-membership-api/config-structure";

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
  ageGroupsApply: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  allowedAgeTiers: {
    select: { ageTier: true },
    orderBy: { ageTier: "asc" },
  },
  _count: { select: { assignments: true } },
} satisfies Prisma.MembershipTypeSelect;

async function loadMembershipTypes() {
  const membershipTypes = await prisma.membershipType.findMany({
    orderBy: membershipTypeOrderBy(),
    select: membershipTypeSelect,
  });

  return {
    membershipTypes: membershipTypes.map(serializeMembershipType),
    // #2107: expose the config-driven current season year so clients (the bulk
    // membership dialog) can default the season select correctly Jan–season-start
    // instead of guessing the calendar year.
    currentSeasonYear: clubSeasonYear(
      await clubTimeZone(),
      undefined,
      await clubFinancialYearEndMonth(),
    ),
  };
}

/**
 * GET /api/admin/membership-types
 * An AI app connection is sent each type with its booking, subscription and
 * age-tier rules, which `update_membership_type` changes (ALP-720).
 */
export async function GET(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) {
    return guard.response;
  }

  return connectionJson(request, await loadMembershipTypes(), MEMBERSHIP_TYPE_LIST_CONNECTION_SHAPE);
}

export async function POST(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) {
    return guard.response;
  }
  const session = guard.session;

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = membershipTypeCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Reject duplicate display names (case-insensitive exact match) before the
  // key builder silently suffixes a unique key for the same visible name.
  const name = parsed.data.name.trim();
  const duplicate = await prisma.membershipType.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
    select: { id: true, name: true },
  });
  if (duplicate) {
    return NextResponse.json(
      { error: `A membership type named "${duplicate.name}" already exists.` },
      { status: 409 },
    );
  }

  const key = await buildUniqueMembershipTypeKey(prisma, name);
  const lastType = await prisma.membershipType.findFirst({
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const sortOrder = parsed.data.sortOrder ?? (lastType?.sortOrder ?? -1) + 1;
  const data = {
    key,
    name,
    description: normalizeMembershipTypeText(parsed.data.description),
    publicDescription: normalizeMembershipTypeText(parsed.data.publicDescription),
    publiclyListed: parsed.data.publiclyListed,
    isActive: parsed.data.isActive,
    isBuiltIn: false,
    bookingBehavior: parsed.data.bookingBehavior,
    subscriptionBehavior: parsed.data.subscriptionBehavior,
    sortOrder,
  };
  // Omitting allowedAgeTiers falls back to the four real age tiers only — never
  // the full selectable set — so N/A is never silently added to a new type
  // (#2069).
  const allowedAgeTiers = normalizeMembershipTypeAgeTiers(
    parsed.data.allowedAgeTiers ?? DEFAULT_MEMBERSHIP_TYPE_AGE_TIERS,
  );
  const configurationError = validateMembershipTypeRuleConfiguration({
    allowedAgeTiers,
    subscriptionBehavior: parsed.data.subscriptionBehavior,
  });
  if (configurationError) {
    return NextResponse.json({ error: configurationError }, { status: 400 });
  }

  const created = await prisma.$transaction(async (tx) => {
    const membershipType = await tx.membershipType.create({
      data,
      select: membershipTypeSelect,
    });
    await replaceMembershipTypeRuleConfiguration(tx, membershipType.id, {
      allowedAgeTiers,
    });
    const membershipTypeWithRules = await tx.membershipType.findUniqueOrThrow({
      where: { id: membershipType.id },
      select: membershipTypeSelect,
    });

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "MEMBERSHIP_TYPE_CREATED",
        actor: { memberId: session.user.id },
        entity: { type: "MembershipType", id: membershipType.id },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Membership type created",
        metadata: {
          newMembershipType: serializeMembershipType(membershipTypeWithRules),
        },
        request: getAuditRequestContext(request),
      }),
    );

    return membershipTypeWithRules;
  });
  revalidatePath("/", "layout");

  return connectionJson(
    request,
    { membershipType: serializeMembershipType(created) },
    MEMBERSHIP_TYPE_CONNECTION_SHAPE,
    { status: 201 },
  );
}
