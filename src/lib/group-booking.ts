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
import { prisma } from "@/lib/prisma";
import { hashActionToken, issueActionToken } from "@/lib/action-tokens";
import {
  sendBookingRequestApprovedEmail,
  sendGroupBookingJoinVerificationEmail,
} from "@/lib/email";
import logger from "@/lib/logger";
import {
  buildGuestCreateData,
  createConfirmedBooking,
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
import { requiresPaidSubscriptionForBooking } from "@/lib/member-subscription-eligibility";
import { findUnpaidMemberGuests } from "@/lib/booking-member-guest-subscriptions";
import {
  calculateBookingHoldDecision,
  priceBookingGuests,
  toGroupDiscountConfig,
  toGuestPricingInputs,
  toSeasonRateData,
} from "@/lib/policies/booking-route-decisions";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import { getNonMemberHoldDays } from "@/lib/cancellation";
import { resolveRequestBookingHoldUntil } from "@/lib/booking-request";
import { endOfDateOnlyForTimeZone, formatDateOnly } from "@/lib/date-only";
import { recordBookingEvent } from "@/lib/booking-events";
import { getLodgeCapacity } from "@/lib/lodge-capacity";
import { getSeasonYear } from "@/lib/utils";
import { ACTIVE_BOOKING_STATUSES } from "@/lib/booking-status";

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

  constructor(
    message: string,
    status = 400,
    options?: { code?: string; details?: unknown }
  ) {
    super(message);
    this.name = "GroupBookingError";
    this.status = status;
    this.code = options?.code;
    this.details = options?.details;
  }
}

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

function isJoinCodeCollision(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") {
    return false;
  }
  const target = err.meta?.target;
  const targets = Array.isArray(target) ? target : [target];
  return targets.some((t) => typeof t === "string" && t.includes("joinCode"));
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
      if (isJoinCodeCollision(err) && attempt < CODE_GENERATION_ATTEMPTS) {
        continue;
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
  };
  organiserMember: { firstName: string };
}

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

/** Pure mapping from the selected record to the public-safe summary. */
export function toGroupBookingSummary(
  group: GroupBookingRecordForSummary,
  now: Date = new Date()
): GroupBookingSummary {
  return {
    code: group.joinCode,
    status: group.status,
    paymentMode: group.paymentMode,
    organiserFirstName: group.organiserMember.firstName,
    checkIn: group.organiserBooking.checkIn,
    checkOut: group.organiserBooking.checkOut,
    joinDeadline: group.joinDeadline,
    // A group is only joinable when BOTH the group itself is open/in-deadline
    // AND its host booking is still active; otherwise the public page would
    // invite joins the write paths will reject.
    isJoinable:
      isGroupJoinable(group, now) &&
      isOrganiserBookingActive(group.organiserBooking),
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
        select: { checkIn: true, checkOut: true, status: true, deletedAt: true },
      },
      organiserMember: { select: { firstName: true } },
    },
  });
  if (!group) {
    return null;
  }
  return toGroupBookingSummary(group);
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

  const lodgeCapacity = await getLodgeCapacity();
  if (guests.length > lodgeCapacity) {
    throw new GroupBookingError(
      `A booking cannot exceed ${lodgeCapacity} guests`,
      400
    );
  }

  // Same eligibility gates as POST /api/bookings (skipped for admins).
  if (sessionRole !== "ADMIN") {
    if (await requiresPaidSubscriptionForBooking(joiner.ageTier)) {
      const seasonYear = getSeasonYear(checkIn);
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
    if (unpaidMemberGuests.length > 0) {
      throw new GroupBookingError(
        `The following member guests have unpaid subscriptions: ${unpaidMemberGuests
          .map((m) => m.name)
          .join(", ")}.`,
        403,
        { code: "GUEST_SUBSCRIPTION_REQUIRED", details: unpaidMemberGuests }
      );
    }

    const { validateMinimumStay, formatViolationsDetail } = await import(
      "@/lib/booking-policies"
    );
    const stay = await validateMinimumStay(checkIn, checkOut);
    if (!stay.valid) {
      throw new GroupBookingError(
        "Booking does not meet the minimum stay requirement",
        400,
        {
          code: "MINIMUM_STAY_VIOLATION",
          details: formatViolationsDetail(stay.violations),
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

  const outcome = await createConfirmedBooking({
    effectiveMemberId: sessionUserId,
    isOnBehalf: false,
    sessionUserId,
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
    // ORGANISER_PAYS: flag the child booking so the joiner is never billed and
    // cannot pay it; the organiser settles the group total. No-op for each-pays.
    organiserSettled,
    // EACH_PAYS_OWN joiner can pay by card or Internet Banking; createConfirmedBooking
    // raises + emails the Xero invoice when internet_banking is chosen.
    paymentMethod: effectivePaymentMethod,
  });

  if (outcome.type === "capacityExceeded") {
    throw new GroupBookingError("The lodge is full for these dates", 409, {
      code: "CAPACITY_EXCEEDED",
      details: { fullNights: outcome.fullNights },
    });
  }

  const booking = outcome.booking;
  await prisma.groupBookingJoin.create({
    data: {
      groupBookingId: group.id,
      bookingId: booking.id,
      joinerMemberId: sessionUserId,
      isMember: true,
      verifiedAt: new Date(),
    },
  });

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
export const GROUP_JOIN_VERIFICATION_TTL_MS = 48 * 60 * 60 * 1000;

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
            select: { checkIn: true, checkOut: true, status: true, deletedAt: true },
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

  const lodgeCapacity = await getLodgeCapacity();
  if (input.guests.length > lodgeCapacity) {
    throw new GroupBookingError(
      `A booking cannot exceed ${lodgeCapacity} guests`,
      400
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
    .map((night) => night.date.toISOString().split("T")[0]);
}

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

  // All joiner guests are non-members; price them from the live season rates.
  const guests: PricedGuestInput[] = snapshotGuests.map((g) => ({
    firstName: g.firstName,
    lastName: g.lastName,
    ageTier: g.ageTier,
    isMember: false,
  }));

  const seasons = await prisma.season.findMany({
    where: { active: true, startDate: { lte: checkOut }, endDate: { gte: checkIn } },
    include: { rates: true },
  });
  const gds = await prisma.groupDiscountSetting.findUnique({ where: { id: "default" } });
  const price = priceBookingGuests({
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
  const holdDays = await getNonMemberHoldDays(checkIn);
  const nonMemberHoldUntil = resolveRequestBookingHoldUntil(
    checkIn,
    holdDays,
    reviewedAt
  );
  // The pay link stays valid to the end of the check-in day in NZT; booking
  // status gates actual payment.
  const paymentLinkExpiresAt = endOfDateOnlyForTimeZone(formatDateOnly(checkIn));
  const { token: payToken, tokenHash: payTokenHash } = issueActionToken();

  let capacityFullNights: string[] | null = null;
  let created: { bookingId: string; memberId: string };

  try {
    created = await prisma.$transaction(async (tx) => {
      // Shared advisory lock serialises every booking-creation path.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

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
          role: "MEMBER",
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
    throw err;
  }

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
      email: join.contactEmail,
      firstName: join.contactFirstName,
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
