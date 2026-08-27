/**
 * Group bookings (shareable join code).
 *
 * A member (the organiser) opens one of their own bookings as a private group
 * event and shares a short join code. Members and non-members open the
 * /join/[code] link and add themselves: each joiner becomes their own child
 * Booking linked to the organiser booking via Booking.parentBookingId (the
 * existing split-booking relation), so capacity, pricing, payment, and
 * cancellation all reuse the per-booking machinery.
 *
 * The organiser chooses, per group, whether each joiner pays for their own beds
 * (EACH_PAYS_OWN) or the organiser settles the whole bill and joiners are
 * registered at $0 (ORGANISER_PAYS). Joins are checked against remaining lodge
 * capacity at join time under the same advisory lock as every other creation
 * path; there is no pre-held block.
 *
 * Conventions (matching booking-request.ts):
 *   - money stays integer cents
 *   - booking dates stay NZ date-only values
 *   - only SHA-256 token hashes are stored (issueActionToken)
 *   - external calls (email) run after the transaction commits
 *
 * This module owns code generation, organiser create/manage, and public code
 * lookup. The join orchestration (member join, non-member verify, child booking
 * creation) builds on these in the route layer.
 */
import { randomBytes, randomInt } from "crypto";
import { hash } from "bcryptjs";
import {
  AgeTier,
  BookingEventType,
  BookingStatus,
  GroupBookingPaymentMode,
  GroupBookingStatus,
  PaymentStatus,
  Prisma,
} from "@prisma/client";
import { getDefaultLodgeId, lodgeNullTolerantScope } from "@/lib/lodges";
import {
  aggregatePolicyExceptionViolations,
  type AggregatedPolicyExceptions,
  type PolicyExceptionViolation,
} from "@/lib/booking-policy-exceptions";
// Leaf module (no Prisma, no email): the generic public sentence lives beside
// the detailed formatter it deliberately replaces on these two surfaces.
import { PUBLIC_GROUP_JOIN_MINIMUM_STAY_MESSAGE } from "@/lib/policies/minimum-stay";
import { PUBLIC_GROUP_JOIN_ADULT_MEMBER_HOSTING_MESSAGE } from "@/lib/policies/adult-member-hosting";
import { prisma } from "@/lib/prisma";
import {
  hashActionToken,
  isActionTokenFormat,
  issueActionToken,
} from "@/lib/action-tokens";
import {
  sendBookingRequestApprovedEmail,
  sendGroupBookingJoinVerificationEmail,
} from "@/lib/email";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import {
  HOSTING_COVERAGE_RETRY_CODE,
  HOSTING_COVERAGE_RETRY_MESSAGE,
  isHostingCoverageParticipantRetry,
} from "@/lib/adult-member-hosting-queue-participants";
import {
  AdultMemberHostingRequiredError,
  buildAdultMemberHostingRefusalBody,
  evaluateProposedAdultMemberHosting,
  reconcileAdultMemberHostingReviewWithSiblings,
} from "@/lib/adult-member-hosting-review";
import logger from "@/lib/logger";
import {
  buildGuestCreateData,
  createConfirmedBooking,
  GroupJoinConflictError,
  type BookingGuestInput as PricedGuestInput,
} from "@/lib/booking-create";
import {
  DEFAULT_BOOKING_PAYMENT_METHOD,
  type BookingPaymentMethod,
} from "@/lib/booking-payment-methods";
import {
  assertLinkedBookingMembersCanBeBooked,
  normalizeBookingGuestInputs,
  resolveLinkedBookingMembers,
  type BookingGuestInput,
} from "@/lib/booking-guests";
import { findUnpaidMemberGuests } from "@/lib/booking-member-guest-subscriptions";
import { resolveSubscriptionLockoutMode } from "@/lib/member-subscription-eligibility";
import {
  assertMembershipTypeBookingAllowed,
  priceBookingGuestsWithMembershipTypePolicy,
  requiresPaidSubscriptionForMemberForBooking,
} from "@/lib/membership-type-policy";
import {
  buildPaidUpAdultRefusalBody,
  evaluateNonMemberPricingRequirements,
} from "@/lib/subscription-lockout-enforcement";
import {
  calculateBookingHoldDecision,
  toGroupDiscountConfig,
  toGuestPricingInputs,
  toSeasonRateData,
} from "@/lib/policies/booking-route-decisions";
import { acquireLodgeCapacityLock, checkCapacityForGuestRanges } from "@/lib/capacity";
import { getNonMemberHoldDays } from "@/lib/cancellation";
import { resolveRequestBookingHoldUntil } from "@/lib/booking-request";
import { formatDateOnly } from "@/lib/date-only";
import { clubToday, dateOnlyInstantOf } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { paymentLinkExpiryForCheckIn } from "@/lib/payment-link-expiry";
import {
  checkInternetBankingLeadTime,
  loadInternetBankingPaymentSettings,
} from "@/lib/internet-banking-settings";
import { recordBookingEvent } from "@/lib/booking-events";
import { getLodgeCapacity } from "@/lib/lodge-capacity";
import { seasonYearOfStoredDate } from "@/lib/financial-year";
import { ACTIVE_BOOKING_STATUSES } from "@/lib/booking-status";
import { describeUniqueConstraintTarget } from "@/lib/prisma-errors";

// Organiser booking states that may host a group. The organiser must be
// committed (their own beds already reserved) before opening the group to
// others, so we require a capacity-holding or payment-pending status.
export const OPENABLE_ORGANISER_STATUSES: readonly string[] = [
  "PAID",
  "CONFIRMED",
  "PAYMENT_PENDING",
];

// Unambiguous uppercase charset (no I/L/O/0/1), shared with work party codes so
// a code is easy to read aloud and type. 31^8 is about 8.5e11 combinations.
const CODE_CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const CODE_GENERATION_ATTEMPTS = 5;

export class GroupBookingError extends Error {
  status: number;
  /** Optional machine-readable code mirrored from the bookings route gates. */
  code?: string;
  /** Optional extra payload (e.g. capacity-exceeded nights, unpaid members). */
  details?: unknown;
  /** Frozen soft-policy facts; present only on the still-blocking 400 path. */
  violations?: PolicyExceptionViolation[];
  exceptionReview?: AggregatedPolicyExceptions;
  reasonCodes?: string[];
  /**
   * Where the member goes to ask for an override (#2543). Carried through the
   * error so the join route serialises the same field the other four refusal
   * paths return: "you were refused but you may ask" is useless advice if the
   * caller cannot find the door, and a client written against the shared refusal
   * body would otherwise render no link on this path alone.
   */
  exceptionRequestPath?: string;

  constructor(
    message: string,
    status = 400,
    options?: {
      code?: string;
      details?: unknown;
      violations?: PolicyExceptionViolation[];
      exceptionReview?: AggregatedPolicyExceptions;
      exceptionRequestPath?: string;
      reasonCodes?: string[];
    }
  ) {
    super(message);
    this.name = "GroupBookingError";
    this.status = status;
    this.code = options?.code;
    this.details = options?.details;
    this.violations = options?.violations;
    this.exceptionReview = options?.exceptionReview;
    this.reasonCodes = options?.reasonCodes;
    this.exceptionRequestPath = options?.exceptionRequestPath;
  }
}

// test seam
/**
 * Generate a short, human-typable join code. randomInt uses rejection sampling
 * so every character is chosen with equal probability (a `randomBytes % len`
 * approach would be subtly biased for a charset length that is not a power of
 * two), matching generateWorkPartyPromoCode in work-party.ts.
 */
export function generateGroupBookingCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARSET[randomInt(0, CODE_CHARSET.length)];
  }
  return code;
}

/**
 * Normalise a code as entered by a person: trim, uppercase, and drop spaces and
 * dashes people add for readability. Lookups always normalise first.
 */
export function normaliseJoinCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]/g, "");
}

/**
 * Was this P2002 the `joinCode` collision the retry above exists for, rather
 * than the `organiserBookingId` one?
 *
 * This used to read `err.meta?.target` alone, and so answered "no" every single
 * time. Measured on 1 Aug 2026 against PostgreSQL 16 (Prisma 7.9.0 + the `pg`
 * driver adapter, this repo's real migration tree): the adapter never populates
 * `meta.target` — for a schema-level `@unique` OR for a hand-written partial
 * index. It reports the colliding COLUMNS under
 * `meta.driverAdapterError.cause.constraint.fields`, quoted as Postgres quoted
 * them, so `joinCode` arrives as the six-character string `"joinCode"` INCLUDING
 * its double quotes. See `describeUniqueConstraintTarget` for the verbatim
 * shapes; it reads every shape and normalises the quoting and case away, which
 * is why the comparison below is lowercase.
 *
 * An unidentifiable P2002 answers "no" on purpose: a `joinCode` collision is
 * about 1 in 8.5e11, while an `organiserBookingId` collision (the organiser
 * double-submitting) is ordinary, so the honest default is to surface the
 * conflict rather than burn five attempts regenerating a code that was fine.
 */
