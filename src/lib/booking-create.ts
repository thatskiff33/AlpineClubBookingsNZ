/**
 * Booking creation service.
 *
 * The POST /api/bookings route handler used to mix request parsing,
 * auth gates, capacity locking, pricing, promo/credit, persistence,
 * payment-flow decisions, audit, and Xero queueing in one file. This
 * service owns the business orchestration: it takes already-validated
 * inputs (member resolved, dates parsed, guests normalized), runs the
 * appropriate transaction, and returns either a created booking or a
 * structured outcome the route handler turns into an HTTP response.
 *
 * Conventions preserved:
 *   - money values stay integer cents
 *   - booking dates stay NZ date-only (Date with time set to 00:00)
 *   - external network calls (email, Xero) stay outside long DB
 *     transactions (fired-and-forget after commit)
 *   - booking creation transactions serialise per lodge via
 *     acquireLodgeCapacityLock so capacity checks stay safe without
 *     cross-lodge contention
 */
import {
  BookingEventType,
  BookingStatus,
  PaymentSource,
  PaymentStatus,
  type PrismaClient,
} from "@prisma/client";
import { assertMemberMayBookLodge } from "@/lib/lodge-access";
import {
  lodgeNullTolerantScope,
  resolveOptionalActiveLodgeId,
} from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import {
  calculateBookingCreditApplication,
  toGuestPricingInputs,
  toSeasonRateData,
} from "@/lib/policies/booking-route-decisions";
import { priceBookingGuestsWithMembershipTypePolicy } from "@/lib/membership-type-policy";
import { acquireLodgeCapacityLock, checkCapacityForGuestRanges } from "@/lib/capacity";
import {
  OverCapacityConfirmationRequiredError,
  overCapacityNights,
} from "@/lib/over-capacity-confirmation";
import { ApiError } from "@/lib/api-error";
import { addDaysDateOnly, getTodayDateOnly } from "@/lib/date-only";
import {
  redeemPromoCode,
  shouldPersistPromoRedemption,
  validateAndCalculatePromoDiscount,
  type PromoBeneficiaryAllocation,
} from "@/lib/promo";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import {
  sendAdminNewBookingAlert,
  sendBookingConfirmedEmail,
  sendBookingPendingEmail,
  sendWaitlistConfirmationEmail,
} from "@/lib/email";
import {
  enqueueXeroAppliedCreditAllocationOperation,
  enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import { applyCreditToBooking, getMemberCreditBalance } from "@/lib/member-credit";
import {
  buildInternetBankingPaymentReference,
  DEFAULT_BOOKING_PAYMENT_METHOD,
} from "@/lib/booking-payment-methods";
import { recordInternetBankingPaymentTransaction } from "@/lib/payment-transactions";
import { logAudit } from "@/lib/audit";
import { recordBookingEvent } from "@/lib/booking-events";
import logger from "@/lib/logger";
import { assertNoBookingMemberNightConflicts } from "@/lib/booking-member-night-conflicts";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { buildInternetBankingHoldUntil } from "@/lib/internet-banking-settings";
import {
  type BookingWithGuests,
  type BookingGuestInput,
  type DraftBookingInput,
  type ConfirmedBookingInput,
  type ConfirmedBookingOutcome,
  type WaitlistedBookingInput,
  type WaitlistedBookingResult,
  BookingPromoError,
  BookingReviewJustificationRequiredError,
  BookingLodgeError,
  RetroactiveCardPaymentError,
  GroupJoinConflictError,
  DuplicateStayConflictError,
  RETROACTIVE_BOOKING_MAX_LOOKBACK_DAYS,
} from "./booking-create-types";
import { DUPLICATE_STAY_BOOKING_STATUSES } from "./booking-status";
import {
  type ResolvedPromo,
  getPromoTargetBookingGuestIds,
  remapPromoIndexesToSubset,
  resolveEffectivePromoSource,
  resolvePromoInTransaction,
} from "./booking-create-promo";
import {
  buildGuestCreateData,
  getCapacityFullNights,
  getCapacityGuestRanges,
  resolveAdminReviewFields,
  resolveBookingDateEnvelope,
} from "./booking-create-guests";

// The helper types, errors, and pure functions that used to live here now live
// in three cohesive sibling modules (types <- promo, types <- guests). Re-export
// the public surface so `@/lib/booking-create` keeps its exact set of exports
// for existing callers.
export {
  BookingPromoError,
  BookingReviewJustificationRequiredError,
  BookingLodgeError,
  RetroactiveCardPaymentError,
  GroupJoinConflictError,
  DuplicateStayConflictError,
  RETROACTIVE_BOOKING_MAX_LOOKBACK_DAYS,
};
export type {
  BookingGuestInput,
  DraftBookingInput,
  ConfirmedBookingInput,
  ConfirmedBookingOutcome,
  WaitlistedBookingInput,
  WaitlistedBookingResult,
};
export { buildGuestCreateData };

type LodgeResolutionDb = Parameters<typeof resolveOptionalActiveLodgeId>[0] & {
  lodgeRoom: {
    findUnique: (args: {
      where: { id: string };
      select: { lodgeId: true };
    }) => Promise<{ lodgeId: string | null } | null>;
  };
};

/**
 * Resolve the lodge a new booking belongs to and enforce the lodge-scoping
 * contract: an explicit lodgeId must name an active lodge, and a requested
 * room must belong to that lodge (rooms without a lodgeId — expand-release
 * tolerance — pass). Throws BookingLodgeError; the routes turn it into 400.
 */
async function resolveBookingLodgeId(
  db: LodgeResolutionDb,
  requestedLodgeId: string | undefined,
  requestedRoomId: string | undefined,
): Promise<string> {
  const lodgeId = await resolveOptionalActiveLodgeId(db, requestedLodgeId);
  if (!lodgeId) {
    throw new BookingLodgeError("Unknown or inactive lodgeId");
  }
  if (requestedRoomId) {
    const room = await db.lodgeRoom.findUnique({
      where: { id: requestedRoomId },
      select: { lodgeId: true },
    });
    if (room?.lodgeId && room.lodgeId !== lodgeId) {
      throw new BookingLodgeError(
        "Requested room belongs to a different lodge",
      );
    }
  }
  return lodgeId;
}

/**
 * Validate the cross-lodge waitlist opt-in list (ADR-004): every alternate
 * must be an active lodge distinct from the primary, and the member must be
 * eligible to book it (same rule as the primary lodge; admin on-behalf
 * bypasses eligibility exactly as assertMemberMayBookLodge does). Throws
 * BookingLodgeError / LodgeBookingEligibilityError; routes map them to
 * 400 / 403. Exported for unit tests.
 */
export async function resolveWaitlistAlternateLodgeIds(
  db: Pick<PrismaClient, "lodge" | "memberLodgeAccess">,
  input: {
    requestedAlternateLodgeIds: string[] | undefined;
    primaryLodgeId: string;
    memberId: string;
    isOnBehalf: boolean;
  },
): Promise<string[]> {
  const distinct = Array.from(new Set(input.requestedAlternateLodgeIds ?? []))
    .filter((id) => id && id !== input.primaryLodgeId);
  if (distinct.length === 0) return [];

  const activeCount = await db.lodge.count({
    where: { id: { in: distinct }, active: true },
  });
  if (activeCount !== distinct.length) {
    throw new BookingLodgeError("Unknown or inactive alternate lodgeId");
  }
  for (const alternateLodgeId of distinct) {
    await assertMemberMayBookLodge(db, {
      memberId: input.memberId,
      lodgeId: alternateLodgeId,
      isOnBehalf: input.isOnBehalf,
    });
  }
  return distinct;
}

/**
 * Create a DRAFT booking. Skips capacity locking, payment, Xero, and
 * email side effects — drafts only persist the booking + pricing + an
 * audit entry. Throws BookingPromoError if the promo code fails
 * validation.
 */
export async function createDraftBooking(input: DraftBookingInput): Promise<BookingWithGuests> {
  const {
    effectiveMemberId,
    isOnBehalf,
    sessionUserId,
    checkIn: inputCheckIn,
    checkOut: inputCheckOut,
    guests,
    notes,
    promoCodeStr,
    promoGuestIndexes,
    workPartyEventId,
    expectedArrivalTime,
    requestedRoomId,
    cancelIfGuestsBumped,
    groupDiscount,
    memberReviewJustification,
    lodgeId,
  } = input;
  // Auto-expand (issue #713): the persisted range covers every guest night,
  // never shrinking below the member's stated range.
  const { checkIn, checkOut } = resolveBookingDateEnvelope(
    guests,
    inputCheckIn,
    inputCheckOut
  );

  const review = resolveAdminReviewFields({
    guests,
    isOnBehalf,
    sessionUserId,
    memberReviewJustification,
  });

  // Member-created drafts that trip the no-adult rule land directly in
  // AWAITING_REVIEW: they hold capacity while the admin is deciding and
  // bypass the 72-hour draft expiry (which would otherwise delete them
  // mid-review). Admin-created drafts (auto-approved) stay as DRAFT.
  const draftStatus = review.blockForReview ? BookingStatus.AWAITING_REVIEW : BookingStatus.DRAFT;

  const newBooking = await prisma.$transaction(async (tx) => {
    const bookingLodgeId = await resolveBookingLodgeId(
      tx,
      lodgeId,
      requestedRoomId,
    );
    await assertMemberMayBookLodge(tx, {
      memberId: effectiveMemberId,
      lodgeId: bookingLodgeId,
      isOnBehalf,
    });
    await acquireLodgeCapacityLock(tx, bookingLodgeId);
    // Duplicate member nights (upstream #80cbdf4c): a member cannot hold
    // two bookings covering the same night, regardless of lodge.
    await assertNoBookingMemberNightConflicts(tx, {
      actorMemberId: sessionUserId,
      actorRole: isOnBehalf ? "ADMIN" : "USER",
      checkIn,
      checkOut,
      guests,
    });
    const draftExpiresAt = review.blockForReview
      ? null
      : new Date(Date.now() + 72 * 60 * 60 * 1000);

    const seasons = await tx.season.findMany({
      where: {
        active: true,
        startDate: { lte: checkOut },
        endDate: { gte: checkIn },
        ...lodgeNullTolerantScope(bookingLodgeId),
      },
      include: { rates: true },
    });
    const seasonData = toSeasonRateData(seasons);
    const guestInputs = toGuestPricingInputs(guests);
    const price = await priceBookingGuestsWithMembershipTypePolicy(tx, {
      ownerMemberId: effectiveMemberId,
      checkIn,
      checkOut,
      guests: guestInputs,
      seasons: seasonData,
      groupDiscount,
    });

    let discountCents = 0;
    let promoAdjustmentCents = 0;
    let promoFreeNightsUsed = 0;
    let promoEligibleGuestCount = 0;
    let promoAllocations: PromoBeneficiaryAllocation[] = [];
    let promoSelectedGuestIndexes: number[] | undefined;
    let promoShouldPersist = false;
    let promoCodeRecord: ResolvedPromo["promoCodeRecord"] = null;
    const promoSource = await resolveEffectivePromoSource(tx, {
      promoCodeStr,
      workPartyEventId,
      checkIn,
      checkOut,
      lodgeId: bookingLodgeId,
    });
    if (promoSource) {
      const resolved = await resolvePromoInTransaction(tx, {
        promoCodeStr: promoSource.promoCodeStr,
        allowInternal: promoSource.allowInternal,
        effectiveMemberId,
        checkIn,
        guests,
        totalPriceCents: price.totalPriceCents,
        perNightCentsByGuest: price.guests.map((g) => g.perNightCents),
        nightDatesByGuest: price.guests.map((g) => g.nightDates),
        promoGuestIndexes,
        lodgeId: bookingLodgeId,
      });
      discountCents = resolved.discountCents;
      promoAdjustmentCents = resolved.promoAdjustmentCents;
      promoFreeNightsUsed = resolved.promoFreeNightsUsed;
      promoEligibleGuestCount = resolved.promoEligibleGuestCount;
      promoAllocations = resolved.promoAllocations;
      promoSelectedGuestIndexes = resolved.promoSelectedGuestIndexes;
      promoShouldPersist = resolved.promoShouldPersist;
      promoCodeRecord = resolved.promoCodeRecord;
    }

    const finalPriceCents = price.totalPriceCents + promoAdjustmentCents;
    const hasNonMembers = guests.some((g) => !g.isMember);

    const createdBooking = await tx.booking.create({
      data: {
        memberId: effectiveMemberId,
        lodgeId: bookingLodgeId,
        checkIn,
        checkOut,
        status: draftStatus,
        totalPriceCents: price.totalPriceCents,
        discountCents,
        promoAdjustmentCents,
        finalPriceCents,
        hasNonMembers,
        nonMemberHoldUntil: null,
        draftExpiresAt,
        notes: notes || null,
        expectedArrivalTime: expectedArrivalTime || null,
        requestedRoomId: requestedRoomId || null,
        cancelIfGuestsBumped: cancelIfGuestsBumped ?? false,
        createdById: isOnBehalf ? sessionUserId : null,
        requiresAdminReview: review.requiresAdminReview,
        adminReviewReason: review.adminReviewReason,
        memberReviewJustification: review.memberReviewJustification,
        adminReviewStatus: review.adminReviewStatus,
        adminReviewNotes: review.adminReviewNotes,
        adminReviewedById: review.adminReviewedById,
        adminReviewedAt: review.adminReviewedAt,
        guests: { create: buildGuestCreateData(guests, price, checkIn, checkOut) },
      },
      include: { guests: true },
    });

    if (promoCodeRecord && promoShouldPersist) {
      await redeemPromoCode(
        tx,
        promoCodeRecord.id,
        createdBooking.id,
        effectiveMemberId,
        discountCents,
        promoAdjustmentCents,
        promoFreeNightsUsed || undefined,
        promoEligibleGuestCount || undefined,
        promoAllocations,
        getPromoTargetBookingGuestIds(createdBooking.guests, promoSelectedGuestIndexes),
        bookingLodgeId,
      );
    }

    await reconcileBedAllocationsForBooking({
      bookingId: createdBooking.id,
      db: tx,
    });

    return createdBooking;
  });

  logAudit({
    action: "booking.created",
    memberId: sessionUserId,
    targetId: newBooking.id,
    subjectMemberId: effectiveMemberId,
    entityType: "Booking",
    entityId: newBooking.id,
    category: "booking",
    outcome: "success",
    summary: "Draft booking created",
    details: "Draft booking created",
    metadata: {
      status: newBooking.status,
      onBehalf: isOnBehalf,
      checkIn: checkIn.toISOString(),
      checkOut: checkOut.toISOString(),
      guestCount: guests.length,
      hasNonMembers: guests.some((guest) => !guest.isMember),
      finalPriceCents: newBooking.finalPriceCents,
    },
  });

  if (isOnBehalf) {
    logAudit({
      action: "booking.created_on_behalf",
      memberId: sessionUserId,
      targetId: newBooking.id,
      subjectMemberId: effectiveMemberId,
      entityType: "Booking",
      entityId: newBooking.id,
      category: "booking",
      outcome: "success",
      summary: "Draft booking created on behalf of member",
      details: `Admin created draft booking on behalf of member ${effectiveMemberId}`,
      metadata: {
        status: newBooking.status,
        checkIn: checkIn.toISOString(),
        checkOut: checkOut.toISOString(),
        guestCount: guests.length,
        hasNonMembers: guests.some((guest) => !guest.isMember),
      },
    });
  }

  await recordBookingEvent({
    bookingId: newBooking.id,
    type: BookingEventType.CREATED,
    actorMemberId: sessionUserId,
    amountCents: newBooking.finalPriceCents,
  });

  // Drafts that land directly in AWAITING_REVIEW skip the usual draft
  // flow — alert admins immediately so they can decide.
  if (review.blockForReview) {
    const draftMember = await prisma.member.findUnique({ where: { id: effectiveMemberId } });
    if (draftMember) {
      sendAdminNewBookingAlert({
        memberName: `${draftMember.firstName} ${draftMember.lastName}`,
        checkIn: newBooking.checkIn,
        checkOut: newBooking.checkOut,
        guestCount: newBooking.guests.length,
        totalCents: newBooking.finalPriceCents,
        status: newBooking.status,
        reviewReason: newBooking.adminReviewReason,
        memberJustification: newBooking.memberReviewJustification,
      }).catch((err) => logger.error({ err }, "Failed to send admin alert for awaiting-review draft"));
    }
  }

  return newBooking;
}

/**
 * Create a CONFIRMED/PENDING/PAYMENT_PENDING/PAID booking with capacity
 * locking, pricing, promo/credit, and post-commit side effects.
 *
 * Returns `{ type: "capacityExceeded", fullNights }` instead of throwing
 * when the request would oversell — the route handler turns that into
 * the 409 capacity-exceeded response and can offer the waitlist option.
 */
export async function createConfirmedBooking(input: ConfirmedBookingInput): Promise<ConfirmedBookingOutcome> {
  const {
    effectiveMemberId,
    isOnBehalf,
    sessionUserId,
    checkIn: inputCheckIn,
    checkOut: inputCheckOut,
    guests,
    notes,
    promoCodeStr,
    promoGuestIndexes,
    workPartyEventId,
    expectedArrivalTime,
    requestedRoomId,
    cancelIfGuestsBumped,
    applyCreditCents,
    groupDiscount,
    status,
    shouldBePending,
    holdDays,
    paymentMethod = DEFAULT_BOOKING_PAYMENT_METHOD,
    internetBankingSettings,
    memberReviewJustification,
    parentBookingId,
    organiserSettled,
    lodgeId,
    groupJoin,
    duplicateStayGuard,
  } = input;
  // Auto-expand (issue #713): cover every guest night (members + non-members)
  // so the member booking and any linked non-member child share one range.
  const { checkIn, checkOut } = resolveBookingDateEnvelope(
    guests,
    inputCheckIn,
    inputCheckOut
  );

  // Retroactive booking (#1695). Honoured only for on-behalf creates whose
  // resolved envelope actually starts in the past — a future-dated create
  // carrying the flag keeps standard behaviour (hard capacity block, normal
  // guards); when unset, every code path below stays byte-identical to the
  // member flow.
  const allowPastDates = Boolean(input.allowPastDates) && isOnBehalf;
  const todayDateOnly = getTodayDateOnly();
  const retroactiveOverride = allowPastDates && checkIn < todayDateOnly;
  // The member email is a per-create choice only for on-behalf bookings; a
  // member booking for themselves is always emailed.
  const notifyMember = !isOnBehalf || input.notifyMember !== false;

  // Defence in depth: the route already gates a past-dated on-behalf create,
  // but the service re-checks the RESOLVED envelope (guest nights can expand
  // it before the requested check-in, #713) so no caller can persist a past
  // stay without either the admin override or the internal inherited-stay
  // marker. `allowPastCheckIn` is set only by callers that join an existing,
  // already-validated stay envelope — group join (whole-stay unit, #1387) and
  // cross-lodge waitlist confirm, which legitimately reach a past check-in
  // once the parent stay is in progress — and is never exposed via the API.
  if (checkIn < todayDateOnly && !input.allowPastCheckIn) {
    if (!allowPastDates) {
      throw new ApiError("Cannot book in the past", 400);
    }
    if (
      checkIn < addDaysDateOnly(todayDateOnly, -RETROACTIVE_BOOKING_MAX_LOOKBACK_DAYS)
    ) {
      throw new ApiError(
        `Retroactive bookings can go back at most ${RETROACTIVE_BOOKING_MAX_LOOKBACK_DAYS} days.`,
        400,
      );
    }
  }

  const review = resolveAdminReviewFields({
    guests,
    isOnBehalf,
    sessionUserId,
    memberReviewJustification,
  });

  // Split-booking decision (#738). A mixed member/non-member party that is not
  // flagged becomes two linked bookings: the member portion is charged up front
  // and holds capacity (the parent), while the non-member portion is a
  // provisional PENDING child that holds nothing (resolved at the hold window
  // in R3). The flagged "only book if my guests can come" path stays a single
  // provisional PENDING booking holding nothing, nothing charged up front.
  // Pure parties stay a single booking. Bookings held for admin review are
  // never split — the whole party waits in AWAITING_REVIEW until an admin
  // decides.
  const memberGuests = guests.filter((g) => g.isMember);
  const nonMemberGuests = guests.filter((g) => !g.isMember);
  const hasMemberGuests = memberGuests.length > 0;
  const hasNonMemberGuests = nonMemberGuests.length > 0;
  const flaggedProvisional =
    shouldBePending &&
    (cancelIfGuestsBumped ?? false) &&
    hasNonMemberGuests &&
    !review.blockForReview;
  const splitBooking =
    hasMemberGuests &&
    hasNonMemberGuests &&
    shouldBePending &&
    !flaggedProvisional &&
    !review.blockForReview;
  const effectiveCancelIfGuestsBumped = flaggedProvisional;

  // The primary (returned) booking. For a split it carries only the member
  // guests; the non-member guests become the linked child created in the same
  // transaction. Promo selection indexes are remapped onto the member subset.
  const primaryGuests = splitBooking ? memberGuests : guests;
  const primaryHasNonMembers = primaryGuests.some((g) => !g.isMember);
  const primaryPromoGuestIndexes = splitBooking
    ? remapPromoIndexesToSubset(promoGuestIndexes, guests, primaryGuests)
    : promoGuestIndexes;

  // A member-created youth-only booking lands in AWAITING_REVIEW regardless
  // of the caller's requested status — payment is intentionally blocked
  // until an admin approves.
  const internetBankingPaymentSelected =
    paymentMethod === "internet_banking" && !review.blockForReview;
  const internetBankingHoldSlots =
    internetBankingPaymentSelected && internetBankingSettings?.holdBedSlots === true;
  const internetBankingHoldUntil = internetBankingHoldSlots
    ? buildInternetBankingHoldUntil(internetBankingSettings)
    : null;
  // Status of the primary booking. A split member booking is always charged up
  // front (a pure-member booking never holds as PENDING). The flagged path is
  // forced PENDING. Otherwise use the status the route computed for the party.
  const requestedStatus = flaggedProvisional
    ? BookingStatus.PENDING
    : splitBooking
      ? BookingStatus.PAYMENT_PENDING
      : internetBankingPaymentSelected
        ? internetBankingHoldSlots
          ? BookingStatus.CONFIRMED
          : BookingStatus.PAYMENT_PENDING
        : status;
  const creditApplicationStatus = internetBankingPaymentSelected
    ? BookingStatus.PAYMENT_PENDING
    : requestedStatus;
  const effectiveStatus = review.blockForReview
    ? BookingStatus.AWAITING_REVIEW
    : requestedStatus;
  // A split member booking holds capacity and is never a provisional hold; the
  // flagged path is always a provisional hold.
  const primaryShouldBePending = flaggedProvisional
    ? true
    : splitBooking
      ? false
      : shouldBePending;

  let isZeroDollarConfirmed = false;
  let capacityFullNights: string[] | null = null;
  // Set inside the transaction when a retroactive booking is created over
  // capacity with the admin's explicit confirmation (#1695); recorded in the
  // audit metadata after commit.
  let capacityOverridden = false;
  // Captured inside the transaction so the split child's CREATED event can be
  // written once, after commit (issue #740).
  let splitChild: { id: string; finalPriceCents: number } | null = null;

  let booking: BookingWithGuests;
  try {
    booking = await prisma.$transaction(async (tx) => {
      const bookingLodgeId = await resolveBookingLodgeId(
        tx,
        lodgeId,
        requestedRoomId,
      );
      await assertMemberMayBookLodge(tx, {
        memberId: effectiveMemberId,
        lodgeId: bookingLodgeId,
        isOnBehalf,
      });
      await acquireLodgeCapacityLock(tx, bookingLodgeId);

      // Cross-lodge duplicate-stay guard, in-transaction layer (#1587 item 2).
      // Only the cross-lodge waitlist confirm sets duplicateStayGuard; every
      // other caller leaves it undefined and this block is skipped. The offered
      // lodge's capacity lock is held (acquired above), so re-running the same
      // duplicate-stay query the confirm ran in its pre-flight phase closes the
      // window where two fully-concurrent confirms of one offer both pass the
      // earlier, separately-committed guard: the second transaction serialises
      // behind the first's commit, sees its committed booking here, and rolls
      // back rather than creating a duplicate stay. Member, lodge, and dates
      // come from this booking's own resolved values so the guard cannot
      // disagree with the row about to be written; the confirm's own entry is
      // excluded by id.
      //
      // Runs BEFORE the member-night guard on purpose: when a real concurrent
      // stay exists, the friendlier DUPLICATE_STAY rejection should win over a
      // generic member-night error. The member-night guard below excludes the
      // same replaced entry (#1628/#1609), so the offer's own WAITLIST_OFFERED
      // booking trips neither check. This guard is a strict no-op for a normal
      // confirm and every non-cross-lodge caller: the only overlapping booking
      // in those cases is the WAITLIST_OFFERED entry, and WAITLIST_OFFERED is
      // not in DUPLICATE_STAY_BOOKING_STATUSES (ACTIVE + COMPLETED), so the
      // query matches nothing and nothing throws until a real concurrent stay
      // exists.
      if (duplicateStayGuard) {
        const duplicateStay = await tx.booking.findFirst({
          where: {
            memberId: effectiveMemberId,
            lodgeId: bookingLodgeId,
            id: { not: duplicateStayGuard.excludeBookingId },
            deletedAt: null,
            status: { in: [...DUPLICATE_STAY_BOOKING_STATUSES] },
            // Date-only overlap, matching the pre-flight guard's predicate.
            checkIn: { lt: checkOut },
            checkOut: { gt: checkIn },
          },
          select: { id: true },
        });
        if (duplicateStay) {
          throw new DuplicateStayConflictError();
        }
      }

      // Duplicate member nights (upstream #80cbdf4c). The cross-lodge confirm
      // replaces a still-live WAITLIST_OFFERED entry whose guest rows can carry
      // the confirming member's own memberId; without an exclusion the guard
      // trips on the very booking this create is replacing and every
      // member-guest confirm fails (#1628/#1609). The replaced entry is the
      // same booking the duplicate-stay guard excludes, so its id is reused
      // here; undefined for every other caller — their behaviour is unchanged.
      await assertNoBookingMemberNightConflicts(tx, {
        actorMemberId: sessionUserId,
        actorRole: isOnBehalf ? "ADMIN" : "USER",
        checkIn,
        checkOut,
        guests,
        excludeBookingId: duplicateStayGuard?.excludeBookingId,
      });

      const capacityGuestRanges = getCapacityGuestRanges(primaryGuests, checkIn, checkOut);
      const capacityCheck = await checkCapacityForGuestRanges(
        bookingLodgeId,
        checkIn,
        checkOut,
        capacityGuestRanges,
        undefined,
        tx
      );

      const seasons = await tx.season.findMany({
        where: {
          active: true,
          startDate: { lte: checkOut },
          endDate: { gte: checkIn },
          ...lodgeNullTolerantScope(bookingLodgeId),
        },
        include: { rates: true },
      });
      const seasonData = toSeasonRateData(seasons);
      const guestInputs = toGuestPricingInputs(primaryGuests);
      const price = await priceBookingGuestsWithMembershipTypePolicy(tx, {
        ownerMemberId: effectiveMemberId,
        checkIn,
        checkOut,
        guests: guestInputs,
        seasons: seasonData,
        groupDiscount,
      });

      let discountCents = 0;
      let promoAdjustmentCents = 0;
      let promoFreeNightsUsed = 0;
      let promoEligibleGuestCount = 0;
      let promoAllocations: PromoBeneficiaryAllocation[] = [];
      let promoSelectedGuestIndexes: number[] | undefined;
      let promoShouldPersist = false;
      let promoCodeRecord: ResolvedPromo["promoCodeRecord"] = null;
      const promoSource = await resolveEffectivePromoSource(tx, {
        promoCodeStr,
        workPartyEventId,
        checkIn,
        checkOut,
        lodgeId: bookingLodgeId,
      });
      if (promoSource) {
        const resolved = await resolvePromoInTransaction(tx, {
          promoCodeStr: promoSource.promoCodeStr,
          allowInternal: promoSource.allowInternal,
          effectiveMemberId,
          checkIn,
          guests: primaryGuests,
          totalPriceCents: price.totalPriceCents,
          perNightCentsByGuest: price.guests.map((g) => g.perNightCents),
          nightDatesByGuest: price.guests.map((g) => g.nightDates),
          promoGuestIndexes: primaryPromoGuestIndexes,
          lodgeId: bookingLodgeId,
        });
        discountCents = resolved.discountCents;
        promoAdjustmentCents = resolved.promoAdjustmentCents;
        promoFreeNightsUsed = resolved.promoFreeNightsUsed;
        promoEligibleGuestCount = resolved.promoEligibleGuestCount;
        promoAllocations = resolved.promoAllocations;
        promoSelectedGuestIndexes = resolved.promoSelectedGuestIndexes;
        promoShouldPersist = resolved.promoShouldPersist;
        promoCodeRecord = resolved.promoCodeRecord;
      }

      const finalPriceCents = price.totalPriceCents + promoAdjustmentCents;
      // Credit is only applied at payment time. For a booking heading to
      // AWAITING_REVIEW, defer credit application until the admin approves
      // and the member completes payment.
      const creditBalance =
        (applyCreditCents ?? 0) > 0 &&
        creditApplicationStatus === BookingStatus.PAYMENT_PENDING &&
        !review.blockForReview
          ? await getMemberCreditBalance(effectiveMemberId, tx)
          : 0;
      const { creditAppliedCents, effectivePriceCents } = calculateBookingCreditApplication({
        requestedCreditCents: review.blockForReview ? 0 : (applyCreditCents ?? 0),
        creditBalanceCents: creditBalance,
        finalPriceCents,
        status: creditApplicationStatus,
      });

      // Retroactive card path (#1709). A finished stay has no future arrival to
      // gate a card hold on, so a card PAYMENT_PENDING obligation for it has
      // nothing to release it and could linger forever. Option A (#1709): a
      // retroactive create must settle via internet banking, account credit, or
      // a $0/comp booking — never the card path. A fully-covered booking
      // (effectivePriceCents === 0, whether genuinely $0 or fully credit-covered)
      // is allowed: it settles immediately to PAID via the zero-dollar path
      // below and never opens a card obligation. Runs before the capacity check
      // so the payment-path rejection wins over a secondary over-capacity prompt.
      //
      // Deliberately NOT conditioned on `review.blockForReview`: today
      // retroactiveOverride ⇒ isOnBehalf ⇒ !blockForReview, but if review
      // semantics ever widen to on-behalf creates, a blocked-for-review
      // retroactive card create must still be rejected here rather than parking
      // in AWAITING_REVIEW and being released straight to card PAYMENT_PENDING by
      // the approve route with no re-check.
      if (
        retroactiveOverride &&
        !internetBankingPaymentSelected &&
        effectivePriceCents > 0
      ) {
        throw new RetroactiveCardPaymentError();
      }

      // AWAITING_REVIEW holds capacity, so capacity must be verified even
      // when the booking would otherwise have skipped the check (zero-dollar
      // member-paid path).
      if (
        !capacityCheck.available &&
        (requestedStatus === BookingStatus.PENDING || effectivePriceCents > 0 || review.blockForReview)
      ) {
        if (retroactiveOverride) {
          // Retroactive over-capacity is warn-and-confirm (#1695): the lodge
          // capacity lock is still held, only the availability decision defers
          // to the admin's explicit confirmation.
          if (input.confirmOverCapacity !== true) {
            throw new OverCapacityConfirmationRequiredError(
              overCapacityNights(capacityCheck),
            );
          }
          capacityOverridden = true;
        } else {
          capacityFullNights = getCapacityFullNights(capacityCheck.nightDetails);
          throw new Error("CAPACITY_EXCEEDED_SENTINEL");
        }
      }

      const nonMemberHoldUntil = primaryShouldBePending && !internetBankingPaymentSelected
        ? new Date(checkIn.getTime() - holdDays * 24 * 60 * 60 * 1000)
        : null;

      const newBooking = await tx.booking.create({
        data: {
          memberId: effectiveMemberId,
          lodgeId: bookingLodgeId,
          checkIn,
          checkOut,
          status: effectiveStatus,
          totalPriceCents: price.totalPriceCents,
          discountCents,
          promoAdjustmentCents,
          finalPriceCents,
          hasNonMembers: primaryHasNonMembers,
          nonMemberHoldUntil,
          // Group join: link this joiner's booking to the organiser's booking.
          // Included only when supplied (the group-join path forbids mixed
          // guests). A normal or split party omits the key entirely so the
          // column defaults to null, matching the create-payload assertions in
          // booking-split.test.ts.
          ...(parentBookingId != null ? { parentBookingId } : {}),
          // ORGANISER_PAYS joins flag the booking so the joiner is never billed
          // and the organiser settles it. Omitted entirely otherwise so the
          // column defaults to false and the create-payload assertions in
          // booking-split.test.ts stay unchanged.
          ...(organiserSettled ? { organiserSettled: true } : {}),
          notes: notes || null,
          expectedArrivalTime: expectedArrivalTime || null,
          requestedRoomId: requestedRoomId || null,
          cancelIfGuestsBumped: effectiveCancelIfGuestsBumped,
          createdById: isOnBehalf ? sessionUserId : null,
          requiresAdminReview: review.requiresAdminReview,
          adminReviewReason: review.adminReviewReason,
          memberReviewJustification: review.memberReviewJustification,
          adminReviewStatus: review.adminReviewStatus,
          adminReviewNotes: review.adminReviewNotes,
          adminReviewedById: review.adminReviewedById,
          adminReviewedAt: review.adminReviewedAt,
          guests: { create: buildGuestCreateData(primaryGuests, price, checkIn, checkOut) },
        },
        include: { guests: true },
      });

      if (promoCodeRecord && promoShouldPersist) {
        await redeemPromoCode(
          tx,
          promoCodeRecord.id,
          newBooking.id,
          effectiveMemberId,
          discountCents,
          promoAdjustmentCents,
          promoFreeNightsUsed || undefined,
          promoEligibleGuestCount || undefined,
          promoAllocations,
          getPromoTargetBookingGuestIds(newBooking.guests, promoSelectedGuestIndexes),
          bookingLodgeId,
        );
      }

      if (creditAppliedCents > 0) {
        await applyCreditToBooking(effectiveMemberId, creditAppliedCents, newBooking.id, tx);
      }

      // Zero-dollar (or fully credit-covered) PAYMENT_PENDING booking:
      // final-claim capacity, create $0 SUCCEEDED Payment, set PAID.
      // Skipped when the booking is held in AWAITING_REVIEW — payment
      // (including the zero-dollar auto-PAID path) must wait for admin.
      if (
        effectivePriceCents === 0 &&
        creditApplicationStatus === BookingStatus.PAYMENT_PENDING &&
        !review.blockForReview
      ) {
        const finalCapacityCheck = await checkCapacityForGuestRanges(
          bookingLodgeId,
          checkIn,
          checkOut,
          capacityGuestRanges,
          newBooking.id,
          tx
        );
        if (!finalCapacityCheck.available) {
          if (retroactiveOverride) {
            // Retroactive $0 booking over capacity: warn-and-confirm (#1695).
            if (input.confirmOverCapacity !== true) {
              throw new OverCapacityConfirmationRequiredError(
                overCapacityNights(finalCapacityCheck),
              );
            }
            capacityOverridden = true;
          } else {
            // Since #737/#738 a PENDING booking holds no capacity, so there is
            // no synchronous bump to fall back on: a $0 all-member booking that
            // does not fit against committed bookings is rejected with the
            // capacity-exceeded response, never bumped into a full lodge
            // (issue #738, carried over from R1).
            capacityFullNights = getCapacityFullNights(finalCapacityCheck.nightDetails);
            throw new Error("CAPACITY_EXCEEDED_SENTINEL");
          }
        }

        isZeroDollarConfirmed = true;
        await tx.payment.create({
          data: {
            bookingId: newBooking.id,
            amountCents: 0,
            creditAppliedCents,
            status: PaymentStatus.SUCCEEDED,
          },
        });
        await tx.booking.update({
          where: { id: newBooking.id },
          data: { status: BookingStatus.PAID },
        });
        newBooking.status = BookingStatus.PAID;
      } else if (
        internetBankingPaymentSelected &&
        effectivePriceCents > 0
      ) {
        const reference = buildInternetBankingPaymentReference(newBooking.id);
        const payment = await tx.payment.create({
          data: {
            bookingId: newBooking.id,
            amountCents: effectivePriceCents,
            creditAppliedCents,
            source: PaymentSource.INTERNET_BANKING,
            reference,
            status: PaymentStatus.PENDING,
            internetBankingHoldSlots,
            internetBankingHoldUntil,
            internetBankingHoldReleasedAt: null,
          },
        });

        await recordInternetBankingPaymentTransaction({
          paymentId: payment.id,
          amountCents: effectivePriceCents,
          status: PaymentStatus.PENDING,
          reference,
          reason: "internet_banking_booking_payment",
          store: tx,
        });
      }

      await reconcileBedAllocationsForBooking({
        bookingId: newBooking.id,
        db: tx,
      });

      // Split booking (#738): create the linked provisional non-member booking
      // in the same transaction. It is PENDING and holds no capacity (it does
      // not run the capacity check or take payment in R2 — confirmed/charged or
      // bumped at the hold window in R3). It carries no promo/credit; those stay
      // with the member booking that is charged up front.
      if (splitBooking) {
        const childGuestInputs = toGuestPricingInputs(nonMemberGuests);
        const childPrice = await priceBookingGuestsWithMembershipTypePolicy(tx, {
          checkIn,
          checkOut,
          guests: childGuestInputs,
          seasons: seasonData,
          groupDiscount,
        });
        const childHoldUntil = new Date(
          checkIn.getTime() - holdDays * 24 * 60 * 60 * 1000
        );
        const childBooking = await tx.booking.create({
          data: {
            memberId: effectiveMemberId,
            // The child of a split booking always stays at the same lodge as
            // its parent (one booking = one lodge, ADR-001).
            lodgeId: newBooking.lodgeId,
            checkIn,
            checkOut,
            status: BookingStatus.PENDING,
            totalPriceCents: childPrice.totalPriceCents,
            discountCents: 0,
            promoAdjustmentCents: 0,
            finalPriceCents: childPrice.totalPriceCents,
            hasNonMembers: true,
            nonMemberHoldUntil: childHoldUntil,
            parentBookingId: newBooking.id,
            notes: notes || null,
            expectedArrivalTime: expectedArrivalTime || null,
            requestedRoomId: requestedRoomId || null,
            cancelIfGuestsBumped: false,
            createdById: isOnBehalf ? sessionUserId : null,
            guests: {
              create: buildGuestCreateData(
                nonMemberGuests,
                childPrice,
                checkIn,
                checkOut
              ),
            },
          },
          include: { guests: true },
        });
        await reconcileBedAllocationsForBooking({
          bookingId: childBooking.id,
          db: tx,
        });
        splitChild = {
          id: childBooking.id,
          finalPriceCents: childBooking.finalPriceCents,
        };
      }

      if (groupJoin) {
        // Roster write is atomic with the child booking (#1039 item 2). The
        // advisory lock above serialises booking creation, so this
        // check-then-write cannot race; the (groupBookingId, joinerMemberId)
        // unique pair backs it at the database as well.
        const existingJoin = await tx.groupBookingJoin.findUnique({
          where: {
            groupBookingId_joinerMemberId: {
              groupBookingId: groupJoin.groupBookingId,
              joinerMemberId: groupJoin.joinerMemberId,
            },
          },
          include: {
            booking: { select: { status: true, deletedAt: true } },
          },
        });
        const existingJoinIsLive =
          existingJoin?.booking &&
          !existingJoin.booking.deletedAt &&
          existingJoin.booking.status !== BookingStatus.CANCELLED &&
          existingJoin.booking.status !== BookingStatus.BUMPED;
        if (existingJoinIsLive) {
          throw new GroupJoinConflictError();
        }
        if (existingJoin) {
          await tx.groupBookingJoin.update({
            where: { id: existingJoin.id },
            data: {
              bookingId: newBooking.id,
              isMember: true,
              verifiedAt: new Date(),
            },
          });
        } else {
          await tx.groupBookingJoin.create({
            data: {
              groupBookingId: groupJoin.groupBookingId,
              bookingId: newBooking.id,
              joinerMemberId: groupJoin.joinerMemberId,
              isMember: true,
              verifiedAt: new Date(),
            },
          });
        }
      }

      return newBooking;
    });
  } catch (err) {
    if (err instanceof Error && err.message === "CAPACITY_EXCEEDED_SENTINEL" && capacityFullNights) {
      return { type: "capacityExceeded", fullNights: capacityFullNights };
    }
    throw err;
  }

  logAudit({
    action: "booking.created",
    memberId: sessionUserId,
    targetId: booking.id,
    subjectMemberId: effectiveMemberId,
    entityType: "Booking",
    entityId: booking.id,
    category: "booking",
    outcome: "success",
    summary: "Booking created",
    details: `Booking created with status ${booking.status}`,
    metadata: {
      status: booking.status,
      onBehalf: isOnBehalf,
      checkIn: checkIn.toISOString(),
      checkOut: checkOut.toISOString(),
      guestCount: primaryGuests.length,
      hasNonMembers: primaryHasNonMembers,
      finalPriceCents: booking.finalPriceCents,
      zeroDollarConfirmed: isZeroDollarConfirmed,
      paymentMethod,
      split: splitBooking,
      // Retroactive-create audit fields (#1695), only when the override is
      // active — a normal create records nothing new.
      ...(retroactiveOverride
        ? {
            allowPastDates: true,
            confirmOverCapacity: input.confirmOverCapacity === true,
            capacityOverridden,
          }
        : {}),
    },
  });

  if (isOnBehalf) {
    logAudit({
      action: "booking.created_on_behalf",
      memberId: sessionUserId,
      targetId: booking.id,
      subjectMemberId: effectiveMemberId,
      entityType: "Booking",
      entityId: booking.id,
      category: "booking",
      outcome: "success",
      summary: "Booking created on behalf of member",
      details: `Admin created booking on behalf of member ${effectiveMemberId}`,
      metadata: {
        status: booking.status,
        checkIn: checkIn.toISOString(),
        checkOut: checkOut.toISOString(),
        guestCount: primaryGuests.length,
        hasNonMembers: primaryHasNonMembers,
        finalPriceCents: booking.finalPriceCents,
        paymentMethod,
        split: splitBooking,
        // The admin's email choice is recorded on every on-behalf create.
        notifyMember,
        ...(retroactiveOverride
          ? {
              allowPastDates: true,
              confirmOverCapacity: input.confirmOverCapacity === true,
              capacityOverridden,
            }
          : {}),
      },
    });
  }

  // Durable lifecycle events (issue #740): the booking was created, and the
  // split non-member child (if any) was created in the same transaction.
  await recordBookingEvent({
    bookingId: booking.id,
    type: BookingEventType.CREATED,
    actorMemberId: sessionUserId,
    amountCents: booking.finalPriceCents,
  });
  // `splitChild` is only assigned inside the transaction closure, which TS
  // control-flow narrows away in this outer scope; cast back to its type.
  const createdSplitChild = splitChild as
    | { id: string; finalPriceCents: number }
    | null;
  if (createdSplitChild) {
    await recordBookingEvent({
      bookingId: createdSplitChild.id,
      type: BookingEventType.CREATED,
      actorMemberId: sessionUserId,
      amountCents: createdSplitChild.finalPriceCents,
    });
  }
  // A fully credit-covered or genuinely free booking is paid up front at $0.
  if (isZeroDollarConfirmed) {
    await recordBookingEvent({
      bookingId: booking.id,
      type: BookingEventType.MEMBER_PAID,
      actorMemberId: sessionUserId,
      amountCents: 0,
    });
  }

  if (isZeroDollarConfirmed) {
    try {
      const fullBooking = await prisma.booking.findUnique({
        where: { id: booking.id },
        include: {
          member: true,
          guests: true,
          promoRedemption: {
            include: {
              promoCode: { include: { workPartyEvent: { select: { name: true } } } },
            },
          },
        },
      });
      if (fullBooking) {
        // The member confirmation email is suppressed when an admin on-behalf
        // create opts out (#1695); the Xero invoice below is still queued.
        if (notifyMember) {
          sendBookingConfirmedEmail(
            fullBooking.member.email,
            fullBooking.member.firstName,
            fullBooking.checkIn,
            fullBooking.checkOut,
            fullBooking.guests.length,
            fullBooking.finalPriceCents,
            {
              lodgeId: fullBooking.lodgeId,
              ...(fullBooking.promoRedemption?.promoCode
                ? {
                    discountCents: fullBooking.discountCents,
                    promoAdjustmentCents: fullBooking.promoAdjustmentCents,
                    // Internal work-party promo codes are meaningless to
                    // members; label the discount with the event name instead.
                    promoCode:
                      fullBooking.promoRedemption.promoCode.workPartyEvent?.name ??
                      fullBooking.promoRedemption.promoCode.code,
                  }
                : {}),
            },
          ).catch((err) => logger.error({ err, bookingId: booking.id }, "Failed to send confirmation email for $0 booking"));
        }

        const effectiveModules = await loadEffectiveModuleFlags();
        if (effectiveModules.xeroIntegration) {
          void enqueueXeroBookingInvoiceOperation(booking.id, { createdByMemberId: sessionUserId })
            .then(async (queuedInvoice) => {
              if (!queuedInvoice.queueOperationId) return;
              await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
            })
            .catch((err) =>
              logger.error({ err, bookingId: booking.id }, "Failed to queue Xero invoice for $0 booking"),
            );
        }
      }
    } catch (err) {
      logger.error({ err, bookingId: booking.id }, "Error in post-creation handling for $0 booking");
    }
  }

  if (
    paymentMethod === "internet_banking" &&
    booking.status === BookingStatus.PAYMENT_PENDING &&
    !isZeroDollarConfirmed
  ) {
    try {
      const queuedInvoice = await enqueueXeroBookingInvoiceOperation(booking.id, {
        createdByMemberId: sessionUserId,
      });
      // #1620 — allocate the member's existing floating credit notes against this
      // invoice so they pay the effective (credit-reduced) amount. Enqueued after
      // the invoice op (older createdAt → processed first). Skips itself when no
      // credit was applied.
      const queuedAllocation = await enqueueXeroAppliedCreditAllocationOperation(
        booking.id,
        { createdByMemberId: sessionUserId },
      );
      if (queuedInvoice.queueOperationId || queuedAllocation.queueOperationId) {
        await kickQueuedXeroOutboxOperationsIfConnected({ limit: 2 });
      }
    } catch (err) {
      logger.error(
        { err, bookingId: booking.id },
        "Failed to queue Xero invoice for Internet Banking booking"
      );
    }
  }

  if (booking.status === BookingStatus.PENDING && booking.nonMemberHoldUntil) {
    const member = await prisma.member.findUnique({ where: { id: effectiveMemberId } });
    // Suppressed when an admin on-behalf create opts out of member email (#1695).
    if (member && notifyMember) {
      sendBookingPendingEmail(
        member.email,
        member.firstName,
        booking.checkIn,
        booking.checkOut,
        booking.guests.length,
        booking.nonMemberHoldUntil,
        booking.lodgeId,
      ).catch((err) => logger.error({ err }, "Failed to send pending booking email"));
    }
  }

  const bookingMember = await prisma.member.findUnique({ where: { id: effectiveMemberId } });
  if (bookingMember) {
    sendAdminNewBookingAlert({
      memberName: `${bookingMember.firstName} ${bookingMember.lastName}`,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      guestCount: booking.guests.length,
      totalCents: booking.finalPriceCents,
      status: booking.status,
      reviewReason: booking.adminReviewReason,
      memberJustification: booking.memberReviewJustification,
    }).catch((err) => logger.error({ err }, "Failed to send admin new booking alert"));
  }

  return { type: "created", booking, bumpedBookingIds: [], isZeroDollarConfirmed };
}

/**
 * Create a WAITLISTED booking when capacity is full and the user has
 * opted in. Pricing is locked in at waitlist time. Position is set
 * inside the transaction so it remains stable until the booking is
 * promoted off the waitlist.
 */
export async function createWaitlistedBooking(input: WaitlistedBookingInput): Promise<WaitlistedBookingResult> {
  const {
    effectiveMemberId,
    isOnBehalf,
    sessionUserId,
    checkIn: inputCheckIn,
    checkOut: inputCheckOut,
    guests,
    notes,
    promoCodeStr,
    promoGuestIndexes,
    workPartyEventId,
    expectedArrivalTime,
    requestedRoomId,
    cancelIfGuestsBumped,
    groupDiscount,
    memberReviewJustification,
    lodgeId,
  } = input;
  // Auto-expand (issue #713): the persisted range covers every guest night,
  // never shrinking below the member's stated range.
  const { checkIn, checkOut } = resolveBookingDateEnvelope(
    guests,
    inputCheckIn,
    inputCheckOut
  );

  // Throws BookingReviewJustificationRequiredError if the rule trips on a
  // member-created booking with no justification supplied. WAITLISTED is
  // kept as the persisted status (waitlist doesn't hold capacity), but
  // adminReviewStatus = PENDING so the review queue and force-confirm path
  // know it needs a decision before it can progress.
  const review = resolveAdminReviewFields({
    guests,
    isOnBehalf,
    sessionUserId,
    memberReviewJustification,
  });

  const waitlistLodgeId = await resolveBookingLodgeId(
    prisma,
    lodgeId,
    requestedRoomId,
  );
  await assertMemberMayBookLodge(prisma, {
    memberId: effectiveMemberId,
    lodgeId: waitlistLodgeId,
    isOnBehalf,
  });
  const alternateLodgeIds = await resolveWaitlistAlternateLodgeIds(prisma, {
    requestedAlternateLodgeIds: input.alternateLodgeIds,
    primaryLodgeId: waitlistLodgeId,
    memberId: effectiveMemberId,
    isOnBehalf,
  });
  const seasons = await prisma.season.findMany({
    where: {
      active: true,
      startDate: { lte: checkOut },
      endDate: { gte: checkIn },
      ...lodgeNullTolerantScope(waitlistLodgeId),
    },
    include: { rates: true },
  });
  const seasonData = toSeasonRateData(seasons);
  const guestInputs = toGuestPricingInputs(guests);
  const price = await priceBookingGuestsWithMembershipTypePolicy(prisma, {
    ownerMemberId: effectiveMemberId,
    checkIn,
    checkOut,
    guests: guestInputs,
    seasons: seasonData,
    groupDiscount,
  });

  let discountCents = 0;
  let promoAdjustmentCents = 0;
  let promoFreeNightsUsed = 0;
  let promoEligibleGuestCount = 0;
  let promoAllocations: PromoBeneficiaryAllocation[] = [];
  let promoSelectedGuestIndexes: number[] | undefined;
  let promoShouldPersist = false;
  let promoCodeRecord: ResolvedPromo["promoCodeRecord"] = null;

  const promoSource = await resolveEffectivePromoSource(prisma, {
    promoCodeStr,
    workPartyEventId,
    checkIn,
    checkOut,
    lodgeId: waitlistLodgeId,
  });
  if (promoSource) {
    const normalizedCode = promoSource.promoCodeStr.toUpperCase().trim();
    const promoCode = await prisma.promoCode.findUnique({
      where: { code: normalizedCode },
      include: {
        assignments: { select: { memberId: true } },
        lodges: { select: { lodgeId: true } },
      },
    });
    if (promoCode?.internal && !promoSource.allowInternal) {
      throw new BookingPromoError("Promo code not found");
    }
    const assignedMemberIds = promoCode?.assignments?.length
      ? promoCode.assignments.map((a) => a.memberId)
      : null;
    const guestNightRates = guests.map((guest, index) => ({
      memberId: guest.memberId ?? null,
      isMember: guest.isMember,
      perNightRates: price.guests[index].perNightCents,
      firstNight: guest.stayStart ?? checkIn,
      nightDates: price.guests[index].nightDates,
    }));
    const application = await validateAndCalculatePromoDiscount(
      promoCode,
      {
        memberId: effectiveMemberId,
        bookingCheckIn: checkIn,
        totalPriceCents: price.totalPriceCents,
        guests: guestNightRates,
      },
      assignedMemberIds,
      { db: prisma, selectedGuestIndexes: promoGuestIndexes, lodgeId: waitlistLodgeId }
    );
    if (application.error || !application.discount) {
      throw new BookingPromoError(application.error ?? "Promo code could not be applied");
    }
    const promoResult = application.discount;
    discountCents = promoResult.discountCents;
    promoAdjustmentCents = promoResult.priceAdjustmentCents;
    promoFreeNightsUsed = promoResult.freeNightsUsed;
    promoEligibleGuestCount = promoResult.eligibleGuestCount;
    promoAllocations = promoResult.allocations;
    promoSelectedGuestIndexes = application.selectedGuestIndexes;
    promoShouldPersist = shouldPersistPromoRedemption(promoResult);
    promoCodeRecord = promoCode;
  }

  const finalPriceCents = price.totalPriceCents + promoAdjustmentCents;
  const hasNonMembers = guests.some((g) => !g.isMember);

  const { newBooking, position } = await prisma.$transaction(async (tx) => {
    await acquireLodgeCapacityLock(tx, waitlistLodgeId);
    // Duplicate member nights (upstream #80cbdf4c): waitlist entries also
    // may not overlap the member's existing booked nights.
    await assertNoBookingMemberNightConflicts(tx, {
      actorMemberId: sessionUserId,
      actorRole: isOnBehalf ? "ADMIN" : "USER",
      checkIn,
      checkOut,
      guests,
    });

    const createdBooking = await tx.booking.create({
      data: {
        memberId: effectiveMemberId,
        lodgeId: waitlistLodgeId,
        checkIn,
        checkOut,
        status: BookingStatus.WAITLISTED,
        totalPriceCents: price.totalPriceCents,
        discountCents,
        promoAdjustmentCents,
        finalPriceCents,
        hasNonMembers,
        nonMemberHoldUntil: null,
        notes: notes || null,
        expectedArrivalTime: expectedArrivalTime || null,
        requestedRoomId: requestedRoomId || null,
        cancelIfGuestsBumped: cancelIfGuestsBumped ?? false,
        createdById: isOnBehalf ? sessionUserId : null,
        requiresAdminReview: review.requiresAdminReview,
        adminReviewReason: review.adminReviewReason,
        memberReviewJustification: review.memberReviewJustification,
        adminReviewStatus: review.adminReviewStatus,
        adminReviewNotes: review.adminReviewNotes,
        adminReviewedById: review.adminReviewedById,
        adminReviewedAt: review.adminReviewedAt,
        guests: { create: buildGuestCreateData(guests, price, checkIn, checkOut) },
      },
      include: { guests: true },
    });

    if (promoCodeRecord && promoShouldPersist) {
      await redeemPromoCode(
        tx,
        promoCodeRecord.id,
        createdBooking.id,
        effectiveMemberId,
        discountCents,
        promoAdjustmentCents,
        promoFreeNightsUsed || undefined,
        promoEligibleGuestCount || undefined,
        promoAllocations,
        getPromoTargetBookingGuestIds(createdBooking.guests, promoSelectedGuestIndexes),
        waitlistLodgeId,
      );
    }

    if (alternateLodgeIds.length > 0) {
      await tx.bookingWaitlistAlternateLodge.createMany({
        data: alternateLodgeIds.map((alternateLodgeId) => ({
          bookingId: createdBooking.id,
          lodgeId: alternateLodgeId,
        })),
      });
    }

    const waitlistPosition =
      (await tx.booking.count({
        where: {
          status: BookingStatus.WAITLISTED,
          checkIn: { lt: createdBooking.checkOut },
          checkOut: { gt: createdBooking.checkIn },
          createdAt: { lt: createdBooking.createdAt },
        },
      })) + 1;

    const updatedBooking = await tx.booking.update({
      where: { id: createdBooking.id },
      data: { waitlistPosition },
      include: { guests: true },
    });

    return { newBooking: updatedBooking, position: waitlistPosition };
  });

  const member = await prisma.member.findUnique({ where: { id: effectiveMemberId } });
  // The waitlist confirmation honours the on-behalf email choice too (#1695);
  // a member joining the waitlist themselves is always emailed.
  const notifyWaitlistedMember = !isOnBehalf || input.notifyMember !== false;
  if (member && notifyWaitlistedMember) {
    sendWaitlistConfirmationEmail(
      member.email,
      member.firstName,
      checkIn,
      checkOut,
      newBooking.guests.length,
      position,
      newBooking.lodgeId,
    ).catch((err) => logger.error({ err }, "Failed to send waitlist confirmation email"));

    sendAdminNewBookingAlert({
      memberName: `${member.firstName} ${member.lastName}`,
      checkIn: newBooking.checkIn,
      checkOut: newBooking.checkOut,
      guestCount: newBooking.guests.length,
      totalCents: newBooking.finalPriceCents,
      status: newBooking.status,
      reviewReason: newBooking.adminReviewReason,
      memberJustification: newBooking.memberReviewJustification,
    }).catch((err) => logger.error({ err }, "Failed to send admin alert for waitlisted booking"));
  }

  logAudit({
    action: "booking.waitlisted",
    memberId: effectiveMemberId,
    targetId: newBooking.id,
    subjectMemberId: effectiveMemberId,
    entityType: "Booking",
    entityId: newBooking.id,
    category: "booking",
    outcome: "success",
    summary: "Booking added to waitlist",
    details: `Booking added to waitlist at position #${position}`,
    metadata: {
      checkIn: checkIn.toISOString(),
      checkOut: checkOut.toISOString(),
      guestCount: newBooking.guests.length,
      position,
      finalPriceCents: newBooking.finalPriceCents,
      requiresAdminReview: newBooking.requiresAdminReview,
      ...(alternateLodgeIds.length > 0 ? { alternateLodgeIds } : {}),
    },
  });

  await recordBookingEvent({
    bookingId: newBooking.id,
    type: BookingEventType.CREATED,
    actorMemberId: sessionUserId,
    amountCents: newBooking.finalPriceCents,
  });

  return { booking: newBooking, position };
}
