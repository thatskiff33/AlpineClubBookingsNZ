import {
  AdminReviewStatus,
  BookingStatus,
  Prisma,
  type MemberGuestConsentStatus,
  type PrismaClient,
} from "@prisma/client";

import {
  hostingCoverageStateKey,
  openOrUpdateHostingCoverageIncident,
  resolveHostingCoverageIncidents,
  type HostingCoverageIncidentCause,
  type HostingCoverageIncidentOutcome,
  type HostingCoverageIncidentResolution,
} from "@/lib/adult-member-hosting-coverage-incidents";
import {
  lockHostingCoverageOwner,
  lockHostingCoverageOwners,
  tryLockHostingCoverageOwner,
  tryLockHostingCoverageOwners,
} from "@/lib/adult-member-hosting-coverage-lock";
import { lockAdultMemberHostingPolicySet } from "@/lib/adult-member-hosting-policy-set";
import {
  enqueueHostingCoverageReevaluation,
  type HostingCoverageReevaluationInput,
} from "@/lib/adult-member-hosting-coverage-queue";
import {
  acquireHostingCoverageQueueParticipantProof,
  assertHostingCoverageQueueParticipantsLocked,
  HostingCoverageParticipantRetryError,
  lockHostingCoverageMemberLifecycleTarget,
  type HostingCoverageQueueParticipantProof,
  type HostingCoverageSourceParticipant,
} from "@/lib/adult-member-hosting-queue-participants";
import {
  SameOwnerCoverageOverrideRequiredError,
  SameOwnerCoverageWouldBreakError,
  sameBookingOwnerCoverageSourceWhere,
  sameOwnerCoverageDependentWhere,
  strandedCoverageStateKey,
  strandedCoverageReference,
  type StrandedCoverageBooking,
} from "@/lib/adult-member-hosting-same-owner";
import { ApiError } from "@/lib/api-error";
import type {
  AdultMemberHostingPolicyExceptionViolation,
  AggregatedPolicyExceptions,
} from "@/lib/booking-policy-exceptions";
import { aggregatePolicyExceptionViolations } from "@/lib/booking-policy-exceptions";
import {
  ACTIVE_BOOKING_STATUSES,
  isHostingCoverageSourceBookingStatus,
} from "@/lib/booking-status";
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
  getTodayDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import { getDefaultLodgeId } from "@/lib/lodges";
import logger from "@/lib/logger";
import { isOperationallyPresentConsent } from "@/lib/member-guest-consent";
import { prisma } from "@/lib/prisma";
import {
  adultMemberHostingReviewChanged,
  adultMemberHostingStateKey,
  evaluateAdultMemberHostingWithPolicy,
  hostingModeIsActive,
  resolveAdultMemberHostingPolicy,
  type EffectiveAdultMemberHostingMode,
  type HostingParticipant,
  type ResolvedAdultMemberHostingPolicy,
} from "@/lib/policies/adult-member-hosting";
import type { SubscriptionLockoutMode } from "@/lib/membership-lockout-settings";
import {
  loadUnpaidSubscriptionMemberIds,
  type SubscriptionLockoutDb,
} from "@/lib/subscription-lockout-enforcement";
import type { AgeTierSettingsReader } from "@/lib/subscription-lockout-facts";
import { getSeasonYear } from "@/lib/utils";

/**
 * Booking-side integration for the adult-member hosting policy (#2364).
 *
 * The evaluator in `policies/adult-member-hosting.ts` is pure; this module is
 * the only place that turns a persisted booking into evaluator input and turns
 * the answer back into review state. Keeping it in one place is what makes the
 * "any change re-evaluates" requirement tractable: every booking mutation calls
 * `reconcileAdultMemberHostingReviewWithSiblings`, and none of them has to
 * understand the rule.
 *
 * The reconciler is IDEMPOTENT and derives everything from live rows, so calling
 * it twice, or from a path that changed nothing, is a no-op that writes nothing.
 * That is deliberate — it means a new call site can be added anywhere without
 * having to reason about what the previous one did.
 *
 * WHICH ENTRY POINT TO CALL. `reconcileAdultMemberHostingReview` answers for ONE
 * booking id. That is not enough for a mutator, because `loadSiblingHosts` makes
 * a split child's answer a function of its PARENT's rows: shortening the
 * member's own stay on the parent removes a host from the child, and extending
 * it restores one, without a single row on the child changing. A mutator that
 * reconciled only the id it was handed would therefore leave the other half of a
 * #738 split pair asserting facts that are no longer true — in both directions,
 * defeating hazard detection AND the issue's automatic clear. Every mutation
 * path calls `reconcileAdultMemberHostingReviewWithSiblings`; the single-id form
 * is for callers that already hold every id in the family and reconcile each one
 * deliberately (booking creation, which must attach an admin's decision to the
 * right row).
 */

/**
 * The narrow client this service needs; a `Prisma.TransactionClient` satisfies it.
 *
 * The member/subscription/membership-type delegates are #2543's: under a club
 * running `NON_MEMBER_PRICING` a member with an unpaid subscription stops
 * counting as a host, and that fact has to be read before the evaluator runs.
 * They are part of the required shape rather than optional because a caller that
 * quietly could not read them would silently restore the unpaid member as a
 * host — a rule that is off when nobody notices is worse than no rule.
 */
export type AdultMemberHostingReadDb = Pick<
  PrismaClient,
  | "booking"
  | "adultMemberHostingPolicy"
  | "lodge"
  | "member"
  | "memberSubscription"
  | "seasonalMembershipAssignment"
  | "membershipType"
>;

export type AdultMemberHostingReviewDb = AdultMemberHostingReadDb & Pick<
  PrismaClient,
  // #2576: the same-owner coverage machinery. The incident and the queue row are
  // written INSIDE the caller's transaction alongside the change that caused them
  // (§8), and the audit row with them, so they are part of the required shape
  // rather than optional extras — a caller that quietly could not write them
  // would allow an authoritative change and lose the obligation to check what it
  // broke, which is the one failure this design must not have.
  | "hostingCoverageIncident"
  | "hostingCoverageReevaluation"
  | "auditLog"
  | "$executeRaw"
>;

/** The narrow client the policy read needs on its own. */
export type AdultMemberHostingPolicyDb = Pick<
  PrismaClient,
  "adultMemberHostingPolicy" | "lodge"
>;

/**
 * Resolve the adult-member hosting policy in force at one lodge (#2364).
 *
 * The table holds at most one club-wide row plus one row per lodge, so both
 * candidates come back in a single query and `resolveAdultMemberHostingPolicy`
 * decides between them. A lodge with no row, or an INHERIT row, falls through to
 * the club default; a club with no row at all resolves DISABLED.
 *
 * COMPOSITION RULE — `db`. The same rule `validateMinimumStay` carries
 * (`booking-policies.ts`), and binding for the same reason: **a caller already
 * inside `prisma.$transaction` MUST pass its own `tx`.** Reaching for the
 * module-level client while the caller holds `pg_advisory_xact_lock(1)` and a
 * per-lodge capacity lock checks out a SECOND pool connection underneath both,
 * which is the pool-starvation shape the ordering rule at the top of
 * `member-guest-add-policy.ts` exists to forbid; passing `tx` also makes the
 * read see the transaction's own snapshot rather than a second, later one.
 * Callers genuinely outside a transaction keep the default.
 *
 * Deliberately declared HERE rather than beside `validateMinimumStay`, even
 * though the two are siblings. A dozen booking tests blanket-mock
 * `@/lib/booking-policies` with non-spreading factories, so an export added
 * there is missing from every one of them the moment a booking path calls it —
 * the same reason `over-capacity-confirmation.ts` lives outside `@/lib/capacity`.
 *
 * Throws `UnknownAdultMemberHostingScopeError` when no lodge can be resolved,
 * rather than answering "disabled" for a scope it could not identify.
 */
export async function loadAdultMemberHostingPolicy(
  lodgeId?: string | null,
  db: AdultMemberHostingPolicyDb = prisma,
): Promise<ResolvedAdultMemberHostingPolicy> {
  const effectiveLodgeId = lodgeId ?? (await getDefaultLodgeId(db));
  const rows = await db.adultMemberHostingPolicy.findMany({
    where: { OR: [{ lodgeId: effectiveLodgeId }, { lodgeId: null }] },
    select: {
      id: true,
      scopeKey: true,
      lodgeId: true,
      mode: true,
      capacityMode: true,
      version: true,
      // #2569's second dimension. Named explicitly because this select is
      // narrowed: omitting them would hand the resolver `undefined`s, which it
      // reads as "this row did not decide" — so a lodge with a custom scope set
      // would silently fall back to the club's, or to the built-in default, and
      // the club's rule would be quietly widened or narrowed. The db parameter is
      // a hand-written narrow interface, so a stale column name here is NOT a
      // typecheck error — it is a runtime Prisma validation failure on every
      // booking write path. `adult-member-hosting-call-sites.test.ts` pins the
      // selected set against the schema for that reason.
      hostScopeSameBooking: true,
      hostScopeSameBookingOwner: true,
    },
  });
  return resolveAdultMemberHostingPolicy(rows, effectiveLodgeId);
}

const BOOKING_HOSTING_SELECT = {
  id: true,
  memberId: true,
  parentBookingId: true,
  lodgeId: true,
  checkIn: true,
  checkOut: true,
  // #2576: a booking that is no longer happening has no attendance, so it has no
  // hosting hazard. See `bookingAttendanceIsTerminal`.
  status: true,
  deletedAt: true,
  adultMemberHostingReview: true,
  adultMemberHostingReviewStatus: true,
  guests: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      stayStart: true,
      stayEnd: true,
      // #2364 review finding: a member guest who has not accepted their invite
      // is not operationally present (D-12), so they cannot host. See
      // `toHostingParticipants`.
      consentStatus: true,
      nights: { select: { stayDate: true } },
      member: {
        select: {
          id: true,
          ageTier: true,
          active: true,
          cancelledAt: true,
          archivedAt: true,
        },
      },
    },
  },
} as const;

type LoadedHostingBooking = {
  id: string;
  memberId: string;
  parentBookingId: string | null;
  lodgeId: string;
  checkIn: Date;
  checkOut: Date;
  status: BookingStatus | string;
  deletedAt: Date | null;
  adultMemberHostingReview: unknown;
  adultMemberHostingReviewStatus: AdminReviewStatus | null;
  guests: Array<{
    id: string;
    firstName: string;
    lastName: string;
    stayStart: Date;
    stayEnd: Date;
    consentStatus: MemberGuestConsentStatus | null;
    nights: Array<{ stayDate: Date }>;
    member: {
      id: string;
      ageTier: string;
      active: boolean;
      cancelledAt: Date | null;
      archivedAt: Date | null;
    } | null;
  }>;
};

/**
 * Turn persisted guest rows into evaluator participants.
 *
 * Nights come from the sparse `BookingGuestNight` rows (#713), which are the
 * authoritative per-night record and the only representation that gets a
 * non-contiguous stay right. Rows predating #713 have none, so those fall back
 * to the guest's own stayStart..stayEnd envelope — the same fallback the rest of
 * the codebase uses, and never the BOOKING's range, which would credit a guest
 * with nights they are not staying.
 *
 * `member` is the live Member row, not the guest's `isMember` snapshot. See the
 * module header of `policies/adult-member-hosting.ts` for why.
 *
 * `operationallyPresent` is the shared D-12 predicate (`member-guest-consent`),
 * the same one the kiosk, the arrival roster, bed allocation and the arrival
 * emails filter on. A member guest whose invite is still `PENDING` is kept off
 * every one of those surfaces, so counting them as a host here would let a
 * member suppress the review with an adult who never agreed to come — and the
 * lodge would then receive the non-member guests unaccompanied, which is
 * precisely the situation the rule exists to flag. `null` (no consent was ever
 * needed) and `CONFIRMED` are present; nothing else is.
 */
export function toHostingParticipants(
  booking: Pick<LoadedHostingBooking, "guests">,
  hostOnly = false,
): HostingParticipant[] {
  return booking.guests.map((guest) => {
    const nights =
      guest.nights.length > 0
        ? guest.nights.map((night) => formatDateOnly(night.stayDate))
        : eachDateOnlyInRange(guest.stayStart, guest.stayEnd).map(formatDateOnly);
    return {
      guestRef: guest.id,
      guestName: `${guest.firstName} ${guest.lastName}`.trim(),
      member: guest.member,
      nights,
      operationallyPresent: isOperationallyPresentConsent(guest.consentStatus),
      ...(hostOnly ? { hostOnly: true } : {}),
    };
  });
}

/**
 * The people staying with this booking's party who are carried on a SIBLING
 * booking row: its direct parent, or its direct children, belonging to the SAME
 * member and still live.
 *
 * This is the split-booking shape (#738) and nothing else. The same-member
 * filter is what keeps a group booking out: a joiner's booking hangs off the
 * organiser's, but belongs to a different member, so the organiser's adults are
 * never borrowed to host somebody else's guests. Cancelled, bumped and
 * soft-deleted rows are excluded — a bumped sibling is not staying.
 */
function hostingSiblingWhere(
  booking: Pick<LoadedHostingBooking, "id" | "memberId" | "parentBookingId">,
): Prisma.BookingWhereInput {
  const relatedIds: Prisma.BookingWhereInput[] = [
    { parentBookingId: booking.id },
  ];
  if (booking.parentBookingId) relatedIds.push({ id: booking.parentBookingId });

  return {
    OR: relatedIds,
    memberId: booking.memberId,
    deletedAt: null,
    status: { notIn: [BookingStatus.CANCELLED, BookingStatus.BUMPED] },
    id: { not: booking.id },
  };
}

async function loadSiblingHosts(
  booking: LoadedHostingBooking,
  db: AdultMemberHostingReadDb,
  /**
   * A DETERMINISTIC CEILING, supplied only by a read-only evidence caller.
   *
   * This read is deliberately unbounded for a WRITER: the hosting answer it
   * computes has to see every sibling that could cover a night, and silently
   * truncating it would change the rule. A diagnostic has a different obligation --
   * it must either answer or say it could not -- and it also has the widest fan-out
   * in either tool pack, because each sibling arrives with its guests and their
   * night rows. So an evidence caller passes a ceiling and gets `ceiling + 1` rows
   * back, which makes "there were more than I may read" a distinguishable fact
   * rather than a quietly short list.
   *
   * Omitted by every writer, whose behaviour is therefore byte-identical.
   */
  siblingCeiling?: number,
): Promise<{ participants: HostingParticipant[]; siblingIds: string[] }> {
  const siblings = (await db.booking.findMany({
    where: hostingSiblingWhere(booking),
    select: BOOKING_HOSTING_SELECT,
    ...(siblingCeiling === undefined
      ? {}
      : {
          // A total order, so a bound that binds binds reproducibly rather than
          // returning any N of the matching rows.
          orderBy: [{ checkIn: "asc" as const }, { id: "asc" as const }],
          take: siblingCeiling + 1,
        }),
  })) as LoadedHostingBooking[];
  if (siblingCeiling !== undefined && siblings.length > siblingCeiling) {
    throw new HostingSiblingCeilingExceededError(siblingCeiling);
  }

  return {
    participants: siblings
      // A sibling that arrived without its guest relation contributes no hosts.
      // Dropping it is the safe direction here: fewer borrowed hosts can only
      // OPEN a review for an admin to look at, never suppress one.
      .filter((sibling) => Array.isArray(sibling.guests))
      .flatMap((sibling) => toHostingParticipants(sibling, true)),
    siblingIds: siblings.map((sibling) => sibling.id),
  };
}