function isJoinCodeCollision(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") {
    return false;
  }
  return describeUniqueConstraintTarget(err)?.includes("joincode") ?? false;
}

// ---------------------------------------------------------------------------
// Organiser: create and manage
// ---------------------------------------------------------------------------

export interface CreateGroupBookingInput {
  organiserBookingId: string;
  paymentMode: GroupBookingPaymentMode;
  joinDeadline?: Date | null;
  maxJoiners?: number | null;
}

/**
 * Open a group on one of the caller's own bookings and generate a join code.
 * Retries on the (unlikely) code collision; a duplicate on organiserBookingId
 * means the booking already has a group.
 */
export async function createGroupBooking(
  input: CreateGroupBookingInput,
  sessionUserId: string
) {
  const booking = await prisma.booking.findUnique({
    where: { id: input.organiserBookingId },
    select: {
      id: true,
      memberId: true,
      status: true,
      deletedAt: true,
      parentBookingId: true,
      groupBookingAsOrganiser: { select: { id: true } },
    },
  });

  if (!booking || booking.deletedAt) {
    throw new GroupBookingError("Booking not found", 404);
  }
  if (booking.memberId !== sessionUserId) {
    throw new GroupBookingError(
      "You can only open a group on your own booking",
      403
    );
  }
  if (booking.parentBookingId) {
    throw new GroupBookingError(
      "This booking is part of another booking and cannot host a group",
      409
    );
  }
  if (!OPENABLE_ORGANISER_STATUSES.includes(booking.status)) {
    throw new GroupBookingError(
      "This booking is not in a state that can host a group",
      409
    );
  }
  if (booking.groupBookingAsOrganiser) {
    throw new GroupBookingError("This booking already has a group", 409);
  }
  if (input.joinDeadline && input.joinDeadline.getTime() <= Date.now()) {
    throw new GroupBookingError("Join deadline must be in the future", 400);
  }
  if (input.maxJoiners != null && input.maxJoiners < 1) {
    throw new GroupBookingError("Maximum joiners must be at least 1", 400);
  }

  for (let attempt = 1; attempt <= CODE_GENERATION_ATTEMPTS; attempt++) {
    try {
      return await prisma.groupBooking.create({
        data: {
          organiserBookingId: booking.id,
          organiserMemberId: booking.memberId,
          joinCode: generateGroupBookingCode(),
          paymentMode: input.paymentMode,
          joinDeadline: input.joinDeadline ?? null,
          maxJoiners: input.maxJoiners ?? null,
        },
      });
    } catch (err) {
      if (isJoinCodeCollision(err)) {
        if (attempt < CODE_GENERATION_ATTEMPTS) {
          continue;
        }
        // Exhausting the budget on genuine code collisions is its own answer,
        // not the organiserBookingId one below. Unreachable in practice at
        // 31^8 codes, but while the retry was broken (#2412) every collision
        // fell through to "this booking already has a group", which would have
        // been a confusing thing to tell an organiser. Logged with the
        // constraint it read, because the route returns a GroupBookingError
        // verbatim without logging: at these odds the realistic cause is a
        // misread P2002, not five real clashes, and that must leave a trace.
        logger.error(
          {
            organiserBookingId: booking.id,
            attempts: CODE_GENERATION_ATTEMPTS,
            constraint: describeUniqueConstraintTarget(err),
          },
          "Group booking join-code generation exhausted its attempts"
        );
        throw new GroupBookingError(
          "Could not generate a unique join code, please try again",
          500
        );
      }
      // A non-code unique violation here is the organiserBookingId guard losing
      // a race with a concurrent create for the same booking.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        throw new GroupBookingError("This booking already has a group", 409);
      }
      throw err;
    }
  }
  throw new GroupBookingError(
    "Could not generate a unique join code, please try again",
    500
  );
}

async function requireOwnedGroupBookingByCode(
  rawCode: string,
  sessionUserId: string
) {
  const code = normaliseJoinCode(rawCode);
  const group = code
    ? await prisma.groupBooking.findUnique({
        where: { joinCode: code },
        select: { id: true, organiserMemberId: true, status: true },
      })
    : null;
  if (!group) {
    throw new GroupBookingError("Group booking not found", 404);
  }
  if (group.organiserMemberId !== sessionUserId) {
    throw new GroupBookingError("This is not your group booking", 403);
  }
  return group;
}

/** Close a group to new joins. Existing child bookings are untouched. */
export async function closeGroupBooking(rawCode: string, sessionUserId: string) {
  const group = await requireOwnedGroupBookingByCode(rawCode, sessionUserId);
  if (group.status === GroupBookingStatus.CANCELLED) {
    throw new GroupBookingError("This group booking has been cancelled", 409);
  }
  return prisma.groupBooking.update({
    where: { id: group.id },
    data: { status: GroupBookingStatus.CLOSED },
  });
}

/** Reopen a closed group to new joins. */
export async function reopenGroupBooking(rawCode: string, sessionUserId: string) {
  const group = await requireOwnedGroupBookingByCode(rawCode, sessionUserId);
  if (group.status === GroupBookingStatus.CANCELLED) {
    throw new GroupBookingError("This group booking has been cancelled", 409);
  }
  return prisma.groupBooking.update({
    where: { id: group.id },
    data: { status: GroupBookingStatus.OPEN },
  });
}

// ---------------------------------------------------------------------------
// Public: code lookup
// ---------------------------------------------------------------------------

export interface GroupBookingSummary {
  code: string;
  status: GroupBookingStatus;
  paymentMode: GroupBookingPaymentMode;
  organiserFirstName: string;
  // The name of the lodge the group is actually staying at (the organiser
  // booking's lodge), so public join copy names the right property in a
  // multi-lodge club. For a single-lodge club this is the sole lodge's name,
  // so nothing changes visibly (ADR-002).
  lodgeName: string;
  checkIn: Date;
  checkOut: Date;
  joinDeadline: Date | null;
  isJoinable: boolean;
}

// Shape that resolveGroupBookingByCode selects from the database. Kept as a
// type so the pure shaping helper can be unit-tested without a database.
export interface GroupBookingRecordForSummary {
  joinCode: string;
  status: GroupBookingStatus;
  paymentMode: GroupBookingPaymentMode;
  joinDeadline: Date | null;
  organiserBooking: {
    checkIn: Date;
    checkOut: Date;
    status: BookingStatus;
    deletedAt: Date | null;
    lodge: { name: string };
  };
  organiserMember: { firstName: string };
}

// test seam
/**
 * True when a group is accepting joins: it is OPEN and either has no deadline or
 * the deadline is still in the future. Re-checked inside the locked join
 * transaction; this is the read-side hint shown to a prospective joiner.
 */
export function isGroupJoinable(
  group: { status: GroupBookingStatus; joinDeadline: Date | null },
  now: Date = new Date()
): boolean {
  if (group.status !== GroupBookingStatus.OPEN) {
    return false;
  }
  return !group.joinDeadline || group.joinDeadline.getTime() > now.getTime();
}

// test seam
/**
 * True when the organiser's host booking is still live, so the group can
 * actually accept joins. Mirrors the gate joinGroupBookingAsMember and
 * verifyAndCreateNonMemberJoin enforce: a cancelled / bumped / completed or
 * soft-deleted host booking can host no further joins. Kept separate from
 * isGroupJoinable so the public summary's hint matches what those write paths
 * accept, even though they re-check it themselves under the capacity lock.
 */
export function isOrganiserBookingActive(booking: {
  status: BookingStatus;
  deletedAt: Date | null;
}): boolean {
  return (
    !booking.deletedAt &&
    (ACTIVE_BOOKING_STATUSES as readonly BookingStatus[]).includes(booking.status)
  );
}

