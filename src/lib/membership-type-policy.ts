import type {
  AgeTier,
  MembershipTypeBookingBehavior,
  MembershipTypeSubscriptionBehavior,
  Role,
} from "@prisma/client";
import {
  computeMemberGuestBoundary,
  type BookingGuestLookupDb,
} from "@/lib/booking-guests";
import logger from "@/lib/logger";
import {
  MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE,
  MEMBER_GUEST_CROSS_FAMILY_REFUSAL_STATUS,
  MEMBER_GUEST_NOT_ADDABLE_CODE,
} from "@/lib/member-guest-refusal";
import { BUILT_IN_MEMBERSHIP_TYPES, defaultMembershipTypeKeyForRole } from "@/lib/membership-types";
import type { SubscriptionLockoutMode } from "@/lib/membership-lockout-settings";
import {
  peekSubscriptionLockoutMode,
  requiresPaidSubscriptionForBooking,
} from "@/lib/member-subscription-eligibility";
import { memberUnpaidSubscriptionForcesNonMemberRate } from "@/lib/policies/subscription-lockout-pricing";
import {
  loadMemberSubscriptionSettlements,
  type SubscriptionSettlementDb,
} from "@/lib/subscription-lockout-facts";
import {
  calculateBookingPrice,
  type GroupDiscountConfig,
  type PriceBreakdown,
  type RateSource,
  type SeasonRateData,
  type UnratedGuestInput,
} from "@/lib/pricing";

const NON_MEMBER_MEMBERSHIP_TYPE_KEY = "NON_MEMBER";
const BUILT_IN_MEMBERSHIP_TYPE_KEYS = BUILT_IN_MEMBERSHIP_TYPES.map(
  (type) => type.key,
);
import { seasonYearOfStoredDate } from "@/lib/financial-year";

const MEMBERSHIP_TYPE_BLOCKS_BOOKING_CODE =
  "MEMBERSHIP_TYPE_BLOCKS_BOOKING";

type PolicyDbDelegate<Row> = {
  findMany(args: unknown): Promise<Row[]>;
};

type MembershipTypePolicyDb = {
  member: PolicyDbDelegate<MembershipTypePolicyMember>;
  seasonalMembershipAssignment: PolicyDbDelegate<SeasonalMembershipAssignmentPolicyRow>;
  membershipType: PolicyDbDelegate<MembershipTypePolicyType>;
};

type MembershipTypePolicySource =
  | "assignment"
  | "role_default"
  | "built_in_default";

type MembershipTypePolicyType = {
  id: string | null;
  key: string;
  name: string;
  isActive: boolean;
  isBuiltIn: boolean;
  bookingBehavior: MembershipTypeBookingBehavior;
  subscriptionBehavior: MembershipTypeSubscriptionBehavior;
};

type MembershipTypePolicyMember = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: Role;
  ageTier: AgeTier;
};

type SeasonalMembershipAssignmentPolicyRow = {
  memberId: string;
  seasonYear: number;
  membershipType: MembershipTypePolicyType;
};

export type ResolvedMembershipTypePolicy = {
  memberId: string;
  memberName: string;
  memberRole: Role;
  memberAgeTier: AgeTier;
  seasonYear: number;
  source: MembershipTypePolicySource;
  membershipType: MembershipTypePolicyType;
  bookingBehavior: MembershipTypeBookingBehavior;
  subscriptionBehavior: MembershipTypeSubscriptionBehavior;
};

export type MembershipTypeBookingPolicyBlock = {
  scope: "BOOKING_OWNER" | "MEMBER_GUEST";
  memberId: string;
  name: string;
  seasonYear: number;
  membershipTypeKey: string;
  membershipTypeName: string;
  bookingBehavior: MembershipTypeBookingBehavior;
  /**
   * D-8: this block is about a member OUTSIDE the booker's family, so nothing in
   * it may reach the caller (privacy re-review of MG3 #2308, finding 2).
   *
   * The block keeps its detail — `name`, `memberId`, the membership type — because
   * an admin path is entitled to all of it and a log line is better for having it.
   * What changes is that `buildMembershipTypeBookingPolicyMessage` and
   * `getMembershipTypeBookingPolicyErrorBody` both refuse to serialise a block
   * carrying this flag. Set by `getMembershipTypeBookingPolicyBlocks`, from the
   * same family boundary every other collapse site uses.
   */
  crossFamily?: boolean;
};

/**
 * The membership-type refusal — D-8's FOURTH collapsing refusal.
 *
 * WHY IT IS ON THE LIST AT ALL (privacy re-review of MG3 #2308, finding 2). MG3's
 * documentation says a cross-family refusal never discloses WHY, and three
 * refusals were made to honour that: the unpaid subscription, the person-night
 * clash and the profile-completeness gate. This one was missed, and it was the
 * most explicit of the four — it answered
 *
 *     "The following member guests cannot be booked for the 2026/2027 season:
 *      Dana Doe."
 *
 * naming the member (or, with a blank name, their EMAIL ADDRESS), and its response
 * body carried their member id and their membership category as structured
 * fields. Against a stranger that is not an inference from a pattern of answers;
 * it is a read-out, and a cheaper one than the C1 leak because it does not even
 * depend on the dates asked about.
 *
 * SO A CROSS-FAMILY BLOCK NOW COLLAPSES INTO THE SAME ENVELOPE AS ITS THREE
 * SIBLINGS: the neutral sentence, the 403, the `MEMBER_GUEST_NOT_ADDABLE` code,
 * and `crossFamilyMemberIds` for the audit trail. That last field is what lets a
 * route hand this error straight to `handleMemberGuestAddRefusal`, so the refusal
 * is throttled, audited and held to the timing floor exactly like the others —
 * without it the fourth refusal would be collapsed but uncounted, which is how
 * #2388's whole mitigation set gets a hole in it.
 *
 * FAMILY SCOPE AND ADMIN PATHS KEEP THE DETAILED SENTENCE, verbatim. A booker
 * adding their own child needs to be told which of their household cannot be
 * booked and why, and an officer acting on behalf is entitled to the same. Only
 * the beyond-family blocks collapse, and only on a path that enforces
 * authorization.
 */
export class MembershipTypeBookingPolicyError extends Error {
  public readonly code: string;
  public readonly status: number;

  /**
   * The beyond-family members this refusal was about, when it collapsed —
   * otherwise undefined. Same field name and same meaning as
   * `BookingGuestValidationError.crossFamilyMemberIds`, so
   * `handleMemberGuestAddRefusal` accepts either without a second overload.
   *
   * NEVER SERIALISED. Echoing the ids back would confirm which of several
   * requested members the club refused to discuss, which is most of what the
   * collapse just removed.
   */
  public readonly crossFamilyMemberIds?: readonly string[];

