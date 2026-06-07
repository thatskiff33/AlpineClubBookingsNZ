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
 *   - the single advisory lock key=1 still serialises ALL booking
 *     creation transactions to keep capacity checks safe
 */
import {
  AdminReviewStatus,
  AgeTier,
  BookingStatus,
  PaymentSource,
  PaymentStatus,
  type FixedNightlyMode,
  PromoCodeType,
  type Booking,
  type BookingGuest,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  calculateBookingCreditApplication,
  priceBookingGuests,
  toGuestPricingInputs,
  toSeasonRateData,
} from "@/lib/policies/booking-route-decisions";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import {
  redeemPromoCode,
  shouldPersistPromoRedemption,
  validateAndCalculatePromoDiscount,
  type PromoBeneficiaryAllocation,
} from "@/lib/promo";
import {
  bumpPendingBookings,
  sendBumpedNotifications,
} from "@/lib/bumping";
import {
  sendAdminNewBookingAlert,
  sendBookingConfirmedEmail,
  sendBookingPendingEmail,
  sendWaitlistConfirmationEmail,
} from "@/lib/email";
import {
  enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import { applyCreditToBooking, getMemberCreditBalance } from "@/lib/member-credit";
import {
  buildInternetBankingPaymentReference,
  DEFAULT_BOOKING_PAYMENT_METHOD,
  type BookingPaymentMethod,
} from "@/lib/booking-payment-methods";
import { recordInternetBankingPaymentTransaction } from "@/lib/payment-transactions";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { isFeatureEnabled } from "@/config/features";
import type { GroupDiscountConfig } from "@/lib/pricing";
import {
  ADULT_SUPERVISION_REVIEW_REASON,
  requiresAdultSupervisionReview,
} from "@/lib/booking-review";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { countActiveGuestsForNight } from "@/lib/booking-guest-stay-ranges";

type BookingWithGuests = Booking & { guests: BookingGuest[] };

export interface BookingGuestInput {
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string;
  stayStart?: Date | null;
  stayEnd?: Date | null;
}

interface BaseInput {
  effectiveMemberId: string;
  isOnBehalf: boolean;
  sessionUserId: string;
  checkIn: Date;
  checkOut: Date;
  guests: BookingGuestInput[];
  notes?: string;
  promoCodeStr?: string;
  expectedArrivalTime?: string;
  groupDiscount?: GroupDiscountConfig;
  memberReviewJustification?: string;
}

export type DraftBookingInput = BaseInput;

export interface ConfirmedBookingInput extends BaseInput {
  applyCreditCents?: number;
  status: BookingStatus;
  shouldBePending: boolean;
  holdDays: number;
  allMembers: boolean;
  paymentMethod?: BookingPaymentMethod;
}

export type ConfirmedBookingOutcome =
  | { type: "created"; booking: BookingWithGuests; bumpedBookingIds: string[]; isZeroDollarConfirmed: boolean }
  | { type: "capacityExceeded"; fullNights: string[] };

export type WaitlistedBookingInput = BaseInput;

export interface WaitlistedBookingResult {
  booking: BookingWithGuests;
  position: number;
}

/**
 * Thrown when promo code validation fails inside the booking transaction.
 * The route handler turns this into a 400 response.
 */
export class BookingPromoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingPromoError";
  }
}

/**
 * Thrown when the no-adult rule trips for a member-created booking but the
 * caller did not supply `memberReviewJustification`. Members must explain
 * why they are booking minors without an adult before the booking can be
 * persisted for admin review.
 */
export class BookingReviewJustificationRequiredError extends Error {
  constructor() {
    super(
      "A reason is required when booking minors without an adult guest. Please explain so an admin can review."
    );
    this.name = "BookingReviewJustificationRequiredError";
  }
}

/**
 * Resolve the admin-review fields for a booking based on guest mix and
 * whether the booking is being created by an admin on behalf of a member.
 *
 * Admin-created bookings auto-approve the review (no second pass on their
 * own work). Member-created bookings that trip the rule require a written
 * justification and land with adminReviewStatus = PENDING so an admin can
 * decide via the booking requests queue.
 */