// test seam
/**
 * True when the group's stay has fully ended (#1723 path 3): the organiser
 * booking's check-out (a date-only lodge night) is on or before the club's
 * current calendar day. Semantics match the unpaid-finished-stays predicate
 * (`checkOut lte today`) — a stay checking out today has fully ended. Such a
 * group is excluded from the joinable set entirely (owner decision A): a join
 * created now could only ever produce a retroactive card obligation.
 *
 * `todayAtClub` IS REQUIRED, and that is the fix (#3123). It used to default to
 * `normalizeDateOnlyForTimeZone(new Date())`, which derives the day from the
 * CONTAINER's timezone rather than the club's persisted one — so a club whose
 * configured zone differed from its deployment's closed, or kept open, a
 * group's joins on the wrong day. This function is pure and sync and is called
 * from inside write paths, so it cannot read the zone itself: every caller
 * resolves it once, outside any transaction, and passes it down.
 *
 * Pass the UTC-midnight `@db.Date` encoding of the club's today —
 * `dateOnlyInstantOf(clubToday(await readClubTimeZoneOutsideRequest()))` — so
 * both sides of the comparison are in one frame. `checkOut` is a stored
 * `@db.Date` value and is used as it is stored, which is correct for exactly
 * that reason.
 */
export function hasGroupStayFullyEnded(
  organiserBooking: { checkOut: Date },
  todayAtClub: Date
): boolean {
  return organiserBooking.checkOut.getTime() <= todayAtClub.getTime();
}

// test seam
/** Pure mapping from the selected record to the public-safe summary. */
export function toGroupBookingSummary(
  group: GroupBookingRecordForSummary,
  todayAtClub: Date,
  now: Date = new Date()
): GroupBookingSummary {
  return {
    code: group.joinCode,
    status: group.status,
    paymentMode: group.paymentMode,
    organiserFirstName: group.organiserMember.firstName,
    lodgeName: group.organiserBooking.lodge.name,
    checkIn: group.organiserBooking.checkIn,
    checkOut: group.organiserBooking.checkOut,
    joinDeadline: group.joinDeadline,
    // A group is only joinable when the group itself is open/in-deadline,
    // its host booking is still active, AND its stay has not fully ended
    // (#1723 path 3); otherwise the public page would invite joins the write
    // paths will reject.
    isJoinable:
      isGroupJoinable(group, now) &&
      isOrganiserBookingActive(group.organiserBooking) &&
      !hasGroupStayFullyEnded(group.organiserBooking, todayAtClub),
  };
}

/**
 * Public lookup by code. Returns a safe summary only (no member contact, no
 * booking ids, no roster), or null when the code is unknown. Returning null
 * uniformly avoids leaking which codes exist.
 */
export async function resolveGroupBookingByCode(
  rawCode: string
): Promise<GroupBookingSummary | null> {
  const code = normaliseJoinCode(rawCode);
  if (!code) {
    return null;
  }
  const group = await prisma.groupBooking.findUnique({
    where: { joinCode: code },
    select: {
      joinCode: true,
      status: true,
      paymentMode: true,
      joinDeadline: true,
      organiserBooking: {
        select: {
          checkIn: true,
          checkOut: true,
          status: true,
          deletedAt: true,
          lodgeId: true,
          lodge: { select: { name: true } },
        },
      },
      organiserMember: { select: { firstName: true } },
    },
  });
  if (!group) {
    return null;
  }
  // The club's today, from its PERSISTED timezone (#3123, INV-CONFIG-002). The
  // CLI-safe runtime reader: `src/instrumentation.node.ts` reaches this module
  // through the Xero inbound chain, where `server-only` throws at import.
  return toGroupBookingSummary(
    group,
    dateOnlyInstantOf(clubToday(await readClubTimeZoneOutsideRequest())),
  );
}

/**
 * Public, read-only: the lodge behind a group-join VERIFICATION token (#2919),
 * so the confirmation page names the lodge the group is actually staying at.
 * Resolved server-side rather than by the verify endpoint, which is a POST
 * because it creates the booking and so only answers AFTER the joiner has read
 * that copy. The name only — never the travel note or door code — and null for
 * a malformed or unknown token, so the caller falls back to the club default
 * exactly as before.
 *
 * That fallback is NOT indistinguishable from a hit, and the docblock used to
 * claim it was (review finding, #2919). Whenever the resolved lodge name differs
 * from the club-level default — a club that renamed its lodge, or a group at a
 * non-default lodge — the copy reads differently for a valid token than for an
 * unknown one. What protects the token is its own entropy: 64 hex characters,
 * looked up by hash, with the format gate rejecting anything else before a query
 * runs. Do not add anything else to this projection on the assumption that the
 * response is uniform.
 */
export async function resolveGroupJoinVerificationLodgeName(
  token: string
): Promise<string | null> {
  if (!isActionTokenFormat(token)) {
    return null;
  }
  const join = await prisma.groupBookingJoin.findUnique({
    where: { verificationTokenHash: hashActionToken(token) },
    select: {
      groupBooking: {
        select: {
          organiserBooking: { select: { lodge: { select: { name: true } } } },
        },
      },
    },
  });
  return join?.groupBooking.organiserBooking.lodge.name ?? null;
}

// ---------------------------------------------------------------------------
// Member self-add (join)
// ---------------------------------------------------------------------------

export interface JoinGroupBookingResult {
  bookingId: string;
  status: BookingStatus;
  isZeroDollarConfirmed: boolean;
  finalPriceCents: number;
  requiresPayment: boolean;
  // True for ORGANISER_PAYS: the joiner's beds are priced and held but the
  // organiser settles them, so the joiner is never billed and requiresPayment
  // is always false.
  organiserSettled: boolean;
}

/**
 * A logged-in member adds themselves (and their own member guests) to a group.
 *
 * The joiner's beds become their own child booking linked to the organiser
 * booking via parentBookingId, created through createConfirmedBooking so
 * capacity (advisory lock), pricing, the $0 auto-confirm and the payment flow
 * are all reused. The same eligibility gates as POST /api/bookings are enforced
 * (owner + guest subscriptions, minimum stay, linked-member rules).
 *
 * Payment mode:
 *   - EACH_PAYS_OWN: the joiner owns and pays their child booking through the
 *     normal member payment flow.
 *   - ORGANISER_PAYS: the child booking is flagged organiserSettled, so the
 *     joiner is never billed (requiresPayment is false) and cannot pay it
 *     themselves; the organiser settles the group total as one combined bill.
 *     The booking is still priced and holds the bed exactly as each-pays.
 *
 * Non-member friends use the public join-request path, so every guest here must
 * be a member; a non-member guest is rejected with a clear message.
 */
