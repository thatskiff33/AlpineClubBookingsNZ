import { z } from "zod";
import { AGE_TIER_VALUES, ageTierEnum } from "@/lib/age-tier-schema";
import { genderEnum, titleEnum } from "@/lib/member-enums-schema";
import type { AgeTier, Prisma } from "@prisma/client";
import { hash } from "bcryptjs";
import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import {
  computeAgeTier,
  getAgeTierSettings,
  getSeasonStartDate,
} from "@/lib/age-tier";
import {
  getXeroContactGroupMemberships,
  getXeroContactIdsForGroup,
} from "@/lib/xero";
import { sendMemberSetupInviteEmail } from "@/lib/email";
import {
  dateOnlyInstantOf,
  fixedClubClock,
  parseCalendarDate,
} from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { clubSeasonYear } from "@/lib/financial-year";
import { UNASSIGNED_MEMBERSHIP_TYPE_VALUE } from "@/lib/membership-type-filter";
import {
  effectiveSubscriptionBehavior,
  isSubscriptionNotRequiredForMembershipType,
  membershipTypeAgeExemption,
} from "@/lib/membership-types";
import logger from "@/lib/logger";
import {
  describeUniqueConstraintTarget,
  isPrismaUniqueConstraintError,
} from "@/lib/prisma-errors";
import { getXeroApiErrorInfo } from "@/lib/xero-api-errors";
import { copyStreetAddressToPostal } from "@/lib/member-address";
import {
  unreachableMemberWhere,
  usableEmailSourceWhere,
  validateInheritEmailSource,
} from "@/lib/member-email-inheritance";
import {
  isLoginEmailUniqueConflict,
  MEMBER_LOGIN_EMAIL_TAKEN_MESSAGE,
} from "@/lib/member-email";
import {
  buildParentLinks,
  NO_INHERITABLE_EMAIL_SOURCE_MESSAGE,
  resolveInheritedEmailSourceId,
} from "@/lib/member-parent-links";
import {
  allowedParentAncestorGenerations,
  ancestorDepthWithinWhere,
  describeChildSideDepth,
  describeParentSideDepth,
  exceedsFamilyLinkGenerationLimit,
  FAMILY_LINK_GENERATION_LIMIT_ERROR,
  type ParentSideDepth,
} from "@/lib/member-family-link-depth";
import {
  DEPENDENT_LINK_CANDIDATE_SELECT,
  DEPENDENT_LINK_INELIGIBILITY_EXPLANATIONS,
  DEPENDENT_PARENT_CREATE_ERRORS,
  DEPENDENT_PARENT_STATE_SELECT,
  dependentLinkBlockers,
  dependentLinkCandidateWhere,
  dependentParentEligibleWhere,
  dependentParentStateBlocker,
  type DependentLinkIneligibleMatch,
} from "@/lib/dependent-link-eligibility";
import { isXeroLiveMemberGroupLookupsEnabled } from "@/lib/xero-feature-flags";
import { getMemberSetupInviteExpiryDate } from "@/lib/member-setup-invite";
import { ensureDefaultSeasonSubscriptionForNewMember } from "@/lib/member-subscription-defaults";
import { ensureMemberAccessRoles } from "@/lib/member-access-role-writes";
import { issueActionToken } from "@/lib/action-tokens";
import { hasMemberCompletedAccountSetup } from "@/lib/password-reset";
import { nameField } from "@/lib/zod-helpers";
import {
  NON_MEMBER_ROLE_VALUES,
  OPERATIONAL_ROLE_VALUES,
  ROLE_VALUES,
  isRole,
} from "@/lib/member-roles";
import {
  accessRoleChangeRequiresFullAdmin,
  accessRolesFromCompatibilityFields,
  isFullAdmin,
  legacyRoleFromAccessRoles,
  normalizeAssignableAccessRoleTokens,
  resolveAccessRoleTokens,
  isAccessRole,
  type AccessRoleInput,
} from "@/lib/access-roles";
import {
  accessRoleAssignmentRowsFromTokens,
  findUnknownAccessRoleTokens,
  loadAccessRoleDefinitions,
  MEMBER_ACCESS_ROLE_SELECT,
} from "@/lib/access-role-definitions";
import {
  financeAccessLevelFromMatrix,
  getAdminPermissionMatrix,
} from "@/lib/admin-permissions";
import { getMemberLoginStageSortRank } from "@/lib/member-login-stage";
import { isDeletedAccountRecord } from "@/lib/deleted-account";

const maxStr = (len: number) => z.string().max(len).optional().nullable();

type JsonRouteResult = {
  body: unknown;
  init?: ResponseInit;
};

function jsonResult(body: unknown, init?: ResponseInit): JsonRouteResult {
  return { body, init };
}

const optionalSearchParam = z.string().optional();

function parseClampedInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = parseInt(value || String(fallback), 10) || fallback;
  return Math.min(max, Math.max(min, parsed));
}

