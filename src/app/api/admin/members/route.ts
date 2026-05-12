import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AGE_TIER_VALUES, ageTierEnum } from "@/lib/age-tier-schema";
import { AgeTier } from "@prisma/client";
import { hash } from "bcryptjs";
import { randomBytes } from "crypto";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { computeAgeTier, getAgeTierSettings, getSeasonStartDate } from "@/lib/age-tier";
import {
  getXeroContactGroupMemberships,
  getXeroContactIdsForGroup,
} from "@/lib/xero";
import { sendMemberSetupInviteEmail } from "@/lib/email";
import { getSeasonYear } from "@/lib/utils";
import logger from "@/lib/logger";
import { isPrismaUniqueConstraintError } from "@/lib/prisma-errors";
import { getXeroApiErrorInfo } from "@/lib/xero-api-errors";
import { copyStreetAddressToPostal } from "@/lib/member-address";
import { validateInheritEmailSource } from "@/lib/member-email-inheritance";
import { buildParentLinks } from "@/lib/member-parent-links";
import { isXeroLiveMemberGroupLookupsEnabled } from "@/lib/xero-feature-flags";
import { getMemberSetupInviteExpiryDate } from "@/lib/member-setup-invite";
import { issueActionToken } from "@/lib/action-tokens";
import { hasMemberCompletedAccountSetup } from "@/lib/password-reset";
import { nameField } from "@/lib/zod-helpers";

const maxStr = (len: number) => z.string().max(len).optional().nullable();

const createMemberSchema = z.object({
  email: z.string().email("Invalid email address"),
  firstName: nameField({ required: "First name is required" }),
  lastName: nameField({ required: "Last name is required" }),
  phoneCountryCode: z.string().max(5).optional().nullable(),
  phoneAreaCode: z.string().max(5).optional().nullable(),
  phoneNumber: z.string().max(15).optional().nullable(),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format")
    .optional()
    .nullable(),
  role: z.enum(["MEMBER", "ADMIN"]).default("MEMBER"),
  financeAccessLevel: z.enum(["NONE", "VIEWER", "MANAGER"]).default("NONE"),
  ageTier: ageTierEnum.optional(),
  active: z.boolean().default(true),
  sendInvite: z.boolean().default(false),
  canLogin: z.boolean().optional(),
  parentMemberId: z.string().optional().nullable(),
  inheritParentEmail: z.boolean().optional(),
  inheritEmailFromId: z.string().optional().nullable(),
  familyGroupIds: z.array(z.string()).optional(),
  joinedDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format")
    .optional()
    .nullable()
    .or(z.literal("")),
  streetAddressLine1: maxStr(200),
  streetAddressLine2: maxStr(200),
  streetCity: maxStr(200),
  streetRegion: maxStr(200),
  streetPostalCode: maxStr(20),
  streetCountry: maxStr(100),
  postalAddressLine1: maxStr(200),
  postalAddressLine2: maxStr(200),
  postalCity: maxStr(200),
  postalRegion: maxStr(200),
  postalPostalCode: maxStr(20),
  postalCountry: maxStr(100),
  postalSameAsPhysical: z.boolean().optional(),
});

const SORT_BY_WHITELIST = ["name", "email", "role", "ageTier", "active", "createdAt"] as const;
const SUBSCRIPTION_STATUS_FILTERS = ["PAID", "UNPAID", "OVERDUE", "NOT_INVOICED"] as const;