export async function joinGroupBookingAsMember(
  input: {
    code: string;
    guests: BookingGuestInput[];
    paymentMethod?: BookingPaymentMethod;
  },
  sessionUserId: string,
  sessionRole: string
): Promise<JoinGroupBookingResult> {
  const code = normaliseJoinCode(input.code);
  const group = code
    ? await prisma.groupBooking.findUnique({
        where: { joinCode: code },
        select: {
          id: true,
          status: true,
          joinDeadline: true,
          paymentMode: true,
          maxJoiners: true,
          organiserMemberId: true,
          organiserBooking: {
            select: {
              id: true,
              lodgeId: true,
              checkIn: true,
              checkOut: true,
              status: true,
              deletedAt: true,
            },
          },
        },
      })
    : null;

  if (!group) {
    throw new GroupBookingError("Group booking not found", 404);
  }
  if (!isGroupJoinable(group)) {
    throw new GroupBookingError("This group is not accepting joins", 409);
  }
  // #1723 path 3: a stay that has fully ended (check-out on or before the
  // club's today) accepts no further joins — a join now could only create a
  // retroactive card obligation on a finished stay. The zone is read here,
  // OUTSIDE the capacity-lock transaction below (#3123).
  //
  // THE ONE READ FOR THE WHOLE JOIN, in both of the kinds this function's
  // callees take (#3123 delta review). Until this was a single read, the join
  // read the club's zone TWICE — here and again at `createConfirmedBooking`
  // below — and a join running across club midnight gated the stay-ended
  // refusal and the Internet Banking lead time on day D while handing D+1 to
  // the retroactive-booking envelope and the promotion's validity window. Both
  // values below are derived from this ONE `CalendarDate`, so they cannot
  // disagree; they are deliberately two names because they are two KINDS —
  // `clubDayForJoin` is the calendar day, `clubDayInstantForJoin` is that same
  // day in the UTC-midnight `@db.Date` encoding the stored `checkIn`/`checkOut`
  // columns are compared against. Passing one where the other is wanted is the
  // conflation this whole issue exists to remove, which is why neither is
  // named just "today".
  const clubDayForJoin = clubToday(await readClubTimeZoneOutsideRequest());
  const clubDayInstantForJoin = dateOnlyInstantOf(clubDayForJoin);
  if (hasGroupStayFullyEnded(group.organiserBooking, clubDayInstantForJoin)) {
    throw new GroupBookingError("This group's stay has ended", 409);
  }
  const organiserSettled =
    group.paymentMode === GroupBookingPaymentMode.ORGANISER_PAYS;
  if (
    group.organiserBooking.deletedAt ||
    !(ACTIVE_BOOKING_STATUSES as readonly BookingStatus[]).includes(
      group.organiserBooking.status
    )
  ) {
    throw new GroupBookingError("This group's booking is no longer active", 409);
  }
  if (group.organiserMemberId === sessionUserId) {
    throw new GroupBookingError("You are the organiser of this group", 409);
  }

  // One active join per member.
  const existingJoin = await prisma.groupBookingJoin.findFirst({
    where: {
      groupBookingId: group.id,
      joinerMemberId: sessionUserId,
      booking: {
        is: {
          deletedAt: null,
          status: { notIn: [BookingStatus.CANCELLED, BookingStatus.BUMPED] },
        },
      },
    },
    select: { id: true },
  });
  if (existingJoin) {
    throw new GroupBookingError("You have already joined this group", 409);
  }

  // Optional organiser cap on headcount, independent of lodge capacity.
  if (group.maxJoiners != null) {
    const joinCount = await prisma.groupBookingJoin.count({
      where: { groupBookingId: group.id, bookingId: { not: null } },
    });
    if (joinCount >= group.maxJoiners) {
      throw new GroupBookingError("This group is full", 409);
    }
  }

  const { checkIn, checkOut } = group.organiserBooking;

  const joiner = await prisma.member.findUnique({
    where: { id: sessionUserId },
    select: { ageTier: true },
  });
  if (!joiner) {
    throw new GroupBookingError("Member not found", 404);
  }

  // Resolve and normalise guests against the joiner; members only here (non-member
  // friends join via the public path). Reuses the same helpers as the route.
  //
  // DELIBERATELY NOT WIDENED — owner decision MG1-D-a keeps group-booking joins
  // FAMILY-SCOPED in v1, so this is the one of the seven `resolveLinkedBooking-
  // Members` call sites that passes no options at all and must keep passing none.
  // MG2 turns the widening on everywhere else ("+ Add Member Guest", epic #2305,
  // #2307); here the omission IS the policy, not an oversight, and the option's
  // `false` default is what enforces it.
  //
  // The reason is worth stating, because "it works everywhere else" is the obvious
  // objection: a group join already creates a booking under somebody ELSE's
  // organiser event, and in ORGANISER_PAYS mode somebody else settles it. Letting
  // a joiner also pull in a member from beyond their own family would put a third
  // party on a stay they did not choose, billed to a fourth. If that is wanted it
  // needs its own decision about who consents to what, and that decision has not
  // been made. A test pins this call site against accidental widening.
  const linkedMembers = await resolveLinkedBookingMembers(
    prisma,
    sessionUserId,
    input.guests.map((g) => g.memberId)
  );
  await assertLinkedBookingMembersCanBeBooked(
    prisma,
    linkedMembers,
    sessionUserId,
    { actorRole: sessionRole, onBehalfOfMemberId: null }
  );
  const guests = normalizeBookingGuestInputs(input.guests, linkedMembers);
  if (guests.length === 0) {
    throw new GroupBookingError("Add at least one guest", 400);
  }
  if (guests.some((g) => !g.isMember)) {
    throw new GroupBookingError(
      "Only members can be added here. Non-member guests should use the public join link.",
      400
    );
  }

  const groupLodgeId =
    group.organiserBooking.lodgeId ?? (await getDefaultLodgeId(prisma));
  const lodgeCapacity = await getLodgeCapacity(groupLodgeId);
  if (guests.length > lodgeCapacity) {
    throw new GroupBookingError(
      `A booking cannot exceed ${lodgeCapacity} guests`,
      400
    );
  }

  const seasonYear = seasonYearOfStoredDate(checkIn);
  await assertMembershipTypeBookingAllowed(prisma, {
    ownerMemberId: sessionUserId,
    guests,
    seasonYear,
  });

  // #2543 — the club's three-way lockout policy, resolved once for this join so
  // the owner refusal, the member-guest refusal and the paid-up-adult
  // requirement all branch on the same answer.
  const subscriptionLockoutMode = await resolveSubscriptionLockoutMode();

  // Same eligibility gates as POST /api/bookings (skipped for admins).
  if (sessionRole !== "ADMIN") {
    if (
      subscriptionLockoutMode === "HARD_BLOCK" &&
      (await requiresPaidSubscriptionForMemberForBooking(prisma, {
        memberId: sessionUserId,
        seasonYear,
        ageTier: joiner.ageTier,
      }))
    ) {
      const paidSub = await prisma.memberSubscription.findFirst({
        where: { memberId: sessionUserId, seasonYear, status: "PAID" },
        select: { id: true },
      });
      if (!paidSub) {
        throw new GroupBookingError(
          `Your membership subscription for the ${seasonYear}/${seasonYear + 1} season is not paid. Please contact the club to arrange payment before joining.`,
          403,
          { code: "SUBSCRIPTION_REQUIRED" }
        );
      }
    }

    const unpaidMemberGuests = await findUnpaidMemberGuests(prisma, {
      bookingMemberId: sessionUserId,
      checkIn,
      guests,
    });
    // #2543: mode-gated like the four sibling paths — the call above still runs
    // under NON_MEMBER_PRICING so the D-8 cross-family refusal is unaffected.
    if (
      subscriptionLockoutMode === "HARD_BLOCK" &&
      unpaidMemberGuests.length > 0
    ) {
      throw new GroupBookingError(
        `The following member guests have unpaid subscriptions: ${unpaidMemberGuests
          .map((m) => m.name)
          .join(", ")}.`,
        403,
        { code: "GUEST_SUBSCRIPTION_REQUIRED", details: unpaidMemberGuests }
      );
    }

    // #2543 — the paid-up-adult requirement over the JOINER's own booking. A
    // group joiner creates their own booking under their own name, so "at least
    // one paid-up adult member on the booking" is judged over their party alone.
    // Hosting is evaluated separately below: only another eligible booking with
    // this joiner's exact Booking.memberId can supply SAME_BOOKING_OWNER cover.
    const nonMemberPricing = await evaluateNonMemberPricingRequirements(prisma, {
      mode: subscriptionLockoutMode,
      lodgeId: groupLodgeId,
      seasonYear,
      checkIn,
      checkOut,
      // Owner decision, 3 Aug 2026: the joiner OWNS the booking they are creating,
      // so an unfinancial joiner triggers the requirement even when every bed they
      // are claiming is for a linked family member. The HARD_BLOCK gate above
      // refuses that same joiner as a person.
      bookingOwnerMemberId: sessionUserId,
      participants: guests,
    });
    const hostingViolation = await evaluateProposedAdultMemberHosting(prisma, {
      bookingOwnerMemberId: sessionUserId,
      lodgeId: groupLodgeId,
      checkIn,
      checkOut,
      guests: guests.map((guest) => ({
        firstName: guest.firstName,
        lastName: guest.lastName,
        memberId: guest.memberId,
        stayStart:
          guest.stayStart instanceof Date ? guest.stayStart : undefined,
        stayEnd: guest.stayEnd instanceof Date ? guest.stayEnd : undefined,
      })),
    });
    if (
      nonMemberPricing?.violation &&
      hostingViolation?.consequence === "ENFORCED"
    ) {
      // Aggregate only the existing member-facing hosting shape. The raw
      // evaluator evidence carries qualifying-host member ids for audit use.
      const hostingRefusal = buildAdultMemberHostingRefusalBody(hostingViolation);
      const exceptionReview = aggregatePolicyExceptionViolations([
        nonMemberPricing.violation,
        ...hostingRefusal.violations,
      ]);
      throw new GroupBookingError(
        "This booking needs both a paid-up adult member and adult member cover for every required night.",
        409,
        {
          code: "BOOKING_POLICY_REQUIREMENTS_NOT_MET",
          details: exceptionReview.violations
            .map((violation) => violation.message)
            .join(" "),
          reasonCodes: exceptionReview.violations.map(
            (violation) => violation.reasonCode,
          ),
          violations: exceptionReview.violations,
          exceptionReview,
          exceptionRequestPath: hostingRefusal.exceptionRequestPath,
        },
      );
    }
    if (nonMemberPricing?.violation) {
      const refusal = buildPaidUpAdultRefusalBody(nonMemberPricing.violation);
      throw new GroupBookingError(nonMemberPricing.violation.message, 409, {
        code: refusal.code,
        details: refusal.details,
        violations: refusal.exceptionReview.violations,
        exceptionReview: refusal.exceptionReview,
        // The one field the other four paths return and this one used to drop.
        exceptionRequestPath: refusal.exceptionRequestPath,
      });
    }

    const { validateMinimumStay, formatViolationsDetail } = await import(
      "@/lib/booking-policies"
    );
    const stay = await validateMinimumStay(checkIn, checkOut, groupLodgeId);
    if (!stay.valid) {
      const exceptionReview = aggregatePolicyExceptionViolations(stay.violations);
      throw new GroupBookingError(
        "Booking does not meet the minimum stay requirement",
        400,
        {
          code: "MINIMUM_STAY_VIOLATION",
          details: formatViolationsDetail(stay.violations),
          violations: exceptionReview.violations,
          exceptionReview,
        }
      );
    }
  }

  const gds = await prisma.groupDiscountSetting.findUnique({
    where: { id: "default" },
  });
  const groupDiscount = toGroupDiscountConfig(gds);

  // All-member booking: no non-member hold; charged up front (PAYMENT_PENDING)
  // or auto-confirmed at $0 inside createConfirmedBooking.
  const hold = calculateBookingHoldDecision({
    hasNonMembers: false,
    checkIn,
    holdDays: 0,
  });

  // Payment method only applies to EACH_PAYS_OWN joiners who pay for their own
  // beds. An ORGANISER_PAYS joiner is organiserSettled (never billed, no payment
  // record created at join), so force the default and never raise an Internet
  // Banking invoice to the joiner. Module availability is gated in the route.
  const effectivePaymentMethod: BookingPaymentMethod = organiserSettled
    ? DEFAULT_BOOKING_PAYMENT_METHOD
    : input.paymentMethod ?? DEFAULT_BOOKING_PAYMENT_METHOD;
  const internetBankingSettings =
    effectivePaymentMethod === "internet_banking"
      ? await loadInternetBankingPaymentSettings()
      : undefined;
  if (internetBankingSettings) {
    const leadTime = checkInternetBankingLeadTime({
      checkIn,
      settings: internetBankingSettings,
      // #3123 — the SAME club day this join already resolved above for the
      // stay-has-ended gate, in the `@db.Date` encoding this comparison wants.
      // One read, one answer, for the whole join.
      today: clubDayInstantForJoin,
    });
    if (!leadTime.allowed) {
      throw new GroupBookingError(
        leadTime.unavailableReason ??
          "Internet Banking is not available for this check-in date.",
        400,
        {
          code: "INTERNET_BANKING_CUTOFF",
          details: {
            minimumDaysBeforeCheckIn: leadTime.minimumDaysBeforeCheckIn,
            checkIn: leadTime.checkIn,
          },
        },
      );
    }
  }

  let outcome: Awaited<ReturnType<typeof createConfirmedBooking>>;
  try {
    outcome = await createConfirmedBooking({
      // #3123 — the CLUB's day (`INV-CONFIG-002`), resolved at the top of this
      // function, outside every transaction. `createConfirmedBooking` is
      // transaction-aware and so cannot read the club's zone for itself
      // (`INV-LOCK-004`). The runtime reader rather than `club-time/server`:
      // this module sits on the shared `src/lib` graph a CLI entry point
      // reaches, where `server-only` is a bare throw at import.
      //
      // The CALENDAR day, not the `@db.Date` instant — this parameter is a
      // `CalendarDate` and `createConfirmedBooking` derives its own instant from
      // it. Same day as the gates above, by construction rather than by a second
      // read that could land on the other side of club midnight.
      todayAtClub: clubDayForJoin,
    effectiveMemberId: sessionUserId,
    isOnBehalf: false,
    sessionUserId,
    // The child booking belongs to the organiser's already-resolved lodge.
    // Omitting this made policy/capacity checks use `groupLodgeId` above but
    // let the booking writer fall back to the club default (#2701).
    lodgeId: groupLodgeId,
    checkIn,
    checkOut,
    // Map to the booking-create guest shape. v1 joins use the organiser's dates
    // with no per-guest night selection, so only the scalar fields carry over.
    guests: guests.map((g) => ({
      firstName: g.firstName,
      lastName: g.lastName,
      ageTier: g.ageTier,
      isMember: g.isMember,
      memberId: g.memberId,
    })),
    groupDiscount,
    status: hold.status,
    shouldBePending: hold.shouldBePending,
    holdDays: 0,
    parentBookingId: group.organiserBooking.id,
    // Roster row is written inside the booking transaction (#1039 item 2) so
    // a concurrent duplicate join rolls the booking back atomically.
    groupJoin: { groupBookingId: group.id, joinerMemberId: sessionUserId },
    // Whole-stay unit (#1387): the child inherits the organiser's dates, which
    // are legitimately in the past once the group stay is in progress.
    allowPastCheckIn: true,
    // ORGANISER_PAYS: flag the child booking so the joiner is never billed and
    // cannot pay it; the organiser settles the group total. No-op for each-pays.
    organiserSettled,
    // EACH_PAYS_OWN joiner can pay by card or Internet Banking; createConfirmedBooking
    // raises + emails the Xero invoice when internet_banking is chosen.
    paymentMethod: effectivePaymentMethod,
    internetBankingSettings,
    });
  } catch (err) {
    if (isHostingCoverageParticipantRetry(err)) {
      throw new GroupBookingError(HOSTING_COVERAGE_RETRY_MESSAGE, 409, {
        code: HOSTING_COVERAGE_RETRY_CODE,
      });
    }
    if (err instanceof GroupJoinConflictError) {
      throw new GroupBookingError("You have already joined this group", 409);
    }
    // #2569 — the ENFORCED hosting refusal over the JOINER's OWN booking, raised by
    // the reconciler inside `createConfirmedBooking`'s transaction (so the child
    // booking and its roster row rolled back together) and translated into exactly
    // the `GroupBookingError` shape the #2543 paid-up-adult refusal above uses. The
    // join route serialises those five fields, so the joiner gets the same
    // exception door as every other refusing path; without this branch the error
    // reached the route's generic handler as a 500 saying nothing.
    //
    // Judged over the joiner's party alone, for the reason #2543 is: the organiser's
    // adults are on a DIFFERENT booking, and `SAME_BOOKING` means what it says.
    //
    // The REDACTED body, never `err.violation` directly — a member-facing body
    // carries no qualifying-host member ids under any scope (§5).
    if (err instanceof AdultMemberHostingRequiredError) {
      const refusal = buildAdultMemberHostingRefusalBody(err.violation);
      throw new GroupBookingError(refusal.error, err.status, {
        code: refusal.code,
        details: refusal.details,
        violations: refusal.exceptionReview.violations,
        exceptionReview: refusal.exceptionReview,
        exceptionRequestPath: refusal.exceptionRequestPath,
      });
    }
    throw err;
  }

  if (outcome.type === "capacityExceeded") {
    throw new GroupBookingError("The lodge is full for these dates", 409, {
      code: "CAPACITY_EXCEEDED",
      details: { fullNights: outcome.fullNights },
    });
  }

  const booking = outcome.booking;

  return {
    bookingId: booking.id,
    status: booking.status,
    isZeroDollarConfirmed: outcome.isZeroDollarConfirmed,
    finalPriceCents: booking.finalPriceCents,
    // ORGANISER_PAYS joiners never pay; the organiser settles the group total.
    requiresPayment:
      !organiserSettled &&
      booking.status === BookingStatus.PAYMENT_PENDING &&
      booking.finalPriceCents > 0,
    organiserSettled,
  };
}