export const createMemberSchema = z.object({
  email: z.string().email("Invalid email address"),
  title: titleEnum.optional().nullable(),
  firstName: nameField({ required: "First name is required" }),
  lastName: nameField({ required: "Last name is required" }),
  gender: genderEnum.optional().nullable(),
  occupation: z.string().max(100).optional().nullable().or(z.literal("")),
  phoneCountryCode: z.string().max(5).optional().nullable(),
  phoneAreaCode: z.string().max(5).optional().nullable(),
  phoneNumber: z.string().max(15).optional().nullable(),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format")
    .optional()
    .nullable(),
  role: z
    .enum(ROLE_VALUES)
    .default("USER"),
  financeAccessLevel: z.enum(["NONE", "VIEWER", "MANAGER"]).default("NONE"),
  // Role tokens: enum values for system roles/seeded bundles, definition
  // ids for custom roles. Validated against the definitions table on write.
  accessRoles: z.array(z.string().trim().min(1).max(120)).optional(),
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
  lifeMemberDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format")
    .optional()
    .nullable()
    .or(z.literal("")),
  comments: z.string().max(4000).optional().nullable().or(z.literal("")),
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

const SORT_BY_WHITELIST = [
  "name",
  "email",
  "access",
  "ageTier",
  "active",
  "createdAt",
] as const;
const SUBSCRIPTION_STATUS_FILTERS = [
  "PAID",
  "UNPAID",
  "OVERDUE",
  "NOT_INVOICED",
] as const;
/**
 * How many excluded matches the dependant-link search explains when it finds no
 * eligible candidate (#2254). Enough to name the person the admin was looking
 * for, small enough that the extra query stays trivial.
 */
const DEPENDENT_LINK_INELIGIBLE_EXPLANATION_LIMIT = 5;

const MEMBER_LIFECYCLE_STATUS_FILTERS = [
  "active",
  "inactive",
  "cancelled",
  "archived",
  "all",
] as const;

export const adminMembersQuerySchema = z
  .object({
    q: optionalSearchParam,
    search: optionalSearchParam,
    page: optionalSearchParam,
    pageSize: optionalSearchParam,
    sortBy: optionalSearchParam,
    sortDir: optionalSearchParam,
    inheritEmailEligible: optionalSearchParam,
    excludeId: optionalSearchParam,
    dependentLinkEligibleFor: optionalSearchParam,
    parentLinkEligibleFor: optionalSearchParam,
    partnerLinkEligibleFor: optionalSearchParam,
    role: optionalSearchParam,
    financeAccess: optionalSearchParam,
    lifecycleStatus: optionalSearchParam,
    includeArchived: optionalSearchParam,
    active: optionalSearchParam,
    ageTier: optionalSearchParam,
    ageTierIn: optionalSearchParam,
    membershipType: optionalSearchParam,
    xeroLinked: optionalSearchParam,
    contactability: optionalSearchParam,
    inviteStatus: optionalSearchParam,
    subscription: optionalSearchParam,
    familyGroup: optionalSearchParam,
    xeroContactGroup: optionalSearchParam,
  })
  .transform((value) => {
    const q = value.q || value.search || undefined;
    const sortByRaw = value.sortBy || "name";
    return {
      ...value,
      trimmedQuery: q?.trim(),
      page: parseClampedInt(value.page, 1, 1, Number.MAX_SAFE_INTEGER),
      pageSize: parseClampedInt(value.pageSize, 25, 1, 100),
      sortBy: (SORT_BY_WHITELIST as readonly string[]).includes(sortByRaw)
        ? sortByRaw
        : "name",
      sortDir: value.sortDir === "desc" ? "desc" : "asc",
      inheritEmailEligible: value.inheritEmailEligible === "true",
      includeArchived: value.includeArchived === "true",
    };
  });

export type AdminMembersQuery = z.infer<typeof adminMembersQuerySchema>;

export type CreateMemberInput = z.infer<typeof createMemberSchema>;

function resolveWriteAccessRoleTokens(input: {
  accessRoles?: string[] | null;
  role?: string | null;
  financeAccessLevel?: string | null;
  canLogin?: boolean | null;
}): string[] {
  if (input.accessRoles) {
    return normalizeAssignableAccessRoleTokens(input.accessRoles, {
      canLogin: input.canLogin,
    });
  }

  return accessRolesFromCompatibilityFields({
    role: input.role,
    financeAccessLevel: input.financeAccessLevel,
    canLogin: input.canLogin,
  });
}

export async function listAdminMembers(
  query: AdminMembersQuery,
): Promise<JsonRouteResult> {
  const {
    trimmedQuery,
    page,
    pageSize,
    sortBy,
    sortDir,
    inheritEmailEligible,
    excludeId,
    dependentLinkEligibleFor,
    parentLinkEligibleFor,
    partnerLinkEligibleFor,
    role: roleFilter,
    financeAccess: financeAccessFilter,
    lifecycleStatus: lifecycleStatusFilter,
    includeArchived,
    active: activeFilter,
    ageTier: ageTierFilter,
    ageTierIn: ageTierInFilter,
    membershipType: membershipTypeFilter,
    xeroLinked: xeroLinkedFilter,
    contactability: contactabilityFilter,
    inviteStatus: inviteStatusFilter,
    subscription: subscriptionFilter,
    familyGroup: familyGroupFilter,
    xeroContactGroup: xeroContactGroupFilter,
  } = query;

  // Build orderBy
  let orderBy: Record<string, string>[] | Record<string, string>;
  switch (sortBy) {
    case "name":
      orderBy = [{ lastName: sortDir }, { firstName: sortDir }];
      break;
    case "email":
      orderBy = { email: sortDir };
      break;
    case "access":
      // Access is a derived four-stage login journey, so its page order is
      // resolved below from the same fields as getMemberLoginStage. Never use
      // hidden role as a proxy for the status the header announces.
      orderBy = [{ lastName: "asc" }, { firstName: "asc" }];
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
  // The season the club is in AT `now`, from the club's PERSISTED zone rather
  // than the container's month (INV-CONFIG-002). `now` is pinned so the whole
  // listing is judged against one moment.
  const currentSeasonYear = clubSeasonYear(
    await readClubTimeZoneOutsideRequest(),
    fixedClubClock(now),
  );
  const ageTierSettings = await getAgeTierSettings();
  const notRequiredAgeTiers = new Set(
    ageTierSettings
      .filter((setting) => setting.subscriptionRequiredForBooking === false)
      .map((setting) => setting.tier),
  );
  // #2149: the SQL exempt-filter must derive from the SAME source as the
  // displayed flag, so it cannot key off role alone. Membership type is the
  // authority: a member is exempt when their assigned season type is NOT_REQUIRED,
  // OR — with no season assignment — their role's DEFAULT built-in type is
  // NOT_REQUIRED (the role→default-type fallback the resolver applies). Roles
  // whose default type is NOT_REQUIRED are exactly OPERATIONAL + NON_MEMBER
  // (ADMIN/LODGE/NON_MEMBER/SCHOOL); USER defaults to FULL (REQUIRED). Guarding
  // the role clause on "no assignment" is what stops a fee-paying admin (role
  // ADMIN with a REQUIRED assignment) from being wrongly filtered as exempt.
  const notRequiredSubscriptionConditions = [
    {
      AND: [
        {
          seasonalMembershipAssignments: {
            none: { seasonYear: currentSeasonYear },
          },
        },
        { role: { in: [...OPERATIONAL_ROLE_VALUES, ...NON_MEMBER_ROLE_VALUES] } },
      ],
    },
    {
      seasonalMembershipAssignments: {
        some: {
          seasonYear: currentSeasonYear,
          membershipType: { subscriptionBehavior: "NOT_REQUIRED" },
        },
      },
    },
    // #2041/#2149: mirror the displayed flag's row-dominance branch. A
    // BASED_ON_AGE_TIER assignment paired with a NOT_REQUIRED current-season
    // subscription row is exempt even when the member's age tier is
    // subscription-liable (the mid-season tier-promotion shape). This clause
    // matches `isSubscriptionNotRequiredForMembershipType`'s
    // `subscriptionBehavior === "BASED_ON_AGE_TIER" && hasNotRequiredSeasonRow`
    // branch exactly — the assignment gate is required because a bare NOT_REQUIRED
    // row does NOT exempt a REQUIRED type, and effective behavior is only
    // BASED_ON_AGE_TIER when a season assignment carries it (no role default does).
    {
      seasonalMembershipAssignments: {
        some: {
          seasonYear: currentSeasonYear,
          membershipType: { subscriptionBehavior: "BASED_ON_AGE_TIER" },
        },
      },
      subscriptions: {
        some: { seasonYear: currentSeasonYear, status: "NOT_REQUIRED" },
      },
    },
    ...(notRequiredAgeTiers.size > 0
      ? [{ ageTier: { in: Array.from(notRequiredAgeTiers) } }]
      : []),
  ];

  // Build where clause
  const where: Record<string, unknown> = {};
  const andConditions: Record<string, unknown>[] = [];

  // Text search. Held in a variable as well as pushed, because the
  // dependant-link diagnostic query below re-uses exactly this condition to
  // explain WHY a search that matched people returned no eligible candidates.
  const queryTerms = trimmedQuery?.split(/\s+/).filter(Boolean) ?? [];
  // Annotated rather than inferred: the diagnostic query below passes this
  // straight to Prisma as a `where`, and an inferred literal widens
  // `mode: "insensitive"` to `string`, which is not `Prisma.QueryMode`.
  const textSearchCondition: Prisma.MemberWhereInput | null = trimmedQuery
    ? {
        OR: [
          { id: { startsWith: trimmedQuery } },
          { firstName: { contains: trimmedQuery, mode: "insensitive" } },
          { lastName: { contains: trimmedQuery, mode: "insensitive" } },
          { email: { contains: trimmedQuery, mode: "insensitive" } },
          ...(queryTerms.length > 1
            ? [
                {
                  // Annotated because a spread inside a conditional does not
                  // carry the outer contextual type into the callback.
                  AND: queryTerms.map(
                    (term): Prisma.MemberWhereInput => ({
                      OR: [
                        { firstName: { contains: term, mode: "insensitive" } },
                        { lastName: { contains: term, mode: "insensitive" } },
                        { email: { contains: term, mode: "insensitive" } },
                      ],
                    }),
                  ),
                },
              ]
            : []),
        ],
      }
    : null;
  if (textSearchCondition) {
    andConditions.push(textSearchCondition);
  }

  if (inheritEmailEligible) {
    // #2255 (D9): the two parent-column clauses are gone. They mirrored
    // `validateInheritEmailSource`'s old "must point to a primary adult member"
    // rule, which the four-generation model retires — the nearest ancestor with
    // a real mailbox is routinely a MIDDLE generation, an adult who is both
    // someone's child and someone's parent. Keeping them here would have left
    // the picker unable to offer the very source the write route now accepts.
    // The guarantees that matter are unchanged and still mirrored exactly: the
    // source is an ADULT, it is TERMINAL (does not itself inherit), and — added
    // with the check that made it load-bearing — it has a REAL address. Without
    // the last clause the picker offers walk-in placeholder contacts that
    // `validateInheritEmailSource` now 422s on, which is the same
    // search-offers-what-the-write-refuses drift #2254 existed to close.
    //
    // #2716: the clauses are no longer restated here at all. They come from
    // `usableEmailSourceWhere`, the SQL half of the one predicate every
    // resolution, validation and sweep applies, so the picker offers exactly the
    // members the write route accepts and cannot drift from it again. Restating
    // them had already gone wrong quietly: this list tested the age tier, the
    // terminality and the placeholder domains but NOT `archivedAt`, so the
    // picker offered archived members that `validateInheritEmailSource` refuses.
    andConditions.push(...usableEmailSourceWhere());
  }

  if (excludeId) {
    andConditions.push({ id: { not: excludeId } });
  }

  // Dependant-link candidates (#2254): the SQL half of the shared eligibility
  // predicate, so this search and the write route
  // (POST /api/admin/members/[id]/dependents/link) cannot drift apart again.
  // See src/lib/dependent-link-eligibility.ts for the NULL-semantics and
  // active/archived reasoning.
  //
  // #2255: the depth cap and the ancestor exclusion both depend on the PARENT's
  // own chain, so that one walk happens here and is reused by the diagnostic
  // pass below rather than being recomputed per candidate.
  let dependentLinkParentSide: ParentSideDepth | null = null;
  if (dependentLinkEligibleFor) {
    dependentLinkParentSide = await describeParentSideDepth(
      prisma,
      dependentLinkEligibleFor,
    );
    andConditions.push(
      ...dependentLinkCandidateWhere(dependentLinkEligibleFor, {
        parentAncestorIds: dependentLinkParentSide.ancestorIds,
        parentAncestorGenerations: dependentLinkParentSide.ancestorGenerations,
      }),
    );
  }

  if (parentLinkEligibleFor) {
    const target = await prisma.member.findUnique({
      where: { id: parentLinkEligibleFor },
      select: { parentMemberId: true, secondaryParentId: true },
    });
    // #2255: the mirror-image constraint. Here the SEARCHED-FOR member becomes
    // the parent, so it is the member's own dependant chain that eats into the
    // cap, and the candidate's ANCESTOR chain that must fit in what is left.
    // The member's descendants are excluded outright: with the old
    // "no dependants" clause gone they are no longer incidentally filtered, and
    // offering one would be offering a cycle the write route then refuses.
    const childSide = await describeChildSideDepth(prisma, parentLinkEligibleFor);
    const excludedParentIds = [
      parentLinkEligibleFor,
      target?.parentMemberId,
      target?.secondaryParentId,
      ...childSide.descendantIds,
    ].filter((memberId): memberId is string => Boolean(memberId));
    // #2282: `{ ageTier: "ADULT" }` is GONE from this filter. Recording that a
    // 16 or 17 year old is a parent is a fact about the family, and the search
    // must offer exactly what `POST /api/admin/members/[id]/dependents/link`
    // accepts (the #2254 no-drift rule). Both halves of what the route DOES
    // still refuse come from one place — `dependentParentEligibleWhere`, the SQL
    // mirror of `dependentParentStateBlocker` — so this search cannot drift from
    // the write again. It adds `archivedAt: null`, which the route always
    // refused and this search never filtered, and it keeps organisation/school
    // accounts out by ROLE: the old ADULT clause excluded them as a side
    // effect, and without a replacement the dialog offered a school as a
    // candidate PARENT and the route accepted it. By role and not by
    // `ageTier: NOT_APPLICABLE`, which age-exempt HUMAN members carry too.
    andConditions.push(
      { id: { notIn: excludedParentIds } },
      ancestorDepthWithinWhere(
        allowedParentAncestorGenerations(childSide.descendantGenerations),
      ),
      ...dependentParentEligibleWhere(),
    );
  }

  // Partner-link assignment candidates (#1742): active adults other than the
  // member, excluding anyone who already has a CONFIRMED partner (one
  // confirmed partner per member).
  if (partnerLinkEligibleFor) {
    andConditions.push(
      { id: { not: partnerLinkEligibleFor } },
      { active: true },
      { ageTier: "ADULT" },
      { partnerLinksAsMemberA: { none: { status: "CONFIRMED" } } },
      { partnerLinksAsMemberB: { none: { status: "CONFIRMED" } } },
    );
  }

  // Filter: access role, with legacy Role values still accepted for old links.
  if (isAccessRole(roleFilter)) {
    const legacyFallbackConditions: Record<string, unknown>[] = [];
    if (roleFilter === "USER") {
      legacyFallbackConditions.push({ role: "USER" });
    } else if (roleFilter === "ADMIN" || roleFilter === "LODGE") {
      legacyFallbackConditions.push({ role: roleFilter });
    } else if (roleFilter === "FINANCE_USER") {
      legacyFallbackConditions.push({ financeAccessLevel: "VIEWER" });
    } else if (roleFilter === "FINANCE_ADMIN") {
      legacyFallbackConditions.push({ financeAccessLevel: "MANAGER" });
    } else if (roleFilter === "ORG") {
      legacyFallbackConditions.push({ role: "SCHOOL", canLogin: true });
    }

    andConditions.push({
      OR: [
        { accessRoles: { some: { role: roleFilter } } },
        ...legacyFallbackConditions,
      ],
    });
  } else if (isRole(roleFilter)) {
    andConditions.push({ role: roleFilter });
  } else if (roleFilter) {
    // Custom definition-backed role token (definition id).
    andConditions.push({
      accessRoles: { some: { roleDefinitionId: roleFilter } },
    });
  }

  if (
    financeAccessFilter &&
    ["NONE", "VIEWER", "MANAGER"].includes(financeAccessFilter)
  ) {
    andConditions.push({ financeAccessLevel: financeAccessFilter });
  }

  const lifecycleStatus =
    lifecycleStatusFilter &&
    (MEMBER_LIFECYCLE_STATUS_FILTERS as readonly string[]).includes(
      lifecycleStatusFilter,
    )
      ? lifecycleStatusFilter
      : null;
  if (lifecycleStatus === "archived") {
    where.archivedAt = { not: null };
  } else if (lifecycleStatus !== "all" && !includeArchived) {
    where.archivedAt = null;
  }

  if (lifecycleStatus === "active") {
    andConditions.push({ active: true }, { cancelledAt: null });
  } else if (lifecycleStatus === "inactive") {
    andConditions.push({ active: false }, { cancelledAt: null });
  } else if (lifecycleStatus === "cancelled") {
    andConditions.push({ cancelledAt: { not: null } });
  }

  // Filter: active (legacy query param retained for existing links)
  if (!lifecycleStatus) {
    if (activeFilter === "true") {
      andConditions.push({ active: true });
    } else if (activeFilter === "false") {
      andConditions.push({ active: false });
    }
  }

  // Filter: ageTier
  if (
    ageTierFilter &&
    AGE_TIER_VALUES.includes(ageTierFilter as (typeof AGE_TIER_VALUES)[number])
  ) {
    andConditions.push({ ageTier: ageTierFilter });
  } else {
    const ageTierIn = ageTierInFilter
      ?.split(",")
      .map((tier) => tier.trim())
      .filter((tier): tier is (typeof AGE_TIER_VALUES)[number] =>
        AGE_TIER_VALUES.includes(tier as (typeof AGE_TIER_VALUES)[number]),
      );

    if (ageTierIn && ageTierIn.length > 0) {
      andConditions.push({ ageTier: { in: ageTierIn } });
    }
  }

  // Filter: membership type (current-season SeasonalMembershipAssignment). The
  // "UNASSIGNED" sentinel matches members with no current-season assignment;
  // any other value is a MembershipType id. This mirrors how
  // currentMembershipType is resolved below (the current-season assignment), so
  // the filter and the displayed Type–Tier column always agree.
  if (membershipTypeFilter === UNASSIGNED_MEMBERSHIP_TYPE_VALUE) {
    andConditions.push({
      seasonalMembershipAssignments: {
        none: { seasonYear: currentSeasonYear },
      },
    });
  } else if (membershipTypeFilter) {
    andConditions.push({
      seasonalMembershipAssignments: {
        some: {
          seasonYear: currentSeasonYear,
          membershipTypeId: membershipTypeFilter,
        },
      },
    });
  }

  // Filter: xeroLinked
  if (xeroLinkedFilter === "true") {
    andConditions.push({ xeroContactId: { not: null } });
  } else if (xeroLinkedFilter === "false") {
    andConditions.push({ xeroContactId: null });
  }

  // Filter: contactability (#2716) — the admin-visible half of the
  // direct-parent inheritance rule.
  //
  // Narrowing inheritance to one hop has an accepted cost: where a middle
  // generation has no address, the descendant now inherits nobody and the club
  // has to ask for one. That is the right failure direction only if somebody can
  // FIND those members, so this filter is part of the deliverable rather than a
  // convenience. `unreachableMemberWhere` is the single definition of who
  // qualifies, shared with the stuck-states dashboard so the count on one screen
  // and the list on the other can never disagree.
  if (contactabilityFilter === "unreachable") {
    andConditions.push(unreachableMemberWhere());
  } else if (contactabilityFilter === "inheritance-unresolved") {
    andConditions.push(unreachableMemberWhere("inheritance-unresolved"));
  } else if (contactabilityFilter === "placeholder-address") {
    andConditions.push(unreachableMemberWhere("placeholder-address"));
  }

  // Filter: login access stage. This mirrors the single Access-column stage the
  // members table shows (getMemberLoginStage) and the row action button. The
  // four values are mutually exclusive: no-login (canLogin off), invite (login
  // on, not yet invited), resend-invite (pending unexpired invite), and
  // reset-password (setup complete).
  const activePendingInviteFilter = {
    used: false,
    expiresAt: { gt: now },
  };
  if (inviteStatusFilter === "no-login") {
    andConditions.push({ canLogin: false });
  } else if (inviteStatusFilter === "invite") {
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
  if (subscriptionFilter === "NOT_REQUIRED") {
    andConditions.push({ OR: notRequiredSubscriptionConditions });
  } else if (subscriptionFilter === "NONE") {
    // #2149: no separate role exclusion — the NOT_REQUIRED conditions above now
    // exempt bare operational/non-member accounts via the assignment-aware
    // fallback, so a fee-paying admin (REQUIRED assignment) correctly stays in
    // the owing set instead of being dropped by a blanket role filter.
    andConditions.push(
      { NOT: { OR: notRequiredSubscriptionConditions } },
      {
        subscriptions: { none: { seasonYear: currentSeasonYear } },
      },
    );
  } else if (
    subscriptionFilter &&
    (SUBSCRIPTION_STATUS_FILTERS as readonly string[]).includes(
      subscriptionFilter,
    )
  ) {
    andConditions.push(
      { NOT: { OR: notRequiredSubscriptionConditions } },
      {
        subscriptions: {
          some: { seasonYear: currentSeasonYear, status: subscriptionFilter },
        },
      },
    );
  }

  // Filter: family group (via join table)
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
  const liveMemberGroupLookupsEnabled = isXeroLiveMemberGroupLookupsEnabled();
  if (
    liveMemberGroupLookupsEnabled &&
    xeroContactGroupFilter &&
    xeroContactGroupFilter !== "all"
  ) {
    try {
      const groupContactIds = await getXeroContactIdsForGroup(
        xeroContactGroupFilter,
      );
      if (groupContactIds.length > 0) {
        andConditions.push({ xeroContactId: { in: groupContactIds } });
      } else {
        // Group has no contacts — force empty result
        andConditions.push({ xeroContactId: { in: [] } });
      }
    } catch (error) {
      logger.error(
        { err: error, groupId: xeroContactGroupFilter },
        "Failed to fetch Xero contact group members for filter",
      );
      // Fall through — don't apply this filter if Xero call fails
    }
  }

  if (andConditions.length > 0) {
    where.AND = andConditions;
  }

  const select = {
    id: true,
    title: true,
    firstName: true,
    lastName: true,
    gender: true,
    occupation: true,
    email: true,
    phoneCountryCode: true,
    phoneAreaCode: true,
    phoneNumber: true,
    dateOfBirth: true,
    role: true,
    financeAccessLevel: true,
    accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
    ageTier: true,
    active: true,
    canLogin: true,
    cancelledAt: true,
    cancelledReason: true,
    archivedAt: true,
    archivedReason: true,
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
    lifeMemberDate: true,
    comments: true,
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
    seasonalMembershipAssignments: {
      where: { seasonYear: currentSeasonYear },
      select: {
        membershipType: {
          select: {
            id: true,
            key: true,
            name: true,
            isActive: true,
            subscriptionBehavior: true,
            // #2106: drives the edit dialog's N/A age-tier control.
            allowedAgeTiers: { select: { ageTier: true } },
          },
        },
      },
      take: 1,
    },
    passwordResetTokens: {
      where: activePendingInviteFilter,
      orderBy: { createdAt: "desc" as const },
      take: 1,
      select: { expiresAt: true, used: true },
    },
  };

  const skip = (page - 1) * pageSize;

  // #2425: the parent picker lists ADULTS FIRST. This is a PRESENTATION rule and
  // nothing else — the `where` both halves run against is the same eligibility
  // predicate assembled above, so every candidate the search offered before is
  // still offered, at the same page size, and the write route's contract (the
  // #2254 no-drift rule) is untouched. #2282 removed the adults-only clause
  // because a 16 or 17 year old can genuinely be a parent; the side effect was
  // that a surname shared by a family put the CHILDREN — sorted by the same
  // lastName/firstName order — in every one of the eight slots before the adult
  // the admin was actually looking for, who was then unreachable without extra
  // typing they had no way of knowing was needed.
  //
  // Two complementary queries rather than one, because the ranking cannot be
  // expressed as an `orderBy`: Prisma has no computed sort key, and sorting on
  // `ageTier` itself would depend on the enum's DECLARATION order. Splitting the
  // set in two and concatenating is exact, and stays correct for pages beyond
  // the first — the picker only ever asks for page 1, but this endpoint is a
  // general list API and a ranking that silently reshuffled on page 2 would drop
  // and duplicate rows.
  //
  // The line is drawn at "is this candidate a MINOR", not at "is this candidate
  // an ADULT" (#2425 review). `NOT_APPLICABLE` is the age-EXEMPT tier, not the
  // organisation tier: `resolveEnforcedAgeTier` gives it to a real person on a
  // FORCED membership type, and preserves an admin's hand-picked N/A while the
  // type ALLOWS it (`src/lib/age-tier-enforcement.ts`, #1440/#2106). Since the
  // picker excludes organisations by ROLE and never by tier
  // (`dependentParentEligibleWhere`), every N/A row that reaches this ranking is
  // one of those age-exempt PEOPLE — an honorary or life member, typically an
  // adult — and ranking them below the household's children would leave them
  // crowded off exactly the page this issue exists to fix. They join the top
  // block instead, where they sort among the adults by name; nothing here
  // claims they ARE adults, only that they are not minors.
  const NON_MINOR_AGE_TIERS: AgeTier[] = ["ADULT", "NOT_APPLICABLE"];
  async function findParentLinkCandidatesNonMinorsFirst() {
    const rankedWhere = (ageClause: Prisma.MemberWhereInput) => ({
      ...where,
      AND: [...andConditions, ageClause],
    });
    // `in` / `notIn` are exact complements here because `Member.ageTier` is NOT
    // NULL (`prisma/schema.prisma`, `AgeTier @default(ADULT)`), so every
    // eligible row lands in exactly one half and the two together are the same
    // set — and the same count — an unranked query would return.
    const nonMinorClause: Prisma.MemberWhereInput = {
      ageTier: { in: NON_MINOR_AGE_TIERS },
    };
    const minorClause: Prisma.MemberWhereInput = {
      ageTier: { notIn: NON_MINOR_AGE_TIERS },
    };
    // Page 1 needs no boundary: the top block starts at row 0. A deeper page has
    // to know where that block ENDS before it can slice across it, and only then
    // is the extra count worth issuing.
    const nonMinorTotal =
      skip > 0
        ? await prisma.member.count({ where: rankedWhere(nonMinorClause) })
        : null;
    const nonMinors =
      nonMinorTotal === null || skip < nonMinorTotal
        ? await prisma.member.findMany({
            where: rankedWhere(nonMinorClause),
            orderBy,
            select,
            skip,
            take: pageSize,
          })
        : [];
    if (nonMinors.length >= pageSize) return nonMinors;
    const minors = await prisma.member.findMany({
      where: rankedWhere(minorClause),
      orderBy,
      select,
      // Once the top block is exhausted the remainder of the window continues
      // into the minors, so the offset is whatever the window overshot it by
      // (zero whenever the page started inside the top block).
      skip: nonMinorTotal === null ? 0 : Math.max(0, skip - nonMinorTotal),
      take: pageSize - nonMinors.length,
    });
    return [...nonMinors, ...minors];
  }

  let members;
  let total: number;
  if (sortBy === "access") {
    // Prisma cannot order by the existence of an active related invite token,
    // so resolve the lightweight status keys for the filtered cohort first,
    // rank them with the shared login-stage helper, then fetch only this page's
    // full rows. This keeps filtering and pagination server-side while making
    // the visible/announced Access order truthful.
    const accessCandidates = await prisma.member.findMany({
      where,
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
      select: {
        id: true,
        firstName: true,
        lastName: true,
        canLogin: true,
        passwordChangedAt: true,
        lastLoginAt: true,
        passwordResetTokens: {
          where: activePendingInviteFilter,
          orderBy: { createdAt: "desc" as const },
          take: 1,
          select: { expiresAt: true },
        },
      },
    });
    const direction = sortDir === "asc" ? 1 : -1;
    accessCandidates.sort((left, right) => {
      const leftRank = getMemberLoginStageSortRank({
        canLogin: left.canLogin,
        hasCompletedAccountSetup: hasMemberCompletedAccountSetup(left),
        pendingInviteExpiresAt: left.passwordResetTokens[0]?.expiresAt ?? null,
      });
      const rightRank = getMemberLoginStageSortRank({
        canLogin: right.canLogin,
        hasCompletedAccountSetup: hasMemberCompletedAccountSetup(right),
        pendingInviteExpiresAt: right.passwordResetTokens[0]?.expiresAt ?? null,
      });
      if (leftRank !== rightRank) return (leftRank - rightRank) * direction;
      return (
        left.lastName.localeCompare(right.lastName) ||
        left.firstName.localeCompare(right.firstName) ||
        left.id.localeCompare(right.id)
      );
    });
    total = accessCandidates.length;
    const pageIds = accessCandidates
      .slice(skip, skip + pageSize)
      .map(({ id }) => id);
    const pageOrder = new Map(pageIds.map((id, index) => [id, index]));
    const unsortedMembers = pageIds.length
      ? await prisma.member.findMany({
          where: { AND: [where, { id: { in: pageIds } }] },
          orderBy,
          select,
        })
      : [];
    members = unsortedMembers.sort(
      (left, right) =>
        (pageOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (pageOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER),
    );
  } else {
    [members, total] = await Promise.all([
      parentLinkEligibleFor
        ? findParentLinkCandidatesNonMinorsFirst()
        : prisma.member.findMany({
            where,
            orderBy,
            select,
            skip,
            take: pageSize,
          }),
      prisma.member.count({ where }),
    ]);
  }

  // #2254: a dependant-link search that finds nobody eligible used to render a
  // bare "No eligible members found.", which told the admin nothing — and hid a
  // real bug for as long as it shipped. When the eligible set is empty, re-run
  // the SAME text search with the eligibility conditions (and the default
  // archived exclusion) lifted, and label each match with the first reason it
  // was excluded. Bounded to a handful of rows, and only ever runs on the
  // otherwise-empty result, so the normal search still costs two queries.
  let dependentLinkIneligible: DependentLinkIneligibleMatch[] | undefined;
  // Distinct from "the list is empty": the dialog may only say "No members
  // matched your search" when the text search really did match nobody. Sent
  // only when that is what happened.
  let dependentLinkSearchMatchedNobody: true | undefined;

  if (
    dependentLinkEligibleFor &&
    dependentLinkParentSide &&
    textSearchCondition &&
    total === 0
  ) {
    const parentSide = dependentLinkParentSide;
    const textMatches = await prisma.member.findMany({
      where: textSearchCondition,
      orderBy,
      take: DEPENDENT_LINK_INELIGIBLE_EXPLANATION_LIMIT,
      select: {
        ...DEPENDENT_LINK_CANDIDATE_SELECT,
        firstName: true,
        lastName: true,
        email: true,
      },
    });

    // #2255: depth is per-candidate, so each explained row needs its own
    // downward walk. Bounded to DEPENDENT_LINK_INELIGIBLE_EXPLANATION_LIMIT
    // rows on an already-empty result, which is the only path that reaches here.
    const candidateDepths = await Promise.all(
      textMatches.map((candidate) => describeChildSideDepth(prisma, candidate.id)),
    );

    const explained = textMatches.flatMap((candidate, index) => {
      const [reason] = dependentLinkBlockers(
        dependentLinkEligibleFor,
        candidate,
        {
          parentAncestorIds: parentSide.ancestorIds,
          parentAncestorGenerations: parentSide.ancestorGenerations,
          candidateDescendantGenerations:
            candidateDepths[index].descendantGenerations,
        },
      );
      if (!reason) return [];
      return [
        {
          id: candidate.id,
          firstName: candidate.firstName,
          lastName: candidate.lastName,
          email: candidate.email,
          reason,
          explanation: DEPENDENT_LINK_INELIGIBILITY_EXPLANATIONS[reason],
        },
      ];
    });

    // Never an empty array. `where` here is the text search alone; if a future
    // filter or a second caller ever made the two queries disagree, a match
    // could clear every blocker and be dropped by the flatMap, leaving a
    // present-but-empty key the dialog would read as "nobody matched".
    dependentLinkIneligible = explained.length > 0 ? explained : undefined;
    dependentLinkSearchMatchedNobody =
      textMatches.length === 0 ? true : undefined;
  }

  let xeroContactGroups: Record<
    string,
    Array<{ id: string; name: string }>
  > = {};
  const linkedContactIds = members
    .map((member) => member.xeroContactId)
    .filter(Boolean) as string[];
  let xeroContactGroupsLoaded = linkedContactIds.length === 0;

  if (linkedContactIds.length > 0) {
    try {
      xeroContactGroups =
        await getXeroContactGroupMemberships(linkedContactIds);
      xeroContactGroupsLoaded = linkedContactIds.every((contactId) =>
        Object.prototype.hasOwnProperty.call(xeroContactGroups, contactId),
      );
    } catch (error) {
      const xeroError = getXeroApiErrorInfo(
        error,
        "Failed to fetch Xero contact groups for members list",
      );
      if (!xeroError.handled) {
        logger.error(
          { err: error },
          "Failed to fetch Xero contact groups for members list",
        );
      }
    }
  }

  const membersWithSub = members.map((m) => {
    const hasCompletedAccountSetup = hasMemberCompletedAccountSetup(m);
    const latestToken = m.passwordResetTokens?.[0];
    const pendingInviteExpiresAt =
      !hasCompletedAccountSetup &&
      latestToken &&
      latestToken.expiresAt > now
        ? latestToken.expiresAt
        : null;
    const currentSeasonAssignment = m.seasonalMembershipAssignments?.[0] ?? null;
    const currentMembershipType = currentSeasonAssignment?.membershipType ?? null;
    // #2149: role carries no subscription exemption. Membership type is the sole
    // authority via the shared derivation: the assigned season type wins, else
    // the role→default-type fallback (so a bare ADMIN/LODGE account resolves to
    // its NOT_REQUIRED built-in type, while a fee-paying admin with a REQUIRED
    // assignment correctly owes a subscription). The current-season row (already
    // selected as m.subscriptions[0]) still lets a NOT_REQUIRED row dominate a
    // BASED_ON_AGE_TIER type after a mid-season tier promotion (#2041).
    const subscriptionNotRequired = isSubscriptionNotRequiredForMembershipType({
      subscriptionBehavior: effectiveSubscriptionBehavior(
        currentMembershipType?.subscriptionBehavior,
        m.role,
      ),
      ageTier: m.ageTier,
      notRequiredAgeTiers,
      hasNotRequiredSeasonRow: m.subscriptions?.[0]?.status === "NOT_REQUIRED",
    });

    return {
      ...m,
      accessRoles: resolveAccessRoleTokens(m),
      // #2620: a deletion-anonymised member is `active: false, cancelledAt: null`
      // — exactly the "inactive" lifecycle filter above — so without this flag an
      // erased account is indistinguishable in the list from a member someone
      // deactivated yesterday, and a multi-select Reactivate to undo a mistaken
      // bulk deactivate would sweep it up. Resolved from the email marker (the
      // password hash is deliberately NOT selected into a list response); the
      // predicate reads whichever markers are present, so it stays correct if the
      // select ever widens. The list badge is the visible warning; the refusals in
      // bulk update, member edit and the login providers are the enforcement.
      deletedAccount: isDeletedAccountRecord(m),
      subscriptionStatus:
        subscriptionNotRequired
          ? "NOT_REQUIRED"
          : (m.subscriptions[0]?.status ?? null),
      subscriptionXeroInvoiceId:
        m.subscriptions[0]?.xeroInvoiceId ?? null,
      currentMembershipType: currentMembershipType
        ? {
            id: currentMembershipType.id,
            key: currentMembershipType.key,
            name: currentMembershipType.name,
            isActive: currentMembershipType.isActive,
            // #2106: age-exemption so the edit dialog can force/allow/omit N/A.
            ageExemption: membershipTypeAgeExemption(
              (currentMembershipType.allowedAgeTiers ?? []).map(
                (tier) => tier.ageTier,
              ),
            ),
          }
        : null,
      familyGroups: m.familyGroupMemberships.map((fg) => ({
        id: fg.familyGroup.id,
        name: fg.familyGroup.name,
      })),
      parentLinks: buildParentLinks(m),
      subscriptions: undefined,
      seasonalMembershipAssignments: undefined,
      familyGroupMemberships: undefined,
      passwordResetTokens: undefined,
      passwordChangedAt: undefined,
      lastLoginAt: undefined,
      xeroContactGroupsLoaded,
      xeroContactGroups: m.xeroContactId
        ? (xeroContactGroups[m.xeroContactId] ?? [])
        : [],
      hasCompletedAccountSetup,
      pendingInviteExpiresAt,
    };
  });

  return jsonResult({
    members: membersWithSub,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
    // Only present for a dependant-link search that came back empty; omitted
    // from every other members-list response.
    ...(dependentLinkIneligible ? { dependentLinkIneligible } : {}),
    ...(dependentLinkSearchMatchedNobody
      ? { dependentLinkSearchMatchedNobody }
      : {}),
  });
}

export async function createAdminMember(
  data: CreateMemberInput,
  actor: { accessRoles: AccessRoleInput["accessRoles"] },
): Promise<JsonRouteResult> {
  // Full Admin gate (issue #1012): a scoped admin (e.g. membership:edit)
  // must not be able to mint a privileged account. Evaluated canLogin-blind
  // so a dormant elevated role cannot be parked for later activation.
  const requestedGrant =
    data.accessRoles !== undefined
      ? normalizeAssignableAccessRoleTokens(data.accessRoles, {
          canLogin: true,
        })
      : accessRolesFromCompatibilityFields({
          role: data.role,
          financeAccessLevel:
            data.role === "LODGE" ? "NONE" : data.financeAccessLevel,
          canLogin: true,
        });
  if (
    accessRoleChangeRequiresFullAdmin([], requestedGrant) &&
    !isFullAdmin({ accessRoles: actor.accessRoles })
  ) {
    return jsonResult(
      {
        error:
          "Only a Full Admin can create members with privileged access roles",
      },
      { status: 403 },
    );
  }

  const roleDefinitions = await loadAccessRoleDefinitions(prisma);
  if (data.accessRoles !== undefined) {
    const unknownTokens = findUnknownAccessRoleTokens(
      data.accessRoles,
      roleDefinitions,
    );
    if (unknownTokens.length > 0) {
      return jsonResult(
        { error: `Unknown access role: ${unknownTokens.join(", ")}` },
        { status: 400 },
      );
    }
  }

  const email = data.email.toLowerCase().trim();
  const requestedInheritEmailFromId = data.inheritEmailFromId?.trim() || null;
  // #2282: `ageTier` is deliberately absent. Nothing on the create path may
  // branch on the PARENT's age again — the email source that actually needs an
  // adult is resolved and validated separately below — so dropping the column
  // makes a re-introduced age gate a compile error rather than a review catch.
  // The one rule about WHO the parent is that survives — an organisation or
  // school account is not a person and cannot be a parent — is classified by
  // ROLE, not by the age-exempt `NOT_APPLICABLE` tier that age-exempt humans
  // also carry (#1440, #2106), and comes in through the shared select below.
  //
  // `inheritEmailFromId` is deliberately absent too (it was selected until
  // #2282's review). Nothing reads it any more — the one-hop
  // `parentMember.inheritEmailFromId || parentMember.id` it fed was replaced by
  // the transitive resolver — and leaving it selected invites a future one-hop
  // shortcut back in.
  let parentMember:
    | ({ id: string } & Prisma.MemberGetPayload<{
        select: typeof DEPENDENT_PARENT_STATE_SELECT;
      }>)
    | null = null;

  // Validate family group assignments
  if (data.familyGroupIds && data.familyGroupIds.length > 0) {
    const groups = await prisma.familyGroup.findMany({
      where: { id: { in: data.familyGroupIds } },
      select: { id: true },
    });
    if (groups.length !== data.familyGroupIds.length) {
      return jsonResult(
        { error: "One or more family groups not found" },
        { status: 404 },
      );
    }
  }

  if (data.inheritParentEmail && !data.parentMemberId) {
    return jsonResult(
      { error: "inheritParentEmail requires parentMemberId" },
      { status: 422 },
    );
  }

  if (data.parentMemberId) {
    parentMember = await prisma.member.findUnique({
      where: { id: data.parentMemberId },
      select: {
        id: true,
        ...DEPENDENT_PARENT_STATE_SELECT,
      },
    });

    if (!parentMember) {
      return jsonResult({ error: "Parent member not found" }, { status: 404 });
    }

    // #2282: the CREATE half of the same rule change as the link route. Age no
    // longer gates recording parentage; `active`/`archivedAt` still do, because
    // they say whether the record is current, and an organisation/school
    // account still cannot be a parent because it is an account, not a person.
    // Keep the two paths in step — this one and the link route were the two
    // different endpoints and two different messages behind the identical dead
    // end.
    const parentStateBlocker = dependentParentStateBlocker(parentMember);
    if (parentStateBlocker) {
      return jsonResult(
        { error: DEPENDENT_PARENT_CREATE_ERRORS[parentStateBlocker] },
        { status: 422 },
      );
    }

    // #2255: admin member-create is a parent-link WRITER too, and it was never
    // covered by the old "target already has dependants" guard because the
    // target does not exist yet. A brand-new member has no dependants, so only
    // the parent's own chain can breach the cap — but it can, and unchecked this
    // is the easiest way to create a fifth generation.
    //
    // READ COMMITTED CAVEAT, stated rather than hidden: this whole function
    // validates on the base client and only opens its transaction at the write,
    // so the walk and the insert see different snapshots. A concurrent link that
    // deepens the parent's chain between the two could let a fifth generation
    // through. The window is milliseconds and the outcome is a too-deep chain
    // rather than lost data or money, so it is accepted here rather than
    // restructuring an unrelated function; the routes that write links
    // interactively (the admin link route, the family-group reviewer, and
    // nomination approval) all walk inside their own transaction and have no
    // such window.
    const parentSide = await describeParentSideDepth(
      prisma,
      parentMember.id,
    );
    if (
      exceedsFamilyLinkGenerationLimit({
        parentAncestorGenerations: parentSide.ancestorGenerations,
        childDescendantGenerations: 0,
      })
    ) {
      return jsonResult(
        { error: FAMILY_LINK_GENERATION_LIMIT_ERROR },
        { status: 422 },
      );
    }
  }

  // #2255/#2716: `parentMember.inheritEmailFromId || parentMember.id` was a raw
  // column read, so creating a dependant under a parent whose only address is a
  // placeholder resolved to that placeholder and 422'd — while the link route,
  // given the same parent, answered differently. Two routes, same family, two
  // answers. Both now go through the shared resolver, which since #2716 answers
  // "that parent or nobody", and a parent with no address is refused with the
  // shared message rather than a misleading one.
  let resolvedInheritEmailFromId = requestedInheritEmailFromId;
  if (!resolvedInheritEmailFromId && data.inheritParentEmail && parentMember) {
    const resolution = await resolveInheritedEmailSourceId(
      prisma,
      parentMember.id,
    );
    if (!resolution.sourceId) {
      return jsonResult(
        { error: NO_INHERITABLE_EMAIL_SOURCE_MESSAGE },
        { status: 422 },
      );
    }
    resolvedInheritEmailFromId = resolution.sourceId;
  }

  if (resolvedInheritEmailFromId) {
    const validation = await validateInheritEmailSource({
      inheritEmailFromId: resolvedInheritEmailFromId,
    });
    if (!validation.ok) {
      return jsonResult(
        { error: validation.error },
        { status: validation.status },
      );
    }
  }

  // ONE read of the club's season for this whole create, resolved BEFORE the
  // transaction below opens (#2870, correctness review). The age tier and the
  // NOT_REQUIRED subscription row seeded inside that transaction must agree, and a
  // zone read from inside it would be an uncached query on the GLOBAL client while
  // the transaction holds a connection.
  const clubCurrentSeasonYear = clubSeasonYear(
    await readClubTimeZoneOutsideRequest(),
  );
  const clubCurrentSeasonStart = getSeasonStartDate(clubCurrentSeasonYear);
  // Determine age tier from DOB if provided, otherwise use explicit value or default
  let ageTier = data.ageTier || "ADULT";
  let dateOfBirth: Date | null = null;
  let joinedDate: Date | null = null;
  if (data.dateOfBirth) {
    // `parseCalendarDate`, not `new Date` + `isNaN` (#3082 fix round) — see the
    // same swap in `admin-member-detail-service.ts`. It matters more here: this
    // create defaults `canLogin` from the tier computed just below, so a rolled
    // or year-0 date could hand somebody a login off a band nobody chose.
    const day = parseCalendarDate(data.dateOfBirth);
    if (day === null) {
      return jsonResult({ error: "Invalid date of birth" }, { status: 422 });
    }
    dateOfBirth = dateOnlyInstantOf(day);
    ageTier = await computeAgeTier(dateOfBirth, clubCurrentSeasonStart);
  }
  // Organisation-type members have no age (#1440): force NOT_APPLICABLE for
  // ORG/SCHOOL accounts and refuse it on anyone else. requestedGrant is the
  // canLogin-blind token set resolved above.
  const isOrganisationMember =
    requestedGrant.includes("ORG") || data.role === "SCHOOL";
  if (isOrganisationMember) {
    ageTier = "NOT_APPLICABLE";
  } else if (ageTier === "NOT_APPLICABLE") {
    return jsonResult(
      {
        error:
          "The N/A age tier applies only to organisation and school accounts",
      },
      { status: 422 },
    );
  }
  if (data.joinedDate && data.joinedDate !== "") {
    joinedDate = new Date(data.joinedDate);
    if (isNaN(joinedDate.getTime())) {
      return jsonResult({ error: "Invalid joined date" }, { status: 422 });
    }
  }
  let lifeMemberDate: Date | null = null;
  if (data.lifeMemberDate && data.lifeMemberDate !== "") {
    lifeMemberDate = new Date(data.lifeMemberDate);
    if (isNaN(lifeMemberDate.getTime())) {
      return jsonResult({ error: "Invalid life member date" }, { status: 422 });
    }
  }
  // Determine canLogin: explicit if provided, otherwise adult members without a parent can log in
  const canLogin =
    data.canLogin !== undefined
      ? data.canLogin
      : data.parentMemberId
        ? false
        : ageTier === "ADULT";
  const accessRoles = resolveWriteAccessRoleTokens({
    accessRoles: data.accessRoles,
    role: data.role,
    financeAccessLevel: data.financeAccessLevel,
    canLogin,
  });
  const legacyRole =
    data.accessRoles !== undefined
      ? legacyRoleFromAccessRoles(accessRoles)
      : data.role;
  const financeAccessLevel =
    data.accessRoles !== undefined
      ? financeAccessLevelFromMatrix(
          getAdminPermissionMatrix({
            accessRoles: accessRoleAssignmentRowsFromTokens(
              accessRoles,
              roleDefinitions,
            ),
            canLogin: true,
          }),
        )
      : legacyRole === "LODGE"
        ? "NONE"
        : data.financeAccessLevel;

  if (data.sendInvite && !canLogin) {
    return jsonResult(
      { error: "Setup invites can only be sent to members who can log in" },
      { status: 422 },
    );
  }

  // Check for existing member with same email that can login
  if (canLogin) {
    const existing = await prisma.member.findFirst({
      where: { email, canLogin: true },
    });
    if (existing) {
      return jsonResult(
        { error: MEMBER_LOGIN_EMAIL_TAKEN_MESSAGE },
        { status: 409 },
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
          title: data.title ?? null,
          firstName: data.firstName.trim(),
          lastName: data.lastName.trim(),
          gender: data.gender ?? null,
          occupation: data.occupation?.trim() || null,
          phoneCountryCode: data.phoneCountryCode?.trim() || null,
          phoneAreaCode: data.phoneAreaCode?.trim() || null,
          phoneNumber: data.phoneNumber?.trim() || null,
          dateOfBirth,
          role: legacyRole,
          financeAccessLevel,
          ageTier: ageTier as AgeTier,
          active: data.active,
          canLogin,
          parentMemberId: data.parentMemberId?.trim() || null,
          // #2282 review: the flag now follows the SOURCE, and never stands
          // alone. `data.inheritParentEmail ?? Boolean(data.parentMemberId)`
          // meant a create with a `parentMemberId` and no `inheritParentEmail`
          // key stored `inheritParentEmail: true` beside a NULL
          // `inheritEmailFromId` — the exact combination
          // `member-lifecycle-actions.ts` documents as one "no writer produces
          // and no reader expects", and the age-up cron reads it as "mail the
          // parent directly". This route was the writer producing it. When the
          // caller does ask to inherit, resolution has already run above and
          // 422'd if no mailbox was reachable, so a truthy source here is the
          // same answer with the invariant kept.
          inheritParentEmail: Boolean(resolvedInheritEmailFromId),
          inheritEmailFromId: resolvedInheritEmailFromId,
          // #2716: the CHOICE is written with the pointer on every create. The
          // member has no dependants yet, so nothing needs reconciling here —
          // but a create that recorded only the pointer would leave a member the
          // first address change could never restore.
          inheritEmailChoiceId: resolvedInheritEmailFromId,
          passwordHash: placeholderHash,
          emailVerified: !canLogin, // Non-login members don't need verification
          joinedDate,
          lifeMemberDate,
          comments: data.comments?.trim() || null,
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
          title: true,
          gender: true,
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
          lifeMemberDate: true,
          occupation: true,
          cancelledAt: true,
          comments: true,
          createdAt: true,
          accessRoles: { select: { role: true } },
        },
      });

      await ensureMemberAccessRoles(tx, {
        memberId: created.id,
        roles: accessRoles,
        canLogin,
        definitions: roleDefinitions,
      });

      // Seed a NOT_REQUIRED current-season row when the new member's effective
      // membership type does not owe a subscription (operational/non-member
      // accounts). Derived from the shared type resolver, not the login role
      // (#2149).
      await ensureDefaultSeasonSubscriptionForNewMember(
        tx,
        { id: created.id, role: created.role },
        clubCurrentSeasonYear,
      );

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
        logger.error(
          { err: emailErr, memberId: member.id },
          "Failed to send invite email",
        );
        inviteWarning = `Member created but invite email failed to send: ${emailErr instanceof Error ? emailErr.message : String(emailErr)}`;
      }
    }

    const warnings = [inviteWarning].filter(Boolean);
    return jsonResult(
      {
        ...member,
        accessRoles,
        ...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}),
      },
      { status: 201 },
    );
  } catch (error) {
    // Backstop for the race the pre-check above cannot close: the uniqueness
    // query runs before the transaction, so a concurrent write can claim the
    // address in between and the partial unique index `Member_email_login_unique`
    // rejects this create. Narrowed from "any P2002 here means the email is
    // taken" (#2412, matching what #2385 did for the member edit): a collision
    // on some other unique constraint is still a 409, because something really
    // is already taken, but it no longer sends the admin off to fix an address
    // that is fine. It is logged either way, since on this path no other unique
    // constraint should be reachable at all — and the constraint is logged
    // beside the error, because the pino `err` serializer keeps only
    // name/message/stack and would drop `meta` entirely.
    //
    // A create that cannot log in never gets the unnamed-P2002 benefit of the
    // doubt: the login-email index is `WHERE "canLogin" = true`, so no email
    // constraint can fire on that insert.
    if (isPrismaUniqueConstraintError(error)) {
      if (isLoginEmailUniqueConflict(error, { canClaimLoginEmail: canLogin })) {
        return jsonResult(
          { error: MEMBER_LOGIN_EMAIL_TAKEN_MESSAGE },
          { status: 409 },
        );
      }
      logger.error(
        { err: error, constraint: describeUniqueConstraintTarget(error) },
        "Member create hit an unexpected unique constraint",
      );
      return jsonResult(
        {
          error:
            "Could not create this member: one of their details is already used by another record",
        },
        { status: 409 },
      );
    }

    logger.error({ err: error }, "Failed to create member");
    return jsonResult({ error: "Failed to create member" }, { status: 500 });
  }
}