/**
 * A hard ceiling on how many same-owner source bookings one evaluation reads
 * (#2576 §10: "use suitable indexes and bounded result limits").
 *
 * Generous rather than tight, because it is a guard and not a policy: a member
 * with more than this many CONFIRMED-or-PAID bookings at ONE lodge overlapping ONE
 * stay is a data problem, not a club member. Twenty-five is far beyond anything the
 * split-booking and family shapes produce (a #738 split pair is two), and the read
 * is already narrowed to one owner, one lodge and one date window before the limit
 * applies.
 *
 * FAILING SAFE MEANS FAILING TOWARDS THE RULE: if the ceiling ever truncated, fewer
 * hosts are seen, so a night reads as uncovered and the booking is flagged or
 * refused rather than quietly allowed.
 */
const SAME_OWNER_COVERAGE_SOURCE_LIMIT = 25;

/**
 * The ceiling on the DEPENDENT reads, which needs its own name because the
 * safe-failure argument above INVERTS for them.
 *
 * A truncated SOURCE read sees fewer hosts, so it errs towards flagging. A
 * truncated DEPENDENT read misses a booking entirely: it is neither refused under
 * `BLOCK` nor escalated, and the drain silently skips it — the failure direction is
 * "a stranded booking nobody hears about". Same number, opposite meaning, so it is a
 * separate constant that cannot be tuned by somebody reasoning about the other one.
 *
 * A DETERMINISTIC ORDER AND A WARNING WHEN IT BINDS. `take` with no `orderBy` leaves
 * Postgres free to return any 25 of the matching rows, so an over-limit account
 * could refuse a change on one request and allow it on the next. Ordering by
 * `checkIn` then `id` makes the truncation reproducible, and
 * `warnIfCoverageDependentCeilingBound` makes it visible — reaching 26 active
 * same-owner bookings at ONE lodge over ONE overlapping window is a data problem
 * rather than a member, and it must not be a silent one.
 */
const SAME_OWNER_COVERAGE_DEPENDENT_LIMIT = 25;

/** Deterministic truncation for both dependent reads. */
const SAME_OWNER_COVERAGE_DEPENDENT_ORDER = [
  { checkIn: "asc" },
  { id: "asc" },
] as const satisfies readonly Prisma.BookingOrderByWithRelationInput[];

/**
 * Say so when a bounded dependent read filled its ceiling.
 *
 * Not an error: the read is still correct for everything it returned, and throwing
 * would turn a data anomaly into a failed member request. But a truncation here can
 * hide a stranded booking, so it must reach the logs with enough context
 * (owner, lodge) for an operator to find the account.
 */
function warnIfCoverageDependentCeilingBound(
  where: { memberId: string; lodgeId: string },
  returned: number,
  read: string,
): void {
  if (returned < SAME_OWNER_COVERAGE_DEPENDENT_LIMIT) return;
  logger.warn(
    {
      memberId: where.memberId,
      lodgeId: where.lodgeId,
      limit: SAME_OWNER_COVERAGE_DEPENDENT_LIMIT,
      read,
    },
    "Same-owner hosting coverage dependent read hit its ceiling; a dependent booking may not have been evaluated",
  );
}

/**
 * The qualifying-adult-member candidates attending ANOTHER eligible booking on the
 * SAME account, at the same lodge, over nights that overlap this stay (#2576 §1
 * to §4).
 *
 * Three things about the returned rows carry the whole scope:
 *
 *  - `hostScope: "SAME_BOOKING_OWNER"` — the evaluator counts them only where the
 *    club has that scope switched on. That is the seam #2569 left, used exactly as
 *    intended: no branch of the rule changed to add this scope.
 *  - `hostOnly: true` — their own nights are NOT this booking's responsibility.
 *    This is also §15's capacity answer: the adult member's REAL attendance on
 *    their own booking is recognised as evidence here, and they are never
 *    duplicated as a guest on this one, so no bed is double-counted.
 *  - the participant shape is `toHostingParticipants`' — the same live Member
 *    facts, the same sparse `BookingGuestNight` nights, the same D-12 consent
 *    predicate. §13 forbids a second definition of a qualifying adult member and
 *    there is none: whether these people actually qualify is decided afterwards by
 *    `participantQualifiesAsHost`, exactly as for the booking's own guests.
 *
 * THE GUEST READ IS NARROWED TO MEMBER-LINKED ROWS, which is a true narrowing
 * rather than a policy: a guest with no Member link can never host under any
 * scope, so loading a source booking's non-member guests would be loading rows the
 * evaluator is guaranteed to ignore. Their own nights are that booking's problem
 * and are judged when that booking is reconciled.
 *
 * SPLIT SIBLINGS ARE EXCLUDED, deliberately. A #738 split pair is one party the
 * database stores as two rows, and the invariant is that such a sibling supplies
 * cover under `SAME_BOOKING` — not as "another booking at the lodge". Loading it
 * here as well would put one person in the participant list twice and would make
 * the same-booking half of the rule reachable through the same-owner half.
 */
async function loadSameBookingOwnerHosts(
  booking: Pick<
    LoadedHostingBooking,
    "id" | "memberId" | "lodgeId" | "checkIn" | "checkOut"
  >,
  db: Pick<AdultMemberHostingReviewDb, "booking">,
  excludeBookingIds: readonly string[],
  /**
   * A DETERMINISTIC CEILING, supplied only by a read-only evidence caller — the
   * same distinction `loadSiblingHosts` draws, for the same reason, on the OTHER
   * host population.
   *
   * The writer's `SAME_OWNER_COVERAGE_SOURCE_LIMIT` truncates, and the docblock on
   * that constant argues correctly that truncating is safe FOR A WRITER: fewer
   * hosts are seen, so a night reads as uncovered and the booking is flagged or
   * refused rather than quietly allowed. That argument INVERTS for evidence. A
   * diagnostic that misses the sibling carrying the covering adult reports
   * `policy_adult_member_hosting` as a LIVE BLOCKER on a booking that is actually
   * covered — a fabricated finding, which is the opposite of safe — and because the
   * writer's read carries no `orderBy`, two invocations could disagree about the
   * same booking with nothing on the row to say so.
   *
   * So an evidence caller passes a ceiling, gets a total order and `ceiling + 1`
   * rows, and gets a REFUSAL when the bound binds. Omitted by every writer, whose
   * read is byte-identical to before.
   */
  sameOwnerSourceCeiling?: number,
): Promise<HostingParticipant[]> {
  const where = sameBookingOwnerCoverageSourceWhere(booking);
  const sources = (await db.booking.findMany({
    where:
      excludeBookingIds.length > 0
        ? { ...where, id: { not: booking.id, notIn: [...excludeBookingIds] } }
        : where,
    take:
      sameOwnerSourceCeiling === undefined
        ? SAME_OWNER_COVERAGE_SOURCE_LIMIT
        : sameOwnerSourceCeiling + 1,
    ...(sameOwnerSourceCeiling === undefined
      ? {}
      : {
          // A total order, so a bound that binds binds reproducibly rather than
          // returning any N of the matching rows.
          orderBy: [{ checkIn: "asc" as const }, { id: "asc" as const }],
        }),
    select: {
      id: true,
      guests: {
        // Member-linked rows only — see the narrowing note above.
        where: { memberId: { not: null } },
        select: BOOKING_HOSTING_SELECT.guests.select,
      },
    },
  })) as Array<{ id: string; guests: LoadedHostingBooking["guests"] }>;
  if (
    sameOwnerSourceCeiling !== undefined &&
    sources.length > sameOwnerSourceCeiling
  ) {
    throw new HostingSameOwnerSourceCeilingExceededError(sameOwnerSourceCeiling);
  }

  return sources
    .filter((source) => Array.isArray(source.guests))
    .flatMap((source) =>
      toHostingParticipants(source, true).map((participant) => ({
        ...participant,
        hostScope: "SAME_BOOKING_OWNER" as const,
      })),
    );
}

/**
 * Raised when an evidence caller's sibling ceiling binds.
 *
 * A NAMED ERROR rather than a truncated list, because the two readings are
 * different answers: a short list says "these are the hosts", and this says "I
 * cannot tell you". Only a caller that passed a ceiling can see it.
 */
export class HostingSiblingCeilingExceededError extends Error {
  constructor(ceiling: number) {
    super(
      `Adult-member hosting evidence: more than ${ceiling} sibling bookings could cover these nights; refusing an inconclusive answer`,
    );
    this.name = "HostingSiblingCeilingExceededError";
  }
}

/**
 * The same refusal for the OTHER host population, and a separate class rather than
 * a shared one.
 *
 * The two populations are different questions with different remedies: a bound
 * sibling read means a #738 split family has grown implausibly wide, and a bound
 * same-owner read means one member holds more than the ceiling of active bookings
 * at ONE lodge overlapping ONE stay. An operator handed "I cannot tell you" needs to
 * know which, and a single message naming both would name the wrong one half the
 * time. It is the same reason the writer keeps `SAME_OWNER_COVERAGE_SOURCE_LIMIT`
 * and `SAME_OWNER_COVERAGE_DEPENDENT_LIMIT` apart at the same number.
 */
export class HostingSameOwnerSourceCeilingExceededError extends Error {
  constructor(ceiling: number) {
    super(
      `Adult-member hosting evidence: more than ${ceiling} same-owner bookings at this lodge could cover these nights; refusing an inconclusive answer`,
    );
    this.name = "HostingSameOwnerSourceCeilingExceededError";
  }
}

/**
 * The ids of the bookings whose hosting answer depends on THIS booking's rows —
 * exactly the set `loadSiblingHosts` borrows from, computed with the same
 * predicate so the two can never drift apart.
 *
 * The dependency is symmetric by construction: if A borrows B's adults, then a
 * change to B's adults changes A's answer. That is why the fan-out below reads
 * the same relation the borrow does.
 */
async function loadHostingSiblingIds(
  bookingId: string,
  db: AdultMemberHostingReviewDb,
): Promise<string[]> {
  const booking = (await db.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, memberId: true, parentBookingId: true },
  })) as Pick<LoadedHostingBooking, "id" | "memberId" | "parentBookingId"> | null;
  if (!booking) return [];

  const siblings = (await db.booking.findMany({
    where: hostingSiblingWhere(booking),
    select: { id: true },
  })) as Array<{ id: string }>;
  return siblings.map((sibling) => sibling.id);
}

/**
 * Evaluate one PERSISTED booking against the hosting policy in force at its
 * lodge. Returns null when the policy is disabled or every non-member
 * guest-night is covered.
 *
 * `db` follows the same composition rule as `validateMinimumStay`: a caller
 * already inside `prisma.$transaction` MUST pass its own `tx`.
 */
async function evaluateLoadedBookingAdultMemberHosting(
  booking: LoadedHostingBooking,
  db: AdultMemberHostingReadDb,
  acquireCoverageOwnerLock: (() => Promise<void>) | null,
  /**
   * The season the subscription bridge judges settlement in, when the caller has
   * already resolved it authoritatively. Omitted by every writer, which runs
   * behind a gated request that has seeded the financial-year cache; supplied by
   * read-only evidence callers, which cannot. See
   * `evaluatePersistedBookingAdultMemberHostingReadOnly`.
   */
  seasonYear?: number,
  /**
   * The club's lockout mode, when the caller has read it authoritatively. Same
   * reason as `seasonYear`: the bridge otherwise peeks it through readers that turn
   * a database failure into `NO_BLOCK`, so an evidence caller would report a
   * fabricated hosting answer for an enforcing club after one transient failure.
   */
  subscriptionLockoutMode?: SubscriptionLockoutMode,
  /** See `loadSiblingHosts`; supplied only by a read-only evidence caller. */
  siblingCeiling?: number,
  /**
   * See `loadSameBookingOwnerHosts`. The OTHER host population, with its own
   * ceiling because it is a different population — a wide split family and a member
   * holding many bookings at one lodge are different data problems.
   */
  sameOwnerSourceCeiling?: number,
  /**
   * How the #2543 subscription bridge reads the club's age-tier rule. Omitted by
   * every writer, which takes the cached reader that falls back to
   * `AGE_TIER_DEFAULTS`; supplied by a read-only evidence caller, whose strict
   * reader rejects a failed read rather than judging a named member's hosting
   * qualification against a tier rule nobody observed. See `AgeTierSettingsReader`.
   */
  readAgeTierSettings?: AgeTierSettingsReader,
): Promise<{
  violation: AdultMemberHostingPolicyExceptionViolation | null;
  resolved: ResolvedAdultMemberHostingPolicy;
}> {
  const resolved = await loadAdultMemberHostingPolicy(booking.lodgeId, db);

  // A booking that is no longer happening has no hosting hazard (#2576).
  //
  // NECESSARY, NOT TIDY, and the cancel path is why. `reconcileAdultMemberHostingReview`
  // refuses an ENFORCED violation by throwing, and a cancelled booking's guest rows
  // survive the cancellation — so without this guard, reconciling a cancellation at
  // an enforcing lodge would evaluate a party that is not coming, find its
  // non-member guests uncovered, and REFUSE THE CANCELLATION. Every cancel at such
  // a lodge would fail. Returning "no hazard" instead also does the right thing to
  // the review row: the reconciler clears it, which is exactly what a cancelled
  // booking's hosting review should be.
  //
  // Deliberately status-based rather than date-based: a stay in the past is still a
  // real historical attendance record (§3), and its review is history, not a
  // hazard to re-open or clear.
  if (bookingAttendanceIsTerminal(booking)) {
    return { violation: null, resolved };
  }

  // Skip the sibling read entirely while the policy is off: it is the only query
  // this evaluation adds to every booking write, and a club that has not turned
  // the rule on should pay nothing for it.
  //
  // The SAME-OWNER read is skipped on that principle and one more: a club with the
  // rule on but `SAME_BOOKING_OWNER` off pays nothing either, which is what keeps
  // the #2569 upgrade a no-op on cost as well as on answers.
  let participants: HostingParticipant[] = [];
  if (hostingModeIsActive(resolved.mode)) {
    const siblings = await loadSiblingHosts(booking, db, siblingCeiling);
    // §9: hold the per-owner key before reading another booking as cover, so a
    // concurrent removal of that cover cannot interleave with this evaluation.
    // Re-entrant, so a caller that already took it (the settle step) pays nothing.
    if (resolved.hostScopes.sameBookingOwner && acquireCoverageOwnerLock) {
      await acquireCoverageOwnerLock();
    }
    participants = await withSubscriptionSettlement(
      [
        ...toHostingParticipants(booking),
        ...siblings.participants,
        ...(resolved.hostScopes.sameBookingOwner
          ? await loadSameBookingOwnerHosts(
              booking,
              db,
              siblings.siblingIds,
              sameOwnerSourceCeiling,
            )
          : []),
      ],
      db,
      seasonYear ?? getSeasonYear(booking.checkIn),
      subscriptionLockoutMode,
      readAgeTierSettings,
    );
  }
  const violation = evaluateAdultMemberHostingWithPolicy(participants, resolved);
  return { violation, resolved };
}

/**
 * Evaluate a booking already loaded by a mutation path.
 *
 * This is the lock-owning form used by reconcilers. Read-only consumers must use
 * `evaluatePersistedBookingAdultMemberHostingReadOnly` below instead of acquiring
 * an advisory lock merely to inspect current evidence.
 */
export async function evaluateBookingAdultMemberHosting(
  booking: LoadedHostingBooking,
  db: AdultMemberHostingReviewDb,
  failFastCoverageOwner = false,
): Promise<{
  violation: AdultMemberHostingPolicyExceptionViolation | null;
  resolved: ResolvedAdultMemberHostingPolicy;
}> {
  return evaluateLoadedBookingAdultMemberHosting(booking, db, async () => {
    if (!failFastCoverageOwner) {
      await lockHostingCoverageOwner(db, booking.memberId);
      return;
    }
    if (!(await tryLockHostingCoverageOwner(db, booking.memberId))) {
      throw new HostingCoverageParticipantRetryError();
    }
  });
}