// ---------------------------------------------------------------------------
// Non-member self-add (email-verified join request)
// ---------------------------------------------------------------------------

/** Verification link lifetime, matching the public booking-request flow. */
const GROUP_JOIN_VERIFICATION_TTL_MS = 48 * 60 * 60 * 1000;

export interface NonMemberJoinGuest {
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
}

export interface NonMemberJoinRequestInput {
  code: string;
  contactFirstName: string;
  contactLastName: string;
  contactEmail: string;
  contactPhone?: string | null;
  guests: NonMemberJoinGuest[];
}

/**
 * Stage a non-member's join: validate the group, capture contact + guest
 * snapshot on a GroupBookingJoin row, and email a verification link. No booking
 * is created yet (mirrors createBookingRequest in booking-request.ts); the child
 * booking and pay link are created only after the email is verified.
 *
 * EACH_PAYS_OWN only for now. If the email belongs to a real login member we ask
 * them to log in and use the member path instead of creating a duplicate
 * non-login member.
 */
export async function createNonMemberJoinRequest(
  input: NonMemberJoinRequestInput
) {
  const code = normaliseJoinCode(input.code);
  const group = code
    ? await prisma.groupBooking.findUnique({
        where: { joinCode: code },
        select: {
          id: true,
          status: true,
          joinDeadline: true,
          paymentMode: true,
          organiserBooking: {
            select: { checkIn: true, checkOut: true, status: true, deletedAt: true, lodgeId: true },
          },
        },
      })
    : null;

  if (!group) {
    throw new GroupBookingError("Group booking not found", 404, {
      code: "GROUP_NOT_FOUND",
    });
  }
  if (!isGroupJoinable(group)) {
    throw new GroupBookingError("This group is not accepting joins", 409, {
      code: "GROUP_NOT_JOINABLE",
    });
  }
  // #1723 path 3: a fully ended stay accepts no further join requests. The
  // club's own day, read from its persisted timezone (#3123).
  const clubTodayForRequest = dateOnlyInstantOf(
    clubToday(await readClubTimeZoneOutsideRequest()),
  );
  if (hasGroupStayFullyEnded(group.organiserBooking, clubTodayForRequest)) {
    throw new GroupBookingError("This group's stay has ended", 409, {
      code: "GROUP_STAY_ENDED",
    });
  }
  if (group.paymentMode !== GroupBookingPaymentMode.EACH_PAYS_OWN) {
    throw new GroupBookingError(
      "This group is not accepting individual sign-ups",
      409,
      { code: "GROUP_NOT_INDIVIDUAL_SIGNUP" }
    );
  }
  if (
    group.organiserBooking.deletedAt ||
    !(ACTIVE_BOOKING_STATUSES as readonly BookingStatus[]).includes(
      group.organiserBooking.status
    )
  ) {
    throw new GroupBookingError("This group's booking is no longer active", 409, {
      code: "GROUP_BOOKING_INACTIVE",
    });
  }

  const contactEmail = input.contactEmail.trim().toLowerCase();
  const contactFirstName = input.contactFirstName.trim();
  const contactLastName = input.contactLastName.trim();
  if (!contactFirstName || !contactLastName || !contactEmail) {
    throw new GroupBookingError("Contact name and email are required", 422);
  }
  if (input.guests.length === 0) {
    throw new GroupBookingError("At least one guest is required", 422);
  }

  const groupLodgeId =
    group.organiserBooking.lodgeId ?? (await getDefaultLodgeId(prisma));
  const lodgeCapacity = await getLodgeCapacity(groupLodgeId);
  if (input.guests.length > lodgeCapacity) {
    throw new GroupBookingError(
      `A booking cannot exceed ${lodgeCapacity} guests`,
      400
    );
  }

  // #2363: the public non-member join is held to the same minimum-stay policy
  // as the member join (joinGroupBookingAsMember) — this contact is never an
  // admin, so there is no override branch. Staging is refused BEFORE a
  // verification token is issued or a GroupBookingJoin row is written, so a
  // stay the policy refuses never reaches a mailbox as a live confirmation
  // link. The joiner inherits the organiser's dates at the group's own lodge,
  // so those are what is evaluated.
  //
  // The refusal is surfaced like the guest-cap refusal above: the plain
  // sentence and its code, no frozen snapshot. It is not on the route's
  // neutral list because it discloses nothing about who or what exists — a
  // caller already holding a valid, joinable group code learns only that the
  // organiser's own dates are too short, which the group's public page already
  // shows them.
  const { validateMinimumStay, formatViolationsDetail } = await import(
    "@/lib/booking-policies"
  );
  const stay = await validateMinimumStay(
    group.organiserBooking.checkIn,
    group.organiserBooking.checkOut,
    groupLodgeId
  );
  if (!stay.valid) {
    const exceptionReview = aggregatePolicyExceptionViolations(stay.violations);
    logger.warn(
      {
        groupBookingId: group.id,
        groupLodgeId,
        // The detailed sentence lives HERE and only here, exactly as it does at
        // the verification stage: rule name, required nights and trigger
        // weekdays are for the club reading its own log, not for an
        // unauthenticated 400 body.
        detail: formatViolationsDetail(stay.violations),
        violations: exceptionReview.violations.map((violation) => ({
          policyId: violation.policyId,
          policyVersion: violation.policyVersion,
        })),
      },
      "Group join staging refused: minimum-stay policy not satisfied"
    );
    throw new GroupBookingError(
      // A non-member cannot move these dates — only the organiser can — so the
      // sentence they read on /join/[code] names the fix rather than the rule.
      PUBLIC_GROUP_JOIN_MINIMUM_STAY_MESSAGE,
      400,
      // Message and code ONLY. The detailed sentence and the frozen snapshot are
      // deliberately absent from the thrown error rather than merely unread by
      // the route: this error is caught one `...err` spread away from an
      // unauthenticated response body, and the club already has both in the log
      // line above.
      { code: "MINIMUM_STAY_VIOLATION" }
    );
  }

  // A real login member should use the authenticated member path so we don't
  // create a duplicate non-login member for them.
  const existingMember = await prisma.member.findFirst({
    where: {
      email: { equals: contactEmail, mode: "insensitive" },
      canLogin: true,
      active: true,
    },
    select: { id: true },
  });
  if (existingMember) {
    throw new GroupBookingError(
      "This email belongs to a member account. Please log in and join from your account.",
      409,
      { code: "USE_MEMBER_LOGIN" }
    );
  }

  const { token, tokenHash } = issueActionToken();
  const verificationTokenExpiresAt = new Date(
    Date.now() + GROUP_JOIN_VERIFICATION_TTL_MS
  );

  const join = await prisma.groupBookingJoin.create({
    data: {
      groupBookingId: group.id,
      isMember: false,
      contactFirstName,
      contactLastName,
      contactEmail,
      contactPhone: input.contactPhone?.trim() || null,
      guestsSnapshot: input.guests as unknown as Prisma.InputJsonValue,
      verificationTokenHash: tokenHash,
      verificationTokenExpiresAt,
    },
  });

  try {
    await sendGroupBookingJoinVerificationEmail({
      // No joiner booking exists yet — it is created only after this contact
      // verifies their email, so there is nothing to suppress (#2258).
      bookingContext: "none",
      email: contactEmail,
      firstName: contactFirstName,
      token,
      checkIn: group.organiserBooking.checkIn,
      checkOut: group.organiserBooking.checkOut,
      guestCount: input.guests.length,
      expiresAt: verificationTokenExpiresAt,
    });
  } catch (err) {
    logger.error(
      { err, joinId: join.id },
      "Failed to send group join verification email"
    );
  }

  return join;
}

