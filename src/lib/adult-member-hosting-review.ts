import {
  AdminReviewStatus,
  BookingStatus,
  Prisma,
  type MemberGuestConsentStatus,
  type PrismaClient,
} from "@prisma/client";

import {
  LINKED_MOVE_DECLINED_INCIDENT_REASON,
  hostingCoverageStateKey,
  openOrUpdateHostingCoverageIncident,
  resolveHostingCoverageIncidents,
  type HostingCoverageIncidentCause,
  type HostingCoverageIncidentOutcome,
  type HostingCoverageIncidentResolution,
} from "@/lib/adult-member-hosting-coverage-incidents";
import {
  lockHostingCoverageGroup,
  lockHostingCoverageOwner,
  lockHostingCoverageOwners,
  tryLockHostingCoverageGroup,
  tryLockHostingCoverageOwner,
  tryLockHostingCoverageOwners,
} from "@/lib/adult-member-hosting-coverage-lock";
import { lockAdultMemberHostingPolicySet } from "@/lib/adult-member-hosting-policy-set";
import { enqueueHostingCoverageReevaluation } from "@/lib/adult-member-hosting-coverage-queue";
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
  dependentNeedsOwnQueueItem,
  sameOwnerCoverageDependentOverStayUnionWhere,
  sameOwnerCoverageDependentWhere,
  strandedCoverageStateKey,
  strandedCoverageReference,
  type StrandedCoverageBooking,
} from "@/lib/adult-member-hosting-same-owner";
import {
  linkedMoveWouldRestoreCover,
} from "@/lib/adult-member-hosting-linked-move";
import { AdultMemberHostingRequiredError } from "@/lib/adult-member-hosting-refusal";
import {
  COVERAGE_READ_ORDER,
  GROUP_TRIP_COVERAGE_DEPENDENT_LIMIT,
  HostingGroupTripSourceCeilingExceededError,
  HostingSameOwnerSourceCeilingExceededError,
  HostingSiblingCeilingExceededError,
  SAME_GROUP_TRIP_COVERAGE_SOURCE_LIMIT,
  SAME_OWNER_COVERAGE_DEPENDENT_LIMIT,
  SAME_OWNER_COVERAGE_SOURCE_LIMIT,
  warnIfCoverageDependentCeilingBound,
  reportGroupTripDependentCeilingBound,
} from "@/lib/adult-member-hosting-coverage-ceilings";
import {
  GROUP_TRIP_IDENTITY_SELECT,
  groupTripCoverageDependentWhere,
  groupTripCoverageSourceWhere,
  groupTripIdentityOf,
  type GroupTripCoverageBooking,
  type GroupTripIdentity,
  type GroupTripIdentityRow,
} from "@/lib/group-trip-identity";
import type {
  AdultMemberHostingPolicyExceptionViolation,
  AdultMemberHostScope,
} from "@/lib/booking-policy-exceptions";
import {
  ACTIVE_BOOKING_STATUSES,
  isHostingCoverageSourceBookingStatus,
} from "@/lib/booking-status";
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
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
  hostingModeCanRefuseStranding,
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
import { seasonYearOfStoredDate } from "@/lib/financial-year";

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
 * WHAT IS NOT IN HERE (#3128). `adult-member-hosting-refusal.ts` holds the 409
 * and the member-facing body; `adult-member-hosting-coverage-ceilings.ts` the
 * bounded-read limits and their two errors;
 * `adult-member-hosting-proposed.ts` the create path's preflight over a party
 * that does not exist yet; and `adult-member-hosting-merge-coverage-plan.ts`
 * the fan-out plan member merge builds twice and compares.
 *
 * The four are separable for two OPPOSITE reasons, and the direction matters if
 * you are deciding whether an import is legal. Refusal and coverage-ceilings are
 * leaves: they import nothing from here, and THIS file imports them. Proposed
 * and merge-coverage-plan are the other way round: they import this file, and
 * nothing here calls them. Either way the edge runs one way only, which is what
 * makes the split safe — but do not read "the engine imports nothing from its
 * split modules", because it imports two of them.
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
      hostScopeSameGroupTrip: true,
    },
  });
  return resolveAdultMemberHostingPolicy(rows, effectiveLodgeId);
}

const BOOKING_HOSTING_SELECT = {
  id: true,
  memberId: true,
  parentBookingId: true,
  // #3038 (epic #2943). Canonical Group Trip identity, spread from the ONE
  // constant that owns it rather than re-typed here, so a relation name that
  // drifts from the schema is a single edit instead of a per-call-site hunt.
  // `groupTripIdentityOf` reads these two and nothing else; `parentBookingId`
  // above is the #738 split-booking relationship and is NEVER group identity
  // (`INV-HOST-043`).
  ...GROUP_TRIP_IDENTITY_SELECT,
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

/**
 * INTERSECTED WITH `GroupTripIdentityRow` RATHER THAN RESTATING IT (#3038).
 * `group-trip-identity.ts` owns what `GROUP_TRIP_IDENTITY_SELECT` produces,
 * including WHY both fields are required and nullable rather than optional; a
 * second copy of that shape here would be a second thing to keep right. It also
 * would not have stayed right for long: the reads below are `as
 * LoadedHostingBooking[]` casts, so a relation narrowed or renamed in the select
 * constant type-checks clean against a hand-written duplicate and fails at
 * runtime. Intersecting makes the drift a compile error instead.
 */
type LoadedHostingBooking = GroupTripIdentityRow & {
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
    ...HOSTING_SIBLING_LIFECYCLE_WHERE,
    id: { not: booking.id },
  };
}

/**
 * Which sibling rows are still real: the lifecycle half of the clause above,
 * spelled once (`INV-SSOT-001`).
 *
 * Extracted because the batched split-pair reader below needs the identical
 * filter over a different key set — `id IN (...)` rather than the parent/child
 * `OR` — and two hand-written copies of "cancelled, bumped and soft-deleted are
 * out" is exactly the arrangement where one of them later admits a cancelled
 * booking as somebody's Group Trip.
 */
