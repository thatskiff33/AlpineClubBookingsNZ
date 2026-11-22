import "server-only";

import type { AgeTier, NoticeAudienceKind, Prisma } from "@prisma/client";
import { getAgeTierSettings } from "@/lib/age-tier";
import {
  isSubscriptionEnforcementActive,
  requiresPaidSubscriptionForAgeTier,
} from "@/lib/member-subscription-eligibility";
import {
  defaultMembershipTypeKeyForRole,
} from "@/lib/membership-types";
import {
  requiresPaidSubscriptionForMemberForBooking,
  resolveMembershipTypePoliciesForMembers,
} from "@/lib/membership-type-policy";
import { prisma } from "@/lib/prisma";
import { fixedClubClock } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { clubSeasonYear } from "@/lib/financial-year";

// ---------------------------------------------------------------------------
// Member Notices audience resolution (server-only).
//
// The whole privacy model of this feature rests on ONE predicate,
// visibleNoticeWhere, used by every member-facing read (list, count, detail).
// No member-facing surface may query notices any other way — a caller that
// hand-rolls a where clause could leak an out-of-audience notice or expose the
// existence of a notice a member cannot see. Members never receive audience
// definitions, other members' receipts, or the financialMembersOnly flag.
// ---------------------------------------------------------------------------

/** The audience-relevant facts about one member, resolved once per request. */
export type MemberAudienceKeys = {
  memberId: string;
  /** Effective current-season membership type id(s): explicit assignment, else
   *  the role-fallback built-in type. Usually a single id. */
  membershipTypeIds: string[];
  /** Lodge ids the member has any MemberLodgeAccess row for. */
  lodgeIds: string[];
  /** Committee role ids from ACTIVE committee assignments. */
  committeeRoleIds: string[];
  /** Paid-up/exempt ("financial") status, used to gate financialMembersOnly
   *  group-kind matches. Explicit MEMBER targets ignore this. */
  isFinancial: boolean;
};

type FinancialDb = Parameters<typeof requiresPaidSubscriptionForMemberForBooking>[0];

/**
 * Canonical "financial member" (paid-up OR exempt) decision for one member,
 * reused everywhere in this module so the financialMembersOnly gate can never
 * diverge from the repo's paid-up semantics. It composes the SAME facts the
 * member-facing /api/member/subscription-status route reports:
 *   - not subscription-required (Life/honorary/operational type, age-tier
 *     exemption, or lockout disabled) => financial (in good standing), OR
 *   - current-season MemberSubscription.status === "PAID".
 * No parallel definition of "financial" is introduced.
 */
export async function isMemberFinancial(
  db: FinancialDb,
  params: { memberId: string; seasonYear: number; ageTier: AgeTier | null | undefined },
): Promise<boolean> {
  const required = await requiresPaidSubscriptionForMemberForBooking(db, {
    memberId: params.memberId,
    seasonYear: params.seasonYear,
    ageTier: params.ageTier,
  });
  if (!required) {
    return true;
  }
  const sub = await prisma.memberSubscription.findUnique({
    where: {
      memberId_seasonYear: { memberId: params.memberId, seasonYear: params.seasonYear },
    },
    select: { status: true },
  });
  return sub?.status === "PAID";
}

/**
 * Batched, many-member equivalent of {@link isMemberFinancial}, resolving the
 * paid-up/exempt ("financial") status for a whole candidate set in a CONSTANT
 * number of queries — replacing the previous per-member N+1 in
 * resolveNoticeAudienceMembers. It faithfully decomposes
 * requiresPaidSubscriptionForMemberForBooking + isMemberFinancial:
 *   - ONE batched effective-type policy resolution (the very resolver the
 *     single-member path calls under the hood);
 *   - ONE batched current-season MemberSubscription read — because
 *     (memberId, seasonYear) is unique there is at most one row per member, and
 *     that single row yields BOTH the NOT_REQUIRED-dominance fact (used only by
 *     BASED_ON_AGE_TIER types, matching hasNotRequiredSubscriptionRow) and the
 *     PAID fact;
 *   - the global subscription-enforcement flag and age-tier settings resolved
 *     ONCE for the whole batch (the singular path re-derived them per member).
 * isMemberFinancial stays the canonical single-member helper; a parity test
 * (notices-financial-parity.test.ts) asserts the two never diverge.
 */