// ---------------------------------------------------------------------------
// Non-member verify-and-create (the money path)
// ---------------------------------------------------------------------------

export type VerifyNonMemberJoinResult =
  | { outcome: "invalid" }
  | { outcome: "expired" }
  | { outcome: "not_joinable"; message: string }
  | { outcome: "capacity_full"; fullNights: string[] }
  // #2363: the minimum-stay policy set is re-read at verification time, so a
  // rule tightened (or newly created) after this request was staged fails
  // closed here instead of admitting a stay the club no longer allows. It is
  // its own outcome, not a thrown error, because a throw becomes a generic 500
  // at the verify route. Carries the generic member-facing sentence and nothing
  // else: this result reaches an unauthenticated route, so the frozen snapshot
  // and the rule-naming sentence stay in the server log the service writes
  // beside it rather than travelling one field-spread from the wire.
  | { outcome: "minimum_stay"; message: string }
  // #2569: the lodge's ENFORCED hosting consequence refuses this join. Its own
  // outcome for the reason `minimum_stay` is one — a throw becomes a generic 500
  // at the verify route, which tells the joiner nothing and reads as an outage —
  // and it carries the generic sentence and nothing else, because this result
  // reaches an UNAUTHENTICATED route. See
  // `PUBLIC_GROUP_JOIN_ADULT_MEMBER_HOSTING_MESSAGE` for why there is no
  // exception-door body here while every member-authenticated path gets one.
  | { outcome: "adult_member_hosting"; message: string }
  | { outcome: "already_done"; bookingId: string }
  | {
      outcome: "created";
      bookingId: string;
      payToken: string;
      priceCents: number;
      checkIn: Date;
      checkOut: Date;
      guestCount: number;
    };

/** Internal sentinel: the join row was claimed by a concurrent verify. */
const JOIN_ALREADY_CLAIMED = "GROUP_JOIN_ALREADY_CLAIMED_SENTINEL";
const CAPACITY_EXCEEDED = "GROUP_JOIN_CAPACITY_EXCEEDED_SENTINEL";