  constructor(public readonly blockedMembers: MembershipTypeBookingPolicyBlock[]) {
    super(buildMembershipTypeBookingPolicyMessage(blockedMembers));
    this.name = "MembershipTypeBookingPolicyError";
    const collapsed = blockedMembers.filter((block) => block.crossFamily);
    this.crossFamilyMemberIds =
      collapsed.length > 0 ? collapsed.map((block) => block.memberId) : undefined;
    this.code =
      collapsed.length > 0
        ? MEMBER_GUEST_NOT_ADDABLE_CODE
        : MEMBERSHIP_TYPE_BLOCKS_BOOKING_CODE;
    // Both are 403 today. Read from the constant rather than repeated as a
    // literal so the collapsed refusal cannot drift away from its three siblings
    // — a different status is a distinction all by itself, which is why D-8's
    // person-night collapse gave up its 409.
    this.status =
      collapsed.length > 0 ? MEMBER_GUEST_CROSS_FAMILY_REFUSAL_STATUS : 403;
  }
}

export function getMembershipTypeBookingPolicyErrorBody(
  error: MembershipTypeBookingPolicyError,
) {
  if (error.crossFamilyMemberIds && error.crossFamilyMemberIds.length > 0) {
    // Byte-identical to the shape `getBookingGuestValidationErrorResponse`
    // returns for the other three collapsed refusals — no `blockedMembers` key
    // at all, rather than an emptied one, because a caller can read the
    // difference between "the array is empty" and "there is no array".
    return { code: error.code, error: error.message };
  }

  return {
    error: error.message,
    code: error.code,
    blockedMembers: error.blockedMembers.map((block) => ({
      scope: block.scope,
      memberId: block.memberId,
      name: block.name,
      seasonYear: block.seasonYear,
      membershipTypeKey: block.membershipTypeKey,
      membershipTypeName: block.membershipTypeName,
      bookingBehavior: block.bookingBehavior,
    })),
  };
}

function isMembershipTypePolicyDb(db: unknown): db is MembershipTypePolicyDb {
  const candidate = db as Partial<MembershipTypePolicyDb> | null | undefined;
  return Boolean(
    candidate?.member?.findMany &&
      candidate.seasonalMembershipAssignment?.findMany &&
      candidate.membershipType?.findMany,
  );
}

function formatSeasonDisplay(seasonYear: number) {
  return `${seasonYear}/${seasonYear + 1}`;
}

function memberDisplayName(member: Pick<MembershipTypePolicyMember, "firstName" | "lastName" | "email">) {
  return `${member.firstName} ${member.lastName}`.trim() || member.email;
}

function toPolicyType(
  type: Omit<MembershipTypePolicyType, "id"> & { id?: string | null },
): MembershipTypePolicyType {
  return {
    id: type.id ?? null,
    key: type.key,
    name: type.name,
    isActive: type.isActive,
    isBuiltIn: type.isBuiltIn,
    bookingBehavior: type.bookingBehavior,
    subscriptionBehavior: type.subscriptionBehavior,
  };
}

function builtInPolicyTypeForKey(key: string): MembershipTypePolicyType | null {
  const builtIn = BUILT_IN_MEMBERSHIP_TYPES.find((type) => type.key === key);
  if (!builtIn) {
    return null;
  }
  return toPolicyType({
    id: null,
    key: builtIn.key,
    name: builtIn.name,
    isActive: true,
    isBuiltIn: true,
    bookingBehavior: builtIn.bookingBehavior,
    subscriptionBehavior: builtIn.subscriptionBehavior,
  });
}

function buildPolicy(
  member: MembershipTypePolicyMember,
  seasonYear: number,
  membershipType: MembershipTypePolicyType,
  source: MembershipTypePolicySource,
): ResolvedMembershipTypePolicy {
  return {
    memberId: member.id,
    memberName: memberDisplayName(member),
    memberRole: member.role,
    memberAgeTier: member.ageTier,
    seasonYear,
    source,
    membershipType,
    bookingBehavior: membershipType.bookingBehavior,
    subscriptionBehavior: membershipType.subscriptionBehavior,
  };
}

export async function resolveMembershipTypePoliciesForMembers(
  db: unknown,
  params: {
    memberIds: ReadonlyArray<string | null | undefined>;
    seasonYear: number;
  },
): Promise<Map<string, ResolvedMembershipTypePolicy>> {
  if (!isMembershipTypePolicyDb(db)) {
    return new Map();
  }

  const memberIds = [
    ...new Set(
      params.memberIds
        .map((memberId) => memberId?.trim())
        .filter((memberId): memberId is string => Boolean(memberId)),
    ),
  ];
  if (memberIds.length === 0) {
    return new Map();
  }

  const [members, assignments] = await Promise.all([
    db.member.findMany({
      where: { id: { in: memberIds } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        role: true,
        ageTier: true,
      },
    }),
    db.seasonalMembershipAssignment.findMany({
      where: {
        memberId: { in: memberIds },
        seasonYear: params.seasonYear,
      },
      include: {
        membershipType: {
          select: {
            id: true,
            key: true,
            name: true,
            isActive: true,
            isBuiltIn: true,
            bookingBehavior: true,
            subscriptionBehavior: true,
          },
        },
      },
    }),
  ]);

  const assignmentByMemberId = new Map(
    assignments.map((assignment) => [assignment.memberId, assignment]),
  );
  const fallbackKeys = [
    ...new Set(
      members
        .filter((member) => !assignmentByMemberId.has(member.id))
        .map((member) => defaultMembershipTypeKeyForRole(member.role)),
    ),
  ];
  const fallbackTypes = fallbackKeys.length > 0
    ? await db.membershipType.findMany({
        where: { key: { in: fallbackKeys } },
        select: {
          id: true,
          key: true,
          name: true,
          isActive: true,
          isBuiltIn: true,
          bookingBehavior: true,
          subscriptionBehavior: true,
        },
      })
    : [];
  const fallbackTypeByKey = new Map(
    fallbackTypes.map((type) => [type.key, toPolicyType(type)]),
  );

  const policies = new Map<string, ResolvedMembershipTypePolicy>();
  for (const member of members) {
    const assignment = assignmentByMemberId.get(member.id);
    if (assignment) {
      policies.set(
        member.id,
        buildPolicy(
          member,
          params.seasonYear,
          toPolicyType(assignment.membershipType),
          "assignment",
        ),
      );
      continue;
    }

    const defaultKey = defaultMembershipTypeKeyForRole(member.role);
    const fallbackType =
      fallbackTypeByKey.get(defaultKey) ?? builtInPolicyTypeForKey(defaultKey);
    if (!fallbackType) {
      continue;
    }

    policies.set(
      member.id,
      buildPolicy(
        member,
        params.seasonYear,
        fallbackType,
        fallbackTypeByKey.has(defaultKey) ? "role_default" : "built_in_default",
      ),
    );
  }

  return policies;
}