export async function resolveFinancialStatusForMembers(
  members: ReadonlyArray<{ id: string; ageTier: AgeTier | null }>,
  seasonYear: number,
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  if (members.length === 0) {
    return result;
  }
  const memberIds = members.map((m) => m.id);

  const policies = await resolveMembershipTypePoliciesForMembers(prisma, {
    memberIds,
    seasonYear,
  });

  const subs = await prisma.memberSubscription.findMany({
    where: { memberId: { in: memberIds }, seasonYear },
    select: { memberId: true, status: true },
  });
  const statusByMember = new Map(subs.map((s) => [s.memberId, s.status]));

  // Global config (same seams requiresPaidSubscriptionForBooking uses), once.
  const enforcementActive = await isSubscriptionEnforcementActive();
  const ageTierSettings = enforcementActive ? await getAgeTierSettings() : [];

  for (const member of members) {
    const policy = policies.get(member.id);
    const status = statusByMember.get(member.id) ?? null;

    let required: boolean;
    if (policy?.subscriptionBehavior === "NOT_REQUIRED") {
      required = false;
    } else if (
      policy?.subscriptionBehavior === "BASED_ON_AGE_TIER" &&
      status === "NOT_REQUIRED"
    ) {
      // Matches hasNotRequiredSubscriptionRow: a NOT_REQUIRED row dominates.
      required = false;
    } else {
      required = enforcementActive
        ? requiresPaidSubscriptionForAgeTier(member.ageTier, ageTierSettings)
        : false;
    }

    result.set(member.id, required ? status === "PAID" : true);
  }

  return result;
}

/**
 * Resolve one member's audience keys for notice visibility. A single member
 * read plus (for members with no explicit season assignment) one MembershipType
 * lookup for the role-fallback type, plus the financial-status resolution.
 */
export async function getMemberAudienceKeys(
  memberId: string,
  options: { now?: Date } = {},
): Promise<MemberAudienceKeys | null> {
  // The CLUB's season at the caller's moment (INV-CONFIG-002). `options.now`
  // stays a pinnable instant; it becomes the clock rather than a value read with
  // host-local getters.
  const seasonYear = clubSeasonYear(
    await readClubTimeZoneOutsideRequest(),
    options.now ? fixedClubClock(options.now) : undefined,
  );

  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: {
      id: true,
      role: true,
      ageTier: true,
      seasonalMembershipAssignments: {
        where: { seasonYear },
        select: { membershipTypeId: true },
        take: 1,
      },
      lodgeAccess: { select: { lodgeId: true } },
      committeeAssignments: {
        where: { isActive: true },
        select: { committeeRoleId: true },
      },
    },
  });

  if (!member) {
    return null;
  }

  // Effective membership type: an explicit season assignment wins; otherwise
  // the member's role maps to a built-in default type (same fallback the
  // canonical policy resolver uses) so members without an explicit assignment
  // still match their type-targeted notices.
  let membershipTypeIds: string[] = [];
  const assigned = member.seasonalMembershipAssignments[0];
  if (assigned) {
    membershipTypeIds = [assigned.membershipTypeId];
  } else {
    const fallbackKey = defaultMembershipTypeKeyForRole(member.role);
    const fallbackType = await prisma.membershipType.findUnique({
      where: { key: fallbackKey },
      select: { id: true },
    });
    if (fallbackType) {
      membershipTypeIds = [fallbackType.id];
    }
  }

  const isFinancial = await isMemberFinancial(prisma, {
    memberId,
    seasonYear,
    ageTier: member.ageTier,
  });

  return {
    memberId: member.id,
    membershipTypeIds,
    lodgeIds: member.lodgeAccess.map((row) => row.lodgeId),
    committeeRoleIds: member.committeeAssignments.map((row) => row.committeeRoleId),
    isFinancial,
  };
}