/** Full nights (date-only strings) where the capacity check went negative. */
function getCapacityFullNights(
  nightDetails: Array<{ date: Date; availableBeds: number }>
): string[] {
  return nightDetails
    .filter((night) => night.availableBeds < 0)
    .map((night) => formatDateOnly(night.date));
}

// test seam
/**
 * Validate the stored guest snapshot. Returns [] (treated as invalid) if the
 * JSON is not the expected array of {firstName, lastName, ageTier}.
 */
export function parseNonMemberJoinGuests(
  snapshot: Prisma.JsonValue | null | undefined
): NonMemberJoinGuest[] {
  if (!Array.isArray(snapshot)) return [];
  const validTiers = new Set<string>(Object.values(AgeTier));
  const guests: NonMemberJoinGuest[] = [];
  for (const raw of snapshot) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const obj = raw as Record<string, unknown>;
    const firstName = typeof obj.firstName === "string" ? obj.firstName.trim() : "";
    const lastName = typeof obj.lastName === "string" ? obj.lastName.trim() : "";
    const ageTier = typeof obj.ageTier === "string" ? obj.ageTier : "";
    if (!firstName || !lastName || !validTiers.has(ageTier)) return [];
    guests.push({ firstName, lastName, ageTier: ageTier as AgeTier });
  }
  return guests;
}

/**
 * Confirm a non-member's emailed token and create their child booking.
 *
 * Mirrors approveBookingRequest (booking-request.ts): under the shared booking
 * advisory lock it status-claims the join row, re-checks capacity, then creates
 * a non-login Member, a PENDING child Booking linked to the organiser booking,
 * a PENDING Payment, and a tokenised PaymentLink. Guests are priced from the
 * live season rates (not an admin price). The pay-link email is sent after the
 * transaction commits.
 *
 * Idempotent: a second call once the row is consumed returns `already_done`
 * with the existing bookingId rather than creating a duplicate.
 */