function resolveAdminReviewFields(args: {
  guests: BookingGuestInput[];
  isOnBehalf: boolean;
  sessionUserId: string;
  memberReviewJustification: string | undefined;
}): {
  requiresAdminReview: boolean;
  adminReviewReason: string | null;
  memberReviewJustification: string | null;
  adminReviewStatus: AdminReviewStatus | null;
  adminReviewNotes: string | null;
  adminReviewedById: string | null;
  adminReviewedAt: Date | null;
  blockForReview: boolean;
} {
  const flagged = requiresAdultSupervisionReview(args.guests);
  if (!flagged) {
    return {
      requiresAdminReview: false,
      adminReviewReason: null,
      memberReviewJustification: null,
      adminReviewStatus: null,
      adminReviewNotes: null,
      adminReviewedById: null,
      adminReviewedAt: null,
      blockForReview: false,
    };
  }

  if (args.isOnBehalf) {
    return {
      requiresAdminReview: true,
      adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
      memberReviewJustification: args.memberReviewJustification?.trim() || null,
      adminReviewStatus: AdminReviewStatus.APPROVED,
      adminReviewNotes: "Approved at creation by admin.",
      adminReviewedById: args.sessionUserId,
      adminReviewedAt: new Date(),
      blockForReview: false,
    };
  }

  const justification = args.memberReviewJustification?.trim();
  if (!justification) {
    throw new BookingReviewJustificationRequiredError();
  }

  return {
    requiresAdminReview: true,
    adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
    memberReviewJustification: justification,
    adminReviewStatus: AdminReviewStatus.PENDING,
    adminReviewNotes: null,
    adminReviewedById: null,
    adminReviewedAt: null,
    blockForReview: true,
  };
}

interface ResolvedPromo {
  discountCents: number;
  promoAdjustmentCents: number;
  promoFreeNightsUsed: number;
  promoEligibleGuestCount: number;
  promoAllocations: PromoBeneficiaryAllocation[];
  promoShouldPersist: boolean;
  promoCodeRecord:
    | {
        id: string;
        type: PromoCodeType;
        valueCents: number | null;
        percentOff: number | null;
        freeNightsPerIndividual: number | null;
        lifetimeFreeNightsCap: number | null;
        fixedNightlyPriceCents: number | null;
        fixedNightlyMode: FixedNightlyMode | null;
        maxGuestsPerBooking: number | null;
        maxNightlyValueCents: number | null;
        memberGuestsOnly: boolean;
      }
    | null;
}

type LockedPromoRow = {
  id: string;
  active: boolean;
  validFrom: Date | null;
  validUntil: Date | null;
  bookingStartFrom: Date | null;
  bookingStartUntil: Date | null;
  maxRedemptionsTotal: number | null;
  maxUniqueMembersTotal: number | null;
  maxUsesPerMember: number | null;
  currentRedemptions: number;
  membersOnly: boolean;
  memberGuestsOnly: boolean;
  type: PromoCodeType;
  valueCents: number | null;
  percentOff: number | null;
  freeNightsPerIndividual: number | null;
  lifetimeFreeNightsCap: number | null;
  fixedNightlyPriceCents: number | null;
  fixedNightlyMode: FixedNightlyMode | null;
  maxGuestsPerBooking: number | null;
  maxNightlyValueCents: number | null;
  code: string;
};

/**
 * Resolve and validate a promo code inside the booking transaction.
 * Locks the row for update so concurrent bookings cannot over-redeem.
 * Throws BookingPromoError on validation failure so the caller can
 * roll back and return a 400.
 */
