import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  MEMBERSHIP_TYPE_BOOKING_BEHAVIORS,
  MEMBERSHIP_TYPE_AGE_TIERS,
  DEFAULT_MEMBERSHIP_TYPE_AGE_TIERS,
  MEMBERSHIP_TYPE_SUBSCRIPTION_BEHAVIORS,
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

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).nullable().optional(),
    publicDescription: z.string().trim().max(4000).nullable().optional(),
    publiclyListed: z.boolean().optional().default(false),
    bookingBehavior: z.enum(MEMBERSHIP_TYPE_BOOKING_BEHAVIORS),
    subscriptionBehavior: z.enum(MEMBERSHIP_TYPE_SUBSCRIPTION_BEHAVIORS),
    isActive: z.boolean().optional().default(true),
    sortOrder: z.number().int().min(0).max(100000).optional(),
    allowedAgeTiers: z.array(z.enum(MEMBERSHIP_TYPE_AGE_TIERS)).optional(),
  })
  .strict();

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
    currentSeasonYear: clubSeasonYear(await clubTimeZone()),
  };
}

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) {
    return guard.response;
  }

  return NextResponse.json(await loadMembershipTypes());
}

export async function POST(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) {
    return guard.response;
  }
  const session = guard.session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
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

  return NextResponse.json(
    {
      membershipType: serializeMembershipType(created),
    },
    { status: 201 },
  );
}