const HOSTING_SIBLING_LIFECYCLE_WHERE: Prisma.BookingWhereInput = {
  deletedAt: null,
  status: { notIn: [BookingStatus.CANCELLED, BookingStatus.BUMPED] },
};

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
): Promise<{
  participants: HostingParticipant[];
  siblingIds: string[];
  /**
   * The rows themselves, because the #738 split pair is the ONE relationship
   * that carries Group Trip identity across two `Booking` rows and the caller
   * has to be able to read it (`inheritedSplitPairGroupTrip`). Returned rather
   * than resolved here on purpose: this loader answers "who can host", and
   * which Group Trip the party belongs to is decided at the call site where all
   * three scopes meet, beside the identity question it is an exception to.
   */
  rows: LoadedHostingBooking[];
}> {
  const siblings = (await db.booking.findMany({
    where: hostingSiblingWhere(booking),
    select: BOOKING_HOSTING_SELECT,
    ...(siblingCeiling === undefined
      ? {}
      : {
          // A total order, so a bound that binds binds reproducibly rather than
          // returning any N of the matching rows. `COVERAGE_READ_ORDER` is that
          // order for every bounded coverage read in this file, and spelling it
          // out a third time here is exactly the drift #3038 removed from the
          // two source reads (`INV-SSOT-001`). Applied only when a ceiling is
          // passed, unlike those two: a writer's sibling read is unbounded, so
          // there is no truncation for an order to make reproducible.
          orderBy: [...COVERAGE_READ_ORDER],
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
    rows: siblings,
  };
}

/**
 * The Group Trip a booking INHERITS from the OTHER HALF OF ITS #738 SPLIT PAIR
 * — the single exception to "a booking's Group Trip identity is its own two
 * canonical relations", and a deliberately narrow carve-out rather than a
 * softening of that rule (owner decision, 31 Aug 2026; `INV-HOST-043`).
 *
 * WHAT WENT WRONG WITHOUT IT. A member joining a Group Trip with a mixed party
 * gets TWO booking rows: `createConfirmedBooking` writes the member half, hangs
 * the non-member half off it by `parentBookingId`, and writes the
 * `GroupBookingJoin` row against the member half only — because one party is
 * one joiner on the roster, and the `(groupBookingId, joinerMemberId)` unique
 * pair says so. So the half that carries the NON-MEMBER GUESTS, the rows the
 * hosting rule exists to judge, resolved to no Group Trip and received no
 * cover. The join preflight evaluates the undivided party and said yes; the
 * reconciler evaluated the child and said no. Told yes, then told no, about one
 * party, seconds apart.
 *
 * THE BOUNDARY, AND IT IS THE WHOLE SAFETY OF THE CARVE-OUT. `parentBookingId`
 * remains categorically NOT a Group Trip identity source, and a booking still
 * never borrows identity from an unrelated parent. Inheritance happens only
 * from a row that is already a `SAME_BOOKING` split sibling under
 * `hostingSiblingWhere` — the rows this function is handed — which is
 * `booking.parentBookingId`, owned by the SAME member, not cancelled, not
 * bumped and not soft-deleted. Three configurations are therefore excluded, and
 * all three matter:
 *
 *  - A #796 GROUP JOINER hangs off the ORGANISER's booking by the same column
 *    while belonging to a DIFFERENT member. It inherits nothing here (the
 *    same-member filter drops it), and needs nothing: a joiner always carries
 *    its own `GroupBookingJoin` row.
 *  - A CANCELLED, BUMPED OR ARCHIVED parent is not in the sibling set, so a
 *    dead booking cannot lend its trip to a live one.
 *  - THE DIRECTION IS ONE-WAY. Only `booking.parentBookingId` is followed, so a
 *    parent never inherits from a child. It has no need to — the roster row is
 *    on the parent — and reading the relation both ways would make "the second
 *    half of a split pair" mean any pair member.
 *
 * A booking with an identity of its own never reaches here: the caller asks
 * `groupTripIdentityOf` first, and this answers only where that returned null.
 *
 * NOTHING FLOWS THE OTHER WAY. Inheriting is about what a split child RECEIVES;
 * it supplies nothing, because the Group Trip source and dependent reads are
 * both relation-based (`groupTripMembershipWhere`) and the child has neither
 * relation. That is the right answer as well as the safe one: the child carries
 * only non-member guests, so it has no adult to lend anybody.
 *
 * WHAT #3039 MUST DO WITH THAT. Being absent from the DEPENDENT set means a
 * Group Trip fan-out finds this child's PARENT and not the child. The child is
 * reached through the `SAME_BOOKING` sibling fan-out that already exists, so the
 * reconciliation #3039 adds has to go through
 * `reconcileAdultMemberHostingReviewWithSiblings` rather than reconciling each
 * dependent row directly — otherwise the half carrying the non-member guests is
 * the one half nobody re-evaluates.
 */
function inheritedSplitPairGroupTrip(
  booking: Pick<LoadedHostingBooking, "parentBookingId">,
  splitSiblings: readonly SplitPairSiblingRow[],
): GroupTripIdentity | null {
  const parentId = booking.parentBookingId;
  if (!parentId) return null;
  const parent = splitSiblings.find((sibling) => sibling.id === parentId);
  return parent ? groupTripIdentityOf(parent) : null;
}

/**
 * The least a row must carry to be judged as the other half of a split pair.
 *
 * `id` and the two canonical relations, and deliberately nothing else. The
 * persisted evaluator hands over full `LoadedHostingBooking` rows it has already
 * read; the exception-request path has no such rows and reads a two-column
 * projection instead, so widening the parameter is what lets ONE rule serve both
 * rather than a second copy growing on the proposal side (`INV-SSOT-001`).
 *
 * The `booking` parameter stays `Pick<LoadedHostingBooking, "parentBookingId">`,
 * and that narrowness is the carve-out's PRIMARY structural guard: the function
 * is never handed the evaluated booking's own `id`, so it cannot be widened to
 * follow children without changing the signature — which no accidental edit
 * does. The behavioural fence in
 * `adult-member-hosting-group-trip-cover.test.ts` is the second guard, and the
 * one that catches a widening of the `find` predicate itself.
 */
type SplitPairSiblingRow = GroupTripIdentityRow & { id: string };

const SPLIT_PAIR_IDENTITY_SELECT = {
  id: true,
  ...GROUP_TRIP_IDENTITY_SELECT,
} as const;

/**
 * The same carve-out for a caller that holds no sibling rows (#3038).
 *
 * `evaluateLoadedBookingAdultMemberHosting` has already read the `SAME_BOOKING`
 * sibling set by the time it asks, so it calls `inheritedSplitPairGroupTrip`
 * directly and the exception costs no extra query. The exception-request
 * re-evaluation
 * (`booking-exception-request-service.ts` -> `resolveProposalGroupTrip`) holds
 * nothing: it resolves identity from a single `findUnique` on the live booking.
 * Without this it could not apply the carve-out AT ALL — and being unable to is
 * not a smaller version of the same answer, it is the two evaluators disagreeing
 * about exactly the booking the carve-out exists to fix. A split child covered
 * only through its parent's Group Trip would be re-judged as uncovered, and that
 * phantom violation is FROZEN into the request, shown to an officer as live,
 * used to reserve beds under `HOLD`, and reproduced at approval so the #2525
 * drift gate compares it with itself.
 *
 * So the RULE lives once and this is a second way in, not a second answer: the
 * same `hostingSiblingWhere` set, filtered by the same
 * `inheritedSplitPairGroupTrip`. The read is skipped entirely for a booking with
 * no `parentBookingId`, which is every ordinary booking.
 */
export async function readInheritedSplitPairGroupTrip(
  db: Pick<AdultMemberHostingReadDb, "booking">,
  booking: Pick<LoadedHostingBooking, "id" | "memberId" | "parentBookingId">,
): Promise<GroupTripIdentity | null> {
  if (!booking.parentBookingId) return null;
  const splitSiblings = (await db.booking.findMany({
    where: hostingSiblingWhere(booking),
    select: SPLIT_PAIR_IDENTITY_SELECT,
  })) as SplitPairSiblingRow[];
  return inheritedSplitPairGroupTrip(booking, splitSiblings);
}

/**
 * The same carve-out for MANY bookings at once, in ONE query (#3040).
 *
 * The singular reader above answers for one booking and issues one query, which
 * is right for the paths that hold one booking. The kiosk day list holds up to a
 * lodge-full of them, and calling the singular in a loop made a sequential N+1
 * on a read the issue's own data contract bounds at "one indexed query over
 * already-loaded Booking ids". Worse, it did so on a population that is NOT
 * rare: a #738 split child exists wherever one party mixes member and non-member
 * guests, and both halves appear on the same day list.
 *
 * A SECOND WAY IN, NOT A SECOND ANSWER, exactly as the singular is for the
 * exception-request path. The verdict is still `inheritedSplitPairGroupTrip` —
 * the one fence — and the lifecycle filter is still
 * `HOSTING_SIBLING_LIFECYCLE_WHERE`. What differs is only the key: `id IN
 * (parents)` instead of one booking's parent/child `OR`, with the same-member
 * test applied to the loaded rows rather than to the query, because the batch
 * spans many members and a per-member clause would rebuild the N queries this
 * exists to remove.
 *
 * A booking with no `parentBookingId` asks nothing, so a day list with no split
 * child issues no query at all.
 */
export async function readInheritedSplitPairGroupTrips(
  db: Pick<AdultMemberHostingReadDb, "booking">,
  bookings: readonly Pick<
    LoadedHostingBooking,
    "id" | "memberId" | "parentBookingId"
  >[],
): Promise<Map<string, GroupTripIdentity>> {
  const children = bookings.filter((booking) => booking.parentBookingId);
  const identities = new Map<string, GroupTripIdentity>();
  if (children.length === 0) return identities;

  const parentIds = [
    ...new Set(children.map((child) => child.parentBookingId as string)),
  ];
  const parents = (await db.booking.findMany({
    where: { ...HOSTING_SIBLING_LIFECYCLE_WHERE, id: { in: parentIds } },
    select: BATCHED_SPLIT_PAIR_IDENTITY_SELECT,
  })) as Array<SplitPairSiblingRow & { memberId: string }>;

  for (const child of children) {
    // The same-member filter the singular reader puts in its `where`. A joiner's
    // booking hangs off the organiser's, so without it a Group Trip would leak
    // across accounts through `parentBookingId` — the one column `INV-HOST-043`
    // forbids as an identity source.
    const inherited = inheritedSplitPairGroupTrip(
      child,
      parents.filter(
        (parent) => parent.memberId === child.memberId && parent.id !== child.id,
      ),
    );
    if (inherited) identities.set(child.id, inherited);
  }
  return identities;
}

/** `SPLIT_PAIR_IDENTITY_SELECT` plus the owner the batched reader filters on. */
const BATCHED_SPLIT_PAIR_IDENTITY_SELECT = {
  ...SPLIT_PAIR_IDENTITY_SELECT,
  memberId: true,
} as const;

/**
 * THE cross-booking coverage source read — one body, parameterised by the
 * relationship clause and the scope it stamps (#3038, `INV-SSOT-001`).
 *
 * `SAME_BOOKING_OWNER` and `SAME_GROUP_TRIP` differ in exactly one thing: which
 * bookings are eligible sources. Everything else about reading them is a
 * property of "reading cover from another booking", and every one of those
 * facts was written out twice before this function existed:
 *
 *  - THE GUEST NARROWING. Only member-linked guest rows are loaded. A true
 *    narrowing rather than a policy: a guest with no `Member` link can never
 *    host under any scope, so loading a source's non-member guests would be
 *    loading rows the evaluator is guaranteed to ignore. Their own nights are
 *    that booking's problem, judged when that booking is reconciled.
 *  - THE ORDERED-TRUNCATION PROTOCOL. A writer takes the scope's own bound and
 *    truncates; an evidence caller passes a ceiling, gets `ceiling + 1` rows so
 *    that "there were more than I may read" is a distinguishable fact, and is
 *    REFUSED rather than handed a quietly short list. The order is
 *    `COVERAGE_READ_ORDER` and it is now applied unconditionally — see that
 *    constant for why a writer wants it too.
 *  - THE DEFENSIVE GUEST-RELATION FILTER. A source that arrived without its
 *    guest relation contributes no hosts. Dropping it is the safe direction:
 *    fewer borrowed hosts can only OPEN a review for an admin to look at, never
 *    suppress one.
 *  - THE `sourceIds` CONTRACT. The ids of the rows ACTUALLY READ, so a truncated
 *    read cannot exclude a booking nobody looked at. They come back because the
 *    scopes narrow in order and each must exclude what the last already loaded:
 *    one adult arriving twice under two scopes would appear in the participant
 *    list twice and would credit `coveredByScopes` with a scope that supplied
 *    nothing new, which is the field #3040's kiosk cover-source display reads.
 *
 * THE EXCLUSION IS COMPOSED UNDER `AND`, NEVER SPREAD, and that is the drift
 * this extraction removes rather than merely tidies. The same-owner read spread
 * `{ ...where, id: { not, notIn } }`, which overwrote the `id` key its own
 * envelope had already set and so had to RE-STATE the self-exclusion to avoid
 * losing it; the Group Trip read composed under `AND` and needed no such
 * restatement. Two spellings of one clause, one of them only correct because it
 * repeated itself. `AND` cannot lose a key, so the envelope's self-exclusion
 * stands on its own and the restatement is gone.
 *
 * `loadSiblingHosts` IS DELIBERATELY NOT FOLDED IN. It reads the FULL booking
 * select rather than the narrowed one (its rows carry the split pair's Group
 * Trip identity), it does not narrow guests to member-linked rows, it stamps no
 * `hostScope` because a split sibling is `SAME_BOOKING`, and it is unbounded for
 * a writer on purpose. A helper contorted to serve both shapes would be harder
 * to read than the two it replaced.
 */
async function loadCoverageSourceHosts(args: {
  db: Pick<AdultMemberHostingReviewDb, "booking">;
  /** The scope's own eligibility clause, envelope included. */
  where: Prisma.BookingWhereInput;
  /** Bookings a NARROWER scope has already read; excluded in the query. */
  excludeBookingIds: readonly string[];
  /** Stamped on every participant, so the evaluator can gate on the club's set. */
  hostScope: AdultMemberHostScope;
  /** The bound a WRITER truncates at. */
  writerLimit: number;
  /** An evidence caller's bound, which refuses instead of truncating. */
  ceiling: number | undefined;
  ceilingError: (ceiling: number) => Error;
}): Promise<{ participants: HostingParticipant[]; sourceIds: string[] }> {
  const { db, where, excludeBookingIds, hostScope, ceiling } = args;
  const sources = (await db.booking.findMany({
    where:
      excludeBookingIds.length > 0
        ? { AND: [where, { id: { notIn: [...excludeBookingIds] } }] }
        : where,
    take: ceiling === undefined ? args.writerLimit : ceiling + 1,
    orderBy: [...COVERAGE_READ_ORDER],
    select: {
      id: true,
      guests: {
        where: { memberId: { not: null } },
        select: BOOKING_HOSTING_SELECT.guests.select,
      },
    },
  })) as Array<{ id: string; guests: LoadedHostingBooking["guests"] }>;
  if (ceiling !== undefined && sources.length > ceiling) {
    throw args.ceilingError(ceiling);
  }

  return {
    participants: sources
      .filter((source) => Array.isArray(source.guests))
      .flatMap((source) =>
        toHostingParticipants(source, true).map((participant) => ({
          ...participant,
          hostScope,
        })),
      ),
    sourceIds: sources.map((source) => source.id),
  };
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
export async function loadSameBookingOwnerHosts(
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
   * covered — a fabricated finding, which is the opposite of safe. Since #3038
   * both reads carry `COVERAGE_READ_ORDER`, so a truncation is at least
   * reproducible; that fixes the writer's snapshot churn and does nothing for the
   * honesty of a short evidence answer.
   *
   * So an evidence caller passes a ceiling, gets `ceiling + 1` rows, and gets a
   * REFUSAL when the bound binds. Omitted by every writer, which still truncates.
   */
  sameOwnerSourceCeiling?: number,
): Promise<{ participants: HostingParticipant[]; sourceIds: string[] }> {
  return loadCoverageSourceHosts({
    db,
    where: sameBookingOwnerCoverageSourceWhere(booking),
    excludeBookingIds,
    hostScope: "SAME_BOOKING_OWNER",
    writerLimit: SAME_OWNER_COVERAGE_SOURCE_LIMIT,
    ceiling: sameOwnerSourceCeiling,
    ceilingError: (ceiling) =>
      new HostingSameOwnerSourceCeilingExceededError(ceiling),
  });
}

/**
 * The qualifying-adult-member candidates attending ANOTHER live booking in the
 * SAME GROUP TRIP, at the same lodge, over nights that overlap this stay
 * (#3038, epic #2943).
 *
 * HOST-ONLY, COUNTED ONCE, AND READ UNDER A BOUND OF ITS OWN — that is
 * `INV-HOST-044`, which is the rule's one home and states all three in full
 * along with why. This docblock says how this function meets it, not what it
 * says, and the id is what a reader follows for the rest.
 *
 * The third cross-booking loader, and deliberately the SAME SHAPE as
 * `loadSameBookingOwnerHosts` — both are `loadCoverageSourceHosts` with one
 * clause changed, which is what makes the three-scope symmetry checkable rather
 * than promised. `hostScope: "SAME_GROUP_TRIP"` is what gates it on the club's
 * setting (`INV-HOST-017`), `hostOnly: true` is what keeps beds, participants,
 * price and responsibility on the source's own booking, and the participants are
 * the canonical `toHostingParticipants`' — so whether these people actually
 * qualify is decided afterwards by `participantQualifiesAsHost`, exactly as for
 * the booking's own guests. There is deliberately no second definition of a
 * qualifying adult member here.
 *
 * OWNERSHIP IS NOT THE RELATIONSHIP HERE, which is the one real difference from
 * its same-owner sibling. Group Trip sources belong to OTHER members — that is
 * the entire point of the feature — so a member-owned join and a non-member
 * join consume this cover on identical terms, and nothing about who owns a
 * source booking is consulted.
 *
 * `excludeBookingIds` IS THE DEDUPLICATION (`INV-HOST-044`), and it is a query
 * clause rather than a post-filter so a booking already read under a narrower
 * scope is never read twice. The caller passes the split siblings
 * (`SAME_BOOKING`) and the same-owner sources (`SAME_BOOKING_OWNER`) it has
 * already loaded.
 *
 * WHAT DECIDES THE SOURCE SET is `groupTripCoverageSourceWhere`: the canonical
 * membership clause AND the shared coverage envelope, which is where the lodge,
 * self-exclusion, half-open night overlap and `Booking.status` rules live. The
 * container's own status is NOT among them (`INV-HOST-043`) — closing or
 * cancelling a Group Trip governs who may still JOIN it, never whether the
 * adults on the bookings that already joined are travelling.
 *
 * `sourceIds` COMES BACK UNCONSUMED TODAY, and that is a stated choice rather
 * than an oversight: this is the last scope in the chain, so nothing narrower
 * follows it, and #3039's reconciliation fan-out is what reads the shape. Its
 * two siblings return the same field for the same reason, which is what lets a
 * reader check the exclusion chain at the one call site where all three meet.
 */
export async function loadSameGroupTripHosts(
  booking: GroupTripCoverageBooking,
  identity: GroupTripIdentity,
  db: Pick<AdultMemberHostingReviewDb, "booking">,
  excludeBookingIds: readonly string[],
  /**
   * A DETERMINISTIC CEILING, supplied only by a read-only evidence caller — the
   * same distinction its two siblings draw, for the same reason, on a third host
   * population.
   *
   * The writer's `SAME_GROUP_TRIP_COVERAGE_SOURCE_LIMIT` truncates, which is
   * safe FOR A WRITER: fewer hosts are seen, so a night reads as uncovered and
   * the booking is flagged or refused rather than quietly allowed. That argument
   * inverts for evidence — a diagnostic that misses the sibling booking carrying
   * the covering adult reports a LIVE BLOCKER on a booking that is actually
   * covered — so an evidence caller passes a ceiling, gets a total order and
   * `ceiling + 1` rows, and gets a refusal when the bound binds. Omitted by
   * every writer.
   */
  groupTripSourceCeiling?: number,
): Promise<{ participants: HostingParticipant[]; sourceIds: string[] }> {
  return loadCoverageSourceHosts({
    db,
    where: groupTripCoverageSourceWhere(booking, identity),
    excludeBookingIds,
    hostScope: "SAME_GROUP_TRIP",
    writerLimit: SAME_GROUP_TRIP_COVERAGE_SOURCE_LIMIT,
    ceiling: groupTripSourceCeiling,
    ceilingError: (ceiling) =>
      new HostingGroupTripSourceCeilingExceededError(ceiling),
  });
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
  // ONE IMPLEMENTATION, THE BATCHED ONE (`INV-SSOT-001`). This and
  // `loadHostingCoverageSplitSiblingIds` answered the same question — "which #738
  // split halves does this booking have" — through the same `hostingSiblingWhere`
  // predicate, in two hand-written reads. The batched form is the general case (its
  // `OR` of per-row clauses is the union of the per-row answers, with no predicate
  // rewritten), so the singular case delegates to it rather than repeating it.
  //
  // THE MUTATION PATH GAINS A BOUNDED READ, and that is an improvement rather than a
  // cost under `INV-OPS`: the batched form applies `COVERAGE_READ_ORDER` and
  // `SAME_OWNER_COVERAGE_DEPENDENT_LIMIT`, where this read had `take` and `orderBy`
  // on neither. An unbounded, unordered sibling read on every booking write was the
  // shape the ceilings exist to prevent, and a split pair is two rows so the bound
  // cannot bind on any real family.
  return loadHostingCoverageSplitSiblingIds([bookingId], db);
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
   * Take the per-TRIP key for one resolved Group Trip identity (#3039).
   *
   * A SECOND CALLBACK RATHER THAN A WIDENED FIRST ONE, because the two keys are
   * acquired at different points and in a fixed order: this one first, the owner
   * key second (`INV-LOCK-002`). Folding them into one acquisition would make the
   * order an implementation detail of that helper rather than something the
   * ordering test can read at this call site, and the group id is not known until
   * the split-pair fallback has run.
   *
   * `null` from the read-only evidence entry point, which takes no advisory lock at
   * all — the same treatment `acquireCoverageOwnerLock` gets there and for the same
   * reason: a diagnostic must never join a writer lock cohort.
   */
  acquireCoverageGroupLock: ((groupBookingId: string) => Promise<void>) | null,
  /**
   * AN OPTIONS OBJECT RATHER THAN A POSITIONAL TAIL (#3038), and the reason is
   * that the tail had reached six. Every one of them is optional, several are
   * `number | undefined`, and #3038 inserted `groupTripSourceCeiling` in the
   * MIDDLE of the run of ceilings — where its two neighbours have the same type,
   * so an argument list that slipped by one would have type-checked clean and
   * silently applied the sibling bound to the same-owner read. Named fields make
   * that unrepresentable, and the read-only entry point below now forwards its
   * own `options` unchanged rather than re-listing them in an order that has to
   * match.
   */
  options: {
    /**
     * The season the subscription bridge judges settlement in, when the caller has
     * already resolved it authoritatively. Omitted by every writer, which runs
     * behind a gated request that has seeded the financial-year cache; supplied by
     * read-only evidence callers, which cannot. See
     * `evaluatePersistedBookingAdultMemberHostingReadOnly`.
     */
    seasonYear?: number;
    /**
     * The club's lockout mode, when the caller has read it authoritatively. Same
     * reason as `seasonYear`: the bridge otherwise peeks it through readers that turn
     * a database failure into `NO_BLOCK`, so an evidence caller would report a
     * fabricated hosting answer for an enforcing club after one transient failure.
     */
    subscriptionLockoutMode?: SubscriptionLockoutMode;
    /** See `loadSiblingHosts`; supplied only by a read-only evidence caller. */
    siblingCeiling?: number;
    /**
     * See `loadSameBookingOwnerHosts`. The OTHER host population, with its own
     * ceiling because it is a different population — a wide split family and a member
     * holding many bookings at one lodge are different data problems.
     */
    sameOwnerSourceCeiling?: number;
    /**
     * See `loadSameGroupTripHosts`. The THIRD host population, with its own
     * ceiling because it is a third data question — a Group Trip is MEANT to be
     * many separate bookings, so its writer bound sits well above the other two.
     */
    groupTripSourceCeiling?: number;
    /**
     * How the #2543 subscription bridge reads the club's age-tier rule. Omitted by
     * every writer, which takes the cached reader that falls back to
     * `AGE_TIER_DEFAULTS`; supplied by a read-only evidence caller, whose strict
     * reader rejects a failed read rather than judging a named member's hosting
     * qualification against a tier rule nobody observed. See `AgeTierSettingsReader`.
     */
    readAgeTierSettings?: AgeTierSettingsReader;
  } = {},
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
  // the #2569 upgrade a no-op on cost as well as on answers. #3038's
  // `SAME_GROUP_TRIP` read is skipped on the same two, plus a third that costs
  // nothing to check: a booking in no Group Trip has no sibling set to read, so
  // the query is skipped for every ordinary booking even at a club that HAS
  // turned the scope on.
  let participants: HostingParticipant[] = [];
  if (hostingModeIsActive(resolved.mode)) {
    const siblings = await loadSiblingHosts(
      booking,
      db,
      options.siblingCeiling,
    );
    // Resolved from the two canonical relations and nothing else; `null` for a
    // booking in no Group Trip, which is the ordinary case (`INV-HOST-043`).
    //
    // The ONE fallback is the other half of a #738 split pair, and it is a named
    // carve-out with a boundary rather than a second identity source — see
    // `inheritedSplitPairGroupTrip`, which is handed the sibling rows this
    // evaluation has already read so the exception costs no extra query and can
    // never reach past the `SAME_BOOKING` relationship.
    //
    // RESOLVED HERE, ABOVE BOTH LOCKS, since #3039. It is I/O-free apart from the
    // sibling rows already in hand, and the per-trip key cannot be taken before the
    // trip is known — so hoisting it is what makes group-before-owner expressible
    // at all rather than an ordering somebody has to remember.
    const groupTripIdentity = resolved.hostScopes.sameGroupTrip
      ? groupTripIdentityOf(booking) ??
        inheritedSplitPairGroupTrip(booking, siblings.rows)
      : null;
    // §9 and #3039: hold the per-TRIP key BEFORE the per-owner key, then both
    // before any cross-booking cover is read. Order is `INV-LOCK-002`; the reason
    // group comes first is in `HOSTING_COVERAGE_GROUP_LOCK_NAMESPACE`'s docblock —
    // the trip's membership is what decides which owners are involved, so it has to
    // be frozen before the owner set is even known.
    //
    // THE GROUP KEY IS WHAT #3038 DELIBERATELY DID NOT INVENT HERE. Its comment at
    // this line said the owner key is `booking.memberId` — the DEPENDENT's owner —
    // while every Group Trip source belongs to somebody else, so the owner key
    // neither excludes a concurrent removal of that cover nor tells a reader
    // anything true, and the lock a trip needs is a per-GROUP key acquired ahead of
    // the owner keys. That is this line, with the family registered in the census
    // and the ordering pinned by a test (`INV-LOCK-003`).
    if (groupTripIdentity && acquireCoverageGroupLock) {
      await acquireCoverageGroupLock(groupTripIdentity.groupBookingId);
    }
    // Re-entrant, so a caller that already took it (the settle step) pays nothing.
    if (resolved.hostScopes.sameBookingOwner && acquireCoverageOwnerLock) {
      await acquireCoverageOwnerLock();
    }
    const sameOwner = resolved.hostScopes.sameBookingOwner
      ? await loadSameBookingOwnerHosts(
          booking,
          db,
          siblings.siblingIds,
          options.sameOwnerSourceCeiling,
        )
      : { participants: [] as HostingParticipant[], sourceIds: [] };
    const groupTrip = groupTripIdentity
      ? await loadSameGroupTripHosts(
          booking,
          groupTripIdentity,
          db,
          // The deduplication, in the order the scopes narrow: a split sibling
          // is already a `SAME_BOOKING` host and a same-owner source is already
          // a `SAME_BOOKING_OWNER` one, so neither is read again here.
          [...siblings.siblingIds, ...sameOwner.sourceIds],
          options.groupTripSourceCeiling,
        )
      : { participants: [] as HostingParticipant[], sourceIds: [] };
    participants = await withSubscriptionSettlement(
      [
        ...toHostingParticipants(booking),
        ...siblings.participants,
        ...sameOwner.participants,
        ...groupTrip.participants,
      ],
      db,
      options.seasonYear ?? seasonYearOfStoredDate(booking.checkIn),
      options.subscriptionLockoutMode,
      options.readAgeTierSettings,
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
  return evaluateLoadedBookingAdultMemberHosting(
    booking,
    db,
    async () => {
      if (!failFastCoverageOwner) {
        await lockHostingCoverageOwner(db, booking.memberId);
        return;
      }
      if (!(await tryLockHostingCoverageOwner(db, booking.memberId))) {
        throw new HostingCoverageParticipantRetryError();
      }
    },
    acquireHostingCoverageGroupKey(db),
  );
}

/**
 * THE ONE PLACE THE PER-TRIP KEY IS ACQUIRED: try, then take (#3039).
 *
 * Every trip-key acquisition in the tree comes through here, and
 * `adult-member-hosting-coverage-lock.test.ts` censuses that: outside the minting
 * module itself, a `lockHostingCoverageGroup(s)` call anywhere but this function's
 * body fails the census. That is not tidiness. The try is the whole deadlock
 * defence, and it used to be written twice — here and inline in
 * `lockAndVerifyGroupTripCoverageDependents`, whose comment even pointed the reader
 * at this function while duplicating it. Two copies of a fail-fast protocol is two
 * places somebody can delete half of it, and the behavioural order tests cannot see
 * the deletion because they assert the FIRST acquisition of the sequence and the
 * other copy still supplies it (`INV-SSOT-001`).
 *
 * ALWAYS FAIL-FAST FIRST, WITH NO `failFastCoverageOwner`-STYLE ESCAPE, and the
 * asymmetry with the owner key above is deliberate. The owner key can be taken
 * blocking because it is the caller's OWN account: waiting on it means waiting for
 * another change to the same member's bookings, which is contention the member
 * caused. A trip key is shared with other accounts, and two transactions can
 * legitimately discover two trip keys in opposite orders — one reconciling a booking
 * in trip A whose same-owner dependent sits in trip B, the other the reverse — so a
 * blocking acquisition here is a real deadlock edge that no sorting within a single
 * call can remove. Failing immediately turns that into the stable
 * `HOSTING_COVERAGE_PARTICIPANT_RETRY` 409 and rolls the outer transaction back,
 * which is the same answer #2597 chose for repeated owner-key acquisition.
 *
 * THE GUARANTEE IS STRONGER THAN "GROUP BEFORE OWNER", AND IT IS THE ONE THAT
 * MATTERS. `pg_try_advisory_xact_lock` never waits, and an xact lock cannot be
 * released before commit — so once the try has succeeded, the blocking call on the
 * next line is re-entrant on the same PostgreSQL session and returns without
 * waiting. Therefore **no transaction ever waits on a trip key at all**, and the
 * group tier cannot appear in a wait-for cycle REGARDLESS of the order it is taken
 * in relative to any other family. That, and not the documented `group → owner`
 * order, is why there is no deadlock: the order is what makes the fan-out read a
 * stable sibling set, and this is what makes it safe. The distinction is load-bearing
 * because the ordering claim is not even true everywhere —
 * `inspectSameOwnerDependents` reaches a trip key for a same-owner dependent in
 * ANOTHER trip while the coverage-owner key is already held — and it is harmless
 * only because of this property. `docs/CONCURRENCY_AND_LOCKING.md` states it this
 * way round for the same reason.
 *
 * The blocking call is retained rather than dropped because it is the acquisition the
 * census and the lock inventory recognise, and because on a client that has
 * `$executeRaw` but not `$queryRaw` the try form is a no-op that returns `true` —
 * there, this is the call that actually takes the key.
 */
function acquireHostingCoverageGroupKey(
  db: AdultMemberHostingReadDb,
): (groupBookingId: string) => Promise<void> {
  return async (groupBookingId: string) => {
    if (!(await tryLockHostingCoverageGroup(db, groupBookingId))) {
      throw new HostingCoverageParticipantRetryError();
    }
    await lockHostingCoverageGroup(db, groupBookingId);
  };
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
 * season comes from `seasonYearOfStoredDate`, whose year-end month defaults to the
 * process-level financial-year cache in `financial-year.ts`. Writers reach this rule through routes that have
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
     * TRUNCATES at 25, which errs towards flagging for a writer and towards a
     * FABRICATED blocker for evidence.
     */
    sameOwnerSourceCeiling?: number;
    /**
     * The same again, for the `SAME_GROUP_TRIP` coverage sources (#3038). A
     * third ceiling rather than a reused one because it bounds a third
     * population whose binding means something different to an operator: a
     * Group Trip is MEANT to be many separate bookings, so its writer bound
     * sits far above the other two and a bind here says the trip is larger than
     * the diagnostic may read, not that an account is misshapen.
     */
    groupTripSourceCeiling?: number;
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
  // Forwarded WHOLE rather than unpacked into an argument list, which is the
  // point of the options object: a field added here reaches the evaluator
  // without an edit, and no ordering has to be kept in step.
  // BOTH lock callbacks are `null` here, and that is the read-only contract rather
  // than an omission: a diagnostic read may span READ COMMITTED instants and must
  // report that limitation, but it must never join a writer lock cohort.
  return evaluateLoadedBookingAdultMemberHosting(
    booking,
    db,
    null,
    null,
    options,
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
export async function withSubscriptionSettlement(
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
 * never refuse. TWO reasons reach for it and `INV-HOST-020`'s census makes a new
 * user say which: §13's SCHOOL AND ORGANISATION workflows, excluded in as many
 * words because teachers, leaders and custodians do not map onto the adult
 * club-member host rule; and the positions where there is NOTHING LEFT TO REFUSE
 * because the write a refusal would prevent is not being made — the drain below,
 * and #3209's cancellation seam. Neither exempts a member-owned flow.
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
  /**
   * The OWNER was offered the linked move and chose to move only the booking they
   * were editing (#3232, `INV-HOST-050`).
   *
   * Distinct from an officer's override, and the distinction is not cosmetic. An
   * override is one person exercising authority over a booking that is not theirs,
   * which is why §7 demands a reason and audits who gave it. This is the owner
   * deciding about their OWN two bookings, which is theirs to decide — so no reason
   * is demanded of them. What IS demanded is proof they were shown the consequence,
   * which is `strandedStateKey`: a stale one means the situation moved since they
   * were asked, and they are asked again rather than held to an answer about a
   * different set of bookings.
   */
  strandingAcceptedByOwner?: boolean;
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
 *    of their own bookings, which lodge and which nights, and pointed at a remedy
 *    they can actually reach: put cover back on that booking, cancel it, or ask a
 *    Booking Officer. NOT "move that booking first", which the same rule refuses
 *    from the other end — see `strandedCoverageOpening` (#3232). A DATE move
 *    that would strand one is offered the linked move instead of being refused at
 *    all (`INV-HOST-050`).
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
  /**
   * The stay window this booking held BEFORE this change, when the change MOVED
   * it — and `null` when the change did not (#3232, `INV-HOST-049`).
   *
   * REQUIRED, WITH NO DEFAULT, AND THAT IS THE POINT. The dependent fan-out runs
   * after the write, so it compares against the NEW dates and a booking that was
   * relying on the OLD ones is invisible to it: no evaluation, no incident, no
   * owner notice, nothing in the officer queue, for as long as nobody happens to
   * edit that booking. The remedy is to match the union of the vacated and the
   * current window (`coverageDependentEnvelopeOverStayUnionWhere`), which needs
   * one fact only a date writer holds.
   *
   * An optional field with a convenient default would have made every existing
   * caller compile unchanged and left the date writers exactly as wrong as they
   * were, silently — the failure this repository has already paid for once
   * (#3116). A required field makes the COMPILER enumerate every actor-driven
   * site, so each one has to state whether its change moved the stay: the date
   * writers pass a real window, everything else passes `null`, which collapses
   * the union to today's single-window test and is byte-identical to their
   * present behaviour. NO COUNT IS STATED HERE, deliberately. It was written out
   * as "three" in this docblock, in `INV-HOST-049` and in the size-allowance
   * note, and all three were wrong — there are four sites, and a number restated
   * in prose is a number that goes stale the next time a writer is added. The
   * compiler is the proof, and `adult-member-hosting-call-sites.test.ts` is the
   * one place a figure lives.
   *
   * NOT "the dates the caller asked for" — the dates the booking REALLY HELD
   * before the write. A proposal is not evidence: an edit that was clamped,
   * rejected in part, or normalised would name a window the booking never
   * occupied, and the dependent read would then miss the one it did.
   */
  vacatedRange: { checkIn: Date; checkOut: Date } | null;
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
  /**
   * The MEMBER's answer to the linked-move offer, when they have given one
   * (#3232, `INV-HOST-050`), together with WHOSE booking is being changed.
   *
   * OPTIONAL, unlike `vacatedRange`, and the asymmetry is deliberate rather than
   * inconsistent. A missing vacated range is silently WRONG — the fan-out looks at
   * the wrong window and loses a booking — so the compiler has to demand it. A
   * missing answer here is simply the truth on every path that never asks the
   * question, and its consequence is the safe one: the member is refused-and-
   * offered rather than allowed. Absence cannot hide a defect.
   *
   * THE OWNER'S ID IS PART OF THE ANSWER, AND IT IS NOT OPTIONAL WITHIN IT. The
   * answer means "the person whose two bookings these are was shown what this
   * costs the other one, and chose to go ahead". That sentence is only true if the
   * actor IS that person, and this field is what lets the check be made rather
   * than assumed. `hostingCoverageLinkedMove` is deliberately not one of either
   * save route's admin-gated flags — correct, because it is a MEMBER's field — so
   * without this an officer refused with `SameOwnerCoverageOverrideRequiredError`
   * could take the `strandedStateKey` out of that refusal body, resubmit it as a
   * declined linked move, and be let through with no reason recorded, no officer
   * attribution, and an audit line saying the member was asked about a booking
   * that is not theirs. That defeats all three of §7's requirements at once and
   * corrupts the cause count `INV-HOST-052` exists to protect. An officer who
   * really means to strand a booking still owes §7's confirmation and reason.
   *
   * `MOVE_BOTH` is deliberately NOT handled here. Accepting is not a disposition,
   * it is a different operation — moving two bookings atomically — and it is
   * `booking-linked-date-move-service.ts`'s job. By the time that service
   * reconciles, both bookings have moved and nothing is stranded, so there is
   * nothing for a disposition to decide.
   */
  linkedMove?: {
    /** The answer as it arrived on the wire, or `null` if none did. */
    answer: {
      choice?: "MOVE_BOTH" | "LEAVE_UNCOVERED";
      acknowledged?: boolean;
      stateKey?: string | null;
    } | null;
    /**
     * The changed booking's own member, from the pre-write snapshot the caller
     * already holds. `null` is not a wildcard: an answer can never be honoured
     * against an unknown owner.
     */
    bookingOwnerMemberId: string | null;
  } | null;
}): Pick<
  HostingReconcileOptions,
  | "dependentCoverage"
  | "coverageChange"
  | "coverageActorMemberId"
  | "coverageChangeVacatedRange"
> {
  const actorMemberId = actor.actorMemberId ?? null;
  const isOfficer =
    actor.actorRole === "ADMIN" || actor.hasBookingsEditAccess === true;
  const coverageChangeVacatedRange = actor.vacatedRange ?? null;
  // #3232: the owner was offered the linked move and declined it. That is D1's "No"
  // arm, and it is an ESCALATION rather than a refusal: the change proceeds, the
  // member has already been told plainly what it costs the other booking, the
  // officer queue gets it and an incident opens. The stranded-state key is carried
  // so the settle step can prove they were shown THIS situation — a stale answer
  // re-prompts instead of being honoured.
  //
  // AND IT IS ONLY THE OWNER'S ANSWER TO GIVE. Checked before the choice is even
  // read, because this branch sits above the officer branch and grants everything
  // that one withholds: an officer answering here would proceed with no reason, no
  // attribution and an incident claiming the member was asked. `null` on either
  // side never matches, so an unknown actor or an unknown owner falls through to
  // the refusal/override branches below rather than through this one.
  const answeredByOwner =
    actorMemberId !== null &&
    actor.linkedMove?.bookingOwnerMemberId === actorMemberId;
  const answer = answeredByOwner ? actor.linkedMove?.answer : null;
  const declinedLinkedMove =
    answer?.choice === "LEAVE_UNCOVERED" &&
    answer?.acknowledged === true &&
    typeof answer?.stateKey === "string" &&
    answer.stateKey.length > 0
      ? answer.stateKey
      : null;
  if (declinedLinkedMove) {
    return {
      dependentCoverage: "ESCALATE",
      coverageActorMemberId: actorMemberId,
      coverageChangeVacatedRange,
      coverageChange: {
        // THE ONE CENSUSED WRITER OF THIS LABEL (#3241, `INV-HOST-052`'s runtime
        // half). NOT `SYSTEM_CHANGE`, which means a change nobody could block, so
        // it told an officer the wrong story and put a member's own prompted
        // choice into the count a club judges its setting by; nor an officer's.
        cause: "OWNER_DECLINED_LINKED_MOVE",
        actorMemberId,
        reason: LINKED_MOVE_DECLINED_INCIDENT_REASON,
        strandedStateKey: declinedLinkedMove,
        strandingAcceptedByOwner: true,
      },
    };
  }
  if (!isOfficer) {
    return {
      dependentCoverage: "BLOCK",
      coverageActorMemberId: actorMemberId,
      coverageChangeVacatedRange,
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
      coverageChangeVacatedRange,
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
    coverageChangeVacatedRange,
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
   * The stay window the changed booking VACATED, when this change moved it
   * (#3232, `INV-HOST-049`).
   *
   * Absent or `null` means the stay did not move, which is true of every writer
   * except a date change. Read only by the same-owner dependent fan-out, whose
   * post-write read would otherwise be narrowed to the NEW nights and would miss
   * the booking whose cover the move just took away. The full reasoning is at
   * `coverageDependentEnvelopeOverStayUnionWhere`; what makes a caller supply it
   * is that `hostingCoverageActorOptions` demands it as a required field.
   */
  coverageChangeVacatedRange?: { checkIn: Date; checkOut: Date } | null;
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
 * Is any booking RELATED to this one at a lodge where the rule is active? (#3209)
 *
 * The question the mode gate has to ask before it may decide that nothing is owed.
 * Clubs configure adult-member hosting per lodge, and `hostingSiblingWhere` — the
 * #738 parent/child, same-member relation — carries no lodge clause, so a split
 * sibling can in principle sit at a lodge with a different answer.
 *
 * PLAIN READS ONLY, NO LOCK, and that is what keeps #2623 T5's property. It reads
 * the related bookings' LODGES through the indexed `Booking(parentBookingId)`
 * relation, then resolves the policy only for lodges that are not the changed
 * booking's own — that one the caller has just read, and is why we are here. So a
 * split pair at a single lodge, which is every pair the product can currently
 * produce, costs that one indexed read and no policy read at all; a booking with
 * no sibling costs the same single read.
 *
 * Deliberately a BOOLEAN and not the sibling id list: the fan-out below re-reads
 * the siblings after the fence, and handing it a list read before the Member rows
 * were protected would quietly widen what this pre-fence read is trusted for.
 */
async function hasHostingSiblingAtActiveLodge(
  booking: Pick<
    LoadedHostingBooking,
    "id" | "memberId" | "parentBookingId" | "lodgeId"
  >,
  db: AdultMemberHostingReviewDb,
): Promise<boolean> {
  const siblings = (await db.booking.findMany({
    where: hostingSiblingWhere(booking),
    select: { lodgeId: true },
  })) as Array<{ lodgeId: string }>;
  const otherLodgeIds = [
    ...new Set(siblings.map((sibling) => sibling.lodgeId)),
  ]
    .filter((lodgeId) => lodgeId !== booking.lodgeId)
    // Sorted so a club with several such lodges reads them in one reproducible
    // order; nothing is locked here, but a stable order keeps a failure
    // reproducible too.
    .sort();
  for (const lodgeId of otherLodgeIds) {
    const resolved = await loadAdultMemberHostingPolicy(lodgeId, db);
    if (hostingModeIsActive(resolved.mode)) return true;
  }
  return false;
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
 * Costs no extra SIBLING work while the rule is off EVERYWHERE THAT MATTERS: the
 * fan-out is skipped when this booking's lodge is inactive and no related booking
 * sits at an active one, so a club that has not turned the policy on anywhere
 * never fans out. See "WHICH LODGE'S MODE" below for why the second half of that
 * test is not optional.
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
 * `enqueueOwnHostingCoverageReevaluation` also does, and an inactive mode with
 * nothing owed at another lodge returns through the plain single-booking
 * reconciler — which is what the fenced path did anyway once `outcome.mode` came
 * back inactive, minus the lock. The single-id reconciler still runs, because
 * clearing a snapshot left behind by a lodge that has since switched the rule off
 * is exactly its job.
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
 * WHICH LODGE'S MODE (#3209). Clubs configure this rule PER LODGE, so "the lodge
 * of the booking that changed has it off" answers nothing about the lodges of the
 * bookings whose answer DEPENDS on it. `hostingSiblingWhere` is a parent/child +
 * same-member relation with no lodge clause in it, so gating on this booking's
 * lodge alone and returning skipped the sibling fan-out for a #738 split sibling
 * at a lodge where the rule IS active — it lost its cover and nothing looked. The
 * gate therefore asks the wider question, and skips only when this lodge is
 * inactive AND no related booking sits at an active one.
 *
 * `settleSameOwnerDependentCoverage` needs no such widening, and that is a
 * property of its query rather than an assumption:
 * `sameOwnerCoverageDependentWhere` pins `lodgeId` to the CHANGED booking's lodge,
 * so a same-owner dependent is always at THIS lodge, and the settle step re-reads
 * this lodge's mode and returns on the same test. Pinned by "keeps the dependent
 * cohort at the changed booking's own lodge" in
 * `adult-member-hosting-same-owner.test.ts`, so that sentence cannot quietly stop
 * being true. The Group Trip fan-out added below needs no widening either, for a
 * stronger reason still, proved in the named block at the gate itself.
 *
 * WHAT THE WIDER GATE COSTS A CLUB THAT OWES NOTHING: one indexed read of this
 * booking's parent and children (`Booking(parentBookingId)`), no lock; and ZERO
 * extra policy reads whenever every related booking is at this same lodge — which
 * is every split pair the product can currently produce, since `booking-create.ts`
 * writes the child at its parent's lodge and no writer moves a booking between
 * lodges (`bed-allocation-lock-topology-contract.test.ts` fails the build on one
 * that tries). The `FOR KEY SHARE NOWAIT` statement and its two under-lock
 * re-reads are still not paid, which is the whole of #2623 T5's property; pinned
 * by "takes no participant proof for a split pair at one DISABLED lodge".
 *
 * AND THE LOCK ORDER IS UNCHANGED (`INV-LOCK-002`). The widened gate decides only
 * WHETHER the fenced body runs; when it runs it runs whole, so the Member rows are
 * still taken before the first evaluation that can reach for a coverage-owner key
 * — including the sibling loop, which acquires that key under the SIBLING's lodge
 * policy for this same member, and which is exactly the ordering the old early
 * return would have inverted had it ever fanned out. Deciding to SKIP acquires
 * nothing at all — two plain reads, no Member rows and no per-trip key — so a skip
 * still cannot leave a key held out of order. With the mode inactive
 * `evaluateBookingAdultMemberHosting` takes no coverage-owner key either, so there
 * is no ordering left to protect. A club that turns the rule ON between this read
 * and the reconciler's own read is covered the same way every other mode gate in
 * this module is: the policy write holds the policy-set key and enqueues
 * re-evaluation for the affected bookings itself.
 *
 * AND SINCE #3039 IT ALSO SETTLES THE OTHER ACCOUNTS IN THIS BOOKING'S GROUP TRIP.
 * Three things happen that did not before, in this order: the trip's dependent
 * bookings are PLANNED before the participant fence (because the fence must lock
 * every owner the queue will name, and those owners are what the plan discovers);
 * the per-TRIP advisory key is taken and the plan re-verified under it, ahead of any
 * owner key (`INV-LOCK-002`); and after the same-owner settle, one bounded queue
 * item is recorded per dependent booking. That last step can refuse NOTHING — the
 * actor's valid change proceeds and they are told nothing about the other account
 * (`INV-HOST-046`) — so it cannot change the outcome this function returns.
 *
 * The fan-out lives HERE, rather than in the thirty-odd writers that call this,
 * for the reason the split-sibling fan-out does: this is the entry point every
 * mutation path uses, so a new writer gets it without knowing Group Trips exist
 * (`INV-SSOT-001`).
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
    select: GROUP_TRIP_COVERAGE_SOURCE_SELECT,
  })) as GroupTripCoverageSourceFacts | null;
  if (!plannedBooking) {
    return { action: "none", violation: null, mode: null };
  }
  // #2623 T5 + #3209: the mode gate comes BEFORE the fence, and it is a gate on
  // the lodges of the RELATED bookings as well as on this one's. See the docstring
  // above for why an inactive lodge must not pay a row lock, why that is not this
  // booking's lodge alone to decide, and why skipping here cannot leave a
  // coverage-owner or per-trip key held out of order. #3209 read `parentBookingId`
  // through a narrower select of its own; the group source select above is a strict
  // superset of it, so the gate still has the one column it needs and this read
  // stays a single spelled-once select (`INV-SSOT-001`).
  //
  // ==== GROUP-TRIP LODGE AWARENESS: DELIBERATELY NOTHING (#3039) ====
  //
  // A separately-named block because #3209 changed this exact gate in parallel, and
  // the two had to compose rather than one replacing the other. #3209 teaches it to
  // ask whether any RELATED booking sits at a lodge with an active mode
  // (`hasHostingSiblingAtActiveLodge`), because a #738 split sibling can legitimately
  // live at a DIFFERENT lodge — `hostingSiblingWhere` carries no lodge clause — so
  // the changed booking's own lodge does not speak for the pair.
  //
  // THE GROUP TRIP CASE NEEDS NO SUCH WIDENING, and that is a proof rather than a
  // decision deferred. Group Trip cover is same-lodge by construction: every group
  // read composes `groupTripMembershipWhere` INSIDE the shared coverage envelope,
  // whose first clause is `lodgeId: booking.lodgeId` (see
  // `adult-member-hosting-coverage-envelope.ts`, and `groupTripCoverageDependentWhere`
  // for the dependent direction). So a Group Trip sibling that can supply or receive
  // cover is always at THIS lodge, under THIS lodge's policy, and this booking's own
  // resolved mode is the whole answer for it. That is the same fact #3038's
  // concurrency review relied on when it established that a trip is confined to one
  // lodge and the two-member write skew therefore cannot occur today.
  //
  // Two consequences, stated so the composed gate is not misread as an oversight:
  // #3209's widening is CORRECT and this block must not be read as arguing against
  // it, and adding a group clause beside it would be dead code that no group read
  // could ever exercise. If a later lane ever makes group cover cross lodges, this
  // block is the place that stops being true.
  const planned = await loadAdultMemberHostingPolicy(plannedBooking.lodgeId, db);
  const sourceLodgeActive = hostingModeIsActive(planned.mode);
  // Read only when this lodge would otherwise skip: an active lodge already owes
  // the whole body, so the extra read would answer a question nobody is asking.
  const siblingOwedAtAnotherLodge =
    !sourceLodgeActive &&
    (await hasHostingSiblingAtActiveLodge(plannedBooking, db));
  if (!sourceLodgeActive && !siblingOwedAtAnotherLodge) {
    return reconcileAdultMemberHostingReview(bookingId, db, options, true);
  }
  const actorMemberId = options.coverageChange?.actorMemberId ?? null;
  // #3039: plan the Group Trip dependents BEFORE the participant fence, because the
  // fence has to lock every owner the queue will name and those owners are exactly
  // what this read discovers. The plan is unlocked and is therefore a hypothesis;
  // `lockAndVerifyGroupTripCoverageDependents` below turns it into a fact under the
  // per-trip key, or fails the whole transaction as a safe retry.
  const plannedGroupTrip = await planGroupTripCoverageDependents(
    plannedBooking,
    planned,
    db,
  );
  // #3232: plan the SAME-OWNER dependents before the fence too, and for the same
  // reason the Group Trip plan is planned here. Since #3232 the same-owner settle
  // records one item per dependent BOOKING rather than one item naming the changed
  // booking's window, and the fence demands a proof source for every booking an
  // item names — so a dependent discovered only inside the settle step would be
  // refused by `assertHostingCoverageQueueParticipantsLocked` rather than enqueued.
  //
  // NO NEW LOCK AND NO NEW ORDERING (`INV-LOCK-002`). Every same-owner dependent
  // shares the changed booking's `memberId` by construction (§1), so the `Member`
  // row set the fence takes is unchanged — the owner is already in it. Only the
  // proof's `sources` list grows, which is a fingerprint of rows the fence re-reads
  // under the row lock it already holds.
  const plannedSameOwner = await planSameOwnerCoverageDependents(
    plannedBooking,
    planned,
    options.coverageChangeVacatedRange ?? null,
    db,
  );
  const participantProof = await acquireOrValidateQueueParticipantProof(
    [
      sourceParticipant(plannedBooking),
      ...plannedSameOwner.map(sourceParticipant),
      ...(plannedGroupTrip?.dependents ?? []).map(sourceParticipant),
    ],
    actorMemberId,
    db,
  );

  // The per-TRIP key, then the plan re-verified under it (`INV-LOCK-002`: group
  // before owner). It is taken here rather than left to the evaluator one call
  // deeper so that the fan-out's own dependent read is protected too, and the
  // evaluator's acquisition is then a re-entrant no-op.
  const verifiedGroupTrip = await lockAndVerifyGroupTripCoverageDependents(
    plannedBooking,
    planned,
    plannedGroupTrip,
    db,
  );

  const outcome = await reconcileAdultMemberHostingReview(
    bookingId,
    db,
    options,
    true,
    { proof: participantProof, actorMemberId },
  );
  if (outcome.mode === null) return outcome;
  // #3209: `outcome.mode` is THIS lodge's, so it decides the fan-out only when
  // this lodge is the reason the fan-out is owed. A sibling at an active lodge
  // is owed its re-read whatever this lodge has switched off.
  if (!hostingModeIsActive(outcome.mode) && !siblingOwedAtAnotherLodge) {
    return outcome;
  }

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
    plannedSameOwner,
  );

  // #3039: and this booking's rows can decide whether a booking on ANOTHER ACCOUNT
  // in the same Group Trip is compliant. Last of all, and after the same-owner
  // settle, for the same reason that one runs last: it is a question about the
  // resulting state. It can refuse nothing, so it cannot change the outcome the
  // caller is about to receive — see `settleGroupTripDependentCoverage`.
  await settleGroupTripDependentCoverage(
    verifiedGroupTrip,
    actorMemberId,
    participantProof,
    db,
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
 * The columns the dependent-coverage machinery needs off a booking, without the
 * guest tree. Deliberately narrow: this read runs on booking write paths and only
 * ever decides WHICH bookings to look at.
 */
export type CoverageOwnerFacts = {
  id: string;
  memberId: string;
  lodgeId: string;
  checkIn: Date;
  checkOut: Date;
};

/**
 * The `select` that produces exactly `CoverageOwnerFacts`, spread by every read that
 * wants those columns.
 *
 * SPELLED OUT FOUR TIMES BEFORE #3039 FINISHED THE MOVE, each read casting its result
 * `as CoverageOwnerFacts` — and a cast is not a check. Drop `checkOut` from one of
 * those `select` objects and the compiler stays silent while the read returns
 * `undefined` for it, which then feeds `eachDateOnlyInRange` and produces a
 * zero-night item the queue drops on the floor. One object, spread, so the type and
 * the columns move together (`INV-SSOT-001`). The two wider selects in this module —
 * the group source facts and the with-outcome facts — spread it and add their own
 * fields, which is what makes them provably supersets.
 */
const COVERAGE_OWNER_FACTS_BASE_SELECT = {
  id: true,
  memberId: true,
  lodgeId: true,
  checkIn: true,
  checkOut: true,
} as const;

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

/**
 * One booking's own NZ lodge-nights, as the queue's `YYYY-MM-DD` strings.
 *
 * Four call sites in this module derived this by hand from `checkIn`/`checkOut`
 * before #3039 added a fifth, and every one of them is the `nights` field of a
 * `HostingCoverageReevaluation` item — the field the drain turns back into a date
 * envelope. A hand-written half-open range that differed by one day at any of them
 * would widen or narrow a bounded re-evaluation invisibly, so there is one
 * derivation (`INV-SSOT-001`).
 */
export function coverageNightsOf(
  booking: Pick<CoverageOwnerFacts, "checkIn" | "checkOut">,
): string[] {
  return eachDateOnlyInRange(booking.checkIn, booking.checkOut).map(formatDateOnly);
}

export function sourceParticipant(
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
  ...COVERAGE_OWNER_FACTS_BASE_SELECT,
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
 * The same-owner bookings whose own compliance may depend on this one, read over
 * the window it VACATED as well as the one it now holds (#3232, `INV-HOST-049`).
 *
 * ONE READ, TWO CALLERS, AND THEY MUST AGREE. It runs first UNLOCKED, before the
 * participant fence, because the fence has to hold a `Member` row for every owner
 * the queue will name and — since #3232 records one item per dependent booking —
 * the fence also has to hold every dependent BOOKING as a proof source. Then it
 * runs again under the per-owner coverage key, where the plan becomes a fact or a
 * safe retry. That is the same plan -> lock -> re-verify -> retry protocol
 * `lockAndVerifyGroupTripCoverageDependents` and
 * `enqueueHostingCoverageReevaluationForMember` use, deliberately shared in shape
 * rather than invented a third time.
 *
 * CHEAPER THAN IT LOOKS FOR A CLUB THAT OWES NOTHING. Both gates are read from the
 * already-resolved, cached policy: an inactive mode or a lodge not on
 * `SAME_BOOKING_OWNER` returns the empty list with no query at all, which is what
 * keeps "costs no same-owner query while the scope is off" true.
 *
 * ORDERED AND CAPPED for the reason the Group Trip plan is: an unordered truncation
 * would return a different N under the lock than it did in the plan, and every edit
 * on an account above the ceiling would fail as a spurious retry.
 */
async function planSameOwnerCoverageDependents(
  booking: CoverageOwnerFacts,
  resolved: ResolvedAdultMemberHostingPolicy,
  vacated: { checkIn: Date; checkOut: Date } | null,
  db: AdultMemberHostingReviewDb,
): Promise<CoverageOwnerFacts[]> {
  if (!hostingModeIsActive(resolved.mode)) return [];
  if (!resolved.hostScopes.sameBookingOwner) return [];
  return (await db.booking.findMany({
    where: sameOwnerCoverageDependentOverStayUnionWhere(booking, vacated),
    orderBy: [...COVERAGE_READ_ORDER],
    take: SAME_OWNER_COVERAGE_DEPENDENT_LIMIT,
    select: COVERAGE_OWNER_FACTS_BASE_SELECT,
  })) as CoverageOwnerFacts[];
}

/**
 * Record the bounded re-evaluation the dependents this change could have stranded
 * are owed, one item per dependent the changed booking's own item cannot reach
 * (#3232, `INV-HOST-049`).
 *
 * ONE ITEM PER DEPENDENT BOOKING, naming the dependent as its own source, for
 * exactly the reason `settleGroupTripDependentCoverage` gives: the participant fence
 * demands a proof source whose `bookingId` is the item's `sourceBookingId` AND whose
 * `ownerMemberId` is the item's `memberId`, so an item pairing the changed booking
 * with a dependent's window would be REFUSED. Here both bookings share the owner by
 * construction (§1), so the item's `memberId` and `lodgeId` are the same either way
 * and only the source and the nights differ.
 *
 * THE NIGHTS ARE THE DEPENDENT'S OWN. That is the whole point — see
 * `dependentNeedsOwnQueueItem`.
 */
async function enqueueSameOwnerDependentItems(
  booking: CoverageOwnerFacts,
  dependents: readonly CoverageOwnerFacts[],
  context: { cause: HostingCoverageIncidentCause; reason: string | null },
  actorMemberId: string | null,
  participantProof: HostingCoverageQueueParticipantProof,
  db: AdultMemberHostingReviewDb,
): Promise<number> {
  let queued = 0;
  // #3241: A DEPENDENT WHOSE STORY IS THE MEMBER'S OWN DECISION NEEDS A ROW OF
  // ITS OWN, overlap or not. The skip below exists to avoid duplicate work when
  // the changed booking's own row already reaches this dependent — but that row's
  // explanation now stops at the booking it is about (`INV-HOST-053`), so an
  // overlapping stranded booking reached only that way would lose the decision
  // entirely. A partial overlap is exactly that case: the dependent still shares
  // a night with the new dates and is still left short on the others.
  const carriesItsOwnStory = context.cause === "OWNER_DECLINED_LINKED_MOVE";
  for (const dependent of dependents) {
    if (!carriesItsOwnStory && !dependentNeedsOwnQueueItem(booking, dependent)) {
      continue;
    }
    const id = await enqueueHostingCoverageReevaluation(
      {
        memberId: dependent.memberId,
        lodgeId: dependent.lodgeId,
        nights: coverageNightsOf(dependent),
        // A dependent's own item is never labelled as somebody's override: the
        // officer authorised stranding on the booking they were working on, not a
        // decision about this one. The actor is still recorded, so the audit trail
        // says who did it — the same reasoning `settleGroupTripDependentCoverage`
        // applies to a third party's booking.
        cause: context.cause === "OFFICER_OVERRIDE" ? "SYSTEM_CHANGE" : context.cause,
        sourceBookingId: dependent.id,
        actorMemberId,
        reason: context.cause === "OFFICER_OVERRIDE" ? null : context.reason,
      },
      participantProof,
      db,
    );
    if (id) queued += 1;
  }
  return queued;
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
  /**
   * The dependent set as planned before the participant fence (#3232). Re-read
   * under the owner key below and compared, so a plan that has stopped describing
   * the account is a safe retry rather than a queue item against an unlocked row.
   */
  plannedDependents: readonly CoverageOwnerFacts[],
): Promise<void> {
  const booking = (await db.booking.findUnique({
    where: { id: bookingId },
    select: COVERAGE_OWNER_FACTS_SELECT,
  })) as CoverageOwnerFactsWithOutcome | null;
  if (!booking) return;

  const resolved = await loadAdultMemberHostingPolicy(booking.lodgeId, db);
  // The shared predicate rather than its two literals written out, which is what
  // this line was (`INV-SSOT-001`).
  if (!hostingModeIsActive(resolved.mode)) return;

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

  const nights = coverageNightsOf(booking);

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

  // #3232: the plan becomes a fact HERE, under the owner key, or the whole
  // transaction is a safe retry. Unlocked, the plan is a hypothesis — at READ
  // COMMITTED each of two concurrent writers can observe a state the other has
  // already invalidated — and the fence's proof was issued for exactly the bookings
  // it named, so a set that has moved must not be enqueued against it.
  const verifiedDependents = await planSameOwnerCoverageDependents(
    booking,
    resolved,
    options.coverageChangeVacatedRange ?? null,
    db,
  );
  if (
    coverageBookingSetFingerprint(verifiedDependents) !==
    coverageBookingSetFingerprint(plannedDependents)
  ) {
    throw new HostingCoverageParticipantRetryError();
  }

  if (!hostingModeCanRefuseStranding(resolved.mode)) {
    // No inspection: nothing here can refuse and nothing can open an incident, so
    // the only question is whether any other booking of this owner is in the set at
    // all. The verified plan already answers that, so the separate count this used
    // to run is gone rather than duplicated — and it was the count whose
    // single-window predicate lost the moved-away dependent (#3232).
    if (verifiedDependents.length === 0) return;
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
    await enqueueSameOwnerDependentItems(
      booking,
      verifiedDependents,
      { cause: "SYSTEM_CHANGE", reason: null },
      actorMemberId,
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

  // #3232, DEFENCE IN DEPTH, for the same reason `resolveDependentDisposition`
  // states it: this is the last point before an acceptance is acted on, and the
  // acceptance is the thing that turns a refusal into an allowed change with no
  // officer reason recorded. `hostingCoverageActorOptions` already refuses to set
  // the flag for anybody but the owner, so reaching here means a caller assembled
  // the options by hand and got it wrong. Fail loudly inside the transaction,
  // where it rolls back, rather than record that a member consented to something
  // on somebody else's booking.
  if (
    context.strandingAcceptedByOwner === true &&
    (context.actorMemberId ?? null) !== booking.memberId
  ) {
    throw new Error(
      "INV-HOST-050: a linked-move answer can only be honoured for the member " +
        "who owns the booking being changed; an officer still owes the " +
        "same-owner coverage override and its reason.",
    );
  }

  const disposition = resolveDependentDisposition(booking, options);
  const { stranded, dependentsWithOpenIncidents } =
    await inspectSameOwnerDependents(booking, verifiedDependents, db);

  /**
   * Whether the LINKED MOVE could actually answer this stranding (#3232,
   * `INV-HOST-050`), asked once and read by both refusal throws below.
   *
   * "Moved away" and "a shift can fix it" are not the same question, and a
   * SHORTENING is where they come apart: cut 10-15 back to 10-12 and the arrival
   * did not move, so a 13-14 dependent's target is where it already is. Marking
   * the refusal answerable there means two full pricing runs inside a transaction
   * that was always going to be discarded, and then this very refusal anyway —
   * having promised the member an arm the offer could not deliver.
   * `linkedMoveWouldRestoreCover` asks with the same shift the offer would use.
   */
  const linkedMoveCouldAnswer = () =>
    stranded.some(
      (row) =>
        dependentNeedsOwnQueueItem(booking, {
          checkIn: parseDateOnly(row.checkIn),
          checkOut: parseDateOnly(row.checkOut),
        }) &&
        linkedMoveWouldRestoreCover(
          {
            vacatedRange: options.coverageChangeVacatedRange ?? null,
            currentCheckIn: booking.checkIn,
            currentCheckOut: booking.checkOut,
          },
          row,
        ),
    );

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

  // #3232: A STALE OWNER ACCEPTANCE IS ANOTHER FIRST SUBMISSION. The member
  // answered about the bookings and nights they were SHOWN; if that set has moved
  // since, honouring the answer would strand something they were never asked
  // about. Re-prompt through the same door a first submission uses, from inside
  // this transaction so the write, the incident work and the queue rows all roll
  // back with it.
  if (
    context.strandingAcceptedByOwner === true &&
    stranded.length > 0 &&
    context.strandedStateKey !== strandedCoverageStateKey(stranded, booking.id)
  ) {
    // #3232: AND IT IS THE SAME QUESTION HERE. `true` unconditionally was wrong:
    // a member re-submitting a stale decline whose NEW stranding is an overlapping
    // guest-change one would be offered a move the rule says should stay a plain
    // refusal, and the offer would then fail because a shift cannot fix it. One
    // predicate, both throws.
    throw new SameOwnerCoverageWouldBreakError(stranded, {
      linkedMoveWouldAnswer: linkedMoveCouldAnswer(),
    });
  }

  // REFUSE FIRST, and which refusal it is depends on who is asking (§6, §7) — and,
  // since #3232, on whether the member has anywhere to go.
  if (stranded.length > 0) {
    // The member's own change is rolled back with the sentence §6 specifies,
    // naming the affected booking, its lodge and the uncovered nights.
    if (disposition === "BLOCK") {
      // #3232, `INV-HOST-050`: A REFUSAL IS ONLY LEGITIMATE WHEN THE PERSON
      // REFUSED CAN DO SOMETHING ABOUT IT, and for one shape of stranding they
      // cannot. Where the dependent no longer shares a night with this booking,
      // this booking has MOVED AWAY from it — and every remedy the refusal's own
      // sentence offers on the affected booking is either irrelevant or refused by
      // this same rule from the other end. Moving that booking to follow this one
      // leaves it with no qualifying adult and `REFUSE` is the default
      // enforcement, so the member could move NEITHER of their own bookings. That
      // is the deadlock the owner refused to ship.
      //
      // So the refusal is MARKED as answerable and the date writer turns it into
      // the linked-move offer: move both together, or decline and be warned while
      // the officer is told. The other shape — a dependent that still overlaps, so
      // the stranding came from a guest change rather than a move — keeps exactly
      // today's refusal, because there the member really can add cover to the
      // affected booking or cancel it.
      //
      // AND IT MUST BE A STRANDING THE OFFER CAN ACTUALLY ANSWER — decided by
      // `linkedMoveCouldAnswer` above, computed once for both throw sites.
      throw new SameOwnerCoverageWouldBreakError(stranded, {
        linkedMoveWouldAnswer: linkedMoveCouldAnswer(),
      });
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
      //
      // #3232: WHAT THIS ITEM CANNOT REACH is a dependent that no longer shares a
      // night with this booking, which is exactly what a date MOVE produces. The
      // drain resolves an item's nights back into bookings, so such a dependent
      // resolves out of this item's list entirely and is dropped in the background
      // with nothing logged. The item below is still right for what it names; the
      // dependents it cannot name get their own, immediately after.
      nights,
      cause: context.cause,
      sourceBookingId: booking.id,
      actorMemberId,
      reason: context.reason ?? null,
    },
    participantProof,
    db,
  );

  // #3232: and one item per dependent this booking's own window cannot reach,
  // naming that dependent's own nights. In the ordinary edit every dependent
  // overlaps and this writes nothing at all.
  await enqueueSameOwnerDependentItems(
    booking,
    verifiedDependents,
    { cause: context.cause, reason: context.reason ?? null },
    actorMemberId,
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
 * put cover back on the affected booking, cancel it, ring an officer — belongs
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
 * The changed booking as the Group Trip fan-out needs it: the coverage facts, the
 * two canonical identity relations, and `parentBookingId` for the split-pair
 * carve-out.
 *
 * The identity relations are REQUIRED rather than optional for the reason
 * `GroupTripIdentityRow` states in full: for a DEPENDENT set, a booking wrongly
 * read as ungrouped is a booking nobody re-evaluates, so a genuinely stranded
 * booking is never reconciled and never escalated. With the fields required, a
 * caller that forgot `GROUP_TRIP_IDENTITY_SELECT` is a compile error rather than a
 * silent wrong answer.
 */
export type GroupTripCoverageSourceFacts = CoverageOwnerFacts &
  GroupTripIdentityRow & { parentBookingId: string | null };

/**
 * Exported for the one post-commit caller that has to load this shape itself:
 * `settleHostingCoverageAfterCommit` reads the written booking once and threads it
 * into `loadGroupTripCoverageDependentBookingIds`, rather than that function reading
 * the same row a second time with a wider select on every booking write.
 */
export const GROUP_TRIP_COVERAGE_SOURCE_SELECT = {
  ...COVERAGE_OWNER_FACTS_BASE_SELECT,
  parentBookingId: true,
  ...GROUP_TRIP_IDENTITY_SELECT,
} as const;

/**
 * The bookings in this booking's Group Trip whose own compliance may depend on it
 * (#3039, `INV-HOST-046`).
 *
 * `null` — not an empty plan — when there is nothing to do at all: the lodge is not
 * on `SAME_GROUP_TRIP`, or the booking is in no trip. The distinction is
 * load-bearing at the call site, because `null` is what says "take no per-trip key
 * and add no participants", while an empty `dependents` list on a real identity
 * still means the key IS owed: the trip exists, and a sibling could join it between
 * this plan and the caller's commit.
 *
 * IDENTITY FIRST, THEN ONE INDEXED READ. Identity comes from the canonical
 * relations, with `readInheritedSplitPairGroupTrip` as the one named fallback so
 * the #738 half carrying the non-member guests resolves to the same trip its
 * parent does (`INV-HOST-043`'s carve-out, and the reason the fan-out is
 * meaningful for such a booking at all). The dependent read is
 * `groupTripCoverageDependentWhere` — the trip's membership clause inside the
 * shared dependent envelope, so the lodge, self-exclusion, half-open night overlap
 * and active-status cohort are byte-for-byte the ones every other coverage read
 * uses (`INV-SSOT-002`).
 *
 * ORDERED AND CAPPED, and the order is not decoration: it is what makes the
 * plan/verify comparison below meaningful, because an unordered truncation would
 * return a different N under the lock than it did in the plan and every edit at a
 * trip above the ceiling would fail as a spurious retry.
 */
async function planGroupTripCoverageDependents(
  booking: GroupTripCoverageSourceFacts,
  resolved: ResolvedAdultMemberHostingPolicy,
  db: AdultMemberHostingReviewDb,
): Promise<{
  identity: GroupTripIdentity;
  dependents: CoverageOwnerFacts[];
} | null> {
  if (!resolved.hostScopes.sameGroupTrip) return null;
  const identity =
    groupTripIdentityOf(booking) ??
    (await readInheritedSplitPairGroupTrip(db, booking));
  if (!identity) return null;

  const dependents = (await db.booking.findMany({
    where: groupTripCoverageDependentWhere(booking, identity),
    orderBy: [...COVERAGE_READ_ORDER],
    take: GROUP_TRIP_COVERAGE_DEPENDENT_LIMIT,
    select: COVERAGE_OWNER_FACTS_BASE_SELECT,
  })) as CoverageOwnerFacts[];
  // NO CEILING REPORT HERE, deliberately: this read runs at least twice per fan-out
  // (the unlocked plan, then the under-lock re-verify) plus once more on the
  // post-commit drain-scope read, so reporting here produced two or three warnings
  // for one truncation. `settleGroupTripDependentCoverage` reports it once, durably.
  return { identity, dependents };
}

/**
 * The exact identity of a planned Group Trip fan-out, for the under-lock re-verify.
 *
 * Owner and lodge are in the fingerprint as well as the booking id because they are
 * what the queue item and the participant fence are keyed on: a sibling booking
 * that changed hands between the plan and the lock would otherwise pass a
 * comparison on ids alone and then be enqueued against a `Member` row this
 * transaction never locked.
 */
function groupTripDependentFingerprint(
  plan: { identity: GroupTripIdentity; dependents: readonly CoverageOwnerFacts[] } | null,
): string {
  if (!plan) return "";
  return [
    plan.identity.groupBookingId,
    coverageBookingSetFingerprint(plan.dependents),
  ].join("\n");
}

/**
 * The plan-versus-verify comparison for ANY bounded set of coverage bookings
 * (`INV-SSOT-001`).
 *
 * TWO SEAMS RE-READ A BOUNDED SET UNDER A LOCK AND COMPARE IT WITH WHAT THEY
 * PLANNED, and before this they compared it two different ways: the Group Trip
 * fan-out with an ordered string fingerprint, and
 * `enqueueHostingCoverageReevaluationForMember` with a length check plus a
 * `Map`-keyed field-by-field loop. Same hazard, same remedy, two implementations —
 * so a fix to one silently left the other behind.
 *
 * ORDER-SENSITIVE, WHICH IS THE STRICTER OF THE TWO AND THEREFORE THE ONE KEPT. Both
 * reads apply the same `orderBy`, so a stable world produces a stable order and a
 * changed order really is a changed world; unifying onto the `Map` form would have
 * traded a check away for nothing.
 *
 * OWNER AND LODGE ARE IN IT, NOT JUST THE ID, because they are what the queue item
 * and the participant fence are keyed on: a booking that changed hands between the
 * plan and the lock would pass a comparison on ids alone and then be enqueued
 * against a `Member` row this transaction never locked.
 */
function coverageBookingSetFingerprint(
  bookings: readonly Pick<CoverageOwnerFacts, "id" | "memberId" | "lodgeId">[],
): string {
  return bookings
    .map((booking) => `${booking.id}:${booking.memberId}:${booking.lodgeId}`)
    .join("\n");
}

/**
 * Freeze one Group Trip's membership, then prove the plan still describes it
 * (#3039; `INV-LOCK-002`, `INV-HOST-046`).
 *
 * WHY A RE-READ AND NOT JUST A LOCK. This is the issue's own reasoning and it is
 * worth keeping next to the code: rereading siblings WITHOUT a shared serialisation
 * point is insufficient, because at READ COMMITTED each of two concurrent writers
 * can observe a state the other has already invalidated. The plan above runs
 * unlocked — it has to, because the owners it discovers are what the participant
 * fence must lock, and the fence comes before this key. So the plan is a
 * hypothesis; this is where it becomes a fact. A drift is a safe retry rather than a
 * guess: the caller's whole outer transaction rolls back and the actor is told to
 * reload.
 *
 * IT IS THE SAME PLAN → LOCK → RE-VERIFY → RETRY PROTOCOL
 * `enqueueHostingCoverageReevaluationForMember` uses for its own candidate set, and
 * deliberately so. A second protocol for the same hazard is a second thing to get
 * right.
 */
async function lockAndVerifyGroupTripCoverageDependents(
  booking: GroupTripCoverageSourceFacts,
  resolved: ResolvedAdultMemberHostingPolicy,
  planned: { identity: GroupTripIdentity; dependents: CoverageOwnerFacts[] } | null,
  db: AdultMemberHostingReviewDb,
): Promise<{ identity: GroupTripIdentity; dependents: CoverageOwnerFacts[] } | null> {
  if (!planned) return null;
  // THE protocol, not a second copy of it: `acquireHostingCoverageGroupKey` tries
  // the key fail-fast and only then takes it blocking, and it is the one place in
  // the tree that may (`INV-SSOT-001`, and the census in
  // `adult-member-hosting-coverage-lock.test.ts`). This used to inline the same two
  // statements while its comment pointed the reader at that function.
  await acquireHostingCoverageGroupKey(db)(planned.identity.groupBookingId);

  const verified = await planGroupTripCoverageDependents(booking, resolved, db);
  if (
    groupTripDependentFingerprint(verified) !==
    groupTripDependentFingerprint(planned)
  ) {
    throw new HostingCoverageParticipantRetryError();
  }
  return verified;
}

/**
 * Record the bounded re-evaluation this change owes the OTHER accounts in its Group
 * Trip (#3039; the epic's settled lifecycle rule, and `INV-HOST-046`).
 *
 * IT NEVER REFUSES, AND THAT IS THE RULE RATHER THAN AN IMPLEMENTATION CHOICE. The
 * owner's contract is explicit: if an actor's valid change strands another account's
 * booking, allow the change, reconcile and escalate for officers, and disclose
 * nothing about the other account to the actor. So there is no group counterpart to
 * `SameOwnerCoverageWouldBreakError` and no group counterpart to the officer's
 * override prompt — no new refusal type, no new error body, no new member-facing
 * sentence and no route change. Blocking would make one account able to control
 * another's booking, and even the REFUSAL would disclose that somebody else depends
 * on them.
 *
 * IT ALSO DOES NOT EVALUATE. `inspectSameOwnerDependents` evaluates each dependent
 * because it has to decide whether to REFUSE; nothing here refuses, so evaluating
 * inside the actor's transaction would buy nothing and would answer against rows
 * that have not committed. The drain re-reads after commit and is the only thing
 * that opens an incident — which is also what keeps the officer's queue honest when
 * the actor's change rolls back for an unrelated reason.
 *
 * ONE ITEM PER DEPENDENT BOOKING, AND WHY NOT PER OWNER. The epic asks for one
 * bounded item per affected owner rather than an unbounded group-wide record, and
 * per-booking is the strictly tighter form of that: in the ordinary trip every owner
 * holds one booking, so the two coincide, and where an owner holds two the two have
 * DIFFERENT nights, so a single item could not name both honestly. It also satisfies
 * the participant fence exactly — `assertHostingCoverageQueueParticipantsLocked`
 * demands a source whose `bookingId` is the item's `sourceBookingId` AND whose
 * `ownerMemberId` is the item's `memberId`, so `{memberId: siblingOwner,
 * sourceBookingId: theActorsBooking}` is REFUSED. Each item names the sibling as its
 * own source, which is the shape
 * `enqueueHostingCoverageReevaluationForMember` already uses for the same reason.
 *
 * THE NIGHTS ARE THE DEPENDENT'S OWN, NOT THE CHANGED BOOKING'S, and that is a
 * correction rather than a preference. This used to record the CHANGED booking's
 * nights, on the reasoning that a change cannot affect a night it never touched and
 * that the dependent was "guaranteed to overlap them, because the dependent
 * envelope's half-open night clause is what selected it". Both halves of that broke
 * on a DATE MOVE. The seam runs after the write, so the changed booking's nights are
 * the NEW ones; the dependent was relying on the OLD ones; and
 * `coverageDependentEnvelopeAcrossNightsWhere` now deliberately drops the overlap
 * clause, so the guarantee is gone by construction. Worse, the item's nights are
 * what the drain turns back into bookings — `loadSameOwnerCoverageDependentIds`
 * reads the owner's bookings at that lodge over exactly that window — so an item
 * carrying nights the dependent does not occupy resolves to an EMPTY dependent list
 * and the sibling is dropped a second time, in the background, with nothing logged.
 *
 * The dependent's own stay is the honest bound and keeps §10 intact: it is bounded
 * by one booking, it is the window over which that booking's compliance can have
 * changed, and it guarantees the drain's own read finds the booking the item is
 * about. The extra reach over the old form is the dependent's non-overlapping
 * nights, which cost one idempotent re-read of a booking the same owner already
 * holds at the same lodge.
 *
 * THE CAUSE IS ALWAYS `SYSTEM_CHANGE`, even when the actor's own change was an
 * officer override. An override is authority over stranding on the account the
 * officer was working on; it is not a decision about a third party's booking, and
 * recording it as one would put an officer's name and reason against an incident
 * they never considered. The actor is still recorded, so the audit trail says who
 * did it.
 */
async function settleGroupTripDependentCoverage(
  verified: { identity: GroupTripIdentity; dependents: CoverageOwnerFacts[] } | null,
  actorMemberId: string | null,
  participantProof: HostingCoverageQueueParticipantProof,
  db: AdultMemberHostingReviewDb,
  /**
   * Bookings that already have an item from this same transaction, so the fan-out
   * does not write a second one for them. Only the membership-lifecycle seam supplies
   * it: its own candidate set is "every booking this person attends", which can
   * legitimately include a booking in the very trip it is fanning out over. A
   * duplicate would be harmless downstream (`stateKey` plus the notification lease
   * make the drain idempotent) but it would inflate the returned count, which that
   * seam's callers log as the truth.
   */
  alreadyQueuedBookingIds?: ReadonlySet<string>,
): Promise<number> {
  if (!verified || verified.dependents.length === 0) return 0;
  // ONE durable record per trip per transaction when the bound binds. What a bound
  // ceiling costs here is a booking nobody re-evaluates, so it is written as an audit
  // row rather than left to a log line — see `reportGroupTripDependentCeilingBound`.
  await reportGroupTripDependentCeilingBound(
    {
      groupBookingId: verified.identity.groupBookingId,
      lodgeId: verified.dependents[0]?.lodgeId ?? "",
    },
    verified.dependents.length,
    "group-trip-fanout",
    db,
  );
  let queued = 0;
  for (const dependent of verified.dependents) {
    if (alreadyQueuedBookingIds?.has(dependent.id)) continue;
    const id = await enqueueHostingCoverageReevaluation(
      {
        memberId: dependent.memberId,
        lodgeId: dependent.lodgeId,
        nights: coverageNightsOf(dependent),
        cause: "SYSTEM_CHANGE",
        sourceBookingId: dependent.id,
        actorMemberId,
        reason: null,
      },
      participantProof,
      db,
    );
    if (id) queued += 1;
  }
  return queued;
}

/**
 * The BOOKINGS a committed change's Group Trip fan-out will have written items for,
 * so the post-commit inline drain can claim exactly those (#3039).
 *
 * BOOKING IDS RATHER THAN OWNER IDS, and that is the whole point of the shape. An
 * owner filter has no lower bound and the claim is oldest-first, so widening the
 * inline drain to the sibling OWNERS let their unrelated stale backlog fill every
 * inline slot — each item fanning out again and each able to send a synchronous
 * email — inside the actor's request, while the actor's own fresh items went
 * undrained. `claimHostingCoverageReevaluations` therefore matches on
 * `sourceBookingId`, so the only cross-account items it can reach are items about
 * bookings in this trip. Its docblock carries the full reasoning.
 *
 * READ AFTER THE COMMIT, OUTSIDE ANY TRANSACTION, by
 * `settleHostingCoverageAfterCommit`. It takes no lock deliberately: it is choosing
 * which queue rows to settle NOW rather than in up to three hours, and a wrong
 * answer costs a delay, never a lost obligation — the cron claims everything
 * unfiltered. Taking the trip key here would put a lock acquisition on the response
 * path of every booking write at a club that runs group trips, for a decision that
 * does not need one.
 *
 * Returns an empty list for the ordinary case — the scope off, or a booking in no
 * trip — so a club that has not enabled `SAME_GROUP_TRIP` pays one cached policy
 * read and nothing else.
 *
 * `booking` IS PASSED IN, NOT RE-READ. `settleHostingCoverageAfterCommit` has already
 * loaded the row for its own owner/lodge narrowing, and this used to `findUnique` the
 * same id again with a wider select — on the ~40 booking-write call sites that reach
 * the wrapper, at every club, including those with the scope switched off. One read,
 * threaded, and the policy resolver is cached.
 */
export async function loadGroupTripCoverageDependentBookingIds(
  booking: GroupTripCoverageSourceFacts,
  db: AdultMemberHostingReviewDb,
): Promise<string[]> {
  const resolved = await loadAdultMemberHostingPolicy(booking.lodgeId, db);
  if (!hostingModeIsActive(resolved.mode)) return [];
  const plan = await planGroupTripCoverageDependents(booking, resolved, db);
  if (!plan) return [];
  return [...new Set(plan.dependents.map((dependent) => dependent.id))].sort();
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
 *
 * IT ALSO OWES THE GROUP TRIP FAN-OUT (#3039), and the group-settlement reaper is
 * the case that proves it rather than an argument by symmetry. Confirming ADDS
 * attendance, so it can RESTORE a sibling's cover; the reaper's
 * `CONFIRMED -> PAYMENT_PENDING` revert REMOVES it, and a revert is exactly a
 * de-confirmation of a coverage source. Without the fan-out here, an automated path
 * could take the last qualifying adult out of a trip with no sibling ever
 * re-evaluated — the same gap that made this seam necessary at all, one account
 * further out. The per-TRIP key is taken before the owner key, and the returned id
 * is still this booking's OWN item: a sibling's item is not what the caller logged.
 */
/**
 * How the confirming seam should handle its Group Trip half, for the two callers
 * whose shape makes the default wrong (#3039).
 *
 * BOTH FIELDS ARE OPTIONAL AND BOTH DEFAULTS ARE THE STRICT, SAFE ONES: every trip
 * is fanned out, and a contended trip rolls the transaction back. A caller that
 * forgets an option therefore pays extra work or answers a transient 409 — never
 * loses a sibling's escalation.
 *
 * `settledTripIds` — ONE FAN-OUT PER TRIP PER TRANSACTION. `group-settlement.ts`
 * and `cron-group-settlement-reaper.ts` call this seam once per child INSIDE one
 * transaction, and every child's fan-out enumerates every OTHER child of the same
 * trip. A twenty-child settlement therefore did twenty plans (two booking reads, a
 * cached policy read, a bounded dependent read and a `Member FOR KEY SHARE NOWAIT`
 * fence over twenty rows apiece) and wrote about three hundred and eighty queue
 * rows, all while holding `pg_advisory_xact_lock(1)` and the per-lodge key — and
 * the trip ceiling bounds each fan-out, not the product of the two. The fan-out is
 * also self-referential there: every item is about a booking that same transaction
 * is confirming. The set is caller-owned, so its lifetime is exactly the loop that
 * created it; a trip is added only once its plan has actually been verified and
 * settled, so a skipped or contended trip is retried by the next child rather than
 * silently dropped.
 *
 * `bestEffort` — SKIP THE CROSS-ACCOUNT HALF RATHER THAN REFUSE THE TRANSITION,
 * and it is legal at a confirming seam ONLY. The trip key and the sibling owners'
 * `Member` rows are shared with other accounts, so a third party editing their own
 * booking in the same trip can now make this seam throw the retry — which rolls back
 * whatever transaction it sits in. At `xero-inbound/invoice-paid-effects.ts` that
 * transaction is a `PAID` claim for an invoice the club has ALREADY been paid, and
 * its own comment says the money is in the bank by the time Xero tells us, so
 * refusing is not an available answer.
 *
 * WHY SKIPPING COSTS NOTHING THERE, which is the part that has to be checked before
 * this flag is ever passed anywhere else. `CONFIRMED` and `PAID` are BOTH in
 * `HOSTING_COVERAGE_SOURCE_BOOKING_STATUSES`, and `PAYMENT_PENDING -> PAID` only
 * ADDS a source — so a Xero PAID transition can RESTORE a sibling's cover or leave
 * it unchanged, and can never remove it. The worst case of skipping is that a
 * sibling's cover is restored three hours later by the cron instead of immediately,
 * which is a delay in the FAVOURABLE direction. The booking's OWN item is still
 * written, so nothing about this transition goes unrecorded.
 *
 * IT MUST NOT BE PASSED BY A DE-CONFIRMING CALLER. The group-settlement reaper's
 * `CONFIRMED -> PAYMENT_PENDING` revert REMOVES a coverage source, so skipping its
 * fan-out is exactly the stranding this whole child exists to prevent. That is the
 * discriminator to apply before adding a third caller: can this transition take
 * cover AWAY? If yes, the answer is the retry, not the flag.
 */
export type GroupTripFanOutOptions = {
  /** Trips this transaction has already fanned out; mutated as they are settled. */
  settledTripIds?: Set<string>;
  /** Skip the cross-account half on contention instead of refusing the change. */
  bestEffort?: boolean;
};

export async function enqueueOwnHostingCoverageReevaluation(
  bookingId: string,
  db: AdultMemberHostingReviewDb,
  context: HostingCoverageChangeContext = { cause: "SYSTEM_CHANGE" },
  suppliedParticipantProof?: HostingCoverageQueueParticipantProof,
  groupTripFanOut: GroupTripFanOutOptions = {},
): Promise<string | null> {
  const plannedBooking = (await db.booking.findUnique({
    where: { id: bookingId },
    select: GROUP_TRIP_COVERAGE_SOURCE_SELECT,
  })) as GroupTripCoverageSourceFacts | null;
  if (!plannedBooking) return null;

  const resolved = await loadAdultMemberHostingPolicy(plannedBooking.lodgeId, db);
  if (resolved.mode !== "ENFORCED") return null;

  const actorMemberId = context.actorMemberId ?? null;
  // #3039: THIS SEAM OWES THE GROUP FAN-OUT TOO, and the reaper is the case that
  // proves it. Confirming ADDS attendance, so it can restore a sibling's cover; the
  // group-settlement reaper's `CONFIRMED -> PAYMENT_PENDING` revert REMOVES it, and
  // a revert is exactly a de-confirmation of a coverage source. Without the fan-out
  // here, an automated path could take the last qualifying adult out of a trip and
  // no sibling booking would ever be re-evaluated — the same gap that made this
  // seam's own existence necessary, one account further out.
  //
  // ONE FAN-OUT PER TRIP PER TRANSACTION. A caller that loops a whole party through
  // this seam — group settlement, the settlement reaper — passes a shared
  // `settledTripIds`, so the trip's plan, key and item writes happen once instead of
  // once per child; see `GroupTripFanOutOptions`.
  let plannedGroupTrip =
    (await planGroupTripCoverageDependents(plannedBooking, resolved, db)) ?? null;
  const tripId = plannedGroupTrip?.identity.groupBookingId ?? null;
  if (tripId && groupTripFanOut.settledTripIds?.has(tripId)) {
    plannedGroupTrip = null;
  }
  let participantProof: HostingCoverageQueueParticipantProof;
  try {
    participantProof = await acquireOrValidateQueueParticipantProof(
      [
        sourceParticipant(plannedBooking),
        ...(plannedGroupTrip?.dependents ?? []).map(sourceParticipant),
      ],
      actorMemberId,
      db,
      suppliedParticipantProof,
    );
  } catch (error) {
    if (!plannedGroupTrip || !groupTripFanOut.bestEffort) throw error;
    // BEST-EFFORT: the sibling owners' `Member` rows were contended, so drop the
    // cross-account half rather than roll back a transition that must not be
    // refused. Safe here and nowhere else — see `GroupTripFanOutOptions.bestEffort`.
    logger.warn(
      { bookingId, groupBookingId: tripId, err: error },
      "Group Trip hosting fan-out skipped: its participant rows were contended and the transition must not be refused",
    );
    plannedGroupTrip = null;
    participantProof = await acquireOrValidateQueueParticipantProof(
      [sourceParticipant(plannedBooking)],
      actorMemberId,
      db,
      suppliedParticipantProof,
    );
  }
  const booking = (await db.booking.findUnique({
    where: { id: plannedBooking.id },
    select: GROUP_TRIP_COVERAGE_SOURCE_SELECT,
  })) as GroupTripCoverageSourceFacts | null;
  if (!booking) throw new HostingCoverageParticipantRetryError();
  assertHostingCoverageQueueParticipantsLocked(participantProof, {
    memberId: booking.memberId,
    lodgeId: booking.lodgeId,
    sourceBookingId: booking.id,
    actorMemberId,
  });

  // §9 and `INV-LOCK-002`. Confirming paths use this seam instead of evaluating, so
  // this is where they join the key discipline: the queue rows and the confirmation
  // commit together, and a concurrent removal of the cover cannot slip between them.
  // GROUP FIRST, then owner — the same order every other holder takes.
  let verifiedGroupTrip: {
    identity: GroupTripIdentity;
    dependents: CoverageOwnerFacts[];
  } | null = null;
  try {
    verifiedGroupTrip = await lockAndVerifyGroupTripCoverageDependents(
      booking,
      resolved,
      plannedGroupTrip,
      db,
    );
  } catch (error) {
    if (!plannedGroupTrip || !groupTripFanOut.bestEffort) throw error;
    logger.warn(
      { bookingId, groupBookingId: tripId, err: error },
      "Group Trip hosting fan-out skipped: its trip key was contended and the transition must not be refused",
    );
    verifiedGroupTrip = null;
  }
  if (resolved.hostScopes.sameBookingOwner) {
    if (!(await tryLockHostingCoverageOwner(db, booking.memberId))) {
      throw new HostingCoverageParticipantRetryError();
    }
    await lockHostingCoverageOwner(db, booking.memberId);
  }

  const ownItemId = await enqueueHostingCoverageReevaluation(
    {
      memberId: booking.memberId,
      lodgeId: booking.lodgeId,
      nights: coverageNightsOf(booking),
      cause: context.cause,
      sourceBookingId: booking.id,
      actorMemberId,
      reason: context.reason ?? null,
    },
    participantProof,
    db,
  );
  await settleGroupTripDependentCoverage(
    verifiedGroupTrip,
    actorMemberId,
    participantProof,
    db,
  );
  if (verifiedGroupTrip && tripId) {
    groupTripFanOut.settledTripIds?.add(tripId);
  }
  // The OWN item's id, unchanged: callers use it to log what they recorded for the
  // booking they were confirming, and a sibling's item is not that.
  return ownItemId;
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

/**
 * The deterministic bounded candidate set shared by ordinary fan-out and merge.
 *
 * `today` is the club's day as the UTC-midnight `@db.Date` encoding
 * (`INV-DATE-026`), resolved by the caller BEFORE it opened the transaction
 * this runs inside (#3123, `INV-LOCK-004`). Every caller hands it a
 * transaction client, and `enqueueHostingCoverageReevaluationForMember` calls
 * it twice under a `Member` row lock and compares the two results for
 * equality — so resolving the club's timezone here would both take a second
 * pooled connection under the lock AND let the plan and the re-verify land on
 * different days across club midnight, which surfaces as a spurious
 * `HostingCoverageParticipantRetryError`. One resolved day, threaded.
 */
export async function loadHostingCoverageMemberFanoutCandidates(
  memberId: string,
  db: AdultMemberHostingReviewDb,
  today: Date,
): Promise<GroupTripCoverageSourceFacts[]> {
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
    // THE GROUP TRIP IDENTITY RELATIONS ARE SELECTED HERE RATHER THAN RE-READ (#3039).
    // A standing change fans out to the trips the person is travelling in, and the
    // caller needs each candidate's trip identity to do that. Reading it here costs
    // two joins on a query that is already running and already bounded; reading it
    // in a second pass would be a second answer to "what trip is this booking in"
    // (`INV-SSOT-001`). Merge's plan takes the same rows as `CoverageOwnerFacts` and
    // is unaffected — this type is a superset.
    select: GROUP_TRIP_COVERAGE_SOURCE_SELECT,
  })) as GroupTripCoverageSourceFacts[];
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
 * AND IT IS THE THIRD SEAM THAT OWES THE GROUP TRIP FAN-OUT (#3039), which is
 * easy to miss because nothing about a membership change looks like a booking
 * change. Host qualification depends on membership standing, so a lapse, a
 * deactivation, an archive, a cancellation or a Xero "unpaid" removes cover from
 * every booking that was relying on this person — including bookings on OTHER
 * ACCOUNTS in the same Group Trip. Enqueueing only for the bookings this person
 * attends leaves those siblings permanently stranded, because there is no periodic
 * full re-evaluation in this system: the three-hourly cron drains the queue and
 * nothing else. So the trips this person is travelling in are planned before the
 * fence, their keys taken before the owner keys, and the same
 * `settleGroupTripDependentCoverage` the other two seams use records the items.
 * `INV-HOST-046`'s claim that every writer reaching the hosting rule participates
 * automatically is only true with this seam included.
 *
 * Returns the number of items recorded — this person's attended bookings plus the
 * Group Trip dependents — so a caller can log the truth.
 */
export async function enqueueHostingCoverageReevaluationForMember(
  memberId: string,
  db: AdultMemberHostingReviewDb,
  /**
   * The club's today (#3123), resolved by the caller BEFORE it opened the
   * transaction this runs inside. It sits third and REQUIRED, ahead of the
   * defaulted `context`, on purpose: `INV-LOCK-004` says the club timezone is
   * one of the two reads that cannot take a transaction client and must be
   * hoisted out and passed as a value, and a required parameter is what makes
   * the compiler enumerate every caller instead of a default quietly reading
   * the container's timezone (`INV-CONFIG-002`). It bounds the fan-out's
   * `checkOut >= today` candidate set, on both the planning pass and the
   * post-lock re-verify, which must agree.
   */
  today: Date,
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
  const plannedAttended = await loadHostingCoverageMemberFanoutCandidates(memberId, db, today);
  if (plannedAttended.length === 0) return 0;
  if (plannedAttended.length >= HOSTING_COVERAGE_MEMBER_FANOUT_LIMIT) {
    logger.warn(
      { memberId, limit: HOSTING_COVERAGE_MEMBER_FANOUT_LIMIT },
      "Hosting coverage member fan-out hit its ceiling; a booking this member attends may not have been re-evaluated",
    );
  }

  // One policy read per distinct lodge rather than per booking: the resolver is
  // already the hot path on every booking write and this can touch several stays.
  const resolvedByLodge = new Map<string, ResolvedAdultMemberHostingPolicy>();
  for (const booking of plannedAttended) {
    if (resolvedByLodge.has(booking.lodgeId)) continue;
    resolvedByLodge.set(
      booking.lodgeId,
      await loadAdultMemberHostingPolicy(booking.lodgeId, db),
    );
  }
  const enforcing = (booking: { lodgeId: string }): boolean =>
    resolvedByLodge.get(booking.lodgeId)?.mode === "ENFORCED";
  const plannedQueueOwners = plannedAttended
    .filter(enforcing)
    .map((booking) => booking.memberId);
  if (plannedQueueOwners.length === 0) return 0;

  const actorMemberId = context.actorMemberId ?? null;
  // #3039: A STANDING CHANGE OWES THE GROUP TRIP FAN-OUT TOO, and this seam is the
  // THIRD door to the hosting rule rather than a second copy of the other two.
  //
  // Host qualification depends on membership standing — `participantQualifiesAsHost`
  // returns false for a member who is inactive, cancelled, archived or carrying an
  // unsettled subscription. So when the adult who was the trip's only qualifying
  // host lapses, is deactivated, is archived, or is marked unpaid by the Xero sync,
  // the cover disappears from a booking on ANOTHER ACCOUNT. Without this block the
  // fan-out enqueued items for the bookings this person attends and for nothing
  // else, the drain expanded each to that owner's own bookings (or, without
  // `SAME_BOOKING_OWNER`, to the booking plus its split halves), and the stranded
  // sibling was never reached — permanently, because there is no periodic full
  // re-evaluation sweep in this system: the cron drains the queue and nothing more.
  // "A member's standing changes a qualifying adult" is named by the epic's settled
  // lifecycle rule, so leaving it out would have made `INV-HOST-046`'s claim that
  // every writer reaching the hosting rule participates automatically false at the
  // one seam nobody would think to check.
  //
  // ONE PLAN PER TRIP, NOT PER BOOKING. Two attended bookings can sit in the same
  // trip, and planning from either reaches every other booking in it (the only
  // difference is which one the self-exclusion drops, and both already get their own
  // item from the loop below). So the trips are de-duplicated by
  // `GroupBooking.id` — first candidate wins, and `plannedAttended` is ordered, so
  // that choice is deterministic. This is a read expansion and it terminates: it
  // enqueues bounded items and never re-enters this seam.
  const plannedGroupTripByTrip = new Map<
    string,
    {
      booking: GroupTripCoverageSourceFacts;
      resolved: ResolvedAdultMemberHostingPolicy;
      plan: { identity: GroupTripIdentity; dependents: CoverageOwnerFacts[] };
    }
  >();
  for (const booking of plannedAttended) {
    if (!enforcing(booking)) continue;
    const resolved = resolvedByLodge.get(booking.lodgeId);
    if (!resolved) continue;
    const plan = await planGroupTripCoverageDependents(booking, resolved, db);
    if (!plan) continue;
    if (plannedGroupTripByTrip.has(plan.identity.groupBookingId)) continue;
    plannedGroupTripByTrip.set(plan.identity.groupBookingId, {
      booking,
      resolved,
      plan,
    });
  }
  const plannedGroupTrips = [...plannedGroupTripByTrip.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entry]) => entry);
  const plannedSources = [
    ...plannedAttended.filter(enforcing).map(sourceParticipant),
    // The fence has to hold every owner the queue will name, and a trip dependent's
    // owner is somebody this person may not share a booking with at all.
    ...plannedGroupTrips.flatMap((entry) =>
      entry.plan.dependents.map(sourceParticipant),
    ),
  ];
  const participantProof = await acquireOrValidateQueueParticipantProof(
    plannedSources,
    actorMemberId,
    db,
    suppliedParticipantProof,
  );

  // Re-query after the Member locks. Every final owner must already belong to
  // the one planned set; a changed owner or new booking outside it is a safe
  // retry, never a late participant acquisition.
  // The SAME club day as the planning pass above — see `today`'s docblock.
  const attended = await loadHostingCoverageMemberFanoutCandidates(memberId, db, today);
  // The SAME comparison the Group Trip fan-out uses — one definition, and the
  // order-sensitive one, because both reads apply the same `orderBy` so a changed
  // order is a changed world. This used to be a length check plus a `Map`-keyed
  // field-by-field loop: the same hazard answered a second way.
  if (
    coverageBookingSetFingerprint(attended) !==
    coverageBookingSetFingerprint(plannedAttended)
  ) {
    throw new HostingCoverageParticipantRetryError();
  }
  for (const booking of attended) {
    if (enforcing(booking)) {
      assertHostingCoverageQueueParticipantsLocked(participantProof, {
        memberId: booking.memberId,
        lodgeId: booking.lodgeId,
        sourceBookingId: booking.id,
        actorMemberId,
      });
    }
  }

  // #3039 and `INV-LOCK-002`: the per-TRIP keys, then the plans re-verified under
  // them, BEFORE any owner key. Sorted by `GroupBooking.id` above, and every
  // acquisition is tried fail-fast first, so a transaction holding one trip key
  // never waits for another.
  const verifiedGroupTrips: Array<{
    identity: GroupTripIdentity;
    dependents: CoverageOwnerFacts[];
  }> = [];
  for (const entry of plannedGroupTrips) {
    const verified = await lockAndVerifyGroupTripCoverageDependents(
      entry.booking,
      entry.resolved,
      entry.plan,
      db,
    );
    if (verified) verifiedGroupTrips.push(verified);
  }

  const sameOwnerQueueOwners = attended
    .filter(
      (booking) =>
        enforcing(booking) &&
        resolvedByLodge.get(booking.lodgeId)?.hostScopes.sameBookingOwner === true,
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
  const ownItemBookingIds = new Set<string>();
  for (const booking of attended) {
    if (!enforcing(booking)) continue;
    ownItemBookingIds.add(booking.id);

    // The plural lock above already took §9's key for every applicable OWNER in
    // sorted order. The owner is not necessarily the member whose standing changed.
    const id = await enqueueHostingCoverageReevaluation(
      {
        memberId: booking.memberId,
        lodgeId: booking.lodgeId,
        nights: coverageNightsOf(booking),
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

  // #3039: and the bookings on OTHER accounts in the trips this person is
  // travelling in — through the SAME fan-out function the other two seams use, not a
  // third copy of the item shape (`INV-SSOT-001`). One call per trip, because a
  // person can be travelling in more than one.
  for (const verified of verifiedGroupTrips) {
    queued += await settleGroupTripDependentCoverage(
      verified,
      actorMemberId,
      participantProof,
      db,
      ownItemBookingIds,
    );
  }
  return queued;
}

/**
 * WHO this change has just stranded, read-only, for a caller that intends to OFFER
 * the member something rather than refuse them (#3232, `INV-HOST-050`).
 *
 * THE SAME ANSWER THE REFUSAL USES, FROM THE SAME CODE. The linked-move offer has
 * to name exactly the bookings the refusal would have named, at exactly the nights
 * it would have named — otherwise the member is offered a move that does not fix
 * the thing that is about to block them, or is charged for moving a booking nothing
 * required to move. So this is `inspectSameOwnerDependents` over the same verified
 * plan, exported rather than reimplemented (`INV-SSOT-001`): a second "who is
 * stranded" predicate is the drift that would make the offer and the enforcement
 * disagree, which is the exact failure #3232's own acceptance criteria call out.
 *
 * READ-ONLY, AND CALLED FROM INSIDE THE CALLER'S TRANSACTION AFTER ITS WRITE. It
 * answers "given what is now true, who is uncovered", so it has to see the caller's
 * own uncommitted rows — which reading through `tx` is what provides. It writes
 * nothing: no review row, no incident, no queue item. The caller either rolls the
 * whole thing back (to quote the offer) or goes on to move the stranded bookings
 * too (to apply it), and in both cases the durable consequences are settled by the
 * ordinary seam afterwards.
 *
 * RETURNS THE EMPTY LIST rather than throwing when the lodge is not on the scope,
 * the mode is inactive, or nothing is stranded. A caller asking "is there anything
 * to offer about" is entitled to a plain no.
 *
 * IT DOES NOT TAKE THE PER-OWNER COVERAGE KEY, deliberately, and that is safe only
 * because of how it is used: the caller is inside a transaction that is about to
 * either roll back or call the full seam (which takes the key and re-verifies).
 * A wrong answer here therefore costs a re-prompt, never a lost obligation. Do not
 * reach for this function to decide anything durable.
 */
export async function inspectSameOwnerStrandingForOffer(
  bookingId: string,
  db: AdultMemberHostingReviewDb,
  vacatedRange: { checkIn: Date; checkOut: Date } | null,
): Promise<StrandedCoverageBooking[]> {
  const booking = (await db.booking.findUnique({
    where: { id: bookingId },
    select: COVERAGE_OWNER_FACTS_SELECT,
  })) as CoverageOwnerFactsWithOutcome | null;
  if (!booking) return [];
  const resolved = await loadAdultMemberHostingPolicy(booking.lodgeId, db);
  // THE SAME PREDICATE THE REFUSAL USES, not a second spelling of it: an offer
  // raised where the refusal would only escalate names nobody, and an offer that
  // names nobody is a body the browser's fail-closed reader discards.
  if (!hostingModeCanRefuseStranding(resolved.mode)) return [];
  if (!resolved.hostScopes.sameBookingOwner) return [];
  const dependents = await planSameOwnerCoverageDependents(
    booking,
    resolved,
    vacatedRange,
    db,
  );
  if (dependents.length === 0) return [];
  const { stranded } = await inspectSameOwnerDependents(booking, dependents, db);
  return stranded;
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
  /**
   * The set already verified under the owner key (#3232). Read BY ID rather than by
   * re-running the predicate, so the bookings evaluated here cannot possibly differ
   * from the bookings the participant fence holds a proof for and the queue items
   * name. Re-running the predicate would be a third evaluation of the same clause
   * and a third chance for the three lists to disagree.
   */
  verified: readonly CoverageOwnerFacts[],
  db: AdultMemberHostingReviewDb,
): Promise<{
  stranded: StrandedCoverageBooking[];
  dependentsWithOpenIncidents: string[];
}> {
  if (verified.length === 0) {
    return { stranded: [], dependentsWithOpenIncidents: [] };
  }
  const dependents = (await db.booking.findMany({
    where: { id: { in: verified.map((dependent) => dependent.id) } },
    orderBy: [...COVERAGE_READ_ORDER],
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
      // #3232: the dependent's OWN stay, so a linked-move offer can name the dates
      // it would be moved to without re-reading the row. Its uncovered `nights` are
      // a subset of this stay and are not a substitute for it: a partially covered
      // booking would otherwise be proposed a move of only the uncovered part.
      checkIn: formatDateOnly(dependent.checkIn),
      checkOut: formatDateOnly(dependent.checkOut),
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
    orderBy: [...COVERAGE_READ_ORDER],
    take: SAME_OWNER_COVERAGE_DEPENDENT_LIMIT,
    select: { id: true },
  });
  warnIfCoverageDependentCeilingBound(work, dependents.length, "drain");
  return dependents.map((dependent) => dependent.id);
}

/**
 * The #738 split halves of the given bookings, so a queue item that names ONE
 * booking still reaches the half carrying the non-member guests (#3039,
 * `INV-HOST-043`).
 *
 * THE GAP THIS CLOSES IS NAMED IN `inheritedSplitPairGroupTrip`'S OWN DOCBLOCK.
 * Nothing flows the other way across a split pair: the child has neither canonical
 * group relation, so `groupTripCoverageDependentWhere` cannot match it and a Group
 * Trip fan-out finds its PARENT and not the child. The child is the half that
 * carries the non-member guests — the rows the hosting rule exists to judge — so
 * reconciling only the parent re-evaluates the one half that has nothing to judge.
 * The child is reached through the `SAME_BOOKING` sibling relation, which is what
 * this read is.
 *
 * IT IS THE SAME PREDICATE, NOT A SECOND ONE. `hostingSiblingWhere` is the clause
 * `loadSiblingHosts` borrows through and `loadHostingSiblingIds` fans out through,
 * so this cannot drift from the borrow relation it mirrors (`INV-SSOT-001`). The
 * batched `OR` is one query rather than one per booking: each disjunct is that exact
 * clause for one row, so the result is the union of the per-row answers with no
 * predicate rewritten.
 *
 * WHY THE DRAIN NEEDS IT AND THE MUTATION PATH DOES NOT. In the actor's transaction
 * `reconcileAdultMemberHostingReviewWithSiblings` already walks
 * `loadHostingSiblingIds` for the booking it was handed. The drain settles a
 * DIFFERENT booking — a sibling named by a queue item — through the single-id
 * reconciler, and re-entering the sibling-walking form from a background drain would
 * re-enter the participant fence and the fan-out, enqueueing fresh work on every
 * pass. Expanding the id list instead gives the same coverage and terminates.
 *
 * BOUNDED BY ITS INPUT AND CAPPED AGAIN. A split pair is two rows, so the realistic
 * answer is one id per input booking; the ceiling is the same
 * `SAME_OWNER_COVERAGE_DEPENDENT_LIMIT` the dependent reads use, because a family
 * wide enough to reach it is the same data problem that constant already names.
 * Returns only ids NOT already in the input, so a caller can concatenate without
 * de-duplicating.
 */
export async function loadHostingCoverageSplitSiblingIds(
  bookingIds: readonly string[],
  db: AdultMemberHostingReviewDb,
): Promise<string[]> {
  const ids = [...new Set(bookingIds)];
  if (ids.length === 0) return [];
  const rows = (await db.booking.findMany({
    where: { id: { in: ids } },
    select: { id: true, memberId: true, parentBookingId: true },
  })) as Array<Pick<LoadedHostingBooking, "id" | "memberId" | "parentBookingId">>;
  // Every row contributes a clause, including one with no `parentBookingId`: that
  // booking may still be the PARENT of a split child, and `hostingSiblingWhere`
  // covers both directions in the one predicate.
  const clauses = rows.map((row) => hostingSiblingWhere(row));
  if (clauses.length === 0) return [];
  const siblings = (await db.booking.findMany({
    where: { OR: clauses },
    orderBy: [...COVERAGE_READ_ORDER],
    take: SAME_OWNER_COVERAGE_DEPENDENT_LIMIT,
    select: { id: true },
  })) as Array<{ id: string }>;
  const known = new Set(ids);
  return siblings
    .map((sibling) => sibling.id)
    .filter((id) => !known.has(id));
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
  // direct-call order is policy-set -> Member KEY SHARE -> coverage-GROUP ->
  // coverage-owner: since #3039 the evaluator also takes the per-TRIP key, fail-fast,
  // before it reads a Group Trip sibling as cover — so a queued reconciliation of a
  // booking in a trip at a lodge with `SAME_GROUP_TRIP` on composes that tier too.
  // Stating the order without it was a stale claim about a live path.
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
      // A reason WITHOUT an override, which is the declined linked move (#3232
      // D3). It used to be computed, carried all the way here on the queue item,
      // and then dropped on the floor because only an override stored one - so an
      // officer reading the booking's history saw a bare "system change" for a
      // decision a member had deliberately made and been warned about. It is
      // recorded in the incident's audit history from this release; `cause`
      // itself carries it from the runtime half of `INV-HOST-052`.
      recordedReason:
        params.cause === "OFFICER_OVERRIDE" ? null : params.reason ?? null,
    },
    db,
  );
}