export async function resolveMembershipTypePolicyForMember(
  db: unknown,
  params: {
    memberId: string;
    seasonYear: number;
  },
): Promise<ResolvedMembershipTypePolicy | null> {
  const policies = await resolveMembershipTypePoliciesForMembers(db, {
    memberIds: [params.memberId],
    seasonYear: params.seasonYear,
  });
  return policies.get(params.memberId) ?? null;
}

function buildMembershipTypeBookingPolicyMessage(
  blocks: MembershipTypeBookingPolicyBlock[],
) {
  if (blocks.length === 0) {
    return "Membership type booking policy blocks this booking.";
  }

  // ANY beyond-family block collapses the WHOLE sentence (privacy re-review of
  // MG3 #2308, finding 2). Not "the collapsed part is omitted and the rest is
  // listed": a caller who can see which members were named and which were merely
  // counted can subtract, and one line of arithmetic would give back the name
  // the collapse just removed. One neutral sentence is the only shape that
  // cannot be differenced.
  //
  // The cost is a booker whose OWN membership type also blocks the booking
  // losing that actionable sentence while a cross-family guest is in the party.
  // That is rare, recoverable (remove the guest and the detailed message
  // returns), and much cheaper than the alternative.
  if (blocks.some((block) => block.crossFamily)) {
    return MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE;
  }

  const ownerBlock = blocks.find((block) => block.scope === "BOOKING_OWNER");
  if (ownerBlock && blocks.length === 1) {
    return `Your ${formatSeasonDisplay(ownerBlock.seasonYear)} membership type (${ownerBlock.membershipTypeName}) does not allow lodge bookings.`;
  }

  const guestBlocks = blocks.filter((block) => block.scope === "MEMBER_GUEST");
  if (guestBlocks.length === blocks.length) {
    return `The following member guests cannot be booked for the ${formatSeasonDisplay(guestBlocks[0].seasonYear)} season: ${guestBlocks.map((block) => block.name).join(", ")}.`;
  }

  return `One or more members cannot be booked for the ${formatSeasonDisplay(blocks[0].seasonYear)} season under their membership type policy.`;
}

/**
 * Can this `db` answer the family-boundary question?
 *
 * `getMembershipTypeBookingPolicyBlocks` takes `db: unknown` — it is called with
 * a `PrismaClient`, a transaction client and a long tail of narrowed test doubles
 * — so the boundary backstop has to ask before it reads, exactly as
 * `isMembershipTypePolicyDb` already does for the policy reads themselves.
 */
function canComputeMemberGuestBoundary(db: unknown): db is BookingGuestLookupDb {
  const candidate = db as
    | { familyGroupMember?: { findMany?: unknown } }
    | null
    | undefined;
  return typeof candidate?.familyGroupMember?.findMany === "function";
}

/**
 * Which of the blocked member guests sit beyond the booker's family (finding 2).
 *
 * TWO SOURCES, AND THE ORDER MATTERS FOR COST RATHER THAN CORRECTNESS.
 *
 *   1. The `crossFamilyMemberGuest` MARKER the caller's party already carries.
 *      Every member-facing add and quote path has run either
 *      `planMemberGuestConsentWrites`, `markCrossFamilyMemberGuests` or
 *      `markCrossFamilyGuestsOnBooking` before it gets here, so on those paths
 *      the answer is already in hand and costs nothing.
 *   2. The LIVE BOUNDARY, for any blocked member the marker does not cover.
 *      `confirm-draft`, the guest-removal path and the promo validator all price
 *      or re-check a party they never marked, and a marker-only implementation
 *      would leak on exactly those — which is the same shape of mistake C1 was.
 *
 * IT RUNS ONLY ON A REFUSAL. The boundary read happens after the blocks are
 * built, so a booking whose members are all bookable — every ordinary booking —
 * pays nothing at all. On the refusal path it is the two `FamilyGroupMember`
 * reads `getAllowedGuestMemberIds` already does everywhere else.
 *
 * IT ABSTAINS RATHER THAN GUESSES. With no `ownerMemberId` there is no family to
 * be outside of, and with a `db` that cannot read `FamilyGroupMember` there is no
 * boundary to compute; in both cases only the marker speaks. The admin approval
 * pipeline is the real instance of the first — it converts a booking request with
 * no member owner — and it passes `skipAuthorization` anyway.
 */
async function resolveCrossFamilyPolicyBlocks(
  db: unknown,
  params: {
    ownerMemberId?: string | null;
    guests?: ReadonlyArray<{
      isMember: boolean;
      memberId?: string | null;
      crossFamilyMemberGuest?: boolean;
    }>;
    skipAuthorization?: boolean;
  },
  blocks: MembershipTypeBookingPolicyBlock[],
): Promise<void> {
  if (params.skipAuthorization) return;

  const guestBlocks = blocks.filter((block) => block.scope === "MEMBER_GUEST");
  if (guestBlocks.length === 0) return;

  const markedMemberIds = new Set(
    (params.guests ?? [])
      .filter((guest) => guest.crossFamilyMemberGuest === true)
      .map((guest) => guest.memberId?.trim())
      .filter((memberId): memberId is string => Boolean(memberId)),
  );

  const beyondFamily = new Set(
    guestBlocks
      .map((block) => block.memberId)
      .filter((memberId) => markedMemberIds.has(memberId)),
  );

  const unresolved = guestBlocks
    .map((block) => block.memberId)
    .filter((memberId) => !beyondFamily.has(memberId));
  if (
    unresolved.length > 0 &&
    params.ownerMemberId &&
    canComputeMemberGuestBoundary(db)
  ) {
    const boundary = await computeMemberGuestBoundary(
      db,
      params.ownerMemberId,
      unresolved,
    );
    for (const memberId of boundary.beyondFamilyMemberIds) {
      beyondFamily.add(memberId);
    }
  }

  for (const block of guestBlocks) {
    if (beyondFamily.has(block.memberId)) {
      block.crossFamily = true;
    }
  }
}