/**
 * THE single visibility predicate for member-facing notice reads. A notice is
 * visible to the member described by `keys` when it is PUBLISHED, its
 * publishedAt is in the past, it has not expired, AND it carries an audience row
 * matching the member — subject to the financialMembersOnly rule:
 *   - an explicit MEMBER target always matches (ignores financialMembersOnly);
 *   - group kinds (ALL_MEMBERS / MEMBERSHIP_TYPE / LODGE / COMMITTEE_ROLE) match
 *     only when the notice is not financialMembersOnly OR the member is
 *     financial.
 * The financial branch is baked in here so no caller can diverge.
 */
export function visibleNoticeWhere(
  keys: MemberAudienceKeys,
  now: Date,
): Prisma.NoticeWhereInput {
  const groupAudienceOr: Prisma.NoticeAudienceWhereInput[] = [
    { kind: "ALL_MEMBERS" },
  ];
  if (keys.membershipTypeIds.length > 0) {
    groupAudienceOr.push({
      kind: "MEMBERSHIP_TYPE",
      membershipTypeId: { in: keys.membershipTypeIds },
    });
  }
  if (keys.lodgeIds.length > 0) {
    groupAudienceOr.push({ kind: "LODGE", lodgeId: { in: keys.lodgeIds } });
  }
  if (keys.committeeRoleIds.length > 0) {
    groupAudienceOr.push({
      kind: "COMMITTEE_ROLE",
      committeeRoleId: { in: keys.committeeRoleIds },
    });
  }

  // An explicit MEMBER target always reaches this member.
  const audienceMatch: Prisma.NoticeWhereInput[] = [
    { audiences: { some: { kind: "MEMBER", memberId: keys.memberId } } },
  ];

  // Group-kind matches. For a financial member they always apply; for a
  // non-financial member they apply only to notices that are NOT
  // financialMembersOnly.
  if (keys.isFinancial) {
    audienceMatch.push({ audiences: { some: { OR: groupAudienceOr } } });
  } else {
    audienceMatch.push({
      financialMembersOnly: false,
      audiences: { some: { OR: groupAudienceOr } },
    });
  }

  return {
    status: "PUBLISHED",
    publishedAt: { lte: now },
    AND: [
      { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      { OR: audienceMatch },
    ],
  };
}

// The member-facing view of a notice: never carries audience definitions,
// receipt data for other members, or the financialMembersOnly flag.
export type MemberNoticeView = {
  id: string;
  title: string;
  /** Sanitised-on-save HTML; the render path re-sanitises (defense in depth). */
  bodyHtml: string;
  publishedAt: string | null;
  expiresAt: string | null;
  pinned: boolean;
  requiresAcknowledgement: boolean;
  read: boolean;
  readAt: string | null;
  acknowledged: boolean;
  acknowledgedAt: string | null;
};

type NoticeWithOwnReceipt = {
  id: string;
  title: string;
  bodyHtml: string;
  publishedAt: Date | null;
  expiresAt: Date | null;
  pinned: boolean;
  requiresAcknowledgement: boolean;
  readReceipts: Array<{ readAt: Date; acknowledgedAt: Date | null }>;
};

export function serializeNoticeForMember(
  notice: NoticeWithOwnReceipt,
): MemberNoticeView {
  const receipt = notice.readReceipts[0] ?? null;
  return {
    id: notice.id,
    title: notice.title,
    bodyHtml: notice.bodyHtml,
    publishedAt: notice.publishedAt?.toISOString() ?? null,
    expiresAt: notice.expiresAt?.toISOString() ?? null,
    pinned: notice.pinned,
    requiresAcknowledgement: notice.requiresAcknowledgement,
    read: receipt !== null,
    readAt: receipt?.readAt.toISOString() ?? null,
    acknowledged: receipt?.acknowledgedAt != null,
    acknowledgedAt: receipt?.acknowledgedAt?.toISOString() ?? null,
  };
}

const OWN_RECEIPT_INCLUDE = (memberId: string) =>
  ({
    readReceipts: {
      where: { memberId },
      take: 1,
      select: { readAt: true, acknowledgedAt: true },
    },
  }) satisfies Prisma.NoticeInclude;

/**
 * Notices visible to a member, pinned first then newest published. Includes the
 * member's OWN read receipt only.
 */
export async function listNoticesForMember(
  memberId: string,
  options: {
    limit?: number;
    now?: Date;
    /** Precomputed audience keys (resolve once and share across sibling calls,
     *  e.g. the dashboard card's list + unread-count). Pass `null` to mean "no
     *  such member" without a lookup; omit to resolve internally. */
    keys?: MemberAudienceKeys | null;
  } = {},
): Promise<MemberNoticeView[]> {
  const now = options.now ?? new Date();
  const keys =
    options.keys !== undefined
      ? options.keys
      : await getMemberAudienceKeys(memberId, { now });
  if (!keys) {
    return [];
  }

  const notices = await prisma.notice.findMany({
    where: visibleNoticeWhere(keys, now),
    orderBy: [{ pinned: "desc" }, { publishedAt: "desc" }],
    ...(options.limit ? { take: options.limit } : {}),
    include: OWN_RECEIPT_INCLUDE(memberId),
  });

  return notices.map(serializeNoticeForMember);
}

/** Count of visible notices the member has not opened. */
export async function getUnreadNoticeCount(
  memberId: string,
  options: {
    now?: Date;
    /** Precomputed audience keys — see listNoticesForMember. */
    keys?: MemberAudienceKeys | null;
  } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const keys =
    options.keys !== undefined
      ? options.keys
      : await getMemberAudienceKeys(memberId, { now });
  if (!keys) {
    return 0;
  }

  return prisma.notice.count({
    where: {
      ...visibleNoticeWhere(keys, now),
      readReceipts: { none: { memberId } },
    },
  });
}

/**
 * The ONLY detail-fetch path for a member. Re-checks audience via the shared
 * predicate, so an out-of-audience or non-existent id both resolve to null —
 * indistinguishable to the member (no existence probe).
 */
export async function getNoticeForMember(
  memberId: string,
  noticeId: string,
  options: { now?: Date } = {},
): Promise<MemberNoticeView | null> {
  const now = options.now ?? new Date();
  const keys = await getMemberAudienceKeys(memberId, { now });
  if (!keys) {
    return null;
  }

  const notice = await prisma.notice.findFirst({
    where: { id: noticeId, ...visibleNoticeWhere(keys, now) },
    include: OWN_RECEIPT_INCLUDE(memberId),
  });

  return notice ? serializeNoticeForMember(notice) : null;
}

/**
 * Audit snapshot for notice create/update/delete/publish events. Mirrors
 * siteBannerAuditSnapshot: scalar fields only, no full body (bodyHtml can be up
 * to ~50k). audiences are recorded separately by the route.
 */
export function noticeAuditSnapshot(notice: {
  title: string;
  status: string;
  pinned: boolean;
  requiresAcknowledgement: boolean;
  financialMembersOnly: boolean;
  publishedAt: Date | null;
  expiresAt: Date | null;
  emailedAt: Date | null;
  bodyHtml: string;
}) {
  return {
    title: notice.title,
    status: notice.status,
    pinned: notice.pinned,
    requiresAcknowledgement: notice.requiresAcknowledgement,
    financialMembersOnly: notice.financialMembersOnly,
    publishedAt: notice.publishedAt?.toISOString() ?? null,
    expiresAt: notice.expiresAt?.toISOString() ?? null,
    emailedAt: notice.emailedAt?.toISOString() ?? null,
    bodyLength: notice.bodyHtml.length,
  };
}

/** Validated audience input (one row of a notice's targeting). */
export type NoticeAudienceInput =
  | { kind: "ALL_MEMBERS" }
  | { kind: "MEMBER"; memberId: string }
  | { kind: "MEMBERSHIP_TYPE"; membershipTypeId: string }
  | { kind: "LODGE"; lodgeId: string }
  | { kind: "COMMITTEE_ROLE"; committeeRoleId: string };

/**
 * Replace-all audience write (deleteMany + createMany) inside the caller's
 * transaction — the same pattern as replaceMembershipTypeRuleConfiguration.
 * App-side dedup: the caller passes a deduped list.
 */
export async function replaceNoticeAudiences(
  tx: Pick<Prisma.TransactionClient, "noticeAudience">,
  noticeId: string,
  audiences: readonly NoticeAudienceInput[],
): Promise<void> {
  await tx.noticeAudience.deleteMany({ where: { noticeId } });
  if (audiences.length === 0) {
    return;
  }
  await tx.noticeAudience.createMany({
    data: audiences.map((audience) => ({
      noticeId,
      kind: audience.kind as NoticeAudienceKind,
      memberId: audience.kind === "MEMBER" ? audience.memberId : null,
      membershipTypeId:
        audience.kind === "MEMBERSHIP_TYPE" ? audience.membershipTypeId : null,
      lodgeId: audience.kind === "LODGE" ? audience.lodgeId : null,
      committeeRoleId:
        audience.kind === "COMMITTEE_ROLE" ? audience.committeeRoleId : null,
    })),
  });
}

// A member resolved into a notice's effective audience, for the admin read
// report and the email-on-publish send.
export type ResolvedAudienceMember = {
  memberId: string;
  name: string;
  email: string;
  /** Human-readable rule(s) the member matched via. Never shown to members. */
  audienceVia: string;
  /** True when the member matched via an explicit MEMBER target (exempt from
   *  the financialMembersOnly filter). */
  viaExplicitMember: boolean;
};

/**
 * Resolve the concrete members a notice reaches, mirroring visibleNoticeWhere's
 * audience semantics for the admin read report and the email send:
 *   - ALL_MEMBERS -> every active member;
 *   - else the union of explicit members, effective-type matches (incl. the
 *     role fallback), lodge access, and active committee assignments;
 *   - the financialMembersOnly filter is applied to GROUP kinds only (explicit
 *     MEMBER targets are always included).
 */
export async function resolveNoticeAudienceMembers(
  noticeId: string,
  options: { now?: Date } = {},
): Promise<ResolvedAudienceMember[]> {
  const now = options.now ?? new Date();
  const seasonYear = clubSeasonYear(await readClubTimeZoneOutsideRequest(), fixedClubClock(now));

  const notice = await prisma.notice.findUnique({
    where: { id: noticeId },
    select: {
      financialMembersOnly: true,
      audiences: {
        select: {
          kind: true,
          memberId: true,
          membershipTypeId: true,
          lodgeId: true,
          committeeRoleId: true,
        },
      },
    },
  });
  if (!notice) {
    return [];
  }

  const hasAllMembers = notice.audiences.some((a) => a.kind === "ALL_MEMBERS");
  const explicitMemberIds = notice.audiences
    .filter((a) => a.kind === "MEMBER" && a.memberId)
    .map((a) => a.memberId as string);
  const typeIds = notice.audiences
    .filter((a) => a.kind === "MEMBERSHIP_TYPE" && a.membershipTypeId)
    .map((a) => a.membershipTypeId as string);
  const lodgeIds = notice.audiences
    .filter((a) => a.kind === "LODGE" && a.lodgeId)
    .map((a) => a.lodgeId as string);
  const roleIds = notice.audiences
    .filter((a) => a.kind === "COMMITTEE_ROLE" && a.committeeRoleId)
    .map((a) => a.committeeRoleId as string);

  // memberId -> { explicit, group labels }
  const viaByMember = new Map<
    string,
    { explicit: boolean; group: Set<string> }
  >();
  const record = (memberId: string, label: string, explicit: boolean) => {
    let entry = viaByMember.get(memberId);
    if (!entry) {
      entry = { explicit: false, group: new Set<string>() };
      viaByMember.set(memberId, entry);
    }
    if (explicit) {
      entry.explicit = true;
    } else {
      entry.group.add(label);
    }
  };

  // Explicit MEMBER targets.
  for (const id of explicitMemberIds) {
    record(id, "Member", true);
  }

  // ALL_MEMBERS.
  if (hasAllMembers) {
    const all = await prisma.member.findMany({
      where: { active: true },
      select: { id: true },
    });
    for (const m of all) {
      record(m.id, "All members", false);
    }
  }

  // MEMBERSHIP_TYPE: explicit season assignment, then role fallback.
  if (typeIds.length > 0) {
    const targetTypes = await prisma.membershipType.findMany({
      where: { id: { in: typeIds } },
      select: { id: true, key: true, name: true },
    });
    const nameByKey = new Map(targetTypes.map((t) => [t.key, t.name]));
    const targetKeys = new Set(targetTypes.map((t) => t.key));

    const assigned = await prisma.seasonalMembershipAssignment.findMany({
      where: {
        seasonYear,
        membershipTypeId: { in: typeIds },
        member: { active: true },
      },
      select: { memberId: true, membershipType: { select: { name: true } } },
    });
    for (const a of assigned) {
      record(a.memberId, `Membership type: ${a.membershipType.name}`, false);
    }

    // Role fallback: active members with NO assignment this season whose role
    // maps to one of the target type keys.
    const noAssignment = await prisma.member.findMany({
      where: {
        active: true,
        seasonalMembershipAssignments: { none: { seasonYear } },
      },
      select: { id: true, role: true },
    });
    for (const m of noAssignment) {
      const key = defaultMembershipTypeKeyForRole(m.role);
      if (targetKeys.has(key)) {
        record(m.id, `Membership type: ${nameByKey.get(key) ?? key}`, false);
      }
    }
  }

  // LODGE access.
  if (lodgeIds.length > 0) {
    const access = await prisma.memberLodgeAccess.findMany({
      where: { lodgeId: { in: lodgeIds }, member: { active: true } },
      select: { memberId: true, lodge: { select: { name: true } } },
    });
    for (const a of access) {
      record(a.memberId, `Lodge: ${a.lodge.name}`, false);
    }
  }

  // Active COMMITTEE_ROLE assignments.
  if (roleIds.length > 0) {
    const assigns = await prisma.committeeAssignment.findMany({
      where: {
        committeeRoleId: { in: roleIds },
        isActive: true,
        member: { active: true },
      },
      select: {
        memberId: true,
        committeeRole: { select: { name: true } },
      },
    });
    for (const a of assigns) {
      record(a.memberId, `Committee: ${a.committeeRole.name}`, false);
    }
  }

  const memberIds = [...viaByMember.keys()];
  if (memberIds.length === 0) {
    return [];
  }

  // active:true also filters explicit MEMBER targets down to active members.
  // Group kinds already constrain active:true in their own queries, so only
  // explicit targets could be inactive here; an inactive member cannot log in
  // or read a notice, so they must not be emailed or surface as a permanent
  // unread "ghost" in the read report. Any id dropped here is simply skipped by
  // the `!member` guard below.
  const members = await prisma.member.findMany({
    where: { id: { in: memberIds }, active: true },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      ageTier: true,
    },
  });
  const memberById = new Map(members.map((m) => [m.id, m]));

  // financialMembersOnly filters GROUP-kind matches only (explicit MEMBER
  // targets are always included). Resolve every candidate's financial status in
  // a CONSTANT number of queries — batched — instead of the old per-member N+1;
  // skip the work entirely when the notice is not financialMembersOnly.
  const financialByMember = notice.financialMembersOnly
    ? await resolveFinancialStatusForMembers(members, seasonYear)
    : null;

  const result: ResolvedAudienceMember[] = [];
  for (const id of memberIds) {
    const via = viaByMember.get(id);
    const member = memberById.get(id);
    if (!via || !member) {
      continue;
    }

    // financialMembersOnly filters GROUP-kind-only matches; an explicit MEMBER
    // target is always included.
    if (notice.financialMembersOnly && !via.explicit) {
      if (!financialByMember?.get(id)) {
        continue;
      }
    }

    const labels = [
      ...(via.explicit ? ["Member"] : []),
      ...[...via.group].filter((l) => l !== "Member"),
    ];
    result.push({
      memberId: id,
      name: `${member.firstName} ${member.lastName}`.trim(),
      email: member.email,
      audienceVia: labels.join(", "),
      viaExplicitMember: via.explicit,
    });
  }

  // Stable order: name then id.
  result.sort(
    (a, b) => a.name.localeCompare(b.name) || a.memberId.localeCompare(b.memberId),
  );
  return result;
}