/**
 * Pure read-only persisted-booking evaluation for evidence surfaces.
 *
 * This is not a second hosting rule. It loads the exact canonical persisted
 * snapshot and delegates to the same participant construction, split-sibling
 * borrow, same-owner exclusion, subscription bridge and pure policy evaluator as
 * the lock-owning reconciler above. It deliberately takes no advisory lock: a
 * diagnostic read may span READ COMMITTED instants and must report that limitation,
 * but it must never join a writer lock cohort or mutate database state.
 *
 * `seasonYear` EXISTS BECAUSE THIS FORM HAS NO GATED REQUEST BEHIND IT. The
 * subscription bridge (#2543) judges settlement in a membership season, and the
 * season comes from `getSeasonYear`, which reads the process-level financial-year
 * cache in `financial-year.ts`. Writers reach this rule through routes that have
 * already called `refreshFinancialYearConfig`; a read-only evidence caller has
 * not, so on a cold process the cache is still the March default and a club with
 * any other year-end month would have its hosts judged against a season row that
 * is not theirs — silently, and in whichever direction the calendar happens to
 * fall. Such a caller resolves the year-end month from STORED state, refuses when
 * it cannot be resolved without a provider call, and passes the season here.
 */
export async function evaluatePersistedBookingAdultMemberHostingReadOnly(
  bookingId: string,
  db: AdultMemberHostingReadDb = prisma,
  options?: {
    seasonYear?: number;
    subscriptionLockoutMode?: SubscriptionLockoutMode;
    /**
     * A deterministic ceiling on the sibling fan-out. An evidence caller passes one
     * because it must either answer or report that it could not; a writer must not,
     * because truncating that read would change the hosting rule.
     */
    siblingCeiling?: number;
    /**
     * The same, for the SAME-OWNER coverage sources. Separate from
     * `siblingCeiling` because the populations are separate: the writer's own read
     * TRUNCATES at 25 with no order, which errs towards flagging for a writer and
     * towards a FABRICATED blocker for evidence.
     */
    sameOwnerSourceCeiling?: number;
    /**
     * How the subscription bridge reads the age-tier rule. Same split as
     * `seasonYear` and `subscriptionLockoutMode`: this form has no gated request
     * behind it, so it cannot accept a reader that answers a failed database read
     * with the platform's default tiers. See `AgeTierSettingsReader`.
     */
    readAgeTierSettings?: AgeTierSettingsReader;
  },
): Promise<{
  violation: AdultMemberHostingPolicyExceptionViolation | null;
  resolved: ResolvedAdultMemberHostingPolicy;
} | null> {
  const booking = (await db.booking.findUnique({
    where: { id: bookingId },
    select: BOOKING_HOSTING_SELECT,
  })) as LoadedHostingBooking | null;
  if (!booking) return null;
  return evaluateLoadedBookingAdultMemberHosting(
    booking,
    db,
    null,
    options?.seasonYear,
    options?.subscriptionLockoutMode,
    options?.siblingCeiling,
    options?.sameOwnerSourceCeiling,
    options?.readAgeTierSettings,
  );
}


/**
 * Is this booking's attendance over or abandoned?
 *
 * CANCELLED and BUMPED are the two terminal statuses in the booking lifecycle, and
 * `deletedAt` is the soft-delete an archived booking carries. None of the three
 * describes people who are coming to the lodge, so none of them can hold a hosting
 * hazard, supply cover, or need cover.
 *
 * The same three exclusions the eligible-SOURCE filter applies
 * (`hostingCoverageSourceBookingFilter`), stated here for the booking being
 * JUDGED rather than for the bookings supplying evidence — the two questions are
 * different and both need answering.
 */
export function bookingAttendanceIsTerminal(
  booking: Pick<LoadedHostingBooking, "status" | "deletedAt">,
): boolean {
  if (booking.deletedAt != null) return true;
  return (
    booking.status === BookingStatus.CANCELLED ||
    booking.status === BookingStatus.BUMPED
  );
}

/**
 * Read whether the queued SOURCE booking is no longer attending (#2596).
 *
 * This is deliberately a direct id lookup rather than an inference from
 * `loadSameOwnerCoverageDependentIds`: that list is capped, so an active source
 * can legitimately sort beyond its first 25 rows. A missing row is a hard-deleted
 * booking and therefore terminal for the same purpose as the soft-delete and
 * terminal lifecycle states handled by `bookingAttendanceIsTerminal`.
 *
 * The drain passes its existing transaction client after taking the policy-set,
 * member-lifecycle and Member-row locks, so this authoritative lifecycle read is
 * made in the same reconciliation transaction as the bounded dependent read and
 * incident writes.
 */
export async function isHostingCoverageSourceBookingTerminal(
  bookingId: string,
  db: AdultMemberHostingReviewDb,
): Promise<boolean> {
  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: { status: true, deletedAt: true },
  });
  return booking === null || bookingAttendanceIsTerminal(booking);
}

/**
 * Stamp #2543's `subscriptionSettled` onto participants, so a member the club is
 * charging as a non-member stops counting as a host.
 *
 * A NO-OP outside `NON_MEMBER_PRICING`: `loadUnpaidSubscriptionMemberIds`
 * returns an empty set without querying, the field stays absent, and the
 * hosting answer is byte-identical to pre-#2543 for every club that has not
 * opted in. It also runs only once the policy has already resolved to
 * ADMIN_REVIEW_REQUIRED, so a club with hosting off pays nothing either.
 */
async function withSubscriptionSettlement(
  participants: HostingParticipant[],
  db: SubscriptionLockoutDb,
  seasonYear: number,
  mode?: SubscriptionLockoutMode,
  readAgeTierSettings?: AgeTierSettingsReader,
): Promise<HostingParticipant[]> {
  const unpaid = await loadUnpaidSubscriptionMemberIds(db, {
    memberIds: participants.map((participant) => participant.member?.id),
    seasonYear,
    mode,
    ...(readAgeTierSettings ? { readAgeTierSettings } : {}),
  });
  if (unpaid.size === 0) return participants;
  return participants.map((participant) => {
    const memberId = participant.member?.id;
    return memberId && unpaid.has(memberId)
      ? { ...participant, subscriptionSettled: false }
      : participant;
  });
}

/**
 * Read a stored snapshot back without trusting it.
 *
 * The column is JSON, so a hand-edited or partially-written value is possible.
 * A value that does not carry the two fields the comparison actually reads is
 * treated as "no snapshot", which reopens the review rather than silently
 * comparing against nonsense.
 */
export function parseStoredHostingReview(
  value: unknown,
): AdultMemberHostingPolicyExceptionViolation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.reasonCode !== "ADULT_MEMBER_HOSTING_REQUIRED") return null;
  if (typeof row.policyId !== "string") return null;
  if (typeof row.policyVersion !== "number") return null;
  const requirements = row.requirements;
  if (!requirements || typeof requirements !== "object") return null;
  const uncovered = (requirements as Record<string, unknown>).uncovered;
  if (!Array.isArray(uncovered)) return null;
  return value as AdultMemberHostingPolicyExceptionViolation;
}

export type HostingReviewOutcome = (
  | /** Nothing was written: no hazard before, no hazard now. */
  { action: "none"; violation: null }
  /** The hazard cleared; any pending hosting review was released. */
  | { action: "cleared"; violation: null }
  /** A hazard is recorded and its review state was left exactly as it was. */
  | { action: "unchanged"; violation: AdultMemberHostingPolicyExceptionViolation }
  /** A hazard appeared on a booking that had none, and now awaits a decision. */
  | { action: "opened"; violation: AdultMemberHostingPolicyExceptionViolation }
  /** A materially different hazard replaced a decided one; it awaits a decision again. */
  | { action: "reopened"; violation: AdultMemberHostingPolicyExceptionViolation }
) & {
  /**
   * The mode the evaluation actually ran under; `null` when there was no
   * booking row to evaluate. Reported so a caller can tell "no hazard" from
   * "the club has not turned this on" without a second policy read — which is
   * what lets the sibling fan-out below stay free for a club that is not using
   * the rule.
   */
  mode: EffectiveAdultMemberHostingMode | null;
};

/**
 * How this caller wants the ENFORCED consequence applied (#2569 §1 and §13).
 *
 * `REFUSE` — the default, and what "stop booking unless corrected or an exception
 * is approved" means: an ENFORCED violation throws
 * `AdultMemberHostingRequiredError` from inside the caller's transaction, so the
 * non-compliant write rolls back and no review row is written for a booking that
 * does not exist. Default rather than opt-in deliberately: a write path added
 * later inherits the club's rule instead of quietly escaping it.
 *
 * `REVIEW_ONLY` — evaluate and record exactly as the review consequence does, and
 * never refuse. Reserved for the SCHOOL AND ORGANISATION workflows, which §13
 * excludes from this expanded enforcement in as many words: those bookings run a
 * separate officer-managed process and may be supervised by teachers, leaders or
 * custodians who do not map onto the adult club-member host rule at all. They keep
 * the pre-#2569 behaviour — the hazard is still recorded and surfaced, so an
 * officer sees it, but the booking is never stopped by this policy.
 */
export type HostingEnforcement = "REFUSE" | "REVIEW_ONLY";

/**
 * How a change that would strand ANOTHER same-owner booking's cover is handled
 * (#2576 §6 versus §7/§8).
 *
 * `BLOCK` — the ordinary member self-service answer. The dependent bookings are
 * re-evaluated against the rows the caller just wrote, and if any of them is left
 * uncovered the change is REFUSED with
 * `SameOwnerCoverageWouldBreakError`, thrown from inside the caller's transaction
 * so the change rolls back and the member is told which of their bookings, which
 * lodge and which nights.
 *
 * `ESCALATE` — the §7 and §8 answer. The change is allowed, and the bounded
 * re-evaluation work it implies is recorded durably in the SAME transaction; after
 * commit the drain re-reads the facts, opens or updates an urgent compliance
 * incident for anything newly uncovered, and notifies the owner and the officer
 * queue. Nothing is cancelled and no beds or payments move.
 *
 * `REQUIRE_OVERRIDE` — the §7 CONFIRMATION STEP for an authorised officer. The
 * dependent bookings are re-evaluated exactly as under `BLOCK`, and if the change
 * would strand one the officer is answered with
 * `SameOwnerCoverageOverrideRequiredError` naming the affected bookings and nights.
 * That is not a block on their change: it is a block on the UNCONFIRMED one. They
 * re-submit with `hostingCoverageOverride`, which produces `ESCALATE` carrying
 * `OFFICER_OVERRIDE` and their mandatory reason. Where nothing would be stranded it
 * behaves identically to `ESCALATE`, so the confirmation is asked for only when
 * there is something to confirm.
 *
 * `ESCALATE` IS THE DEFAULT, and that is the opposite choice from `enforcement`
 * above — deliberately, because the failure directions are opposite. A path that
 * inherits `REFUSE` and should not have been enforced merely annoys somebody; a
 * path that inherited `BLOCK` and should not have would ROLL BACK an authoritative
 * change — a membership lapse, an administrative cancellation, a payment-lifecycle
 * transition, a cron sweep — which §8 forbids in as many words and which would
 * wedge the system rather than protect anybody. `ESCALATE` is never silence: it
 * produces a durable incident, an officer-queue entry, an audit trail and an owner
 * notification.
 *
 * IT IS ALSO WHY `REQUIRE_OVERRIDE` IS NOT THE DEFAULT. §8's list of changes that
 * cannot reasonably be blocked includes every automated path, and those never go
 * through `hostingCoverageActorOptions` — they call this module with the default, so
 * they can never be refused for want of a confirmation nobody is there to give.
 *
 * The member self-service paths therefore pass `BLOCK` explicitly, and
 * `adult-member-hosting-call-sites.test.ts` pins that set tree-wide so a new
 * member-facing edit route cannot quietly inherit the escalating behaviour.
 */
export type HostingDependentCoverageDisposition =
  | "BLOCK"
  | "REQUIRE_OVERRIDE"
  | "ESCALATE";

/** Who did the escalating change and why, for the incident and the audit trail. */
export interface HostingCoverageChangeContext {
  /**
   * `OFFICER_OVERRIDE` for §7 (an authorised officer deliberately overrode the
   * refusal, with a mandatory reason), `SYSTEM_CHANGE` for §8 (an authoritative
   * change outside the ordinary member edit flow).
   */
  cause: HostingCoverageIncidentCause;
  actorMemberId?: string | null;
  /** Mandatory for `OFFICER_OVERRIDE`; refused without one. */
  reason?: string | null;
  /** Exact stranded state the officer was shown before confirming the override. */
  strandedStateKey?: string | null;
}

/**
 * The reconcile options for an ACTOR-DRIVEN booking change (#2576 §6 versus §7/§8).
 *
 * One helper rather than a hand-written pair of fields at every call site, because
 * the distinction it encodes is a policy and not a local judgement, and because a
 * site that got it backwards would either trap a member or silently let cover be
 * removed. `adult-member-hosting-call-sites.test.ts` pins the set of files that use
 * it.
 *
 * THE RULE, straight from the owner's text:
 *
 *  - AN ORDINARY MEMBER'S SELF-SERVICE CHANGE IS BLOCKED (§6). They are told which
 *    of their own bookings, which lodge and which nights, and directed to amend
 *    that booking, restore alternative cover, or contact a Booking Officer.
 *  - AN AUTHORISED OFFICER'S CHANGE IS ALLOWED AND ESCALATED (§7, §8). §8 lists
 *    "authorised officer action" among the changes that cannot reasonably be
 *    blocked, and §7 describes what must happen instead: the affected booking stays
 *    confirmed with its beds and payments, gets an urgent compliance incident, the
 *    owner is notified, and the whole thing is audited. Refusing an officer would
 *    also be circular — they are the authority the member's refusal points to.
 *
 * WHERE THE OFFICER'S REASON COMES FROM (§7). It is not inferred and it is never
 * invented: the surface has to have captured an explicit confirmation and a reason,
 * which every officer-capable route now accepts as `hostingCoverageOverride` — the
 * same shape the `no-emails` route uses for an acknowledged admin action. With one,
 * the change escalates as `OFFICER_OVERRIDE` recorded against the officer's member
 * id with their reason on the incident. Without one, the officer is ASKED for it: the
 * disposition is `REQUIRE_OVERRIDE`, which refuses only when the change would
 * actually strand a dependent booking, and answers with the affected bookings and
 * nights so the confirmation dialog can state what is being overridden.
 *
 * WHY NOT JUST RECORD IT HONESTLY AS AN UNEXPLAINED SYSTEM CHANGE, which is what
 * this helper did first. Because it made §7's mandatory reason unreachable: no caller
 * supplied one, so `OFFICER_OVERRIDE`, `HostingCoverageIncident.overrideReason` and
 * `overriddenByMemberId` were dead outside tests, every officer change looked
 * identical to a cron sweep in the audit trail, and an officer removing the last
 * qualifying adult was given no indication that another booking was about to be
 * stranded. Asking is the only way the reason exists.
 *
 * THE ACTOR'S OWN IDENTITY IS PART OF THE ANSWER (§6, §11). `coverageActorMemberId`
 * travels with the disposition because `BLOCK` names the owner's OTHER bookings in
 * its refusal, and that is only safe to show the owner. See the ownership check in
 * `settleSameOwnerDependentCoverage`.
 */
export function hostingCoverageActorOptions(actor: {
  /** The session role at the acting site; "ADMIN" is the officer case. */
  actorRole?: string | null;
  /** Additionally treat a delegated bookings-edit permission as officer authority. */
  hasBookingsEditAccess?: boolean;
  actorMemberId?: string | null;
  /**
   * The officer's explicit confirmation and mandatory reason (§7), as captured by
   * the surface. Both parts are required: an acknowledgement with no reason, or a
   * reason with no acknowledgement, is not an override and the officer is asked
   * again.
   */
  override?: {
    acknowledged?: boolean;
    reason?: string | null;
    strandedStateKey?: string | null;
  } | null;
}): Pick<
  HostingReconcileOptions,
  "dependentCoverage" | "coverageChange" | "coverageActorMemberId"