export async function getMembershipTypeBookingPolicyBlocks(
  db: unknown,
  params: {
    seasonYear: number;
    ownerMemberId?: string | null;
    guests?: ReadonlyArray<{
      isMember: boolean;
      memberId?: string | null;
      /**
       * D-8's marker, when the caller has already computed it — see
       * `resolveCrossFamilyPolicyBlocks`. Optional and absent on every
       * non-widened path, so nothing about a family booking changes.
       */
      crossFamilyMemberGuest?: boolean;
    }>;
    /**
     * True on an admin/officer on-behalf path. Keeps the detailed, actionable
     * message and the structured `blockedMembers` body: an officer is entitled to
     * know which member their club's policy blocked, and collapsing it for them
     * would buy nothing and cost support tickets. Same exemption
     * `applyMemberGuestAddThrottle` and `markCrossFamilyGuestsOnBooking` make.
     */
    skipAuthorization?: boolean;
  },
): Promise<MembershipTypeBookingPolicyBlock[]> {
  const guestMemberIds =
    params.guests
      ?.filter((guest) => guest.isMember && guest.memberId)
      .map((guest) => guest.memberId as string) ?? [];
  const policies = await resolveMembershipTypePoliciesForMembers(db, {
    memberIds: [params.ownerMemberId, ...guestMemberIds],
    seasonYear: params.seasonYear,
  });
  const blocks: MembershipTypeBookingPolicyBlock[] = [];

  const ownerPolicy = params.ownerMemberId
    ? policies.get(params.ownerMemberId)
    : null;
  if (ownerPolicy?.bookingBehavior === "BLOCK_BOOKING") {
    blocks.push({
      scope: "BOOKING_OWNER",
      memberId: ownerPolicy.memberId,
      name: ownerPolicy.memberName,
      seasonYear: ownerPolicy.seasonYear,
      membershipTypeKey: ownerPolicy.membershipType.key,
      membershipTypeName: ownerPolicy.membershipType.name,
      bookingBehavior: ownerPolicy.bookingBehavior,
    });
  }

  const seenGuestBlocks = new Set<string>();
  for (const memberId of guestMemberIds) {
    if (seenGuestBlocks.has(memberId)) {
      continue;
    }
    seenGuestBlocks.add(memberId);
    const policy = policies.get(memberId);
    if (policy?.bookingBehavior !== "BLOCK_BOOKING") {
      continue;
    }
    blocks.push({
      scope: "MEMBER_GUEST",
      memberId: policy.memberId,
      name: policy.memberName,
      seasonYear: policy.seasonYear,
      membershipTypeKey: policy.membershipType.key,
      membershipTypeName: policy.membershipType.name,
      bookingBehavior: policy.bookingBehavior,
    });
  }

  await resolveCrossFamilyPolicyBlocks(db, params, blocks);

  return blocks;
}

export async function assertMembershipTypeBookingAllowed(
  db: unknown,
  params: Parameters<typeof getMembershipTypeBookingPolicyBlocks>[1],
): Promise<void> {
  const blocks = await getMembershipTypeBookingPolicyBlocks(db, params);
  if (blocks.length > 0) {
    throw new MembershipTypeBookingPolicyError(blocks);
  }
}

export type GuestRateResolution = {
  rateMembershipTypeId: string;
  rateSource: RateSource;
};

/** The db shape the #2543 reprice read needs on top of the policy resolver's. */
type UnpaidSubscriptionRepriceDb = MembershipTypePolicyDb & SubscriptionSettlementDb;

function canReadUnpaidSubscriptionFacts(
  db: unknown,
): db is UnpaidSubscriptionRepriceDb {
  const candidate = db as Partial<UnpaidSubscriptionRepriceDb> | null | undefined;
  return Boolean(
    candidate?.member?.findMany && candidate.memberSubscription?.findMany,
  );
}

/**
 * Which member-linked guests must price at the NON_MEMBER rate because their
 * season subscription is required but unpaid (#2543).
 *
 * EMPTY UNLESS THE CLUB IS IN `NON_MEMBER_PRICING`. Under `HARD_BLOCK` (the
 * default) and `NO_BLOCK` this returns before touching the database and pricing
 * is byte-identical to pre-#2543, which is what makes the mode switch the only
 * thing that can move a club's money.
 *
 * UNREADABLE INPUTS YIELD NO REPRICE, matching the structural seam its neighbour
 * `resolveMembershipTypePoliciesForMembers` already uses: a `db` that is not a
 * real client (a narrow test double) returns an empty result rather than
 * throwing, because this function's contract is "resolve rates from what the
 * client can see". Every production call site passes `prisma` or a
 * `Prisma.TransactionClient`, both of which carry every delegate, so the branch
 * is not reachable in production. It is checked BEFORE the mode is read, so a
 * narrow double never triggers a settings query; when the caller HANDED us a
 * `NON_MEMBER_PRICING` mode the branch also logs, because in that combination the
 * silence would be an undercharge rather than a no-op.
 *
 * A FAILED MODE READ IS NO LONGER SWALLOWED. This function used to wrap
 * `peekSubscriptionLockoutMode()` in `try { … } catch { return empty }`, and an
 * empty set means "charge member rates" — so a transient failure on the two
 * settings queries (a pool timeout being the realistic trigger) silently and
 * permanently undercharged an unpaid member, snapshotted per guest row, on a
 * booking the route gate had already waved through. The error now propagates: the
 * request fails loudly instead of charging the wrong price quietly. Callers that
 * hold the mode (every booking write path) pass it in and never reach the read at
 * all.
 *
 * Be clear about the direction of the risk rather than calling it fail-safe: if
 * the unreadable-client branch WERE reached under `NON_MEMBER_PRICING`, the unpaid
 * member would be charged MEMBER rates and the booking would still succeed — the
 * route gate does not refuse in that mode, so nothing else would catch it. That is
 * why the reprice is covered by a test that drives it through a client carrying
 * every delegate (`membership-type-policy-subscription-reprice.test.ts`), instead
 * of relying on the empty-set branch being the safe one.
 *
 * ONE LENIENCY REMAINS AND IT IS PRE-EXISTING, not introduced here:
 * `loadEffectiveModuleFlags` swallows its own database errors and returns every
 * module DISABLED (it does log at error level), which resolves to `NO_BLOCK` and
 * therefore to member rates. `main` has the identical outcome through
 * `isSubscriptionEnforcementActive` — a failed flags read there skips the hard
 * block and the unpaid member books at member rates just the same — so #2543
 * neither widens nor narrows it, and fixing it belongs to whoever changes that
 * shared reader for every module in the tree.
 */