/**
 * GET /api/admin/members
 * List members with search, filtering, sorting, and pagination.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const sp = req.nextUrl.searchParams;
  const q = sp.get("q") || sp.get("search") || undefined;
  const trimmedQuery = q?.trim();

  // Pagination
  const page = Math.max(1, parseInt(sp.get("page") || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(sp.get("pageSize") || "25", 10) || 25));

  // Sorting
  const sortByRaw = sp.get("sortBy") || "name";
  const sortBy = (SORT_BY_WHITELIST as readonly string[]).includes(sortByRaw) ? sortByRaw : "name";
  const sortDir = sp.get("sortDir") === "desc" ? "desc" : "asc";

  // Build orderBy
  let orderBy: Record<string, string>[] | Record<string, string>;
  switch (sortBy) {
    case "name":
      orderBy = [{ lastName: sortDir }, { firstName: sortDir }];
      break;
    case "email":
      orderBy = { email: sortDir };
      break;
    case "role":
      orderBy = { role: sortDir };
      break;
    case "ageTier":
      orderBy = { ageTier: sortDir };
      break;
    case "active":
      orderBy = { active: sortDir };
      break;
    case "createdAt":
      orderBy = { createdAt: sortDir };
      break;
    default:
      orderBy = [{ lastName: "asc" }, { firstName: "asc" }];
  }

  const now = new Date();
  const currentSeasonYear = getSeasonYear(now);
  const ageTierSettings = await getAgeTierSettings();
  const notRequiredAgeTiers = new Set(
    ageTierSettings
      .filter((setting) => setting.subscriptionRequiredForBooking === false)
      .map((setting) => setting.tier)
  );
  const notRequiredSubscriptionConditions = [
    { role: "ADMIN" },
    ...(notRequiredAgeTiers.size > 0
      ? [{ ageTier: { in: Array.from(notRequiredAgeTiers) } }]
      : []),
  ];

  // Build where clause
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = {};
  const andConditions: Record<string, unknown>[] = [];

  // Text search
  if (trimmedQuery) {
    const queryTerms = trimmedQuery.split(/\s+/).filter(Boolean);
    andConditions.push({
      OR: [
        { id: { startsWith: trimmedQuery } },
        { firstName: { contains: trimmedQuery, mode: "insensitive" } },
        { lastName: { contains: trimmedQuery, mode: "insensitive" } },
        { email: { contains: trimmedQuery, mode: "insensitive" } },
        ...(queryTerms.length > 1
          ? [
              {
                AND: queryTerms.map((term) => ({
                  OR: [
                    { firstName: { contains: term, mode: "insensitive" } },
                    { lastName: { contains: term, mode: "insensitive" } },
                    { email: { contains: term, mode: "insensitive" } },
                  ],
                })),
              },
            ]
          : []),
      ],
    });
  }

  const inheritEmailEligibleFilter =
    sp.get("inheritEmailEligible") === "true";
  if (inheritEmailEligibleFilter) {
    andConditions.push(
      { ageTier: "ADULT" },
      { parentMemberId: null },
      { secondaryParentId: null },
      { inheritEmailFromId: null },
    );
  }

  const excludeId = sp.get("excludeId");
  if (excludeId) {
    andConditions.push({ id: { not: excludeId } });
  }

  const dependentLinkEligibleFor = sp.get("dependentLinkEligibleFor");
  if (dependentLinkEligibleFor) {
    andConditions.push(
      { id: { not: dependentLinkEligibleFor } },
      { parentMemberId: { not: dependentLinkEligibleFor } },
      { secondaryParentId: { not: dependentLinkEligibleFor } },
      { OR: [{ parentMemberId: null }, { secondaryParentId: null }] },
      { dependents: { none: {} } },
      { secondaryDependents: { none: {} } },
    );
  }

  const parentLinkEligibleFor = sp.get("parentLinkEligibleFor");
  if (parentLinkEligibleFor) {
    const target = await prisma.member.findUnique({
      where: { id: parentLinkEligibleFor },
      select: { parentMemberId: true, secondaryParentId: true },
    });
    const excludedParentIds = [
      parentLinkEligibleFor,
      target?.parentMemberId,
      target?.secondaryParentId,
    ].filter((memberId): memberId is string => Boolean(memberId));
    andConditions.push(
      { id: { notIn: excludedParentIds } },
      { active: true },
      { ageTier: "ADULT" },
    );
  }

  // Filter: role
  const roleFilter = sp.get("role");
  if (roleFilter && (roleFilter === "MEMBER" || roleFilter === "ADMIN")) {
    andConditions.push({ role: roleFilter });
  }

  const financeAccessFilter = sp.get("financeAccess");
  if (
    financeAccessFilter &&
    ["NONE", "VIEWER", "MANAGER"].includes(financeAccessFilter)
  ) {
    andConditions.push({ financeAccessLevel: financeAccessFilter });
  }

  // Filter: active
  const activeFilter = sp.get("active");
  if (activeFilter === "true") {
    andConditions.push({ active: true });
  } else if (activeFilter === "false") {
    andConditions.push({ active: false });
  }

  // Filter: ageTier
  const ageTierFilter = sp.get("ageTier");
  if (
    ageTierFilter &&
    AGE_TIER_VALUES.includes(ageTierFilter as (typeof AGE_TIER_VALUES)[number])
  ) {
    andConditions.push({ ageTier: ageTierFilter });
  } else {
    const ageTierInFilter = sp.get("ageTierIn");
    const ageTierIn = ageTierInFilter
      ?.split(",")
      .map((tier) => tier.trim())
      .filter((tier): tier is (typeof AGE_TIER_VALUES)[number] =>
        AGE_TIER_VALUES.includes(tier as (typeof AGE_TIER_VALUES)[number])
      );

    if (ageTierIn && ageTierIn.length > 0) {
      andConditions.push({ ageTier: { in: ageTierIn } });
    }
  }

  // Filter: xeroLinked
  const xeroLinkedFilter = sp.get("xeroLinked");
  if (xeroLinkedFilter === "true") {
    andConditions.push({ xeroContactId: { not: null } });
  } else if (xeroLinkedFilter === "false") {
    andConditions.push({ xeroContactId: null });
  }

  // Filter: invite status. This mirrors the action shown in the members table.
  const activePendingInviteFilter = {
    used: false,
    expiresAt: { gt: now },
  };
  const inviteStatusFilter = sp.get("inviteStatus");
  if (inviteStatusFilter === "invite") {
    andConditions.push(
      { canLogin: true },
      { passwordChangedAt: null },
      { lastLoginAt: null },
      { passwordResetTokens: { none: activePendingInviteFilter } },
    );
  } else if (inviteStatusFilter === "resend-invite") {
    andConditions.push(
      { canLogin: true },
      { passwordChangedAt: null },
      { lastLoginAt: null },
      { passwordResetTokens: { some: activePendingInviteFilter } },
    );
  } else if (inviteStatusFilter === "reset-password") {
    andConditions.push(
      { canLogin: true },
      {
        OR: [
          { passwordChangedAt: { not: null } },
          { lastLoginAt: { not: null } },
        ],
      },
    );
  }

  // Filter: subscription
  const subscriptionFilter = sp.get("subscription");
  if (subscriptionFilter === "NOT_REQUIRED") {
    andConditions.push({ OR: notRequiredSubscriptionConditions });
  } else if (subscriptionFilter === "NONE") {
    andConditions.push(
      { role: { not: "ADMIN" } },
      {
        subscriptions: { none: { seasonYear: currentSeasonYear } },
      },
    );
  } else if (
    subscriptionFilter &&
    (SUBSCRIPTION_STATUS_FILTERS as readonly string[]).includes(subscriptionFilter)
  ) {
    andConditions.push(
      { role: { not: "ADMIN" } },
      {
        subscriptions: {
          some: { seasonYear: currentSeasonYear, status: subscriptionFilter },
        },
      },
    );
  }

  // Filter: family group (via join table)
  const familyGroupFilter = sp.get("familyGroup");
  if (familyGroupFilter === "none") {
    andConditions.push({ familyGroupMemberships: { none: {} } });
  } else if (familyGroupFilter === "any") {
    andConditions.push({ familyGroupMemberships: { some: {} } });
  } else if (familyGroupFilter && familyGroupFilter !== "all") {
    andConditions.push({
      familyGroupMemberships: { some: { familyGroupId: familyGroupFilter } },
    });
  }

  // Filter: Xero contact group — fetch contact IDs from Xero, then filter DB
  const xeroContactGroupFilter = sp.get("xeroContactGroup");
  const liveMemberGroupLookupsEnabled = isXeroLiveMemberGroupLookupsEnabled();
  if (
    liveMemberGroupLookupsEnabled &&
    xeroContactGroupFilter &&
    xeroContactGroupFilter !== "all"
  ) {
    try {
      const groupContactIds = await getXeroContactIdsForGroup(xeroContactGroupFilter);
      if (groupContactIds.length > 0) {
        andConditions.push({ xeroContactId: { in: groupContactIds } });
      } else {
        // Group has no contacts — force empty result
        andConditions.push({ xeroContactId: { in: [] } });
      }
    } catch (error) {
      logger.error({ err: error, groupId: xeroContactGroupFilter }, "Failed to fetch Xero contact group members for filter");
      // Fall through — don't apply this filter if Xero call fails
    }
  }

  if (andConditions.length > 0) {
    where.AND = andConditions;
  }

  const select = {
    id: true,
    firstName: true,
    lastName: true,
    email: true,
    phoneCountryCode: true,
    phoneAreaCode: true,
    phoneNumber: true,
    dateOfBirth: true,
    role: true,
    financeAccessLevel: true,
    ageTier: true,
    active: true,
    canLogin: true,
    parentMemberId: true,
    secondaryParentId: true,
    parent: {
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        ageTier: true,
        active: true,
        canLogin: true,
        inheritEmailFromId: true,
      },
    },
    secondaryParent: {
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        ageTier: true,
        active: true,
        canLogin: true,
        inheritEmailFromId: true,
      },
    },
    xeroContactId: true,
    joinedDate: true,
    createdAt: true,
    forcePasswordChange: true,
    passwordChangedAt: true,
    lastLoginAt: true,
    streetAddressLine1: true,
    streetAddressLine2: true,
    streetCity: true,
    streetRegion: true,
    streetPostalCode: true,
    streetCountry: true,
    postalAddressLine1: true,
    postalAddressLine2: true,
    postalCity: true,
    postalRegion: true,
    postalPostalCode: true,
    postalCountry: true,
    familyGroupMemberships: {
      select: {
        familyGroupId: true,
        familyGroup: { select: { id: true, name: true } },
      },
    },
    subscriptions: {
      where: { seasonYear: currentSeasonYear },
      select: { status: true, seasonYear: true, xeroInvoiceId: true },
      take: 1,
    },
    passwordResetTokens: {
      orderBy: { createdAt: "desc" as const },
      take: 1,
      select: { expiresAt: true, used: true },
    },
  };

  const [members, total] = await Promise.all([
    prisma.member.findMany({
      where,
      orderBy,
      select,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.member.count({ where }),
  ]);

  let xeroContactGroups: Record<string, Array<{ id: string; name: string }>> = {};
  const linkedContactIds = members
    .map((member) => member.xeroContactId)
    .filter(Boolean) as string[];
  let xeroContactGroupsLoaded = linkedContactIds.length === 0;

  if (linkedContactIds.length > 0) {
    try {
      xeroContactGroups = await getXeroContactGroupMemberships(linkedContactIds);
      xeroContactGroupsLoaded = linkedContactIds.every((contactId) =>
        Object.prototype.hasOwnProperty.call(xeroContactGroups, contactId)
      );
    } catch (error) {
      const xeroError = getXeroApiErrorInfo(error, "Failed to fetch Xero contact groups for members list");
      if (!xeroError.handled) {
        logger.error({ err: error }, "Failed to fetch Xero contact groups for members list");
      }
    }
  }

  const membersWithSub = members.map((m) => {
    const hasCompletedAccountSetup = hasMemberCompletedAccountSetup(m);
    const latestToken = m.passwordResetTokens?.[0];
    const pendingInviteExpiresAt =
      !hasCompletedAccountSetup &&
      latestToken &&
      !latestToken.used &&
      latestToken.expiresAt > now
        ? latestToken.expiresAt
        : null;

    return {
      ...m,
      subscriptionStatus:
        m.role === "ADMIN" || notRequiredAgeTiers.has(m.ageTier)
          ? "NOT_REQUIRED"
          : m.subscriptions[0]?.status ?? null,
      subscriptionXeroInvoiceId:
        m.role === "ADMIN" || notRequiredAgeTiers.has(m.ageTier)
          ? null
          : m.subscriptions[0]?.xeroInvoiceId ?? null,
      familyGroups: m.familyGroupMemberships.map((fg) => ({
        id: fg.familyGroup.id,
        name: fg.familyGroup.name,
      })),
      parentLinks: buildParentLinks(m),
      subscriptions: undefined,
      familyGroupMemberships: undefined,
      passwordResetTokens: undefined,
      passwordChangedAt: undefined,
      lastLoginAt: undefined,
      xeroContactGroupsLoaded,
      xeroContactGroups: m.xeroContactId
        ? xeroContactGroups[m.xeroContactId] ?? []
        : [],
      hasCompletedAccountSetup,
      pendingInviteExpiresAt,
    };
  });

  return NextResponse.json({
    members: membersWithSub,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  });
}

/**
 * POST /api/admin/members
 * Create a new member.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
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

  const parsed = createMemberSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const data = parsed.data;
  const email = data.email.toLowerCase().trim();
  const requestedInheritEmailFromId = data.inheritEmailFromId?.trim() || null;
  let parentMember:
    | { id: string; ageTier: AgeTier; inheritEmailFromId: string | null }
    | null = null;

  // Validate family group assignments
  if (data.familyGroupIds && data.familyGroupIds.length > 0) {
    const groups = await prisma.familyGroup.findMany({
      where: { id: { in: data.familyGroupIds } },
      select: { id: true },
    });
    if (groups.length !== data.familyGroupIds.length) {
      return NextResponse.json({ error: "One or more family groups not found" }, { status: 404 });
    }
  }

  if (data.inheritParentEmail && !data.parentMemberId) {
    return NextResponse.json(
      { error: "inheritParentEmail requires parentMemberId" },
      { status: 422 }
    );
  }

  if (data.parentMemberId) {
    parentMember = await prisma.member.findUnique({
      where: { id: data.parentMemberId },
      select: { id: true, ageTier: true, inheritEmailFromId: true },
    });

    if (!parentMember) {
      return NextResponse.json({ error: "Parent member not found" }, { status: 404 });
    }

    if (parentMember.ageTier !== "ADULT") {
      return NextResponse.json(
        { error: "Dependents can only be created under adult members" },
        { status: 422 }
      );
    }
  }

  const resolvedInheritEmailFromId =
    requestedInheritEmailFromId ||
    (data.inheritParentEmail && parentMember
      ? parentMember.inheritEmailFromId || parentMember.id
      : null);

  if (resolvedInheritEmailFromId) {
    const validation = await validateInheritEmailSource({
      inheritEmailFromId: resolvedInheritEmailFromId,
    });
    if (!validation.ok) {
      return NextResponse.json(
        { error: validation.error },
        { status: validation.status }
      );
    }
  }

  // Determine age tier from DOB if provided, otherwise use explicit value or default
  let ageTier = data.ageTier || "ADULT";
  let dateOfBirth: Date | null = null;
  let joinedDate: Date | null = null;
  if (data.dateOfBirth) {
    dateOfBirth = new Date(data.dateOfBirth);
    if (isNaN(dateOfBirth.getTime())) {
      return NextResponse.json({ error: "Invalid date of birth" }, { status: 422 });
    }
    ageTier = await computeAgeTier(dateOfBirth, getSeasonStartDate(getSeasonYear()));
  }
  if (data.joinedDate && data.joinedDate !== "") {
    joinedDate = new Date(data.joinedDate);
    if (isNaN(joinedDate.getTime())) {
      return NextResponse.json({ error: "Invalid joined date" }, { status: 422 });
    }
  }

  // Determine canLogin: explicit if provided, otherwise adult members without a parent can log in
  const canLogin =
    data.canLogin !== undefined
      ? data.canLogin
      : data.parentMemberId
        ? false
        : ageTier === "ADULT";

  if (data.sendInvite && !canLogin) {
    return NextResponse.json(
      { error: "Setup invites can only be sent to members who can log in" },
      { status: 422 }
    );
  }

  // Check for existing member with same email that can login
  if (canLogin) {
    const existing = await prisma.member.findFirst({ where: { email, canLogin: true } });
    if (existing) {
      return NextResponse.json(
        { error: "A member with this email already exists" },
        { status: 409 }
      );
    }
  }

  // Random unguessable password
  const placeholderHash = await hash(randomBytes(32).toString("hex"), 13);

  const postalAddress = data.postalSameAsPhysical
    ? copyStreetAddressToPostal({
        streetAddressLine1: data.streetAddressLine1,
        streetAddressLine2: data.streetAddressLine2,
        streetCity: data.streetCity,
        streetRegion: data.streetRegion,
        streetPostalCode: data.streetPostalCode,
        streetCountry: data.streetCountry,
      })
    : {
        postalAddressLine1: data.postalAddressLine1,
        postalAddressLine2: data.postalAddressLine2,
        postalCity: data.postalCity,
        postalRegion: data.postalRegion,
        postalPostalCode: data.postalPostalCode,
        postalCountry: data.postalCountry,
      };

  try {
    const member = await prisma.$transaction(async (tx) => {
      const created = await tx.member.create({
        data: {
          email,
          firstName: data.firstName.trim(),
          lastName: data.lastName.trim(),
          phoneCountryCode: data.phoneCountryCode?.trim() || null,
          phoneAreaCode: data.phoneAreaCode?.trim() || null,
          phoneNumber: data.phoneNumber?.trim() || null,
          dateOfBirth,
          role: data.role,
          financeAccessLevel: data.financeAccessLevel,
          ageTier: ageTier as AgeTier,
          active: data.active,
          canLogin,
          parentMemberId: data.parentMemberId?.trim() || null,
          inheritParentEmail: data.inheritParentEmail ?? Boolean(data.parentMemberId),
          inheritEmailFromId: resolvedInheritEmailFromId,
          passwordHash: placeholderHash,
          emailVerified: !canLogin, // Non-login members don't need verification
          joinedDate,
          streetAddressLine1: data.streetAddressLine1?.trim() || null,
          streetAddressLine2: data.streetAddressLine2?.trim() || null,
          streetCity: data.streetCity?.trim() || null,
          streetRegion: data.streetRegion?.trim() || null,
          streetPostalCode: data.streetPostalCode?.trim() || null,
          streetCountry: data.streetCountry?.trim() || null,
          postalAddressLine1: postalAddress.postalAddressLine1?.trim() || null,
          postalAddressLine2: postalAddress.postalAddressLine2?.trim() || null,
          postalCity: postalAddress.postalCity?.trim() || null,
          postalRegion: postalAddress.postalRegion?.trim() || null,
          postalPostalCode: postalAddress.postalPostalCode?.trim() || null,
          postalCountry: postalAddress.postalCountry?.trim() || null,
        },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phoneCountryCode: true,
          phoneAreaCode: true,
          phoneNumber: true,
          dateOfBirth: true,
          role: true,
          financeAccessLevel: true,
          ageTier: true,
          active: true,
          canLogin: true,
          parentMemberId: true,
          inheritParentEmail: true,
          inheritEmailFromId: true,
          xeroContactId: true,
          joinedDate: true,
          createdAt: true,
        },
      });

      // Add to family groups if specified
      if (data.familyGroupIds && data.familyGroupIds.length > 0) {
        await tx.familyGroupMember.createMany({
          data: data.familyGroupIds.map((fgId) => ({
            memberId: created.id,
            familyGroupId: fgId,
          })),
          skipDuplicates: true,
        });
      }

      return created;
    });

    // Send invite email if requested
    let inviteWarning: string | undefined;
    if (data.sendInvite) {
      try {
        const { token, tokenHash } = issueActionToken();
        const expiresAt = getMemberSetupInviteExpiryDate();
        await prisma.passwordResetToken.create({
          data: { tokenHash, memberId: member.id, expiresAt },
        });
        await sendMemberSetupInviteEmail(member.email, member.firstName, token);
      } catch (emailErr) {
        logger.error({ err: emailErr, memberId: member.id }, "Failed to send invite email");
        inviteWarning = `Member created but invite email failed to send: ${emailErr instanceof Error ? emailErr.message : String(emailErr)}`;
      }
    }

    const warnings = [inviteWarning].filter(Boolean);
    return NextResponse.json(
      { ...member, ...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}) },
      { status: 201 },
    );
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      return NextResponse.json(
        { error: "A member with this email already exists" },
        { status: 409 }
      );
    }

    logger.error({ err: error }, "Failed to create member");
    return NextResponse.json({ error: "Failed to create member" }, { status: 500 });
  }
}