> {
  const actorMemberId = actor.actorMemberId ?? null;
  const isOfficer =
    actor.actorRole === "ADMIN" || actor.hasBookingsEditAccess === true;
  if (!isOfficer) {
    return {
      dependentCoverage: "BLOCK",
      coverageActorMemberId: actorMemberId,
      // Carried even though a member's change is normally refused rather than
      // escalated, because it is NOT always refused: a member acting on a booking
      // that is not theirs (a member-linked guest removing their own row) is
      // allowed and escalated instead, and the audit row for that escalation has to
      // name who did it. See `resolveDependentDisposition`.
      coverageChange: {
        cause: "SYSTEM_CHANGE",
        actorMemberId,
        reason: null,
      },
    };
  }

  const reason = actor.override?.reason?.trim();
  const strandedStateKey = actor.override?.strandedStateKey?.trim();
  if (!actor.override?.acknowledged || !reason || !strandedStateKey) {
    return {
      dependentCoverage: "REQUIRE_OVERRIDE",
      coverageActorMemberId: actorMemberId,
      // Still `SYSTEM_CHANGE` with the officer named, for the case where nothing
      // is stranded and the change simply proceeds: no override happened, so
      // recording one would be a lie.
      coverageChange: {
        cause: "SYSTEM_CHANGE",
        actorMemberId,
        reason: null,
      },
    };
  }

  return {
    dependentCoverage: "ESCALATE",
    coverageActorMemberId: actorMemberId,
    coverageChange: {
      cause: "OFFICER_OVERRIDE",
      actorMemberId,
      reason,
      strandedStateKey,
    },
  };
}

export interface HostingReconcileOptions {
  /**
   * Status to use when a hazard is opened for the FIRST time on this booking.
   * Defaults to PENDING. `APPROVED` requires `decision`, so an admin path
   * cannot auto-approve without recording who decided and why (D-R4).
   */
  openedStatus?: AdminReviewStatus;
  decision?: { reason: string; byMemberId: string } | null;
  /** See `HostingEnforcement`. Defaults to `REFUSE`. */
  enforcement?: HostingEnforcement;
  /**
   * See `HostingDependentCoverageDisposition`. Defaults to `ESCALATE`. Read only
   * by `reconcileAdultMemberHostingReviewWithSiblings` — the single-id form
   * settles one booking's own review and never reaches across accounts.
   */
  dependentCoverage?: HostingDependentCoverageDisposition;
  /** Required context for an `ESCALATE` change; see `HostingCoverageChangeContext`. */
  coverageChange?: HostingCoverageChangeContext;
  /**
   * The member who is making this change, when there is one (#2576 §6, §11).
   *
   * NOT the booking owner and not interchangeable with it — that conflation is the
   * disclosure this field exists to prevent. `BLOCK`'s refusal names the OWNER's
   * other bookings, and the guest DELETE route deliberately lets a member from
   * another account remove their own row from someone else's booking, so the
   * refusal can be reached by an actor with no right to see it. Supplied by
   * `hostingCoverageActorOptions` at every actor-driven site; absent on the
   * automated paths, which never `BLOCK`.
   */
  coverageActorMemberId?: string | null;
}

/**
 * Bring a booking's hosting review into line with its CURRENT authoritative
 * facts, and report what changed.
 *
 * The rules, in the order they are applied:
 *
 *  - **No hazard now.** Clear the snapshot and the review. This is the "if every
 *    night becomes hosted, clear the pending review automatically" requirement,
 *    and it fires for every reason a hazard can end: an adult member was added,
 *    a non-member guest left, the nights moved, the member was reinstated, the
 *    lodge's policy was switched off, or the booking moved to a lodge that never
 *    had the rule. A DECIDED review is cleared too — the thing that was decided
 *    no longer exists, so leaving it would leave the booking permanently
 *    labelled with a hazard nobody can see in its guest list.
 *  - **Hazard, none recorded before.** Open it as PENDING. `openedStatus` lets a
 *    caller that has ALREADY captured an explicit decision (an admin on-behalf
 *    reason, per D-R4) open it as APPROVED instead — but only by supplying that
 *    reason, which is what stops a silent auto-approval.
 *  - **Hazard, and the recorded one is materially different.** Reopen as PENDING
 *    and drop the previous decision: a different set of uncovered guest-nights,
 *    or a different policy revision, is a different question.
 *  - **Hazard, materially identical.** Write nothing. An admin's decision stands
 *    while the hazard it was made about stands, and the guest list shuffling
 *    underneath it does not re-prompt them.
 */
export async function reconcileAdultMemberHostingReview(
  bookingId: string,
  db: AdultMemberHostingReviewDb,
  options: HostingReconcileOptions = {},
  failFastCoverageOwner = false,
  participantContext?: {
    proof: HostingCoverageQueueParticipantProof;
    actorMemberId: string | null;
  },
): Promise<HostingReviewOutcome> {
  const booking = (await db.booking.findUnique({
    where: { id: bookingId },
    select: BOOKING_HOSTING_SELECT,
  })) as LoadedHostingBooking | null;
  if (!booking) return { action: "none", violation: null, mode: null };
  // A row that came back without its guest relation is a narrowed select or a
  // partially-hydrated row, not a booking with nobody on it. Refuse to evaluate
  // it rather than conclude "no hazard" from absent evidence — that conclusion
  // would CLEAR a live review. Same reasoning as the `!= null` on `recorded`
  // below: when the facts are missing, write nothing.
  if (!Array.isArray(booking.guests)) {
    return { action: "none", violation: null, mode: null };
  }
  if (participantContext) {
    assertHostingCoverageQueueParticipantsLocked(participantContext.proof, {
      memberId: booking.memberId,
      lodgeId: booking.lodgeId,
      sourceBookingId: booking.id,
      actorMemberId: participantContext.actorMemberId,
    });
  }

  const { violation, resolved } = await evaluateBookingAdultMemberHosting(
    booking,
    db,
    failFastCoverageOwner,
  );
  const mode = resolved.mode;

  // The ENFORCED consequence (#2569 §1): do not confirm a non-compliant booking.
  //
  // BEFORE any review write, and therefore before the caller's transaction can
  // commit. Throwing here rather than recording a review is the difference the
  // owner asked for: under review the booking exists and waits for an officer,
  // under enforced it never existed, and the member is handed the same
  // exception door instead. The write the caller just made rolls back with the
  // throw, so a modification that would have broken the rule leaves no trace.
  //
  // `REVIEW_ONLY` is the school/organisation carve-out (§13) — see
  // `HostingEnforcement`.
  //
  // AN EXPLICIT DECISION IS AN APPROVAL, so it is not refused. `options.decision`
  // is only ever set by a path that captured an admin's on-behalf reason (D-R4),
  // which is an officer approving this exact party with an attributable reason —
  // the same authority the exception door leads to. Refusing it would mean an
  // officer could approve a hosting exception for a booking they may not make.
  if (
    violation !== null &&
    mode === "ENFORCED" &&
    (options.enforcement ?? "REFUSE") === "REFUSE" &&
    !options.decision
  ) {
    throw new AdultMemberHostingRequiredError(violation);
  }

  const previous = parseStoredHostingReview(booking.adultMemberHostingReview);
  // `!= null` on purpose: a narrowed select, a partially-hydrated row or a test
  // double can leave the field UNDEFINED, and treating that as "a status is
  // recorded" would make this write a clearing UPDATE to a booking that never
  // had a hosting review.
  const recorded = previous !== null || booking.adultMemberHostingReviewStatus != null;

  if (violation === null) {
    if (!recorded) return { action: "none", violation: null, mode };
    await db.booking.update({
      where: { id: bookingId },
      data: {
        // `Prisma.DbNull`, not `null`: on a nullable Json column `null` is
        // ambiguous between the SQL NULL and the JSON value `null`, so Prisma
        // refuses it. SQL NULL is what "no hazard recorded" means here.
        adultMemberHostingReview: Prisma.DbNull,
        adultMemberHostingReviewStatus: null,
        adultMemberHostingReviewReason: null,
        adultMemberHostingReviewedById: null,
        adultMemberHostingReviewedAt: null,
      },
    });
    return { action: "cleared", violation: null, mode };
  }

  if (!recorded) {
    const openedStatus = options.openedStatus ?? AdminReviewStatus.PENDING;
    const decision =
      openedStatus === AdminReviewStatus.PENDING ? null : options.decision ?? null;
    if (openedStatus !== AdminReviewStatus.PENDING && !decision) {
      // D-R4 in code: the only way out of PENDING at open time is an explicit,
      // attributable reason. A caller that wants to auto-approve must have
      // captured one, and a programming error here fails loudly rather than
      // quietly approving.
      throw new Error(
        "Opening an adult-member hosting review as anything but PENDING requires an explicit decision reason",
      );
    }
    await db.booking.update({
      where: { id: bookingId },
      data: {
        adultMemberHostingReview: violation,
        adultMemberHostingReviewStatus: openedStatus,
        adultMemberHostingReviewReason: decision?.reason ?? null,
        adultMemberHostingReviewedById: decision?.byMemberId ?? null,
        adultMemberHostingReviewedAt: decision ? new Date() : null,
      },
    });
    return { action: "opened", violation, mode };
  }

  if (!adultMemberHostingReviewChanged(previous, violation)) {
    return { action: "unchanged", violation, mode };
  }

  await db.booking.update({
    where: { id: bookingId },
    data: {
      adultMemberHostingReview: violation,
      adultMemberHostingReviewStatus: AdminReviewStatus.PENDING,
      adultMemberHostingReviewReason: null,
      adultMemberHostingReviewedById: null,
      adultMemberHostingReviewedAt: null,
    },
  });
  return { action: "reopened", violation, mode };
}

/**
 * Reconcile a booking AND the split siblings whose answer depends on it (#2364).
 *
 * THE ENTRY POINT EVERY MUTATION PATH USES. `loadSiblingHosts` lets a #738 split
 * child borrow its parent's adults, which makes the child's answer a function of
 * rows the child does not own: the member shortening their own stay on the
 * parent takes a host away from the child, and extending it gives one back,
 * without touching a single row on the child. Reconciling only the mutated id
 * would leave the other half of the pair asserting facts that are no longer
 * true — no review where the club now has unhosted guest-nights, and a stale
 * PENDING review where it no longer does.
 *
 * The fan-out is ONE LEVEL and that is exact, not a safety margin: the borrow
 * relation is direct-parent / direct-child of the same member, so expanding from
 * a sibling could only ever lead back to the booking just reconciled. Each
 * sibling is reconciled with DEFAULT options — an admin's on-behalf decision
 * belongs to the booking they were making, never to a row reached through it, so
 * a hazard that appears on a sibling always opens PENDING.
 *
 * Costs no extra SIBLING work while the rule is off: the mode reported by the
 * first reconciliation is the same one it evaluated under, so a club that has
 * not turned the policy on never fans out.
 *
 * AND IT NOW COSTS NO FENCE EITHER (#2623 T5). This used to acquire the
 * participant proof BEFORE reading the policy mode, so a club with hosting
 * disabled paid the `FOR KEY SHARE NOWAIT` statement and its two under-lock
 * re-reads on every booking write — and could still be refused with the fixed
 * `HOSTING_COVERAGE_PARTICIPANT_RETRY` 409 by a concurrent member-lifecycle
 * writer, for a rule it does not use. That 409 tells a member to reload and to
 * check their payment status, which at such a club is a scary, payment-flavoured
 * refusal produced entirely by a switched-off feature guarding a queue row that
 * would never be written.
 *
 * The mode is therefore read FIRST, as the sibling seam
 * `enqueueOwnHostingCoverageReevaluation` also does, and an inactive mode returns
 * through the plain single-booking reconciler — which is what the fenced path did
 * anyway once `outcome.mode` came back inactive, minus the lock. The single-id
 * reconciler still runs, because clearing a snapshot left behind by a lodge that
 * has since switched the rule off is exactly its job.
 *
 * THE THRESHOLD IS NOT THE SIBLING'S, and the difference is deliberate rather than
 * drift (#2623 F5). That seam gates on `resolved.mode !== "ENFORCED"`, because all
 * it does is enqueue queue work that only an ENFORCED lodge can ever act on. This
 * one gates on `hostingModeIsActive` — ENFORCED *or* ADMIN_REVIEW_REQUIRED —
 * because under review-only the dependants still have to be re-read and a review
 * snapshot still has to be written, so the fence is genuinely owed. Narrowing this
 * to the sibling's test skips the fence at a review-only lodge that needs it, and
 * the `ADMIN_REVIEW_REQUIRED` case in `adult-member-hosting-same-owner.test.ts`
 * fails if you try it.
 *
 * SKIPPING THE FENCE HERE IS SAFE, not merely cheap: with the mode inactive
 * `evaluateBookingAdultMemberHosting` takes no coverage-owner advisory key, so
 * there is no coverage-owner → Member ordering left to protect, and neither the
 * sibling fan-out nor `settleSameOwnerDependentCoverage` — the two things that
 * consume the proof — is reachable. A club that turns the rule ON between this
 * read and the reconciler's own read is covered the same way every other mode
 * gate in this module is: the policy write holds the policy-set key and enqueues
 * re-evaluation for the affected bookings itself.
 */
export async function reconcileAdultMemberHostingReviewWithSiblings(
  bookingId: string,
  db: AdultMemberHostingReviewDb,
  options: HostingReconcileOptions = {},
): Promise<HostingReviewOutcome> {
  // #2597: acquire the exact queue owner/actor Member rows BEFORE the first
  // evaluation can take a coverage-owner advisory key. Acquiring only inside
  // the later settle step would invert coverage-owner -> Member against merge.
  const plannedBooking = (await db.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      memberId: true,
      lodgeId: true,
      checkIn: true,
      checkOut: true,
    },
  })) as CoverageOwnerFacts | null;
  if (!plannedBooking) {
    return { action: "none", violation: null, mode: null };
  }
  // #2623 T5: the mode gate comes BEFORE the fence. See the docstring above for
  // why an inactive lodge must not pay a row lock, and why skipping it here
  // cannot leave a coverage-owner key held out of order.
  const planned = await loadAdultMemberHostingPolicy(plannedBooking.lodgeId, db);
  if (!hostingModeIsActive(planned.mode)) {
    return reconcileAdultMemberHostingReview(bookingId, db, options, true);
  }
  const actorMemberId = options.coverageChange?.actorMemberId ?? null;
  const participantProof = await acquireOrValidateQueueParticipantProof(
    [sourceParticipant(plannedBooking)],
    actorMemberId,
    db,
  );

  const outcome = await reconcileAdultMemberHostingReview(
    bookingId,
    db,
    options,
    true,
    { proof: participantProof, actorMemberId },
  );
  if (outcome.mode === null || !hostingModeIsActive(outcome.mode)) return outcome;

  for (const siblingId of await loadHostingSiblingIds(bookingId, db)) {
    // DEFAULT options, except that the caller's enforcement choice travels: an
    // admin's on-behalf decision belongs to the booking they were making and
    // never to a row reached through it, but a school booking's §13 carve-out
    // has to reach its split sibling too — otherwise one half of a #738 pair is
    // exempt and the other is refused, for the same party.
    await reconcileAdultMemberHostingReview(
      siblingId,
      db,
      {
        ...(options.enforcement ? { enforcement: options.enforcement } : {}),
      },
      true,
    );
  }

  // #2576 §6 to §8: this booking's rows can also decide whether ANOTHER booking on
  // the same account is compliant. Last, and after the siblings, because it is a
  // question about the resulting state of the whole account at this lodge.
  await settleSameOwnerDependentCoverage(
    bookingId,
    db,
    options,
    participantProof,
  );
  return outcome;
}