async function resolveUnpaidSubscriptionRepricedMemberIds(
  db: unknown,
  params: {
    seasonYear: number;
    memberIds: ReadonlyArray<string | null | undefined>;
    policies: ReadonlyMap<string, ResolvedMembershipTypePolicy>;
    /** The mode this request already resolved, when the caller holds one. */
    subscriptionLockoutMode?: SubscriptionLockoutMode;
  },
): Promise<ReadonlySet<string>> {
  const empty: ReadonlySet<string> = new Set<string>();
  const candidateIds = [
    ...new Set(
      params.memberIds
        .map((id) => id?.trim())
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (candidateIds.length === 0) return empty;
  if (!canReadUnpaidSubscriptionFacts(db)) {
    if (params.subscriptionLockoutMode === "NON_MEMBER_PRICING") {
      logger.warn(
        { candidateCount: candidateIds.length },
        "#2543 reprice skipped: the pricing client cannot read subscription facts while the club is in NON_MEMBER_PRICING",
      );
    }
    return empty;
  }

  const mode =
    params.subscriptionLockoutMode ?? (await peekSubscriptionLockoutMode());
  if (mode !== "NON_MEMBER_PRICING") return empty;

  return readMemberIdsOwingSubscription(db, {
    candidateIds,
    seasonYear: params.seasonYear,
    policies: params.policies,
  });
}

/**
 * Which of these members owe a required season subscription they have not paid,
 * read with NO reference to the club's lockout mode.
 *
 * THE SHARED CORE OF TWO DIFFERENT QUESTIONS, deliberately factored out rather
 * than answered twice:
 *
 *   - the #2543 REPRICE ("charge them non-member rates"), which is a money rule
 *     the club opts into and therefore fires only under `NON_MEMBER_PRICING` —
 *     see `resolveUnpaidSubscriptionRepricedMemberIds` above, which applies that
 *     gate before calling this;
 *   - whether the reciprocal other-lodge tick may be OFFERED to them at all
 *     (#2978), which the owner decided on 21 Aug 2026 is mode-INDEPENDENT —
 *     see `resolveMemberIdsOwingSubscription` below.
 *
 * It takes an already-narrowed client and an already-de-duplicated id list, so
 * each caller keeps its own early-return order (the reprice checks readability
 * before it reads the mode, so a narrow test double never triggers a settings
 * query) instead of inheriting one from here.
 */
async function readMemberIdsOwingSubscription(
  db: UnpaidSubscriptionRepriceDb,
  params: {
    seasonYear: number;
    candidateIds: ReadonlyArray<string>;
    policies: ReadonlyMap<string, ResolvedMembershipTypePolicy>;
  },
): Promise<ReadonlySet<string>> {
  const behaviorByMember = new Map(
    [...params.policies].map(([memberId, policy]) => [
      memberId,
      policy.subscriptionBehavior,
    ]),
  );
  const settlements = await loadMemberSubscriptionSettlements(db, {
    memberIds: params.candidateIds,
    seasonYear: params.seasonYear,
    subscriptionBehaviorByMember: behaviorByMember,
  });

  const owing = new Set<string>();
  for (const memberId of params.candidateIds) {
    if (
      memberUnpaidSubscriptionForcesNonMemberRate({
        isMember: true,
        subscriptionRequired:
          settlements.get(memberId)?.subscriptionRequired ?? false,
        subscriptionPaid: settlements.get(memberId)?.subscriptionPaid ?? false,
      })
    ) {
      owing.add(memberId);
    }
  }
  return owing;
}

/**
 * Which member-linked guests owe this club a subscription — the question the
 * other-lodge tick is withheld on (#2978; owner decision, 21 Aug 2026).
 *
 * MODE-INDEPENDENT, AND THAT IS THE DECISION, not an oversight. The neighbouring
 * reprice answers "does the club charge them non-member rates", which only a club
 * in `NON_MEMBER_PRICING` does. This answers "do they owe us a subscription",
 * which does not depend on what the club chose to do about it — and the owner's
 * reasoning for withholding the tick was exactly that: "the lockout exists
 * precisely to chase an unpaid subscription, and a person in that position does
 * still owe this club one". Letting reciprocity win for them would let anybody
 * lapse their subscription, claim membership of a partner lodge, and hold the
 * member rate indefinitely.
 *
 * Gating this on `NON_MEMBER_PRICING` would have left the DEFAULT configuration
 * (`MembershipLockoutSettings.mode` defaults to `HARD_BLOCK`) offering the tick to
 * an unpaid member on a `NON_MEMBER_RATE` membership type — the built-in
 * ASSOCIATE shape — which is the one combination where the rule has to bite.
 * `NO_BLOCK` was considered and deliberately included too.
 *
 * IT DOES NOT REPRICE ANYBODY. This decides which ticks may be OFFERED and
 * ACCEPTED; a flag already stored against a guest keeps pricing exactly as it did
 * (`resolveGuestRateMembershipTypes` still fences on the mode-gated reprice set),
 * so no club's existing booking moves money because of this rule. Under
 * `NON_MEMBER_PRICING` the two sets coincide and the fences agree.
 */
async function resolveMemberIdsOwingSubscription(
  db: unknown,
  params: {
    seasonYear: number;
    memberIds: ReadonlyArray<string | null | undefined>;
    policies: ReadonlyMap<string, ResolvedMembershipTypePolicy>;
  },
): Promise<ReadonlySet<string>> {
  const empty: ReadonlySet<string> = new Set<string>();
  const candidateIds = [
    ...new Set(
      params.memberIds
        .map((id) => id?.trim())
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (candidateIds.length === 0) return empty;
  // A client that cannot read these facts yields an empty set, exactly as the
  // reprice does — and that is fail-CLOSED here rather than fail-open, because
  // the same client cannot resolve a membership-type policy either, so every
  // member-flagged guest is already refused by the `!policy` rule below.
  if (!canReadUnpaidSubscriptionFacts(db)) return empty;

  return readMemberIdsOwingSubscription(db, {
    candidateIds,
    seasonYear: params.seasonYear,
    policies: params.policies,
  });
}

/**
 * Whether this guest may carry the other-lodge member rate at all (#2978).
 *
 * THE QUESTION IS "WHAT RATE IS THIS PERSON ON", NOT "IS THIS PERSON A MEMBER".
 * The original fence was `!isMember`, which was wrong in both directions. A
 * booking guest can be flagged `isMember` and still price at the club's
 * NON-member rate - most commonly a non-member contact created by
 * book-on-behalf and later re-added through the member-guest finder, which
 * filters only on `active` and age tier, so the row carries `isMember` while its
 * role resolves to the built-in NON_MEMBER type. Those people are exactly who
 * the reciprocal rate is for, and the old fence hid the tick from them.
 *
 * THE ONE CLASS THAT STAYS FENCED OUT: a member who owes this club a season
 * subscription. Under `NON_MEMBER_PRICING` they are already repriced to
 * non-member rates, and they carry `NON_MEMBER_DEFAULT` - the same rate source a
 * true non-member gets, which is deliberate (it keeps the group discount
 * treating them alike), so the rate source alone cannot separate them.
 * `isMember` plus the withheld set separates them exactly. Letting the tick
 * reach them would restore the member rate and quietly undo a lockout the club
 * configured on purpose, and — owner decision, 21 Aug 2026 — it is withheld
 * under EVERY lockout mode, because owing the subscription is the fact that
 * matters and the club's chosen response to it is not.
 *
 * THE TWO CALLERS PASS DIFFERENT SETS ON PURPOSE, so read the parameter's name
 * rather than assuming. `resolveOtherLodgeRateEligibleGuestIds` (who may be
 * ticked, on the screen and at both API boundaries) passes the MODE-INDEPENDENT
 * "owes a subscription" set. `resolveGuestRateMembershipTypes` (what a stored
 * flag is priced at) passes the mode-gated #2543 REPRICE set, so no club's
 * existing booking is repriced by the offer rule; under `NON_MEMBER_PRICING` the
 * two coincide.
 */
function guestIsOtherLodgeRateEligible(
  guest: { isMember: boolean; memberId?: string | null },
  policies: Map<string, { bookingBehavior: MembershipTypeBookingBehavior }>,
  subscriptionWithheldMemberIds: ReadonlySet<string>,
): boolean {
  // A true non-member: always eligible, and the only class the feature
  // originally served.
  if (!guest.isMember) return true;
  // Owes a subscription -> never, per the note above.
  if (guest.memberId && subscriptionWithheldMemberIds.has(guest.memberId)) {
    return false;
  }
  const policy = guest.memberId ? policies.get(guest.memberId) : undefined;
  // A member with no resolvable type prices at the member (FULL) rate below, so
  // there is no non-member rate here to replace. Fail-closed: a client that
  // cannot resolve policies at all refuses every member-flagged guest rather
  // than waving them through.
  if (!policy) return false;
  // `=== "NON_MEMBER_RATE"`, NOT `!== "MEMBER_RATE"`. The third value,
  // `BLOCK_BOOKING`, is not "on the non-member rate" — it is "may not book" —
  // and the looser test admitted it. That is unreachable today only because
  // `assertMembershipTypeBookingAllowed` refuses such a guest earlier in every
  // pricing path, which makes a money fence depend on an unrelated guard
  // continuing to exist. State the rule the fence actually means.
  return policy.bookingBehavior === "NON_MEMBER_RATE";
}

/**
 * The guests on a booking that may be offered the other-lodge member tick.
 *
 * Exists so the SCREEN, the preview and the save all answer this question from
 * the same code: the edit panel decides which rows get a tick box from this, and
 * `resolveOtherLodgeRateElection` refuses a tick on anybody outside it. Deriving
 * the two independently is how a screen ends up offering a control whose save is
 * refused.
 *
 * IT TAKES NO LOCKOUT MODE, and that absence is load-bearing (owner decision,
 * 21 Aug 2026). Somebody who owes this club a subscription is withheld the tick
 * whatever the club does about the debt, so this question never consults the
 * mode — see `resolveMemberIdsOwingSubscription`. The mode still governs the
 * #2543 REPRICE, which is a different question asked in a different place.
 */
export async function resolveOtherLodgeRateEligibleGuestIds(
  db: unknown,
  params: {
    seasonYear: number;
    guests: ReadonlyArray<{
      id: string;
      isMember: boolean;
      memberId?: string | null;
    }>;
  },
): Promise<Set<string>> {
  const eligible = new Set<string>();
  if (params.guests.length === 0) return eligible;
  // Short-circuit: with no member-flagged guest there is nothing to resolve and
  // every guest is eligible by the first rule above, so the ordinary
  // all-non-members booking costs zero extra queries.
  if (!params.guests.some((guest) => guest.isMember)) {
    for (const guest of params.guests) eligible.add(guest.id);
    return eligible;
  }
  const policies = await resolveMembershipTypePoliciesForMembers(db, {
    memberIds: params.guests.map((guest) => guest.memberId),
    seasonYear: params.seasonYear,
  });
  const owingSubscriptionMemberIds = await resolveMemberIdsOwingSubscription(db, {
    seasonYear: params.seasonYear,
    memberIds: params.guests
      .filter((guest) => guest.isMember)
      .map((guest) => guest.memberId),
    policies,
  });
  for (const guest of params.guests) {
    if (
      guestIsOtherLodgeRateEligible(guest, policies, owingSubscriptionMemberIds)
    ) {
      eligible.add(guest.id);
    }
  }
  return eligible;
}

/**
 * Resolve every guest's rate membership type + rateSource (#1930, E4, D3).
 * This REPLACES the old `applyMembershipTypeRatePolicyToGuests` boolean flip:
 *   - a non-member flagged as a partner-lodge member -> the built-in FULL type
 *     (OTHER_LODGE_MEMBER), which is the club's own member rate,
 *   - a true non-member  -> the built-in NON_MEMBER type (NON_MEMBER_DEFAULT),
 *   - a MEMBER_RATE member -> their own type (OWN_TYPE),
 *   - a member whose type forces the non-member rate (NON_MEMBER_RATE) or is
 *     otherwise non-MEMBER_RATE -> the NON_MEMBER type (TYPE_POLICY_FORCED).
 * The result is persisted as the BookingGuest.rateMembershipTypeId snapshot and
 * fed straight into calculateBookingPrice. Extends (does not fork) the shared
 * `resolveMembershipTypePoliciesForMembers` effective-type helper.
 *
 * #2543 ADDS ONE MORE WAY TO RESOLVE NON_MEMBER_DEFAULT: under a club whose
 * subscription-lockout mode is `NON_MEMBER_PRICING`, a member whose season
 * subscription is required but unpaid prices at the built-in NON_MEMBER type —
 * the SAME rate rows, the SAME Xero item code and the SAME `rateSource` as any
 * other non-member, so no new money path is introduced.
 *
 * WHY `NON_MEMBER_DEFAULT` AND NOT `TYPE_POLICY_FORCED` (owner decision, 2 Aug
 * 2026 — "priced at non-member rates"). `TYPE_POLICY_FORCED` is deliberately
 * EXCLUDED from the group-discount substitution (`policies/pricing.ts`), so
 * labelling the reprice that way charged the repriced member the raw NON_MEMBER
 * rate on every night the group discount applied, while the genuine non-member
 * standing beside them paid the substituted (FULL) rate. On the seeded fixture
 * that is 2400 c/night against 1000 c/night: the member the club decided to
 * charge "non-member rates" paid 2.4x the rate the club actually charges
 * non-members on that booking, and was financially better off if the club deleted
 * their membership record. `NON_MEMBER_DEFAULT` makes the group discount treat
 * them exactly like a real non-member, which is what the decision says.
 *
 * The pre-existing `TYPE_POLICY_FORCED` class is untouched: a member whose
 * membership TYPE forces the non-member rate is a type the club deliberately
 * configured, and its exclusion from the discount is a reasoned #1930 behaviour
 * (pinned by `pricing-rekey.test.ts` and `docs/DOMAIN_INVARIANTS.md`). #2543
 * inherited that exclusion for a large new class it was never reasoned about;
 * this is the correction, not a change to the old class.
 *
 * WHY HERE AND NOT AT THE FIVE BOOKING WRITE PATHS. The issue's requirement is
 * that the reprice is consistent across every write path. There are ~25 places
 * that price a booking (create, confirm, quote, modify preview, modify apply,
 * guest add, guest removal, group join, waitlist promotion, cross-lodge
 * promotion, booking requests, school requests, promo validation…), and a rule
 * threaded through each of them by hand is a rule that will be missing from the
 * twenty-sixth. This function is the ONE gate every one of them already passes
 * through, so putting the reprice here makes "consistent across all paths" a
 * structural property rather than a review checklist. The cost is one settings
 * read per pricing call, which returns before any further query in the two modes
 * that are not `NON_MEMBER_PRICING`.
 */
export async function resolveGuestRateMembershipTypes<
  Guest extends {
    isMember: boolean;
    memberId?: string | null;
    /**
     * The reciprocal other-club rate opt-in (Other Lodges epic). Optional on the
     * constraint so every existing caller compiles unchanged: a caller that does
     * not carry the flag resolves exactly as it did before this field existed.
     */
    otherLodgeMember?: boolean | null;
  },
>(
  db: unknown,
  params: {
    seasonYear: number;
    guests: ReadonlyArray<Guest>;
    /**
     * The subscription-lockout mode this REQUEST already resolved (#2543).
     *
     * Pass it wherever the caller holds one, which is every booking write path —
     * they all resolve it to decide whether to run their HARD_BLOCK refusal. Two
     * reasons, both about correctness rather than speed:
     *
     *  1. CONSISTENCY. Without it every pricing call re-read the mode
     *     independently and uncached, so an admin saving the panel mid-request
     *     could have the route gate branch on one regime and the price computed
     *     under the other — the exact "priced as a member here, refused there"
     *     drift #2543 exists to remove. `modify-quote` performs seven or more
     *     pricing calls in one request and differences two of them into the
     *     member's settlement delta, so a save landing between those two calls
     *     made the delta wrong by the whole member/non-member spread.
     *  2. CONNECTIONS. This function runs inside booking transactions that hold
     *     the per-lodge capacity lock. Reading the settings through the module
     *     client there checks out a SECOND pool connection underneath the lock,
     *     which `docs/CONCURRENCY_AND_LOCKING.md` names as the pool-starvation
     *     shape and forbids twice by name for `validateMinimumStay` and
     *     `loadAdultMemberHostingPolicy`. Being handed the mode removes the read
     *     entirely.
     *
     * Omitting it is still correct — the mode is peeked as a fallback for callers
     * that genuinely hold none — but every in-transaction caller should pass it.
     */
    subscriptionLockoutMode?: SubscriptionLockoutMode;
  },
): Promise<Array<Guest & GuestRateResolution>> {
  const policies = await resolveMembershipTypePoliciesForMembers(db, {
    memberIds: params.guests.map((guest) => guest.memberId),
    seasonYear: params.seasonYear,
  });

  // #2543. Only the ids of guests flagged as members are offered: a row whose
  // `isMember` snapshot is false already prices at the non-member rate, so
  // asking about their subscription would be a pointless query and a pointless
  // disclosure.
  const unpaidRepricedMemberIds = await resolveUnpaidSubscriptionRepricedMemberIds(
    db,
    {
      seasonYear: params.seasonYear,
      memberIds: params.guests
        .filter((guest) => guest.isMember)
        .map((guest) => guest.memberId),
      policies,
      subscriptionLockoutMode: params.subscriptionLockoutMode,
    },
  );

  // Built-in type ids: the NON_MEMBER default target, plus a key->id map that
  // backfills any built-in fallback policy whose membershipType.id is null.
  const typeIdByKey = new Map<string, string>();
  if (isMembershipTypePolicyDb(db)) {
    const types = (await db.membershipType.findMany({
      where: { key: { in: [...BUILT_IN_MEMBERSHIP_TYPE_KEYS] } },
      select: { id: true, key: true },
    })) as Array<{ id: string; key: string }>;
    for (const type of types) {
      typeIdByKey.set(type.key, type.id);
    }
  }

  const requireTypeId = (id: string | null | undefined, label: string): string => {
    if (!id) {
      throw new Error(
        `Cannot price booking: membership type "${label}" is not present in the database.`,
      );
    }
    return id;
  };
  const nonMemberTypeId = () =>
    requireTypeId(
      typeIdByKey.get(NON_MEMBER_MEMBERSHIP_TYPE_KEY),
      NON_MEMBER_MEMBERSHIP_TYPE_KEY,
    );
  // Member-rate fallback for a member whose specific type cannot be resolved
  // (no memberId — e.g. an orphaned guest whose member row was SetNull'd — or
  // no policy row). Mirrors both the old engine (any isMember guest priced at
  // the member rate) and the Xero NULL-snapshot fallback (isMember -> FULL), so
  // day-one resolution stays byte-identical.
  const fullTypeId = () => requireTypeId(typeIdByKey.get("FULL"), "FULL");

  return params.guests.map((guest) => {
    // Other Lodges epic: a non-member the booking officer has recognised as a
    // member of the booking's partner lodge prices from the built-in FULL type's
    // rows — the club's own member rate, at this guest's own age tier.
    //
    // FIRST, and deliberately so. It is an explicit, audited human decision about
    // one named person on one booking, so it outranks every rule below, all of
    // which are derived from the guest's own record.
    //
    // #2978 WIDENED THE FENCE FROM `!isMember` TO "prices at the non-member
    // rate", which is the question this feature was always asking - see
    // `guestIsOtherLodgeRateEligible`. The half of the old fence that MATTERS is
    // kept there: a member repriced by the #2543 unpaid-subscription lockout is
    // still refused, so a tick can never undo a lockout. The API boundary
    // refuses the same set too - this is the second fence, not the only one.
    if (guest.otherLodgeMember &&
        guestIsOtherLodgeRateEligible(guest, policies, unpaidRepricedMemberIds)) {
      return {
        ...guest,
        rateMembershipTypeId: fullTypeId(),
        rateSource: "OTHER_LODGE_MEMBER" as const,
      };
    }
    if (!guest.isMember) {
      // True non-member: the only class the group discount may substitute.
      return {
        ...guest,
        rateMembershipTypeId: nonMemberTypeId(),
        rateSource: "NON_MEMBER_DEFAULT" as const,
      };
    }
    // #2543: an unpaid subscription forces the non-member rate BEFORE the
    // member's own type is consulted, so it overrides MEMBER_RATE. Placed first
    // deliberately — a member whose type says MEMBER_RATE is exactly the member
    // this rule is about, and reading the type first would leave the rule with
    // no effect on anyone.
    //
    // `NON_MEMBER_DEFAULT`, i.e. treated as a real non-member by the group
    // discount too. See the note on this function: `TYPE_POLICY_FORCED` is
    // excluded from the discount substitution, which made the repriced member
    // pay MORE than the non-member beside them. The set is empty in every mode
    // but `NON_MEMBER_PRICING`, so no club that has not opted in reaches here.
    if (guest.memberId && unpaidRepricedMemberIds.has(guest.memberId)) {
      return {
        ...guest,
        rateMembershipTypeId: nonMemberTypeId(),
        rateSource: "NON_MEMBER_DEFAULT" as const,
      };
    }
    const policy = guest.memberId ? policies.get(guest.memberId) : undefined;
    if (!policy) {
      // A member with no resolvable type prices at the member (FULL) rate.
      return {
        ...guest,
        rateMembershipTypeId: fullTypeId(),
        rateSource: "OWN_TYPE" as const,
      };
    }
    if (policy.bookingBehavior === "MEMBER_RATE") {
      const ownId =
        policy.membershipType.id ?? typeIdByKey.get(policy.membershipType.key);
      return {
        ...guest,
        rateMembershipTypeId: requireTypeId(ownId, policy.membershipType.key),
        rateSource: "OWN_TYPE" as const,
      };
    }
    // NON_MEMBER_RATE, or BLOCK_BOOKING (blocked before pricing): both price
    // from the built-in NON_MEMBER type's rows.
    return {
      ...guest,
      rateMembershipTypeId: nonMemberTypeId(),
      rateSource: "TYPE_POLICY_FORCED" as const,
    };
  });
}

/**
 * Read-time fallback for the group-discount substitution target (#1930, E4).
 * A GroupDiscountSetting row created AFTER the re-key migration (the admin
 * route's old upsert-create, or any hand-inserted row) carries a NULL
 * rateMembershipTypeId; without this fallback an enabled discount would be
 * silently inert (the engine only substitutes when a target id is present),
 * where main's boolean flip always discounted. Resolve NULL to the built-in
 * FULL type — the same target the migration seeds — so the discount always
 * works. No-op (no query) when the discount is disabled or already targeted.
 */
export async function resolveGroupDiscountRateType(
  db: unknown,
  groupDiscount: GroupDiscountConfig | undefined,
): Promise<GroupDiscountConfig | undefined> {
  if (!groupDiscount?.enabled || groupDiscount.rateMembershipTypeId) {
    return groupDiscount;
  }
  if (!isMembershipTypePolicyDb(db)) {
    return groupDiscount;
  }
  const [fullType] = (await db.membershipType.findMany({
    where: { key: { in: ["FULL"] } },
    select: { id: true },
  })) as Array<{ id: string }>;
  return fullType
    ? { ...groupDiscount, rateMembershipTypeId: fullType.id }
    : groupDiscount;
}

export async function priceBookingGuestsWithMembershipTypePolicy(
  db: unknown,
  input: {
    ownerMemberId?: string | null;
    checkIn: Date;
    checkOut: Date;
    guests: UnratedGuestInput[];
    seasons: SeasonRateData[];
    groupDiscount?: GroupDiscountConfig;
    seasonYear?: number;
    /**
     * Forwarded to the policy guard below (privacy re-review of MG3 #2308,
     * finding 2). An admin/on-behalf or unattended system path passes `true` and
     * keeps the detailed refusal; everything else leaves it unset, which is the
     * safe direction — the worst case of forgetting it is an officer being shown
     * the neutral sentence, where the worst case of defaulting the other way is a
     * stranger's name on a member's screen.
     */
    skipAuthorization?: boolean;
    /**
     * #2543 — forwarded verbatim to `resolveGuestRateMembershipTypes`; see the
     * note on its own `subscriptionLockoutMode` for why an in-transaction caller
     * should always pass the mode its request already resolved.
     */
    subscriptionLockoutMode?: SubscriptionLockoutMode;
  },
): Promise<PriceBreakdown> {
  const seasonYear = input.seasonYear ?? seasonYearOfStoredDate(input.checkIn);
  await assertMembershipTypeBookingAllowed(db, {
    ownerMemberId: input.ownerMemberId,
    guests: input.guests,
    seasonYear,
    skipAuthorization: input.skipAuthorization,
  });
  const [ratedGuests, groupDiscount] = await Promise.all([
    resolveGuestRateMembershipTypes(db, {
      seasonYear,
      guests: input.guests,
      subscriptionLockoutMode: input.subscriptionLockoutMode,
    }),
    resolveGroupDiscountRateType(db, input.groupDiscount),
  ]);
  return calculateBookingPrice(
    input.checkIn,
    input.checkOut,
    ratedGuests,
    input.seasons,
    groupDiscount,
  );
}

// Structural read seam so the NOT_REQUIRED-row dominance check works with
// PrismaClient, a transaction client, and test doubles alike.
type MemberSubscriptionStatusReadDb = {
  memberSubscription: {
    findFirst(args: {
      where: { memberId: string; seasonYear: number; status: "NOT_REQUIRED" };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
};

function canReadMemberSubscriptionStatus(
  db: unknown,
): db is MemberSubscriptionStatusReadDb {
  const candidate = db as Partial<MemberSubscriptionStatusReadDb> | null | undefined;
  return typeof candidate?.memberSubscription?.findFirst === "function";
}

async function hasNotRequiredSubscriptionRow(
  db: unknown,
  params: { memberId: string; seasonYear: number },
): Promise<boolean> {
  if (!canReadMemberSubscriptionStatus(db)) {
    return false;
  }
  const row = await db.memberSubscription.findFirst({
    where: {
      memberId: params.memberId,
      seasonYear: params.seasonYear,
      status: "NOT_REQUIRED",
    },
    select: { id: true },
  });
  return row !== null;
}

export async function requiresPaidSubscriptionForMemberForBooking(
  db: unknown,
  params: {
    memberId: string;
    seasonYear: number;
    ageTier: AgeTier | null | undefined;
  },
): Promise<boolean> {
  const policy = await resolveMembershipTypePolicyForMember(db, {
    memberId: params.memberId,
    seasonYear: params.seasonYear,
  });
  if (policy?.subscriptionBehavior === "NOT_REQUIRED") {
    return false;
  }
  // #2149: role-based subscription exemption dropped. Membership type is the sole
  // authority — a bare ADMIN/LODGE account resolves (via the role→default-type
  // fallback) to its own NOT_REQUIRED built-in type and is caught above, while a
  // fee-paying human who holds the admin permission carries a REQUIRED membership
  // type and now correctly owes a subscription.
  // BASED_ON_AGE_TIER (issue #2041): the type defers its subscription-required
  // answer to the per-age-tier flag (decision Q2 — the same
  // AgeTierSetting.subscriptionRequiredForBooking that gates invoice minting).
  // A NOT_REQUIRED MemberSubscription row for the season is authoritative and
  // dominates: the annual-fee sweep writes it for a tier-exempt member (season-
  // start age), so it keeps the booking gate consistent with billing even if
  // the stored ageTier is later promoted mid-season (decision Q4). This keeps
  // one coherent meaning of "not required" (DOMAIN_INVARIANTS paid-up
  // one-meaning). Scoped to BASED_ON_AGE_TIER so REQUIRED/NOT_REQUIRED types are
  // byte-unchanged (no extra query on their booking path).
  if (
    policy?.subscriptionBehavior === "BASED_ON_AGE_TIER" &&
    (await hasNotRequiredSubscriptionRow(db, {
      memberId: params.memberId,
      seasonYear: params.seasonYear,
    }))
  ) {
    return false;
  }
  return requiresPaidSubscriptionForBooking(params.ageTier);
}