async function resolvePromoInTransaction(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  options: {
    promoCodeStr: string;
    effectiveMemberId: string;
    checkIn: Date;
    guests: BookingGuestInput[];
    totalPriceCents: number;
    perNightCentsByGuest: number[][];
  },
): Promise<ResolvedPromo> {
  const { promoCodeStr, effectiveMemberId, checkIn, guests, totalPriceCents, perNightCentsByGuest } = options;
  const normalizedCode = promoCodeStr.toUpperCase().trim();
  const lockedRows = await tx.$queryRaw<LockedPromoRow[]>`
    SELECT * FROM "PromoCode" WHERE "code" = ${normalizedCode} FOR UPDATE
  `;
  const promoCode = lockedRows.length > 0 ? lockedRows[0] : null;

  let assignedMemberIds: string[] | null = null;
  if (promoCode) {
    const assignments = await tx.promoCodeAssignment.findMany({
      where: { promoCodeId: promoCode.id },
      select: { memberId: true },
    });
    if (assignments.length > 0) {
      assignedMemberIds = assignments.map((a) => a.memberId);
    }
  }

  const guestNightRates = guests.map((guest, index) => ({
    memberId: guest.memberId ?? null,
    isMember: guest.isMember,
    perNightRates: perNightCentsByGuest[index],
  }));
  const application = await validateAndCalculatePromoDiscount(
    promoCode,
    {
      memberId: effectiveMemberId,
      bookingCheckIn: checkIn,
      totalPriceCents,
      guests: guestNightRates,
    },
    assignedMemberIds,
    { db: tx }
  );
  if (application.error || !application.discount) {
    throw new BookingPromoError(application.error ?? "Promo code could not be applied");
  }
  const promoResult = application.discount;

  return {
    discountCents: promoResult.discountCents,
    promoAdjustmentCents: promoResult.priceAdjustmentCents,
    promoFreeNightsUsed: promoResult.freeNightsUsed,
    promoEligibleGuestCount: promoResult.eligibleGuestCount,
    promoAllocations: promoResult.allocations,
    promoShouldPersist: shouldPersistPromoRedemption(promoResult),
    promoCodeRecord: promoCode,
  };
}

function buildGuestCreateData(guests: BookingGuestInput[], price: { guests: { priceCents: number }[] }, checkIn: Date, checkOut: Date) {
  return guests.map((g, i) => ({
    firstName: g.firstName,
    lastName: g.lastName,
    ageTier: g.ageTier,
    isMember: g.isMember,
    memberId: g.memberId || null,
    stayStart: g.stayStart ?? checkIn,
    stayEnd: g.stayEnd ?? checkOut,
    priceCents: price.guests[i].priceCents,
  }));
}

function getCapacityGuestRanges(
  guests: BookingGuestInput[],
  checkIn: Date,
  checkOut: Date
) {
  return guests.map((guest) => ({
    stayStart: guest.stayStart ?? checkIn,
    stayEnd: guest.stayEnd ?? checkOut,
  }));
}

function getCapacityFullNights(
  nightDetails: Array<{ date: Date; availableBeds: number }>
): string[] {
  return nightDetails
    .filter((night) => night.availableBeds < 0)
    .map((night) => night.date.toISOString().split("T")[0]);
}