/**
 * Record the hosting review for a booking that has just been created, INSIDE
 * the creating transaction.
 *
 * In the transaction on purpose: a booking that committed without its review
 * evaluated would sit unflagged until something else happened to touch it, and
 * "we would have caught it eventually" is not a policy.
 *
 * `adminReason` is the admin's explicit on-behalf confirmation (D-R4). Supplying
 * it opens the review already APPROVED, attributed to that admin; omitting it
 * opens PENDING. There is no third option — an admin path that wants to approve
 * must say why.
 */
export async function recordAdultMemberHostingReviewForNewBooking(
  bookingId: string,
  tx: AdultMemberHostingReviewDb,
  admin: { reason: string; byMemberId: string } | null,
): Promise<HostingReviewOutcome> {
  const options: HostingReconcileOptions = {
    openedStatus: admin ? AdminReviewStatus.APPROVED : AdminReviewStatus.PENDING,
    decision: admin,
  };
  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    select: { status: true, deletedAt: true },
  });

  // A newly-created CONFIRMED/PAID booking is immediately authoritative cover
  // for its split siblings and same-owner dependants. Route that live source
  // through the fenced high-level seam so the review snapshot, sibling
  // restoration and any durable re-evaluation obligation commit atomically.
  // Draft, waitlist and provisional states still receive their own review
  // snapshot, but cannot supply cover and therefore must not fan out queue work.
  if (
    booking?.deletedAt == null &&
    isHostingCoverageSourceBookingStatus(String(booking?.status))
  ) {
    return reconcileAdultMemberHostingReviewWithSiblings(
      bookingId,
      tx,
      options,
    );
  }
  return reconcileAdultMemberHostingReview(bookingId, tx, options);
}

/**
 * Record an officer's EXPLICIT decision on a hosting review that is already
 * recorded and still PENDING (#2526).
 *
 * `recordAdultMemberHostingReviewForNewBooking` can open a review straight to
 * APPROVED because nothing was recorded yet. A MODIFICATION cannot: the
 * canonical modification service reconciles the hazard from the rows it just
 * wrote, deliberately WITHOUT a decision (an unrelated edit must never
 * auto-approve a hosting exception), so the row lands PENDING. When the edit was
 * itself an approved booking-policy exception, the officer HAS decided — with a
 * reason, on the exact reviewed proposal — and that decision has to be written
 * after the service has reconciled, or the booking carries a pending review that
 * nobody will ever action.
 *
 * Deliberately narrow, and guarded at the database:
 *  - only PENDING → APPROVED. A cleared review (`adultMemberHostingReviewStatus`
 *    NULL, because the executed change resolved the hazard) is left alone, and a
 *    review somebody else already decided is never overwritten.
 *  - a `reason` is required, exactly as D-R4 requires everywhere else — "an
 *    officer clicked approve" is not an answer anybody can audit.
 *
 * Returns whether the guarded update actually moved a row, so the caller can log
 * the truth rather than an assumption.
 */
export async function recordAdultMemberHostingReviewDecision(
  bookingId: string,
  db: Pick<PrismaClient, "booking">,
  decision: { reason: string; byMemberId: string },
): Promise<boolean> {
  const reason = decision.reason.trim();
  if (!reason) {
    throw new Error(
      "Recording an adult-member hosting decision requires an explicit reason",
    );
  }
  const claim = await db.booking.updateMany({
    where: {
      id: bookingId,
      adultMemberHostingReviewStatus: AdminReviewStatus.PENDING,
    },
    data: {
      adultMemberHostingReviewStatus: AdminReviewStatus.APPROVED,
      adultMemberHostingReviewReason: reason.slice(0, 500),
      adultMemberHostingReviewedById: decision.byMemberId,
      adultMemberHostingReviewedAt: new Date(),
    },
  });
  return claim.count === 1;
}

/**
 * Evaluate a party that is not persisted yet (the create path).
 *
 * Create has to know BEFORE the transaction whether the rule will trip, because
 * that decides whether a member must supply a justification and whether an admin
 * booking on somebody's behalf must supply an explicit reason. It cannot read
 * guest rows, so it evaluates the submitted party, resolving each member-linked
 * guest against the live Member row.
 *
 * The result is used ONLY for those two decisions. The snapshot that gets stored
 * is always the one the reconciler derives from the persisted rows afterwards,
 * so `guestRef` values in a stored snapshot are always real `BookingGuest` ids
 * and two snapshots of the same booking are always comparable.
 */