export async function verifyAndCreateNonMemberJoin(
  token: string
): Promise<VerifyNonMemberJoinResult> {
  const tokenHash = hashActionToken(token);
  const join = await prisma.groupBookingJoin.findUnique({
    where: { verificationTokenHash: tokenHash },
    select: {
      id: true,
      isMember: true,
      bookingId: true,
      verifiedAt: true,
      verificationTokenExpiresAt: true,
      contactFirstName: true,
      contactLastName: true,
      contactEmail: true,
      contactPhone: true,
      guestsSnapshot: true,
      groupBooking: {
        select: {
          status: true,
          joinDeadline: true,
          paymentMode: true,
          organiserBooking: {
            select: {
              id: true,
              checkIn: true,
              checkOut: true,
              status: true,
              deletedAt: true,
              lodgeId: true,
            },
          },
        },
      },
    },
  });

  // Unknown token, or a member roster row (members never carry a token).
  if (!join || join.isMember) {
    return { outcome: "invalid" };
  }
  // Already consumed → idempotent success (the joiner already got the pay link).
  if (join.bookingId) {
    return { outcome: "already_done", bookingId: join.bookingId };
  }
  if (
    !join.verificationTokenExpiresAt ||
    join.verificationTokenExpiresAt.getTime() < Date.now()
  ) {
    return { outcome: "expired" };
  }
  if (!join.contactEmail || !join.contactFirstName || !join.contactLastName) {
    return { outcome: "invalid" };
  }

  const group = join.groupBooking;
  const organiserBooking = group.organiserBooking;
  if (!isGroupJoinable(group)) {
    return { outcome: "not_joinable", message: "This group is no longer accepting joins" };
  }
  // #1723 path 3: a fully ended stay accepts no further joins, even when the
  // verification email was sent while the stay was still running. ONE zone read
  // for this whole path — the payment-link expiry below uses the same
  // `clubZone` rather than reading the setting a second time (#3123).
  const clubZone = await readClubTimeZoneOutsideRequest();
  if (
    hasGroupStayFullyEnded(
      organiserBooking,
      dateOnlyInstantOf(clubToday(clubZone)),
    )
  ) {
    return { outcome: "not_joinable", message: "This group's stay has ended" };
  }
  if (group.paymentMode !== GroupBookingPaymentMode.EACH_PAYS_OWN) {
    return { outcome: "not_joinable", message: "This group is not accepting individual sign-ups" };
  }
  if (
    organiserBooking.deletedAt ||
    !(ACTIVE_BOOKING_STATUSES as readonly BookingStatus[]).includes(
      organiserBooking.status
    )
  ) {
    return { outcome: "not_joinable", message: "This group's booking is no longer active" };
  }

  const snapshotGuests = parseNonMemberJoinGuests(join.guestsSnapshot);
  if (snapshotGuests.length === 0) {
    return { outcome: "invalid" };
  }

  const { id: organiserBookingId, checkIn, checkOut } = organiserBooking;
  // A group booking lives at one lodge (ADR-001): the joiner's booking,
  // pricing seasons, hold policy, lock, and capacity check all use the
  // organiser's lodge.
  const groupLodgeId =
    organiserBooking.lodgeId ?? (await getDefaultLodgeId(prisma));

  // #2363: re-validate minimum stay against the CURRENT policy set before any
  // booking is created. Stage 1 (createNonMemberJoinRequest) checked it when
  // the link was emailed, but that link lives for 48 hours, during which an
  // admin or a config import can tighten or add a rule — and the organiser's
  // own dates can move. Re-reading here makes the second stage fail CLOSED
  // rather than admitting a stay under a rule that now applies.
  //
  // Deliberately outside the booking transaction, like every other pre-write
  // check on this path. The argument is about the CONNECTION POOL, not lock
  // order: running it inside would leave `validateMinimumStay` reading through
  // the module-level Prisma client while the per-lodge capacity lock is held,
  // taking a second pool connection underneath that lock — the shape
  // `member-guest-add-policy.ts` forbids. (The two in-transaction callers that
  // genuinely cannot hoist the check — the two modify services — pass their own
  // `tx` instead; see docs/CONCURRENCY_AND_LOCKING.md.) There is no lock-order
  // hazard to weigh either way: no minimum-stay policy writer ever takes a
  // per-lodge capacity lock and no booking path takes the policy-set key, so
  // the two keyspaces are disjoint and cannot cycle. The residual window is the
  // few milliseconds between this read and the claim below, which is the same
  // footing as the member join path.
  const {
    validateMinimumStay: validateVerifyMinimumStay,
    formatViolationsDetail: formatVerifyViolationsDetail,
  } = await import("@/lib/booking-policies");
  const verifyStay = await validateVerifyMinimumStay(
    checkIn,
    checkOut,
    groupLodgeId
  );
  if (!verifyStay.valid) {
    const exceptionReview = aggregatePolicyExceptionViolations(
      verifyStay.violations
    );
    logger.warn(
      {
        joinId: join.id,
        groupLodgeId,
        // The detailed sentence lives HERE and only here: rule name, required
        // nights and trigger weekdays are for the club reading its own log, not
        // for an unauthenticated 409 body.
        detail: formatVerifyViolationsDetail(verifyStay.violations),
        violations: exceptionReview.violations.map((violation) => ({
          policyId: violation.policyId,
          policyVersion: violation.policyVersion,
        })),
      },
      "Group join verification refused: minimum-stay policy no longer satisfied"
    );
    return {
      outcome: "minimum_stay",
      // The same generic sentence stage 1 answers with — see
      // PUBLIC_GROUP_JOIN_MINIMUM_STAY_MESSAGE. This used to be the detailed
      // formatter output, which contradicted the route's own comment and turned
      // the unauthenticated confirm into a policy-configuration read.
      //
      // Outcome and message ONLY: the frozen snapshot rode this result as far as
      // the route, which forwards these two fields — one `...result` spread from
      // being published on an unauthenticated surface. It stays in the log line
      // above instead, matching stage 1.
      message: PUBLIC_GROUP_JOIN_MINIMUM_STAY_MESSAGE,
    };
  }

  // All joiner guests are non-members; price them from the live season rates.
  const guests: PricedGuestInput[] = snapshotGuests.map((g) => ({
    firstName: g.firstName,
    lastName: g.lastName,
    ageTier: g.ageTier,
    isMember: false,
  }));

  const seasons = await prisma.season.findMany({
    where: {
      active: true,
      startDate: { lte: checkOut },
      endDate: { gte: checkIn },
      ...lodgeNullTolerantScope(groupLodgeId),
    },
    include: { membershipTypeRates: true },
  });
  const gds = await prisma.groupDiscountSetting.findUnique({ where: { id: "default" } });
  const price = await priceBookingGuestsWithMembershipTypePolicy(prisma, {
    checkIn,
    checkOut,
    guests: toGuestPricingInputs(guests),
    seasons: toSeasonRateData(seasons),
    groupDiscount: toGroupDiscountConfig(gds),
  });
  const priceCents = price.totalPriceCents;

  // Non-login member: store a random bcrypt hash so the row satisfies the
  // schema without any usable credential (mirrors approveBookingRequest).
  const placeholderPasswordHash = await hash(randomBytes(32).toString("hex"), 13);
  const reviewedAt = new Date();
  const holdDays = await getNonMemberHoldDays(checkIn, groupLodgeId);
  const nonMemberHoldUntil = resolveRequestBookingHoldUntil(
    checkIn,
    holdDays,
    reviewedAt
  );
  // The pay link stays valid to the end of the check-in day in the CLUB's
  // persisted zone; booking status gates actual payment. `clubZone` was
  // resolved once at the top of this path, outside the capacity-lock
  // transaction below — `payment-link-expiry.ts`.
  const paymentLinkExpiresAt = paymentLinkExpiryForCheckIn(checkIn, clubZone);
  const { token: payToken, tokenHash: payTokenHash } = issueActionToken();

  let capacityFullNights: string[] | null = null;
  let created: { bookingId: string; memberId: string };

  try {
    created = await prisma.$transaction(async (tx) => {
      // Per-lodge advisory lock serialises booking creation at this lodge.
      await acquireLodgeCapacityLock(tx, groupLodgeId);

      // Status-claim so a concurrent verify (or a double-submit) cannot create
      // two bookings from one token. Only the row that is still unconsumed wins.
      const claimed = await tx.groupBookingJoin.updateMany({
        where: { id: join.id, bookingId: null, verifiedAt: null },
        data: { verifiedAt: reviewedAt },
      });
      if (claimed.count === 0) {
        throw new Error(JOIN_ALREADY_CLAIMED);
      }

      const ranges = guests.map(() => ({ stayStart: checkIn, stayEnd: checkOut }));
      const capacity = await checkCapacityForGuestRanges(
        groupLodgeId,
        checkIn,
        checkOut,
        ranges,
        undefined,
        tx
      );
      if (!capacity.available) {
        capacityFullNights = getCapacityFullNights(capacity.nightDetails);
        throw new Error(CAPACITY_EXCEEDED);
      }

      // Mirror approveBookingRequest: a non-login member owns the booking.
      // emailVerified is true because this token proved control of the address.
      const member = await tx.member.create({
        data: {
          email: join.contactEmail!,
          passwordHash: placeholderPasswordHash,
          emailVerified: true,
          firstName: join.contactFirstName!,
          lastName: join.contactLastName!,
          role: "USER",
          ageTier: AgeTier.ADULT,
          active: true,
          canLogin: false,
          phoneNumber: join.contactPhone,
        },
        select: { id: true },
      });

      const booking = await tx.booking.create({
        data: {
          memberId: member.id,
          lodgeId: groupLodgeId,
          checkIn,
          checkOut,
          status: BookingStatus.PENDING,
          totalPriceCents: priceCents,
          finalPriceCents: priceCents,
          hasNonMembers: true,
          nonMemberHoldUntil,
          parentBookingId: organiserBookingId,
          guests: { create: buildGuestCreateData(guests, price, checkIn, checkOut) },
        },
        select: { id: true },
      });

      // #2364. A verified NON-MEMBER joiner booking is all non-member guests
      // owned by a fresh non-login contact, so nobody on it can host. It hangs
      // off the organiser's booking by `parentBookingId`, but it belongs to a
      // DIFFERENT member, so the organiser's adults are deliberately not
      // borrowed (see `loadSiblingHosts`): "an adult member on the same booking"
      // keeps meaning what it says, and under the REVIEW consequence the review is
      // how an admin decides whether the organiser's presence is good enough.
      //
      // #2569: under the ENFORCED consequence this throws instead, which rolls the
      // whole verified join back. Every non-member join at such a lodge is refused
      // — see the catch below for why that is the rule working rather than an edge
      // case, and for the generic sentence this unauthenticated path answers with.
      await reconcileAdultMemberHostingReviewWithSiblings(booking.id, tx);

      await tx.payment.create({
        data: {
          bookingId: booking.id,
          amountCents: priceCents,
          status: PaymentStatus.PENDING,
        },
      });

      await tx.paymentLink.create({
        data: {
          bookingId: booking.id,
          tokenHash: payTokenHash,
          expiresAt: paymentLinkExpiresAt,
        },
      });

      await tx.groupBookingJoin.update({
        where: { id: join.id },
        data: { bookingId: booking.id, joinerMemberId: member.id },
      });

      return { bookingId: booking.id, memberId: member.id };
    });
  } catch (err) {
    if (err instanceof Error && err.message === CAPACITY_EXCEEDED && capacityFullNights) {
      // The claim was rolled back with the rest of the transaction, so the
      // joiner can retry once capacity frees up.
      return { outcome: "capacity_full", fullNights: capacityFullNights };
    }
    if (err instanceof Error && err.message === JOIN_ALREADY_CLAIMED) {
      const latest = await prisma.groupBookingJoin.findUnique({
        where: { id: join.id },
        select: { bookingId: true },
      });
      if (latest?.bookingId) {
        return { outcome: "already_done", bookingId: latest.bookingId };
      }
      return { outcome: "invalid" };
    }
    // #2569 — the ENFORCED hosting refusal, raised by the reconciler above and
    // rolled back with the booking, the payment, the pay link and the roster
    // claim. Fails closed, and now says so: without this branch it reached the
    // verify route's generic handler as a 500 reading "Unable to confirm your join
    // right now", which is an outage message for a policy decision.
    //
    // A verified non-member join is the party this rule exists for — every guest
    // is a non-member and the owner is a fresh non-login contact, so nobody on the
    // booking can host — which means an ENFORCED lodge refuses ALL of them. That
    // is the club's rule doing what it says, not an edge case.
    //
    // The detailed sentence, the uncovered nights and the frozen violation live in
    // this log line and only here, matching the minimum-stay refusal above: the
    // route spreads fields out of this result onto an unauthenticated response.
    if (err instanceof AdultMemberHostingRequiredError) {
      logger.warn(
        {
          joinId: join.id,
          groupLodgeId,
          detail: err.violation.message,
          policyId: err.violation.policyId,
          policyVersion: err.violation.policyVersion,
          uncoveredNonMemberGuestNights:
            err.violation.requirements.uncoveredNonMemberGuestNights,
        },
        "Group join verification refused: non-member guest nights are not covered by an adult member (#2569)",
      );
      return {
        outcome: "adult_member_hosting",
        message: PUBLIC_GROUP_JOIN_ADULT_MEMBER_HOSTING_MESSAGE,
      };
    }
    throw err;
  }


  // #2576 §7. Every path that can ENQUEUE bounded re-evaluation work must also
  // drain it: a queue row with nobody draining it turns the owner's "immediate
  // re-evaluation" into "within three hours", which is how long an officer-created
  // booking that has just RESTORED cover would leave a critical incident standing,
  // or one that removed it would leave the owner un-notified. Best-effort and
  // scoped to this booking's owner; the cron sweep is the authority on completion.
  await settleHostingCoverageAfterCommit({ bookingId: created.bookingId });

  // Narrative event and pay-link email run after commit (a failed insert inside
  // the transaction would abort the booking creation).
  await recordBookingEvent({
    bookingId: created.bookingId,
    type: BookingEventType.CREATED,
    actorMemberId: created.memberId,
    amountCents: priceCents,
  });

  try {
    // Reuses the booking-request pay-link email (same /pay/[token] flow); a
    // group-specific template is a follow-up.
    await sendBookingRequestApprovedEmail({
      bookingContext: {
        bookingId: created.bookingId,
        recipientMemberId: created.memberId,
      },
      email: join.contactEmail,
      firstName: join.contactFirstName,
      lodgeId: groupLodgeId,
      token: payToken,
      checkIn,
      checkOut,
      guestCount: guests.length,
      priceCents,
      bookingReference: created.bookingId,
      expiresAt: paymentLinkExpiresAt,
    });
  } catch (err) {
    logger.error(
      { err, bookingId: created.bookingId },
      "Failed to send group join pay link email"
    );
  }

  return {
    outcome: "created",
    bookingId: created.bookingId,
    payToken,
    priceCents,
    checkIn,
    checkOut,
    guestCount: guests.length,
  };
}