function getMaxActiveGuestCount(
  guests: BookingGuestInput[],
  checkIn: Date,
  checkOut: Date
): number {
  let maxActive = 0;

  for (
    let current = new Date(checkIn);
    current < checkOut;
    current.setUTCDate(current.getUTCDate() + 1)
  ) {
    maxActive = Math.max(
      maxActive,
      countActiveGuestsForNight(guests, current, { checkIn, checkOut })
    );
  }

  return maxActive;
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
    checkIn,
    checkOut,
    guests,
    notes,
    promoCodeStr,
    expectedArrivalTime,
    groupDiscount,
    memberReviewJustification,
  } = input;

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
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const draftExpiresAt = review.blockForReview
      ? null
      : new Date(Date.now() + 72 * 60 * 60 * 1000);

    const seasons = await tx.season.findMany({
      where: { active: true, startDate: { lte: checkOut }, endDate: { gte: checkIn } },
      include: { rates: true },
    });
    const seasonData = toSeasonRateData(seasons);
    const guestInputs = toGuestPricingInputs(guests);
    const price = priceBookingGuests({ checkIn, checkOut, guests: guestInputs, seasons: seasonData, groupDiscount });

    let discountCents = 0;
    let promoAdjustmentCents = 0;
    let promoFreeNightsUsed = 0;
    let promoEligibleGuestCount = 0;
    let promoAllocations: PromoBeneficiaryAllocation[] = [];
    let promoShouldPersist = false;
    let promoCodeRecord: ResolvedPromo["promoCodeRecord"] = null;
    if (promoCodeStr) {
      const resolved = await resolvePromoInTransaction(tx, {
        promoCodeStr,
        effectiveMemberId,
        checkIn,
        guests,
        totalPriceCents: price.totalPriceCents,
        perNightCentsByGuest: price.guests.map((g) => g.perNightCents),
      });
      discountCents = resolved.discountCents;
      promoAdjustmentCents = resolved.promoAdjustmentCents;
      promoFreeNightsUsed = resolved.promoFreeNightsUsed;
      promoEligibleGuestCount = resolved.promoEligibleGuestCount;
      promoAllocations = resolved.promoAllocations;
      promoShouldPersist = resolved.promoShouldPersist;
      promoCodeRecord = resolved.promoCodeRecord;
    }

    const finalPriceCents = price.totalPriceCents + promoAdjustmentCents;
    const hasNonMembers = guests.some((g) => !g.isMember);

    const createdBooking = await tx.booking.create({
      data: {
        memberId: effectiveMemberId,
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
    checkIn,
    checkOut,
    guests,
    notes,
    promoCodeStr,
    expectedArrivalTime,
    applyCreditCents,
    groupDiscount,
    status,
    shouldBePending,
    holdDays,
    allMembers,
    paymentMethod = DEFAULT_BOOKING_PAYMENT_METHOD,
    memberReviewJustification,
  } = input;

  const hasNonMembers = guests.some((g) => !g.isMember);
  const review = resolveAdminReviewFields({
    guests,
    isOnBehalf,
    sessionUserId,
    memberReviewJustification,
  });
  // A member-created youth-only booking lands in AWAITING_REVIEW regardless
  // of the caller's requested status — payment is intentionally blocked
  // until an admin approves.
  const internetBankingPaymentSelected =
    paymentMethod === "internet_banking" && !review.blockForReview;
  const requestedStatus = internetBankingPaymentSelected
    ? BookingStatus.PAYMENT_PENDING
    : status;
  const effectiveStatus = review.blockForReview
    ? BookingStatus.AWAITING_REVIEW
    : requestedStatus;

  let bumpedBookingIds: string[] = [];
  let isZeroDollarConfirmed = false;
  let capacityFullNights: string[] | null = null;

  let booking: BookingWithGuests;
  try {
    booking = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

      const capacityGuestRanges = getCapacityGuestRanges(guests, checkIn, checkOut);
      const capacityCheck = await checkCapacityForGuestRanges(
        checkIn,
        checkOut,
        capacityGuestRanges,
        undefined,
        tx
      );

      const seasons = await tx.season.findMany({
        where: { active: true, startDate: { lte: checkOut }, endDate: { gte: checkIn } },
        include: { rates: true },
      });
      const seasonData = toSeasonRateData(seasons);
      const guestInputs = toGuestPricingInputs(guests);
      const price = priceBookingGuests({ checkIn, checkOut, guests: guestInputs, seasons: seasonData, groupDiscount });

      let discountCents = 0;
      let promoAdjustmentCents = 0;
      let promoFreeNightsUsed = 0;
      let promoEligibleGuestCount = 0;
      let promoAllocations: PromoBeneficiaryAllocation[] = [];
      let promoShouldPersist = false;
      let promoCodeRecord: ResolvedPromo["promoCodeRecord"] = null;
      if (promoCodeStr) {
        const resolved = await resolvePromoInTransaction(tx, {
          promoCodeStr,
          effectiveMemberId,
          checkIn,
          guests,
          totalPriceCents: price.totalPriceCents,
          perNightCentsByGuest: price.guests.map((g) => g.perNightCents),
        });
        discountCents = resolved.discountCents;
        promoAdjustmentCents = resolved.promoAdjustmentCents;
        promoFreeNightsUsed = resolved.promoFreeNightsUsed;
        promoEligibleGuestCount = resolved.promoEligibleGuestCount;
        promoAllocations = resolved.promoAllocations;
        promoShouldPersist = resolved.promoShouldPersist;
        promoCodeRecord = resolved.promoCodeRecord;
      }

      const finalPriceCents = price.totalPriceCents + promoAdjustmentCents;
      // Credit is only applied at payment time. For a booking heading to
      // AWAITING_REVIEW, defer credit application until the admin approves
      // and the member completes payment.
      const creditBalance =
        (applyCreditCents ?? 0) > 0 &&
        requestedStatus === BookingStatus.PAYMENT_PENDING &&
        !review.blockForReview
          ? await getMemberCreditBalance(effectiveMemberId, tx)
          : 0;
      const { creditAppliedCents, effectivePriceCents } = calculateBookingCreditApplication({
        requestedCreditCents: review.blockForReview ? 0 : (applyCreditCents ?? 0),
        creditBalanceCents: creditBalance,
        finalPriceCents,
        status: requestedStatus,
      });

      // AWAITING_REVIEW holds capacity, so capacity must be verified even
      // when the booking would otherwise have skipped the check (zero-dollar
      // member-paid path).
      if (
        !capacityCheck.available &&
        (requestedStatus === BookingStatus.PENDING || effectivePriceCents > 0 || review.blockForReview)
      ) {
        capacityFullNights = getCapacityFullNights(capacityCheck.nightDetails);
        throw new Error("CAPACITY_EXCEEDED_SENTINEL");
      }

      const nonMemberHoldUntil = shouldBePending && !internetBankingPaymentSelected
        ? new Date(checkIn.getTime() - holdDays * 24 * 60 * 60 * 1000)
        : null;

      const newBooking = await tx.booking.create({
        data: {
          memberId: effectiveMemberId,
          checkIn,
          checkOut,
          status: effectiveStatus,
          totalPriceCents: price.totalPriceCents,
          discountCents,
          promoAdjustmentCents,
          finalPriceCents,
          hasNonMembers,
          nonMemberHoldUntil,
          notes: notes || null,
          expectedArrivalTime: expectedArrivalTime || null,
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
          newBooking.id,
          effectiveMemberId,
          discountCents,
          promoAdjustmentCents,
          promoFreeNightsUsed || undefined,
          promoEligibleGuestCount || undefined,
          promoAllocations,
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
        requestedStatus === BookingStatus.PAYMENT_PENDING &&
        !review.blockForReview
      ) {
        const finalCapacityCheck = await checkCapacityForGuestRanges(
          checkIn,
          checkOut,
          capacityGuestRanges,
          newBooking.id,
          tx
        );
        if (!finalCapacityCheck.available) {
          if (!allMembers) {
            capacityFullNights = getCapacityFullNights(finalCapacityCheck.nightDetails);
            throw new Error("CAPACITY_EXCEEDED_SENTINEL");
          }

          const bumpResult = await bumpPendingBookings(
            checkIn,
            checkOut,
            getMaxActiveGuestCount(guests, checkIn, checkOut),
            tx
          );
          if (!bumpResult.capacityRestored) {
            capacityFullNights = getCapacityFullNights(finalCapacityCheck.nightDetails);
            throw new Error("CAPACITY_EXCEEDED_SENTINEL");
          }

          bumpedBookingIds = bumpResult.bumpedBookingIds;
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
      guestCount: guests.length,
      hasNonMembers,
      finalPriceCents: booking.finalPriceCents,
      zeroDollarConfirmed: isZeroDollarConfirmed,
      paymentMethod,
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
        guestCount: guests.length,
        hasNonMembers,
        finalPriceCents: booking.finalPriceCents,
        paymentMethod,
      },
    });
  }

  if (bumpedBookingIds.length > 0) {
    const triggeringMember = await prisma.member.findUnique({ where: { id: effectiveMemberId } });
    const triggeringName = triggeringMember
      ? `${triggeringMember.firstName} ${triggeringMember.lastName}`
      : "Unknown";
    sendBumpedNotifications(bumpedBookingIds, triggeringName).catch((err) =>
      logger.error({ err }, "Failed to send bump notifications"),
    );
  }

  if (isZeroDollarConfirmed) {
    try {
      const fullBooking = await prisma.booking.findUnique({
        where: { id: booking.id },
        include: { member: true, guests: true, promoRedemption: { include: { promoCode: true } } },
      });
      if (fullBooking) {
        sendBookingConfirmedEmail(
          fullBooking.member.email,
          fullBooking.member.firstName,
          fullBooking.checkIn,
          fullBooking.checkOut,
          fullBooking.guests.length,
          fullBooking.finalPriceCents,
          fullBooking.promoRedemption?.promoCode
            ? {
                discountCents: fullBooking.discountCents,
                promoAdjustmentCents: fullBooking.promoAdjustmentCents,
                promoCode: fullBooking.promoRedemption.promoCode.code,
              }
            : undefined,
        ).catch((err) => logger.error({ err, bookingId: booking.id }, "Failed to send confirmation email for $0 booking"));

        if (isFeatureEnabled("xeroIntegration")) {
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
      if (queuedInvoice.queueOperationId) {
        await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
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
    if (member) {
      sendBookingPendingEmail(
        member.email,
        member.firstName,
        booking.checkIn,
        booking.checkOut,
        booking.guests.length,
        booking.nonMemberHoldUntil,
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

  return { type: "created", booking, bumpedBookingIds, isZeroDollarConfirmed };
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
    checkIn,
    checkOut,
    guests,
    notes,
    promoCodeStr,
    expectedArrivalTime,
    groupDiscount,
    memberReviewJustification,
  } = input;

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

  const seasons = await prisma.season.findMany({
    where: { active: true, startDate: { lte: checkOut }, endDate: { gte: checkIn } },
    include: { rates: true },
  });
  const seasonData = toSeasonRateData(seasons);
  const guestInputs = toGuestPricingInputs(guests);
  const price = priceBookingGuests({ checkIn, checkOut, guests: guestInputs, seasons: seasonData, groupDiscount });

  let discountCents = 0;
  let promoAdjustmentCents = 0;
  let promoFreeNightsUsed = 0;
  let promoEligibleGuestCount = 0;
  let promoAllocations: PromoBeneficiaryAllocation[] = [];
  let promoShouldPersist = false;
  let promoCodeRecord: ResolvedPromo["promoCodeRecord"] = null;

  if (promoCodeStr) {
    const normalizedCode = promoCodeStr.toUpperCase().trim();
    const promoCode = await prisma.promoCode.findUnique({
      where: { code: normalizedCode },
      include: { assignments: { select: { memberId: true } } },
    });
    const assignedMemberIds = promoCode?.assignments?.length
      ? promoCode.assignments.map((a) => a.memberId)
      : null;
    const guestNightRates = guests.map((guest, index) => ({
      memberId: guest.memberId ?? null,
      isMember: guest.isMember,
      perNightRates: price.guests[index].perNightCents,
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
      { db: prisma }
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
    promoShouldPersist = shouldPersistPromoRedemption(promoResult);
    promoCodeRecord = promoCode;
  }

  const finalPriceCents = price.totalPriceCents + promoAdjustmentCents;
  const hasNonMembers = guests.some((g) => !g.isMember);

  const { newBooking, position } = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(1)`);

    const createdBooking = await tx.booking.create({
      data: {
        memberId: effectiveMemberId,
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
      );
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
  if (member) {
    sendWaitlistConfirmationEmail(
      member.email,
      member.firstName,
      checkIn,
      checkOut,
      newBooking.guests.length,
      position,
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
    },
  });

  return { booking: newBooking, position };
}