export async function evaluateProposedAdultMemberHosting(
  db: Pick<
    PrismaClient,
    // #2543 adds the subscription/membership-type reads the host bridge needs.
    | "member"
    | "booking"
    | "adultMemberHostingPolicy"
    | "lodge"
    | "memberSubscription"
    | "seasonalMembershipAssignment"
    | "membershipType"
  >,
  input: {
    /** The authoritative prospective Booking.memberId. */
    bookingOwnerMemberId?: string | null;
    lodgeId: string;
    checkIn: Date;
    checkOut: Date;
    guests: ReadonlyArray<{
      firstName: string;
      lastName: string;
      memberId?: string | null;
      stayStart?: Date | null;
      stayEnd?: Date | null;
      nights?: ReadonlyArray<string | Date | { stayDate: string | Date }> | null;
    }>;
  },
): Promise<AdultMemberHostingPolicyExceptionViolation | null> {
  const resolved = await loadAdultMemberHostingPolicy(input.lodgeId, db);
  if (!hostingModeIsActive(resolved.mode)) return null;

  const memberIds = [
    ...new Set(
      input.guests
        .map((guest) => guest.memberId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  const members = memberIds.length
    ? await db.member.findMany({
        where: { id: { in: memberIds } },
        select: {
          id: true,
          ageTier: true,
          active: true,
          cancelledAt: true,
          archivedAt: true,
        },
      })
    : [];
  const memberById = new Map(members.map((member) => [member.id, member]));

  // The proposed row does not exist yet, but SAME_BOOKING_OWNER is still a live
  // relationship: another eligible booking under the prospective Booking.memberId
  // may cover these exact lodge-nights. This is a preflight answer only; the
  // persisted reconciler repeats the read under the owner lock inside the create
  // transaction before it commits.
  const sameOwnerHosts =
    resolved.hostScopes.sameBookingOwner && input.bookingOwnerMemberId
      ? await loadSameBookingOwnerHosts(
          {
            id: "__proposed_booking__",
            memberId: input.bookingOwnerMemberId,
            lodgeId: input.lodgeId,
            checkIn: input.checkIn,
            checkOut: input.checkOut,
          },
          db,
          [],
        )
      : [];

  const participants: HostingParticipant[] = [
    ...input.guests.map((guest, index) => ({
      guestRef: `guest:${index}`,
      guestName: `${guest.firstName} ${guest.lastName}`.trim(),
      member: guest.memberId ? memberById.get(guest.memberId) ?? null : null,
      nights: proposedGuestNights(guest, input.checkIn, input.checkOut),
    })),
    ...sameOwnerHosts,
  ];

  return evaluateAdultMemberHostingWithPolicy(
    // #2543 — the same bridge the persisted path applies, so a proposed party
    // and the booking it becomes cannot disagree about who may host.
    await withSubscriptionSettlement(
      participants,
      db,
      getSeasonYear(input.checkIn),
    ),
    resolved,
  );
}

function proposedGuestNights(
  guest: {
    stayStart?: Date | null;
    stayEnd?: Date | null;
    nights?: ReadonlyArray<string | Date | { stayDate: string | Date }> | null;
  },
  checkIn: Date,
  checkOut: Date,
): string[] {
  if (guest.nights && guest.nights.length > 0) {
    return guest.nights.map((entry) => {
      if (typeof entry === "string") return entry.slice(0, 10);
      if (entry instanceof Date) return formatDateOnly(entry);
      const stayDate = entry.stayDate;
      return typeof stayDate === "string"
        ? stayDate.slice(0, 10)
        : formatDateOnly(stayDate);
    });
  }
  const start = guest.stayStart ?? checkIn;
  const endExclusive = guest.stayEnd ?? checkOut;
  // A zero- or negative-width range yields no nights rather than throwing; the
  // booking's own date validation owns that refusal.
  if (endExclusive <= start) return [];
  return eachDateOnlyInRange(start, endExclusive).map(formatDateOnly);
}


/**
 * The columns the dependent-coverage machinery needs off a booking, without the
 * guest tree. Deliberately narrow: this read runs on booking write paths and only
 * ever decides WHICH bookings to look at.
 */
type CoverageOwnerFacts = {
  id: string;
  memberId: string;
  lodgeId: string;
  checkIn: Date;
  checkOut: Date;
};

/**
 * The same columns plus the ones §7's automatic resolutions read off the AFFECTED
 * booking itself: its lifecycle, and the review state the reconciliation that just
 * ran left behind.
 */
type CoverageOwnerFactsWithOutcome = CoverageOwnerFacts & {
  status: BookingStatus;
  deletedAt: Date | null;
  adultMemberHostingReview: Prisma.JsonValue | null;
  adultMemberHostingReviewStatus: AdminReviewStatus | null;
};

function sourceParticipant(
  booking: Pick<CoverageOwnerFacts, "id" | "memberId" | "lodgeId">,
): HostingCoverageSourceParticipant {
  return {
    bookingId: booking.id,
    ownerMemberId: booking.memberId,
    lodgeId: booking.lodgeId,
  };
}

async function acquireOrValidateQueueParticipantProof(
  sources: readonly HostingCoverageSourceParticipant[],
  actorMemberId: string | null,
  db: AdultMemberHostingReviewDb,
  suppliedProof?: HostingCoverageQueueParticipantProof,
): Promise<HostingCoverageQueueParticipantProof> {
  if (!suppliedProof) {
    return acquireHostingCoverageQueueParticipantProof(
      { sources, actorMemberId },
      db,
    );
  }
  for (const source of sources) {
    assertHostingCoverageQueueParticipantsLocked(suppliedProof, {
      memberId: source.ownerMemberId,
      lodgeId: source.lodgeId,
      sourceBookingId: source.bookingId,
      actorMemberId,
    });
  }
  return suppliedProof;
}

const COVERAGE_OWNER_FACTS_SELECT = {
  id: true,
  memberId: true,
  lodgeId: true,
  checkIn: true,
  checkOut: true,
  status: true,
  deletedAt: true,
  adultMemberHostingReview: true,
  adultMemberHostingReviewStatus: true,
} as const;

/**
 * Close the changed booking's OWN incident when the change it just made is one of
 * §7's automatic resolutions (#2576 §7, §16).
 *
 * THE GAP THIS CLOSES WAS TOTAL, AND THAT IS WORTH SPELLING OUT. The re-evaluation
 * fan-out is built on `sameOwnerCoverageDependentWhere`, which excludes the booking
 * being changed (`id: { not: booking.id }`). So every list the settle step computes
 * is a list of OTHER bookings, and nothing a member or officer did TO an affected
 * booking could ever reach its own incident: amending it cleared its review row and
 * left a `critical` stuck-state card standing against a booking whose guest list
 * plainly showed an adult member; cancelling it left the same card against a stay
 * that was not happening; approving a policy exception recorded the officer's
 * decision and then had the next reconciliation re-affirm the incident against a
 * hazard that officer had just authorised. `BOOKING_AMENDED` and
 * `EXCEPTION_APPROVED` were declared in the schema and in the TS union and written
 * nowhere. Since there is no admin route, no UI action and no periodic sweep that
 * resolves an incident, a wrong one was permanent.
 *
 * Three of §7's four resolutions are decided here, from facts this transaction has
 * just written, and the labels are the truth rather than a default:
 *
 *  - the booking is no longer happening → `BOOKING_CANCELLED`;
 *  - an officer has APPROVED the hosting review → `EXCEPTION_APPROVED`. The
 *    approval is an authority over exactly this hazard, so leaving an urgent
 *    incident open against it would put the officer's own decision in their queue
 *    as an emergency;
 *  - the reconciliation that ran a moment ago CLEARED the review, so this booking's
 *    own facts no longer carry the hazard → `BOOKING_AMENDED`.
 *
 * The fourth, `COVERAGE_RESTORED`, is not decided here on purpose: it is a fact
 * about ANOTHER booking supplying cover, which only the post-commit drain can
 * establish against committed rows.
 *
 * IN THE CALLER'S TRANSACTION, and correct there: if the change rolls back — a
 * member's refused edit, a failed payment claim — the resolution rolls back with
 * it, so an incident is never closed for a change that did not happen.
 */
async function resolveOwnCoverageIncidentAfterChange(
  booking: CoverageOwnerFactsWithOutcome,
  db: AdultMemberHostingReviewDb,
  actorMemberId: string | null,
): Promise<boolean> {
  const open = await db.hostingCoverageIncident.findFirst({
    where: { bookingId: booking.id, resolvedAt: null },
    select: { id: true },
  });
  if (!open) return false;

  const resolution = ((): HostingCoverageIncidentResolution | null => {
    if (bookingAttendanceIsTerminal(booking)) return "BOOKING_CANCELLED";
    if (booking.adultMemberHostingReviewStatus === AdminReviewStatus.APPROVED) {
      return "EXCEPTION_APPROVED";
    }
    // The reconciliation immediately before this call clears BOTH columns when it
    // finds no hazard, so "no snapshot and no status" is exactly "this booking
    // complies now". Reading the columns rather than re-evaluating keeps this to
    // one cheap read and cannot disagree with what was just written.
    if (
      booking.adultMemberHostingReviewStatus == null &&
      parseStoredHostingReview(booking.adultMemberHostingReview) === null
    ) {
      return "BOOKING_AMENDED";
    }
    return null;
  })();
  if (resolution === null) return false;

  await resolveHostingCoverageIncidents(
    { bookingId: booking.id, resolution, actorMemberId },
    db,
  );
  return true;
}

/**
 * Settle the same-owner bookings whose cover this change may have removed
 * (#2576 §6, §7, §8).
 *
 * Runs at the END of the mutation transaction, after the caller's write and after
 * the split-sibling fan-out, because it is a question about the RESULTING rows:
 * "given what is now true, is another booking on this account left uncovered".
 * Evaluating the pre-change rows would answer a question nobody asked.
 *
 * THE SCOPE IS THE HARD PRECONDITION; THE CONSEQUENCE DECIDES WHAT HAPPENS.
 *
 *  - the scope: without `SAME_BOOKING_OWNER` no booking's compliance can depend on
 *    another booking, so there is nothing to strand, nothing to escalate and
 *    nothing to re-read. This function returns immediately and a club that is not
 *    on the scope pays one cached policy read per booking write.
 *  - `ENFORCED`: the full behaviour below — refuse a member, ask an officer to
 *    confirm, escalate a system change to an urgent incident.
 *  - `ADMIN_REVIEW_REQUIRED`: never refuse and never open an incident — an
 *    uncovered booking is a normal, permitted state there and the pending review is
 *    already the officer's signal — but the dependents STILL have to be re-read.
 *    That is the one class of staleness this scope introduces which the review
 *    consequence cannot catch by itself: with `SAME_BOOKING` alone a booking's cover
 *    can only change through its own rows or its split siblings, and both are
 *    reconciled on every write, whereas under this scope a change to a DIFFERENT
 *    booking can strand it and nothing else will ever look. Returning early here
 *    left such a booking recorded as compliant indefinitely, which makes §1's
 *    "record and clearly surface the uncovered non-member nights for Booking
 *    Officer review" untrue for exactly the case the new scope adds. So the work is
 *    queued and the drain refreshes each dependent's own snapshot after commit;
 *    `reconcileSameOwnerCoverageIncident` opens no incident while the mode is not
 *    `ENFORCED`, so the officer's queue is not doubled.
 *
 * CONCURRENCY (§9). A PER-OWNER ADVISORY LOCK, taken here and by every reader of
 * same-owner cover — see `lockHostingCoverageOwner`. An earlier draft argued no new
 * lock was needed because "every path that can confirm a booking and every path that
 * can remove exact-night attendance already takes the per-lodge capacity lock". That
 * was false in both directions: `booking-cancel.ts`'s claim transactions take
 * `pg_advisory_xact_lock(1)` and never the lodge lock, while `booking-create.ts` and
 * the guest-add route take the lodge lock and never `lock(1)`. Those are different
 * keys at READ COMMITTED over disjoint rows, so a cancel removing the last
 * qualifying adult could interleave with a create that had just read that adult as
 * cover, and the outcome depended on commit order — the exact non-determinism §9
 * forbids. With the owner key held by both sides one of them always sees the other's
 * committed rows. This function reads through the caller's `tx`, so it sees that
 * transaction's own writes and the committed state of everything else.
 */
async function settleSameOwnerDependentCoverage(
  bookingId: string,
  db: AdultMemberHostingReviewDb,
  options: HostingReconcileOptions,
  participantProof: HostingCoverageQueueParticipantProof,
): Promise<void> {
  const booking = (await db.booking.findUnique({
    where: { id: bookingId },
    select: COVERAGE_OWNER_FACTS_SELECT,
  })) as CoverageOwnerFactsWithOutcome | null;
  if (!booking) return;

  const resolved = await loadAdultMemberHostingPolicy(booking.lodgeId, db);
  if (resolved.mode !== "ENFORCED" && resolved.mode !== "ADMIN_REVIEW_REQUIRED") {
    return;
  }

  // Exact queue attribution only. An on-behalf review decision is a separate
  // Booking FK and must never be substituted for a missing coverage-change actor.
  const actorMemberId = options.coverageChange?.actorMemberId ?? null;
  assertHostingCoverageQueueParticipantsLocked(participantProof, {
    memberId: booking.memberId,
    lodgeId: booking.lodgeId,
    sourceBookingId: booking.id,
    actorMemberId,
  });

  // Before any coverage read, and held to commit — see the concurrency note above.

  const nights = eachDateOnlyInRange(booking.checkIn, booking.checkOut).map(
    formatDateOnly,
  );

  // SAME_BOOKING still needs durable settlement of THIS booking. Confirmation can
  // turn it into a live incident source, an officer override can leave it
  // confirmed but uncovered, and a later correction must close that incident.
  // Only the cross-booking fan-out needs the owner lock and dependent inspection.
  if (!resolved.hostScopes.sameBookingOwner) {
    if (resolved.mode !== "ENFORCED") return;
    const context = options.coverageChange ?? { cause: "SYSTEM_CHANGE" as const };
    if (context.cause === "OFFICER_OVERRIDE" && !context.reason?.trim()) {
      throw new Error(
        "Overriding adult-member hosting coverage requires an explicit reason",
      );
    }
    await resolveOwnCoverageIncidentAfterChange(
      booking,
      db,
      context.actorMemberId ?? null,
    );
    await enqueueHostingCoverageReevaluation(
      {
        memberId: booking.memberId,
        lodgeId: booking.lodgeId,
        nights,
        cause: context.cause,
        sourceBookingId: booking.id,
        actorMemberId,
        reason: context.reason ?? null,
      },
      participantProof,
      db,
    );
    return;
  }

  // Before any cross-booking coverage read, and held to commit.
  if (!(await tryLockHostingCoverageOwner(db, booking.memberId))) {
    throw new HostingCoverageParticipantRetryError();
  }
  await lockHostingCoverageOwner(db, booking.memberId);

  if (resolved.mode === "ADMIN_REVIEW_REQUIRED") {
    // No inspection: nothing here can refuse and nothing can open an incident, so
    // the only question is whether any other booking of this owner overlaps at all.
    // One indexed count, and a queue row only when there is somebody to re-read.
    const dependents = await db.booking.count({
      where: sameOwnerCoverageDependentWhere(booking),
    });
    if (dependents === 0) return;
    await enqueueHostingCoverageReevaluation(
      {
        memberId: booking.memberId,
        lodgeId: booking.lodgeId,
        nights,
        cause: "SYSTEM_CHANGE",
        sourceBookingId: booking.id,
        actorMemberId,
        reason: null,
      },
      participantProof,
      db,
    );
    return;
  }

  let context = options.coverageChange ?? { cause: "SYSTEM_CHANGE" as const };
  if (context.cause === "OFFICER_OVERRIDE" && !context.reason?.trim()) {
    // §7 makes the reason mandatory, and this is the point at which the override
    // becomes irreversible. Failing here rather than recording an unexplained
    // override is the same rule D-R4 already applies to a hosting decision.
    throw new Error(
      "Overriding same-owner hosting coverage requires an explicit reason",
    );
  }

  const disposition = resolveDependentDisposition(booking, options);
  const { stranded, dependentsWithOpenIncidents } =
    await inspectSameOwnerDependents(booking, db);

  // The confirmation is authority over the exact bookings and lodge-nights the
  // officer saw, not over whatever happens to be stranded by the time the retry
  // acquires the owner lock. A changed set is therefore another FIRST submission:
  // throw the fresh structured prompt inside the mutation transaction so its
  // booking write, incident resolution, audit and queue work all roll back.
  if (
    context.cause === "OFFICER_OVERRIDE" &&
    stranded.length > 0 &&
    context.strandedStateKey !== strandedCoverageStateKey(stranded, booking.id)
  ) {
    throw new SameOwnerCoverageOverrideRequiredError(stranded, booking.id);
  }
  if (context.cause === "OFFICER_OVERRIDE" && stranded.length === 0) {
    // Coverage improved while the confirmation was open. There is no longer an
    // override to take, so do not manufacture one in the audit/queue record and
    // do not return an empty prompt the client cannot meaningfully confirm.
    context = {
      cause: "SYSTEM_CHANGE",
      actorMemberId: context.actorMemberId ?? null,
      reason: null,
    };
  }

  // §7's automatic resolutions that act on the AFFECTED booking itself — amended,
  // exception-approved, cancelled. Only after the state-bound override check: a
  // stale retry must perform no incident transition even in a transaction double
  // that cannot model PostgreSQL rollback.
  const ownIncidentResolved = await resolveOwnCoverageIncidentAfterChange(
    booking,
    db,
    context.actorMemberId ?? null,
  );

  // REFUSE FIRST, and which refusal it is depends on who is asking (§6, §7).
  if (stranded.length > 0) {
    // The member's own change is rolled back with the sentence §6 specifies,
    // naming the affected booking, its lodge and the uncovered nights.
    if (disposition === "BLOCK") {
      throw new SameOwnerCoverageWouldBreakError(stranded);
    }
    // The officer's change is authorised but not yet confirmed: they are shown
    // what would be stranded and asked to acknowledge it with a reason (§7).
    if (disposition === "REQUIRE_OVERRIDE") {
      throw new SameOwnerCoverageOverrideRequiredError(stranded, booking.id);
    }
  }

  // ENQUEUE only where there is something to settle, which is the difference
  // between a queue and a log. Three conditions, and the last two are the halves
  // that are easy to forget:
  //
  //  - something is newly uncovered, so an incident has to be opened (§8);
  //  - or a dependent is carrying an OPEN incident, so the change may have
  //    RESTORED its cover and §7's automatic resolution is owed. This arm fires
  //    under BLOCK as well as ESCALATE: a member who fixes the problem by
  //    amending the booking has made a change that strands nobody, and the
  //    incident must not be left standing because the fix was permitted.
  //  - or THIS booking's own incident was just resolved, which can free cover its
  //    guests were consuming and can change what its owner's other bookings are
  //    entitled to conclude. Re-reading after commit is cheap and idempotent; not
  //    re-reading leaves the account half-settled.
  //
  // A booking write that can affect nothing therefore writes nothing, so a club
  // on this scope does not accumulate a queue row per edit.
  if (
    stranded.length === 0 &&
    dependentsWithOpenIncidents.length === 0 &&
    !ownIncidentResolved
  ) {
    return;
  }

  await enqueueHostingCoverageReevaluation(
    {
      memberId: booking.memberId,
      lodgeId: booking.lodgeId,
      // The nights this booking covers, and no others (§10). A change to this
      // booking cannot affect a night it never touched, so this IS the bound —
      // not a heuristic narrowing of a wider sweep.
      nights,
      cause: context.cause,
      sourceBookingId: booking.id,
      actorMemberId,
      reason: context.reason ?? null,
    },
    participantProof,
    db,
  );
}

/**
 * Which refusal, if any, this actor is entitled to receive (#2576 §6, §11).
 *
 * THE ACTOR IS NOT THE OWNER, AND ASSUMING OTHERWISE DISCLOSES ANOTHER ACCOUNT'S
 * BOOKING. `BLOCK`'s refusal lists the OWNER's other bookings — reference, lodge and
 * exact uncovered nights — and the guest DELETE route deliberately admits a member
 * from a different account: `booking-guest-removal-service.ts` sets `isSelfRemoval`
 * for a member-linked guest taking their own row off, and the self-removable
 * statuses include CONFIRMED and PAID, exactly the ones that qualify as coverage
 * sources. So an adult member who is a guest on somebody else's booking could
 * remove themselves, be answered `BLOCK`, and be handed that owner's booking
 * reference, lodge and nights, in a sentence addressing them as though the booking
 * were on their own account.
 *
 * There is a second harm on the same path, and it is the reason the answer is
 * `ESCALATE` rather than a redacted refusal: every remedy §6's message offers —
 * amend the affected booking, restore alternative cover, ring an officer — belongs
 * to the OWNER. A guest refused here could not comply by any means available to
 * them; they would simply be pinned to a stranger's booking indefinitely. §8's
 * principle applies exactly: allow the change nobody can sensibly block, and record
 * the consequence durably instead. The owner is emailed, the incident is raised, the
 * officer queue shows it.
 *
 * DEFENCE IN DEPTH RATHER THAN TRUST IN THE CALL SITES. Every site does pass
 * `coverageActorMemberId`, and `adult-member-hosting-call-sites.test.ts` pins that.
 * This check is here as well because it is the last point before the disclosure, and
 * a site that forgot the field fails towards escalation — an allowed change plus an
 * incident — rather than towards leaking.
 */
function resolveDependentDisposition(
  booking: Pick<CoverageOwnerFacts, "memberId">,
  options: HostingReconcileOptions,
): HostingDependentCoverageDisposition {
  const disposition = options.dependentCoverage ?? "ESCALATE";
  if (disposition !== "BLOCK") return disposition;
  const actorMemberId = options.coverageActorMemberId ?? null;
  return actorMemberId !== null && actorMemberId === booking.memberId
    ? "BLOCK"
    : "ESCALATE";
}

/**
 * Record the re-evaluation this booking's OWN nights need, without evaluating and
 * without refusing anything (#2576 §8, §9).
 *
 * FOR THE CONFIRMING PATHS THAT MUST NOT BE REFUSED, and there are exactly two
 * shapes of those: the saved-card auto-charge cron and the group-settlement
 * confirmations. §8 names both — "payment or booking lifecycle failure",
 * "automated status transitions" — among the changes that "cannot reasonably be
 * blocked", and the reason is concrete rather than philosophical: by the time
 * either runs, capacity is claimed and a charge is either in flight or settled, so
 * throwing would leave money and beds pointing at a booking the club just refused.
 * §9's answer for them is the same as §8's: allow the transition, then re-read the
 * facts after commit and escalate to an urgent incident.
 *
 * WHY IT ENQUEUES RATHER THAN EVALUATES. Evaluating here would answer the question
 * against UNCOMMITTED rows, and the confirming transaction is exactly the one whose
 * commit decides the answer. The queue row commits WITH the confirmation — so the
 * obligation to look cannot be lost — and the drain re-reads afterwards. It also
 * keeps a background sweep, not a money transaction, as the thing that sends the
 * owner's email.
 *
 * The item names this booking's owner, lodge and own nights and nothing else, so it
 * is bounded by construction the same way every other item is (§10); the drain will
 * pick up any OTHER booking of the same owner over those nights as a matter of
 * course, which is correct — a confirmation adds attendance, and attendance can
 * RESTORE cover as easily as remove it.
 *
 * Returns the queued item id, or null when nothing was queued: the club is not
 * enforcing or the booking has gone. `SAME_BOOKING` alone still queues this
 * booking; only the cross-booking owner lock depends on `SAME_BOOKING_OWNER`.
 */
export async function enqueueOwnHostingCoverageReevaluation(
  bookingId: string,
  db: AdultMemberHostingReviewDb,
  context: HostingCoverageChangeContext = { cause: "SYSTEM_CHANGE" },
  suppliedParticipantProof?: HostingCoverageQueueParticipantProof,
): Promise<string | null> {
  const plannedBooking = (await db.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      memberId: true,
      lodgeId: true,
      checkIn: true,
      checkOut: true,
    },
  })) as CoverageOwnerFacts | null;
  if (!plannedBooking) return null;

  const resolved = await loadAdultMemberHostingPolicy(plannedBooking.lodgeId, db);
  if (resolved.mode !== "ENFORCED") return null;

  const actorMemberId = context.actorMemberId ?? null;
  const participantProof = await acquireOrValidateQueueParticipantProof(
    [sourceParticipant(plannedBooking)],
    actorMemberId,
    db,
    suppliedParticipantProof,
  );
  const booking = (await db.booking.findUnique({
    where: { id: plannedBooking.id },
    select: {
      id: true,
      memberId: true,
      lodgeId: true,
      checkIn: true,
      checkOut: true,
    },
  })) as CoverageOwnerFacts | null;
  if (!booking) throw new HostingCoverageParticipantRetryError();
  assertHostingCoverageQueueParticipantsLocked(participantProof, {
    memberId: booking.memberId,
    lodgeId: booking.lodgeId,
    sourceBookingId: booking.id,
    actorMemberId,
  });

  // §9. Confirming paths use this seam instead of evaluating, so this is where they
  // join the owner-key discipline: the queue row and the confirmation commit
  // together, and a concurrent removal of the cover cannot slip between them.
  if (resolved.hostScopes.sameBookingOwner) {
    if (!(await tryLockHostingCoverageOwner(db, booking.memberId))) {
      throw new HostingCoverageParticipantRetryError();
    }
    await lockHostingCoverageOwner(db, booking.memberId);
  }

  return enqueueHostingCoverageReevaluation(
    {
      memberId: booking.memberId,
      lodgeId: booking.lodgeId,
      nights: eachDateOnlyInRange(booking.checkIn, booking.checkOut).map(
        formatDateOnly,
      ),
      cause: context.cause,
      sourceBookingId: booking.id,
      actorMemberId,
      reason: context.reason ?? null,
    },
    participantProof,
    db,
  );
}

/**
 * A ceiling on the bookings ONE person's lifecycle change fans out to.
 *
 * Higher than the per-account ceilings because the set is a different shape — every
 * current-or-future booking this person ATTENDS, across lodges — and still small:
 * fifty live stays for one member is already far beyond a club member's real
 * footprint. Truncation is warned about for the same reason the dependent reads warn.
 */
export const HOSTING_COVERAGE_MEMBER_FANOUT_LIMIT = 50;

/** The deterministic bounded candidate set shared by ordinary fan-out and merge. */
export async function loadHostingCoverageMemberFanoutCandidates(
  memberId: string,
  db: AdultMemberHostingReviewDb,
): Promise<CoverageOwnerFacts[]> {
  const today = getTodayDateOnly();
  return (await db.booking.findMany({
    where: {
      deletedAt: null,
      status: { in: [...ACTIVE_BOOKING_STATUSES] },
      // Current or future stays only — a checkout on or after today still has
      // nights the rule can judge.
      checkOut: { gte: today },
      guests: { some: { memberId } },
    },
    orderBy: [{ checkIn: "asc" }, { id: "asc" }],
    take: HOSTING_COVERAGE_MEMBER_FANOUT_LIMIT,
    select: {
      id: true,
      memberId: true,
      lodgeId: true,
      checkIn: true,
      checkOut: true,
    },
  })) as CoverageOwnerFacts[];
}

export type MemberMergeHostingCoveragePlan = Readonly<{
  items: readonly HostingCoverageReevaluationInput[];
  sources: readonly HostingCoverageSourceParticipant[];
  coverageOwnerIds: readonly string[];
}>;

/**
 * Plan the merge's exact actorless SYSTEM_CHANGE fan-out after relation moves.
 * The policy-set lock held by merge keeps the ENFORCED decisions stable while
 * the Member participant rows are acquired and this plan is re-read.
 */
export async function buildMemberMergeHostingCoveragePlan(
  params: {
    masterId: string;
    capturedLoserOwnedBookingIds: readonly string[];
  },
  db: AdultMemberHostingReviewDb,
): Promise<MemberMergeHostingCoveragePlan> {
  const [attended, movedOwnerBookings] = await Promise.all([
    loadHostingCoverageMemberFanoutCandidates(params.masterId, db),
    params.capturedLoserOwnedBookingIds.length > 0
      ? (db.booking.findMany({
          where: { id: { in: [...params.capturedLoserOwnedBookingIds] } },
          orderBy: { id: "asc" },
          select: {
            id: true,
            memberId: true,
            lodgeId: true,
            checkIn: true,
            checkOut: true,
          },
        }) as Promise<CoverageOwnerFacts[]>)
      : Promise.resolve([]),
  ]);
  const candidatesById = new Map<string, CoverageOwnerFacts>();
  for (const booking of [...attended, ...movedOwnerBookings]) {
    candidatesById.set(booking.id, booking);
  }
  const candidates = [...candidatesById.values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const policyByLodge = new Map<string, ResolvedAdultMemberHostingPolicy>();
  for (const booking of candidates) {
    if (!policyByLodge.has(booking.lodgeId)) {
      const policy = await loadAdultMemberHostingPolicy(booking.lodgeId, db);
      policyByLodge.set(booking.lodgeId, policy);
    }
  }
  const included = candidates.filter(
    (booking) => policyByLodge.get(booking.lodgeId)?.mode === "ENFORCED",
  );
  const items = included.map((booking) => ({
    memberId: booking.memberId,
    lodgeId: booking.lodgeId,
    nights: eachDateOnlyInRange(booking.checkIn, booking.checkOut).map(
      formatDateOnly,
    ),
    cause: "SYSTEM_CHANGE" as const,
    sourceBookingId: booking.id,
    actorMemberId: null,
    reason: null,
  }));
  const sourcesByBooking = new Map<string, HostingCoverageSourceParticipant>();
  for (const booking of included) {
    sourcesByBooking.set(booking.id, sourceParticipant(booking));
  }
  return Object.freeze({
    items: Object.freeze(items.map((item) => Object.freeze(item))),
    sources: Object.freeze(
      [...sourcesByBooking.values()].sort((a, b) =>
        a.bookingId.localeCompare(b.bookingId),
      ),
    ),
    coverageOwnerIds: Object.freeze(
      [...new Set(
        included
          .filter(
            (booking) =>
              policyByLodge.get(booking.lodgeId)?.hostScopes.sameBookingOwner ===
              true,
          )
          .map((booking) => booking.memberId),
      )].sort(),
    ),
  });
}

export function memberMergeHostingCoveragePlanFingerprint(
  plan: MemberMergeHostingCoveragePlan,
): string {
  return JSON.stringify(
    plan.items.map((item) => ({
      memberId: item.memberId,
      lodgeId: item.lodgeId,
      nights: [...item.nights],
      cause: item.cause,
      sourceBookingId: item.sourceBookingId ?? null,
    })),
  ) + JSON.stringify(plan.coverageOwnerIds);
}

export async function enqueueMemberMergeHostingCoveragePlan(
  plan: MemberMergeHostingCoveragePlan,
  proof: HostingCoverageQueueParticipantProof,
  db: AdultMemberHostingReviewDb,
): Promise<number> {
  let queued = 0;
  for (const item of plan.items) {
    assertHostingCoverageQueueParticipantsLocked(proof, item);
    if (await enqueueHostingCoverageReevaluation(item, proof, db)) queued += 1;
  }
  return queued;
}

/**
 * Record the re-evaluation a change to ONE PERSON's standing implies (#2576 §8).
 *
 * THE MISSING HALF OF §8, AND IT WAS THE FIRST ITEM ON ITS LIST. "Membership
 * becoming inactive, lapsed, cancelled or archived" heads the changes that cannot
 * reasonably be blocked and must instead record durable re-evaluation work. Only the
 * evaluator half existed — a lapsed or unconsented adult correctly stops counting as
 * a host — while nothing told the club to go and look. So an officer deactivating a
 * membership, the Xero sync marking one lapsed, or an adult declining their
 * member-guest invite left a confirmed booking silently non-compliant: no incident,
 * no owner email, no officer-queue entry, and the booking's own review snapshot still
 * reading "compliant". There is no periodic sweep to compensate — the 3-hourly cron
 * drains queue rows and nothing else — so the obligation had to be recorded at the
 * moment the standing changed.
 *
 * It also removed a trap. `inspectSameOwnerDependents` classifies a hazard as
 * "newly uncovered" by comparing against the dependent's stored review snapshot and
 * its open incident. With neither written, the member's NEXT edit was blamed for the
 * lapse: they could no longer cancel or amend the booking that used to supply cover,
 * because the refusal told them to fix the other booking first, which they could not
 * do without a qualifying adult.
 *
 * WHAT IT ENQUEUES, AND WHY THAT IS STILL BOUNDED (§10). Attendance — not ownership
 * (§2) — is what a person's standing changes, so the fan-out is driven by this
 * member's own `BookingGuest` rows on live, current-or-future bookings. Each row
 * becomes ONE queue item naming that booking's OWNER, its lodge and its own nights:
 * exactly the owner/lodge/night triple every other item carries, so the drain cannot
 * widen it into the lodge-wide sweep #2575 rejected. Past stays are excluded because
 * a lapse cannot retroactively break a completed attendance record (§3).
 *
 * GATED ON `ENFORCED` AND NOT ON THE SCOPE, deliberately, and this is the one place
 * the two gates differ. Incidents exist only under `ENFORCED` — that rule is
 * unchanged — but a lapse removes cover under `SAME_BOOKING` just as surely as under
 * `SAME_BOOKING_OWNER`, and the drain reconciles each booking through the shared
 * evaluator, which honours whichever scopes the lodge actually has on. Gating on the
 * scope would have left an enforcing single-booking club with no lapse detection at
 * all, for no reason.
 *
 * THE PARTICIPANT FENCE IS ALREADY MODE-GATED HERE and always was: the per-lodge
 * `ENFORCED` filter below returns 0 before any proof is acquired, so #2623 T5's
 * report that this seam takes the participant lock ungated does not hold against
 * this code. The subject barrier ABOVE it is ungated, and deliberately — see the
 * comment at that lock.
 *
 * Returns the number of items recorded, so a caller can log the truth.
 */
export async function enqueueHostingCoverageReevaluationForMember(
  memberId: string,
  db: AdultMemberHostingReviewDb,
  context: HostingCoverageChangeContext = { cause: "SYSTEM_CHANGE" },
  suppliedParticipantProof?: HostingCoverageQueueParticipantProof,
): Promise<number> {
  // Freeze the standing subject before even deciding that the fan-out is
  // empty. A linked-guest hold takes KEY SHARE on this same row after its lodge
  // lock, so one side wins cleanly: the hold is included in the candidate
  // snapshot, or the hold resumes after this standing change and refuses its
  // now-inactive member. NOWAIT keeps repeated bulk fan-outs fail-fast.
  //
  // DELIBERATELY NOT GATED ON THE HOSTING POLICY, and #2623 T5 is where that was
  // tested rather than assumed. Gating the enqueue seams on the mode is right —
  // see `reconcileAdultMemberHostingReviewWithSiblings` — but this barrier is not
  // one of them. It is the SHARED standing-subject fence: account deletion and
  // every other standing writer reach it through this function, and it is what
  // makes a concurrent booking-request linked-member hold and a deactivation
  // mutually exclusive. `docs/CONCURRENCY_AND_LOCKING.md` states the contract in
  // as many words — the hold's refusal "is independent of the lodge's hosting
  // consequence (DISABLED, ADMIN_REVIEW_REQUIRED, or ENFORCED), so review policy
  // is not an identity-safety backstop" — and
  // `adult-member-hosting-queue-merge.realdb.test.ts` proves both winner orders
  // against real PostgreSQL in all three modes. A club-wide `ENFORCED` gate here
  // was written, and those six interleavings failed for DISABLED and
  // ADMIN_REVIEW_REQUIRED: a deletion could deactivate the member and unlink the
  // guest underneath a hold that had already read them as active. The spurious
  // retry a non-enforcing club can still see on a standing write is the price of
  // that fence, and it is a price this repository has decided to pay.
  await lockHostingCoverageMemberLifecycleTarget(db, memberId);
  const plannedAttended = await loadHostingCoverageMemberFanoutCandidates(memberId, db);
  if (plannedAttended.length === 0) return 0;
  if (plannedAttended.length >= HOSTING_COVERAGE_MEMBER_FANOUT_LIMIT) {
    logger.warn(
      { memberId, limit: HOSTING_COVERAGE_MEMBER_FANOUT_LIMIT },
      "Hosting coverage member fan-out hit its ceiling; a booking this member attends may not have been re-evaluated",
    );
  }

  // One policy read per distinct lodge rather than per booking: the resolver is
  // already the hot path on every booking write and this can touch several stays.
  const enforcingByLodge = new Map<string, boolean>();
  const sameOwnerByLodge = new Map<string, boolean>();
  for (const booking of plannedAttended) {
    if (enforcingByLodge.has(booking.lodgeId)) continue;
    const resolved = await loadAdultMemberHostingPolicy(booking.lodgeId, db);
    enforcingByLodge.set(booking.lodgeId, resolved.mode === "ENFORCED");
    sameOwnerByLodge.set(
      booking.lodgeId,
      resolved.hostScopes.sameBookingOwner,
    );
  }
  const plannedQueueOwners = plannedAttended
    .filter((booking) => enforcingByLodge.get(booking.lodgeId) === true)
    .map((booking) => booking.memberId);
  if (plannedQueueOwners.length === 0) return 0;

  const actorMemberId = context.actorMemberId ?? null;
  const plannedSources = plannedAttended
    .filter((booking) => enforcingByLodge.get(booking.lodgeId) === true)
    .map(sourceParticipant);
  const participantProof = await acquireOrValidateQueueParticipantProof(
    plannedSources,
    actorMemberId,
    db,
    suppliedParticipantProof,
  );

  // Re-query after the Member locks. Every final owner must already belong to
  // the one planned set; a changed owner or new booking outside it is a safe
  // retry, never a late participant acquisition.
  const attended = await loadHostingCoverageMemberFanoutCandidates(memberId, db);
  const plannedById = new Map(plannedAttended.map((booking) => [booking.id, booking]));
  if (attended.length !== plannedAttended.length) {
    throw new HostingCoverageParticipantRetryError();
  }
  for (const booking of attended) {
    const planned = plannedById.get(booking.id);
    if (
      !planned ||
      planned.memberId !== booking.memberId ||
      planned.lodgeId !== booking.lodgeId
    ) {
      throw new HostingCoverageParticipantRetryError();
    }
    if (enforcingByLodge.get(booking.lodgeId) === true) {
      assertHostingCoverageQueueParticipantsLocked(participantProof, {
        memberId: booking.memberId,
        lodgeId: booking.lodgeId,
        sourceBookingId: booking.id,
        actorMemberId,
      });
    }
  }

  const sameOwnerQueueOwners = attended
    .filter(
      (booking) =>
        enforcingByLodge.get(booking.lodgeId) === true &&
        sameOwnerByLodge.get(booking.lodgeId) === true,
    )
    .map((booking) => booking.memberId);
  if (!(await tryLockHostingCoverageOwners(db, sameOwnerQueueOwners))) {
    throw new HostingCoverageParticipantRetryError();
  }
  await lockHostingCoverageOwners(
    db,
    sameOwnerQueueOwners,
  );
  let queued = 0;
  for (const booking of attended) {
    const enforcing = enforcingByLodge.get(booking.lodgeId) === true;
    if (!enforcing) continue;

    // The plural lock above already took §9's key for every applicable OWNER in
    // sorted order. The owner is not necessarily the member whose standing changed.
    const id = await enqueueHostingCoverageReevaluation(
      {
        memberId: booking.memberId,
        lodgeId: booking.lodgeId,
        nights: eachDateOnlyInRange(booking.checkIn, booking.checkOut).map(
          formatDateOnly,
        ),
        cause: context.cause,
        sourceBookingId: booking.id,
        actorMemberId,
        reason: context.reason ?? null,
      },
      participantProof,
      db,
    );
    if (id) queued += 1;
  }
  return queued;
}

/**
 * Look at every same-owner booking this change could have touched, and report two
 * things: which are NEWLY uncovered, and which are already carrying an open
 * incident (#2576 §6, §7, §14).
 *
 * "NEWLY" IS THE WHOLE SUBTLETY, and getting it wrong makes the rule unusable in
 * one direction and useless in the other. A booking that was ALREADY uncovered —
 * because an officer overrode something last week, or a membership lapsed and an
 * incident is open — must not block an unrelated edit the member makes today: they
 * cannot fix that booking by abandoning this change, so refusing would trap them.
 * A booking that is uncovered only BECAUSE of this change must block it.
 *
 * The test is the shared material-identity key (`adultMemberHostingStateKey`, the
 * same definition that decides whether an officer's review decision still applies
 * and whether the owner has already been notified): if the dependent's uncovered
 * state after this change is identical to what its own stored review snapshot or
 * its open incident already records, this change did not cause it. Anything else —
 * a first hazard, or a materially different one — is caused by this change.
 *
 * The SECOND list is what makes automatic resolution work. A dependent with an open
 * incident has to be re-examined after commit whether or not anything is stranded
 * now, because the change may have RESTORED its cover — §14's existential rule and
 * §7's automatic resolution both live on that read.
 *
 * READ-ONLY. It evaluates each dependent rather than reconciling it, on purpose:
 * under `BLOCK` the change is about to be rolled back by the throw, so writing
 * review rows for dependents would either be undone (harmless but pointless) or,
 * worse, would record a hazard derived from rows that never existed.
 */
async function inspectSameOwnerDependents(
  booking: CoverageOwnerFacts,
  db: AdultMemberHostingReviewDb,
): Promise<{
  stranded: StrandedCoverageBooking[];
  dependentsWithOpenIncidents: string[];
}> {
  const dependents = (await db.booking.findMany({
    where: sameOwnerCoverageDependentWhere(booking),
    orderBy: [...SAME_OWNER_COVERAGE_DEPENDENT_ORDER],
    take: SAME_OWNER_COVERAGE_DEPENDENT_LIMIT,
    select: BOOKING_HOSTING_SELECT,
  })) as LoadedHostingBooking[];
  if (dependents.length === 0) {
    return { stranded: [], dependentsWithOpenIncidents: [] };
  }
  warnIfCoverageDependentCeilingBound(booking, dependents.length, "inspect");

  const openIncidents = await db.hostingCoverageIncident.findMany({
    where: {
      bookingId: { in: dependents.map((dependent) => dependent.id) },
      resolvedAt: null,
    },
    select: { bookingId: true, stateKey: true },
  });
  const incidentKeyByBooking = new Map(
    openIncidents.map((incident) => [incident.bookingId, incident.stateKey]),
  );

  const stranded: StrandedCoverageBooking[] = [];
  let lodgeName: string | null = null;
  for (const dependent of dependents) {
    if (!Array.isArray(dependent.guests)) continue;
    const { violation } = await evaluateBookingAdultMemberHosting(dependent, db);
    if (violation === null) continue;

    const currentKey = adultMemberHostingStateKey(violation);
    const recorded = parseStoredHostingReview(dependent.adultMemberHostingReview);
    if (recorded && adultMemberHostingStateKey(recorded) === currentKey) continue;
    const incidentKey = incidentKeyByBooking.get(dependent.id);
    if (incidentKey && incidentKey === hostingCoverageStateKey(violation)) continue;

    // Read the lodge name only once, and only where a refusal is actually being
    // built: the happy path costs no extra query.
    lodgeName ??= await resolveCoverageLodgeName(booking.lodgeId, db);
    stranded.push({
      bookingId: dependent.id,
      reference: strandedCoverageReference(dependent.id),
      lodgeName,
      nights: violation.affectedNights,
    });
  }

  return {
    stranded,
    dependentsWithOpenIncidents: openIncidents.map(
      (incident) => incident.bookingId,
    ),
  };
}

/**
 * The lodge's display name for the member-facing refusal.
 *
 * Falls back to a neutral word rather than throwing or leaking the id: the refusal
 * is already correct without it, and "your other booking at the lodge on these
 * nights" is a usable sentence where "your other booking at clv8k2p9x0001 …" is
 * not. The lodge is the one being changed, so there is no cross-lodge disclosure
 * to consider.
 */
async function resolveCoverageLodgeName(
  lodgeId: string,
  db: AdultMemberHostingReviewDb,
): Promise<string> {
  const lodge = await db.lodge.findFirst({
    where: { id: lodgeId },
    select: { name: true },
  });
  return lodge?.name ?? "the lodge";
}

/**
 * The dependent bookings one queued re-evaluation item covers (#2576 §10).
 *
 * The drain's entry point into this module, and the reason the bound is a property
 * of the DATA rather than of the caller's discipline: an item names one owner, one
 * lodge and an explicit night list, and this turns that into a booking id list by
 * intersecting the same three things. There is no shape of item that can widen it
 * into the lodge-wide sweep #2575 rejected.
 *
 * The night list bounds the read as a date envelope (earliest to latest night),
 * because the per-night decision belongs to the evaluator, which reads each
 * booking's own `BookingGuestNight` rows.
 */
export async function loadSameOwnerCoverageDependentIds(
  work: { memberId: string; lodgeId: string; nights: readonly string[] },
  db: AdultMemberHostingReviewDb,
): Promise<string[]> {
  const nights = [...new Set(work.nights)].sort();
  if (nights.length === 0) return [];
  const first = parseDateOnly(nights[0]);
  // The night AFTER the last one is the exclusive checkout bound, so a booking
  // arriving on the last night is included and one arriving the morning after is
  // not — the same half-open convention as everywhere else.
  const lastExclusive = addDaysDateOnly(parseDateOnly(nights[nights.length - 1]), 1);

  const dependents = await db.booking.findMany({
    where: sameOwnerCoverageDependentWhere({
      // A synthetic envelope rather than a real booking: the item may outlive the
      // booking that caused it (an administrative cancellation, a hard delete), and
      // the work is still owed. `id` excludes nothing, which is correct — every
      // active booking of this owner at this lodge over these nights is a
      // candidate, including the one that changed if it still exists.
      id: "",
      memberId: work.memberId,
      lodgeId: work.lodgeId,
      checkIn: first,
      checkOut: lastExclusive,
    }),
    orderBy: [...SAME_OWNER_COVERAGE_DEPENDENT_ORDER],
    take: SAME_OWNER_COVERAGE_DEPENDENT_LIMIT,
    select: { id: true },
  });
  warnIfCoverageDependentCeilingBound(work, dependents.length, "drain");
  return dependents.map((dependent) => dependent.id);
}

/**
 * Bring one dependent booking's incident state into line with current facts
 * (#2576 §8, §14, §16). Called by the drain, after commit, per dependent.
 *
 * Four outcomes, all idempotent:
 *
 *  - no hazard, no incident → nothing;
 *  - no hazard, an open incident → resolve it as `COVERAGE_RESTORED`. §14's
 *    existential rule reaches here: another eligible same-owner source keeps the
 *    booking compliant, so an incident opened when the first source went away is
 *    closed rather than left standing, and no loss-of-cover message is sent;
 *  - a hazard, no incident or a materially different one → open or update, and
 *    report the state key so the caller can notify ONCE for that transition;
 *  - a hazard identical to the recorded one → `unchanged`, with no incident write;
 *    the caller still checks the delivery lease because a prior transient transport
 *    failure may have left this exact state unnotified.
 *
 * The review snapshot is reconciled first, with `REVIEW_ONLY`. That is not a
 * carve-out from the enforced consequence: the booking already exists and was
 * already confirmed, so there is nothing left to refuse — refusing here would
 * throw inside a background drain and roll back the incident that is the whole
 * point. Recording the hazard keeps the booking's own page and the officer's
 * booking view honest alongside the incident.
 */
export async function reconcileSameOwnerCoverageIncident(
  params: {
    bookingId: string;
    cause: HostingCoverageIncidentCause;
    actorMemberId?: string | null;
    reason?: string | null;
  },
  db: AdultMemberHostingReviewDb,
): Promise<
  // Flat rather than grouped by shape, so a caller narrowing on `action` reaches
  // `incidentId` without a cast.
  { action: "none" } | { action: "resolved" } | HostingCoverageIncidentOutcome
> {
  // Serialise the effective-policy read and every resulting incident write with
  // policy administration. Without this, a drain could read ENFORCED, race a
  // demotion to Review/Disabled, and open a fresh urgent incident after the
  // policy writer had already enumerated the active rows it needed to close.
  // The policy-set key is first here; an optional actor Member KEY SHARE comes
  // next, and the evaluator's coverage-owner key is taken after that. The
  // direct-call order is policy-set -> Member KEY SHARE -> coverage-owner.
  // The queue drain has a stronger outer handshake: policy-set -> sorted claimed
  // lifecycle keys -> sorted claimed Member rows -> exact typed queue refresh,
  // then re-enters here with the refreshed actor. Neither layer locks the queue
  // row, so there is no queue -> Member inversion.
  await lockAdultMemberHostingPolicySet(db);

  // Queue attribution is intentionally FK-less so the work survives ordinary
  // member deletion. A merge re-points it (member-merge.ts), but an exceptional
  // hard deletion between enqueue and drain can still leave a dangling id.
  // Incident attribution IS a real FK, so verify at the promotion seam and
  // degrade to anonymous officer attribution rather than retrying a poison item.
  // The mandatory reason is independent evidence and is preserved below.
  // `FOR KEY SHARE` closes the existence-check/FK-write race: a present actor
  // cannot be hard-deleted until this reconciliation transaction commits.
  let actorMemberId: string | null = null;
  if (params.actorMemberId) {
    // Lock raw, read typed (#2289). The row count matters: at READ COMMITTED a
    // zero-match lock followed by a model read could see a newly inserted row
    // that this transaction never locked. Member ids are immutable, but keeping
    // the zero-match guard makes this split read exactly match one locked read.
    const locked = await db.$executeRaw`
      SELECT 1
      FROM "Member"
      WHERE "id" = ${params.actorMemberId}
      FOR KEY SHARE
    `;
    actorMemberId =
      locked > 0
        ? (
            await db.member.findUnique({
              where: { id: params.actorMemberId },
              select: { id: true },
            })
          )?.id ?? null
        : null;
  }

  const outcome = await reconcileAdultMemberHostingReview(params.bookingId, db, {
    enforcement: "REVIEW_ONLY",
  });
  if (outcome.mode !== "ENFORCED") {
    // The club is no longer enforcing (or the booking moved out of scope), so an
    // incident is no longer the right instrument. Resolve rather than leave a row
    // an officer can do nothing useful with.
    const closed = await resolveHostingCoverageIncidents(
      { bookingId: params.bookingId, resolution: "COVERAGE_RESTORED" },
      db,
    );
    return { action: closed > 0 ? "resolved" : "none" };
  }

  if (outcome.violation === null) {
    const closed = await resolveHostingCoverageIncidents(
      {
        bookingId: params.bookingId,
        resolution: "COVERAGE_RESTORED",
        actorMemberId,
      },
      db,
    );
    return { action: closed > 0 ? "resolved" : "none" };
  }

  const booking = await db.booking.findUnique({
    where: { id: params.bookingId },
    select: {
      lodgeId: true,
      status: true,
      deletedAt: true,
      adultMemberHostingReviewStatus: true,
    },
  });
  if (!booking) return { action: "none" };

  // §7's third automatic resolution: "a valid policy exception is approved".
  //
  // WITHOUT THIS THE APPROVAL WAS UNDONE ON THE NEXT PASS. The reconciliation above
  // tests only `violation === null`, and an approved exception does not remove the
  // hazard — it authorises it. So an officer who approved the uncovered nights, with
  // a reason, on this exact proposal, had the next drain re-affirm a `critical`
  // incident against their own decision, and `EXCEPTION_APPROVED` was written
  // nowhere in the tree.
  //
  // APPROVED HERE MEANS APPROVED FOR *THIS* HAZARD, not once upon a time: the
  // reconciliation that just ran reopens the review as PENDING and drops the
  // decision whenever the uncovered state changes materially
  // (`adultMemberHostingReviewChanged`). A stale approval therefore cannot suppress a
  // new problem.
  if (booking.adultMemberHostingReviewStatus === AdminReviewStatus.APPROVED) {
    const closed = await resolveHostingCoverageIncidents(
      {
        bookingId: params.bookingId,
        resolution: "EXCEPTION_APPROVED",
        actorMemberId,
      },
      db,
    );
    return { action: closed > 0 ? "resolved" : "none" };
  }

  // AN INCIDENT IS ONLY EVER OPENED FOR A BOOKING THE CLUB HAS ACCEPTED (§7, §16:
  // "where a booking BECOMES UNCOVERED AFTER CONFIRMATION").
  //
  // NOT TIDINESS — this is the guard that stops a false urgent incident, and the
  // shape that produces one is real. The saved-card auto-charge claims a booking
  // PENDING -> CONFIRMED, queues this re-evaluation with the claim, and RELEASES it
  // back to PENDING if the charge does not complete. Without this test the drain
  // would arrive after the release, find an uncovered PENDING booking, and put a
  // stay nobody has confirmed in front of an officer as an emergency. The same
  // applies to every DRAFT, AWAITING_REVIEW or waitlisted booking the bounded read
  // legitimately returns: uncovered is a normal, permitted state for those, they
  // carry a pending hosting review already, and they will be refused at their own
  // confirmation (§9) if the cover has not come back.
  //
  // It does NOT resolve an incident that is already open. A CONFIRMED booking that
  // regressed to PENDING still holds its beds and its problem, and reporting that as
  // `COVERAGE_RESTORED` would tell an officer cover came back when nothing of the
  // kind happened. The row stays, and the next reconciliation of a re-confirmed
  // booking updates it.
  if (
    booking.deletedAt != null ||
    !isHostingCoverageSourceBookingStatus(String(booking.status))
  ) {
    return { action: "none" };
  }

  return openOrUpdateHostingCoverageIncident(
    {
      bookingId: params.bookingId,
      lodgeId: booking.lodgeId,
      cause: params.cause,
      violation: outcome.violation,
      override:
        params.cause === "OFFICER_OVERRIDE" &&
        params.reason?.trim()
          ? { byMemberId: actorMemberId, reason: params.reason }
          : null,
    },
    db,
  );
}

/**
 * The refusal the ENFORCED consequence raises (#2569 §1).
 *
 * DELIBERATELY THE SAME SHAPE AS `PaidUpAdultMemberRequiredError` (#2543/#2560),
 * down to the status code and the reasoning behind it: 409, not 403. A 403 says
 * "you may not do this"; this booking IS permitted, by a Booking Officer, through
 * the #2365 exception-request workflow — the state of the party is what conflicts.
 * It also keeps `ADULT_MEMBER_HOSTING_REQUIRED` out of the
 * `HARD_STOP_BOOKING_FAILURE_CODES` family, which is exactly the set of refusals
 * that may NOT enter exception review.
 *
 * NOT A SECOND REFUSAL PATH. The violation it carries is the same frozen
 * `AdultMemberHostingPolicyExceptionViolation` the review mode records, produced
 * by the same evaluator, aggregated by the same `aggregatePolicyExceptionViolations`
 * and re-derived server-side by `collectProposalPolicyViolations` when the member
 * walks through the exception door. Nothing about the officer queue, the frozen
 * snapshot or the override machinery is forked for the enforced mode — only
 * whether the booking is allowed to exist while it waits.
 *
 * WHY IT IS AN ApiError. It is thrown from inside the mutation transactions that
 * every booking write path already runs, so the throw rolls the non-compliant
 * write back — which is what "do not confirm a non-compliant booking" means in
 * practice — and every route that already handles `ApiError` answers 409 with the
 * message rather than a 500. Routes that want to hand the member the exception
 * door as well add a typed branch and return `buildAdultMemberHostingRefusalBody`.
 */
export class AdultMemberHostingRequiredError extends ApiError {
  readonly code = "ADULT_MEMBER_HOSTING_REQUIRED";
  readonly violation: AdultMemberHostingPolicyExceptionViolation;
  readonly exceptionReview: AggregatedPolicyExceptions;

  constructor(violation: AdultMemberHostingPolicyExceptionViolation) {
    super(violation.message, 409);
    this.name = "AdultMemberHostingRequiredError";
    this.violation = violation;
    this.exceptionReview = aggregatePolicyExceptionViolations([violation]);
  }
}

/**
 * Strip the identities of the adult members whose stays cover each night.
 *
 * REQUIRED, NOT DEFENSIVE (#2576 §11). A member-facing body has no business
 * carrying member ids under any scope: `memberIds` is an internal identity the
 * frozen snapshot keeps in full for validation and audit, and the member-facing
 * answer says only that adult-member cover is or is not present. Under
 * `SAME_BOOKING_OWNER` the covering stay is on the member's OWN account, so the
 * privacy stake is lower than the removed lodge-wide scope's was — but the rule is
 * applied to EVERY scope rather than only where it bites, because a redaction that
 * fires under one setting is a redaction nobody tests.
 *
 * The night list and the per-night scope list are kept: "this night is covered,
 * by an adult member on this booking" is the advice §17 asks for, and neither
 * field names a person.
 */
function withheldHostIdentities(
  violation: AdultMemberHostingPolicyExceptionViolation,
): AdultMemberHostingPolicyExceptionViolation {
  return {
    ...violation,
    requirements: {
      ...violation.requirements,
      qualifyingHostsByNight: violation.requirements.qualifyingHostsByNight.map(
        (night) => ({
          night: night.night,
          memberIds: [],
          ...(night.coveredByScopes
            ? { coveredByScopes: night.coveredByScopes }
            : {}),
        }),
      ),
    },
  };
}

/**
 * The member-facing body for an ENFORCED hosting refusal.
 *
 * Mirrors `buildPaidUpAdultRefusalBody` (#2543) so the two refusals a party can
 * trip at once are described the same way, and so a client can rely on
 * `exceptionReview.capacityMode` to know whether asking for an override keeps the
 * beds. Host identities are withheld — see `withheldHostIdentities`.
 *
 * `exceptionRequestPath` states where the member goes next rather than leaving the
 * client to know: "you were refused but you may ask" is useless advice if the
 * caller cannot find the door. For a NEW booking that door reserves nothing — the
 * request holds no beds and capacity is checked again at approval (#2569 §1) —
 * which is what `exceptionReview.capacityMode` reports honestly.
 */
export function buildAdultMemberHostingRefusalBody(
  violation: AdultMemberHostingPolicyExceptionViolation,
) {
  const redacted = withheldHostIdentities(violation);
  const exceptionReview = aggregatePolicyExceptionViolations([redacted]);
  return {
    error: redacted.message,
    code: "ADULT_MEMBER_HOSTING_REQUIRED" as const,
    details: redacted.message,
    violations: exceptionReview.violations,
    exceptionReview,
    exceptionRequestPath: "/api/bookings/exception-requests",
  };
}
