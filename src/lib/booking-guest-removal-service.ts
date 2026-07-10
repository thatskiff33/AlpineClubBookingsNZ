import {
  AdminReviewStatus,
  BookingStatus,
  type AgeTier,
  type Prisma,
} from "@prisma/client";
import {
  type SeasonRateData,
} from "@/lib/pricing";
import {
  assertMembershipTypeBookingAllowed,
  priceBookingGuestsWithMembershipTypePolicy,
} from "@/lib/membership-type-policy";
import {
  deletePromoRedemptionAndAdjustCount,
  replacePromoRedemptionAllocations,
  validateAndCalculatePromoDiscount,
} from "@/lib/promo";
import { toGroupDiscountConfig } from "@/lib/policies/booking-route-decisions";
import {
  ADULT_SUPERVISION_REVIEW_REASON,
  minorsReviewAlertShouldFire,
  requiresAdultSupervisionReview,
} from "@/lib/booking-review";
import {
  getBookingEditPolicy,
  usesActiveBookingEditLifecycle,
} from "@/lib/booking-edit-policy";
import {
  applyLifecycleTransitions,
  applyPaymentAdjustments,
  assertBookingNotQuotePriced,
  calculateModificationSettlementOptions,
  lockedNightPricesForGuest,
  type BookingModificationSettlementMethod,
  type LoadedBookingForModify,
} from "@/lib/booking-modify";
import type { SupersededPrimaryPaymentIntent } from "@/lib/booking-payment-cleanup";
import { createBookingModificationCredit } from "@/lib/member-credit";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { getSeasonYear } from "@/lib/utils";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { getDefaultLodgeId, lodgeNullTolerantScope } from "@/lib/lodges";
import {
  getTodayDateOnly,
  normalizeDateOnlyForTimeZone,
} from "@/lib/date-only";

export class BookingGuestRemovalError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

export type RemoveBookingGuestResult = {
  booking: Prisma.BookingGetPayload<{ include: { guests: true; payment: true } }>;
  removedGuest: Prisma.BookingGuestGetPayload<Record<string, never>>;
  priceDiffCents: number;
  refundAmountCents: number;
  accountCreditAmountCents: number;
  pendingRefundAmountCents: number;
  additionalAmountCents: number;
  settlementMethod: BookingModificationSettlementMethod | null;
  policyRetainedAmountCents: number;
  xeroRefundAmountCents: number;
  xeroAdditionalAmountCents: number;
  hasSucceededPayment: boolean;
  hasIssuedXeroInvoice: boolean;
  paymentStatus: string | null;
  paymentId: string | null;
  paymentCustomerId: string | null;
  memberEmail: string;
  memberName: string;
  memberId: string;
  promoRemoved: boolean;
  choreWarnings: string[];
  oldGuestCount: number;
  bookingModificationId: string;
  zeroDollarAutoPaid: boolean;
  supersededPrimaryPaymentIntents: SupersededPrimaryPaymentIntent[];
  // #1372: this removal newly dropped a paid (capacity-holding) booking into the
  // blocked minors-only review state, so the route should alert admins.
  minorsOnlyReviewNewlyFlagged: boolean;
  // #1705: the effective member-email decision. `false` ONLY when an admin acting
  // on-behalf opted out; member/linked-guest self-removal is always `true`. The
  // route uses this to gate the member email and to record it in the audit log.
  notifyMember: boolean;
};

const SELF_REMOVABLE_GUEST_BOOKING_STATUSES = new Set<string>([
  BookingStatus.DRAFT,
  BookingStatus.PENDING,
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
  BookingStatus.WAITLISTED,
  BookingStatus.WAITLIST_OFFERED,
  BookingStatus.AWAITING_REVIEW,
]);

type PromoRedemptionWithTargets = {
  promoCode: {
    assignedMembersOnlyOwnNights?: boolean | null;
    assignments: Array<{ memberId: string }>;
    lodges?: Array<{ lodgeId: string }>;
  };
  guestTargets?: Array<{ bookingGuestId: string }>;
};

function promoRequiresStoredGuestTargets(redemption: PromoRedemptionWithTargets) {
  return (
    redemption.promoCode.assignments.length > 0 &&
    redemption.promoCode.assignedMembersOnlyOwnNights === false
  );
}

function selectedIndexesForStoredGuestTargets(
  redemption: PromoRedemptionWithTargets,
  guestNightRates: Array<{ bookingGuestId?: string | null }>
) {
  if (!promoRequiresStoredGuestTargets(redemption)) {
    return undefined;
  }

  const targetIds = new Set((redemption.guestTargets ?? []).map((target) => target.bookingGuestId));
  if (targetIds.size === 0) {
    return guestNightRates.map((_, index) => index);
  }

  return guestNightRates
    .map((guest, index) => (guest.bookingGuestId && targetIds.has(guest.bookingGuestId) ? index : -1))
    .filter((index) => index >= 0);
}

function targetBookingGuestIdsForSelectedIndexes(
  guestNightRates: Array<{ bookingGuestId?: string | null }>,
  selectedGuestIndexes: number[] | undefined
) {
  if (!selectedGuestIndexes) return undefined;
  return selectedGuestIndexes
    .map((index) => guestNightRates[index]?.bookingGuestId)
    .filter((id): id is string => Boolean(id));
}

type RemovalReviewUpdate = {
  requiresAdminReview: boolean;
  adminReviewReason: string | null;
  memberReviewJustification: string | null;
  adminReviewStatus: AdminReviewStatus | null;
  adminReviewNotes: string | null;
  adminReviewedById: string | null;
  adminReviewedAt: Date | null;
  parkForReview: boolean;
  releaseFromReview: boolean;
};

/**
 * Review fields to write after a guest removal (#1100). Mirrors the batch
 * path's resolveModifyReviewUpdate scenarios, with one deliberate difference:
 * a member (or self-removing linked guest) who trips the no-adult rule is
 * never blocked for a written justification — the removal proceeds and the
 * booking is flagged with an automatic note so it lands in the admin review
 * queue, even when the booking is already paid.
 */
function resolveRemovalReviewUpdate({
  booking,
  actorRole,
  actorMemberId,
  nowFlagged,
  removedGuestName,
}: {
  booking: {
    status: string;
    requiresAdminReview: boolean;
    adminReviewStatus: AdminReviewStatus | null;
    memberReviewJustification: string | null;
    adminReviewNotes: string | null;
    adminReviewedById: string | null;
    adminReviewedAt: Date | null;
  };
  actorRole: string;
  actorMemberId: string;
  nowFlagged: boolean;
  removedGuestName: string;
}): RemovalReviewUpdate {
  if (!nowFlagged) {
    // Rule cleared (or never tripped): wipe review state so the booking
    // returns to the normal lifecycle; release a parked booking.
    return {
      requiresAdminReview: false,
      adminReviewReason: null,
      memberReviewJustification: null,
      adminReviewStatus: null,
      adminReviewNotes: null,
      adminReviewedById: null,
      adminReviewedAt: null,
      parkForReview: false,
      releaseFromReview: booking.status === BookingStatus.AWAITING_REVIEW,
    };
  }

  // Still (or already) flagged with a recorded review: preserve it — admins
  // are not re-prompted just because the guest list shuffled.
  if (booking.requiresAdminReview && booking.adminReviewStatus !== null) {
    return {
      requiresAdminReview: true,
      adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
      memberReviewJustification: booking.memberReviewJustification,
      adminReviewStatus: booking.adminReviewStatus,
      adminReviewNotes: booking.adminReviewNotes,
      adminReviewedById: booking.adminReviewedById,
      adminReviewedAt: booking.adminReviewedAt,
      parkForReview: booking.adminReviewStatus === AdminReviewStatus.PENDING,
      releaseFromReview: false,
    };
  }

  // First trip. An admin performing the removal is the approval (batch
  // parity); anyone else flags the booking for admin review.
  if (actorRole === "ADMIN") {
    return {
      requiresAdminReview: true,
      adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
      memberReviewJustification: null,
      adminReviewStatus: AdminReviewStatus.APPROVED,
      adminReviewNotes: "Approved at guest removal by admin.",
      adminReviewedById: actorMemberId,
      adminReviewedAt: new Date(),
      parkForReview: false,
      releaseFromReview: false,
    };
  }

  return {
    requiresAdminReview: true,
    adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
    memberReviewJustification: `Automatic: removing ${removedGuestName} left no adult on this booking.`,
    adminReviewStatus: AdminReviewStatus.PENDING,
    adminReviewNotes: null,
    adminReviewedById: null,
    adminReviewedAt: null,
    parkForReview: true,
    releaseFromReview: false,
  };
}

export async function removeBookingGuestInTransaction({
  tx,
  bookingId,
  guestId,
  actorMemberId,
  actorRole,
  settlementMethod,
  notifyMember,
}: {
  tx: Prisma.TransactionClient;
  bookingId: string;
  guestId: string;
  actorMemberId: string;
  actorRole: string;
  settlementMethod?: BookingModificationSettlementMethod;
  // Issue #1705: the admin-on-behalf per-action email choice. Honored ONLY when
  // the actor is an admin removing a guest from a booking they do NOT own; a
  // member/linked-guest self-removal always notifies (the effective decision is
  // computed below and echoed back so the route gates the member email + audit).
  notifyMember?: boolean;
}): Promise<RemoveBookingGuestResult> {
  // Pre-lock read: only the lock key. lodgeId is immutable, so keying the lock
  // from this read is safe; the guest set, pricing and refund below consume
  // ONLY the post-lock re-read.
  const lockTarget = await tx.booking.findUnique({
    where: { id: bookingId },
    select: { lodgeId: true },
  });

  if (!lockTarget) {
    throw new BookingGuestRemovalError("Booking not found", 404);
  }

  const bookingLodgeId = lockTarget.lodgeId ?? (await getDefaultLodgeId(tx));
  await acquireLodgeCapacityLock(tx, bookingLodgeId);

  // Re-read the full booking under the lock; every field consumed below comes
  // from this post-lock snapshot.
  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    include: {
      guests: {
        include: {
          nights: { select: { stayDate: true, priceCents: true } },
        },
      },
      payment: true,
      member: true,
        promoRedemption: {
          include: {
            guestTargets: { select: { bookingGuestId: true } },
            promoCode: {
              include: {
                assignments: { select: { memberId: true } },
                lodges: { select: { lodgeId: true } },
              },
            },
          },
        },
    },
  });

  if (!booking) {
    throw new BookingGuestRemovalError("Booking not found", 404);
  }

  const guestToRemove = booking.guests.find((guest) => guest.id === guestId);
  const isOwnerOrAdmin = booking.memberId === actorMemberId || actorRole === "ADMIN";
  const isSelfRemoval =
    !isOwnerOrAdmin && guestToRemove?.memberId === actorMemberId;
  // Issue #1705: only an admin acting on a booking they do NOT own may suppress
  // the member email. An owner removing their own guest, or a linked guest
  // self-removing, is a member-self action and always notifies — so a stray
  // notifyMember:false from those paths is ignored (defence in depth; the DELETE
  // route's only member-facing caller is the wizard self-removal).
  const isAdminOnBehalf =
    actorRole === "ADMIN" && booking.memberId !== actorMemberId;
  const effectiveNotifyMember = isAdminOnBehalf ? notifyMember !== false : true;
  const isLinkedGuestViewer = booking.guests.some(
    (guest) => guest.memberId === actorMemberId,
  );

  if (!isOwnerOrAdmin && !isLinkedGuestViewer) {
    throw new BookingGuestRemovalError("Forbidden", 403);
  }

  if (!guestToRemove) {
    throw new BookingGuestRemovalError(
      isOwnerOrAdmin ? "Guest not found on this booking" : "Forbidden",
      isOwnerOrAdmin ? 404 : 403,
    );
  }

  if (!isOwnerOrAdmin && !isSelfRemoval) {
    throw new BookingGuestRemovalError("Forbidden", 403);
  }

  if (
    !isSelfRemoval &&
    !["PENDING", "PAYMENT_PENDING", "CONFIRMED", "PAID"].includes(booking.status)
  ) {
    throw new BookingGuestRemovalError(
      "Only PENDING, PAYMENT_PENDING, CONFIRMED, or PAID bookings can be modified",
      400
    );
  }
  if (
    isSelfRemoval &&
    !SELF_REMOVABLE_GUEST_BOOKING_STATUSES.has(booking.status)
  ) {
    throw new BookingGuestRemovalError(
      "You cannot remove yourself from this booking in its current status",
      400,
    );
  }

  const editPolicy = getBookingEditPolicy({
    status: booking.status,
    role: actorRole,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
  });
  const selfRemovalIsFuture =
    isSelfRemoval &&
    normalizeDateOnlyForTimeZone(booking.checkIn) > getTodayDateOnly();
  if (!isSelfRemoval && !editPolicy.canModify) {
    throw new BookingGuestRemovalError(
      editPolicy.reason ?? "This booking cannot be modified",
      400
    );
  }
  if (isSelfRemoval && !selfRemovalIsFuture) {
    throw new BookingGuestRemovalError(
      "Only future booking guests can remove themselves from another member's booking",
      400,
    );
  }
  if (!isSelfRemoval && editPolicy.mode !== "future") {
    throw new BookingGuestRemovalError(
      "Use the full booking edit flow for in-progress booking guest changes",
      400
    );
  }

  if (booking.guests.length <= 1) {
    throw new BookingGuestRemovalError(
      "Cannot remove the last guest. Cancel the booking instead.",
      400
    );
  }

  await assertBookingNotQuotePriced(tx, bookingId);

  const choreWarnings = await removeGuestChoreAssignments(tx, guestId);

  await tx.bookingGuest.delete({ where: { id: guestId } });

  const remainingGuests = booking.guests.filter((guest) => guest.id !== guestId);
  const seasonRateData = await loadSeasonRateData(tx, bookingLodgeId);

  const guestsForPricing = remainingGuests.map((guest) => ({
    bookingGuestId: guest.id,
    ageTier: guest.ageTier as AgeTier,
    isMember: guest.isMember,
    memberId: guest.memberId ?? null,
    // Price remaining guests over exactly the nights they hold (#1093):
    // their stored night set (or stay envelope for pre-#713 guests without
    // rows), never the full booking range — removing one guest must not grow
    // phantom nights on a partial-stay guest who stays behind.
    stayStart: guest.stayStart,
    stayEnd: guest.stayEnd,
    nights: guest.nights && guest.nights.length > 0 ? guest.nights : null,
    // Remaining guests keep their booked nightly prices (#1036): removing a
    // guest must return exactly that guest's own price, policy permitting.
    lockedNightPrices: lockedNightPricesForGuest(guest),
  }));
  const seasonYear = getSeasonYear(booking.checkIn);
  await assertMembershipTypeBookingAllowed(tx, {
    ownerMemberId: booking.memberId,
    guests: guestsForPricing,
    seasonYear,
  });

  const groupDiscountSetting = await tx.groupDiscountSetting.findUnique({
    where: { id: "default" },
  });
  const priceBreakdown = await priceBookingGuestsWithMembershipTypePolicy(tx, {
    ownerMemberId: booking.memberId,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    guests: guestsForPricing,
    seasons: seasonRateData,
    // Group discount applies to any newly priced nights (#1095); remaining
    // guests' locked nights keep their booked (discount-inclusive) prices, so
    // a party dropping below the minimum never loses a discount it bought.
    groupDiscount: toGroupDiscountConfig(groupDiscountSetting),
    seasonYear,
  });
  const guestNightRates = guestsForPricing.map((guest, index) => ({
    bookingGuestId: guest.bookingGuestId,
    memberId: guest.memberId ?? null,
    isMember: guest.isMember,
    perNightRates: priceBreakdown.guests[index].perNightCents,
    nightDates: priceBreakdown.guests[index].nightDates,
    // nightDates carry each guest's actual priced nights (partial stays
    // included); firstNight remains the booking's check-in so internal
    // work-party promos date their window from the stay start.
    firstNight: booking.checkIn,
  }));

  const newTotalPriceCents = priceBreakdown.totalPriceCents;
  const promoResult = await recalculateBookingPromo({
    tx,
    bookingId,
    booking,
    newTotalPriceCents,
    guestNightRates,
  });
  const newFinalPriceCents = newTotalPriceCents + promoResult.newPromoAdjustmentCents;
  const priceDiffCents = newFinalPriceCents - booking.finalPriceCents;
  // Owner rule (#1100): a booking left with only non-adults must go through
  // admin approval, even if it was previously paid and approved for a
  // different composition. The self-removing guest is never blocked — the
  // removal proceeds and the booking is flagged with an automatic
  // justification (no written reason can be demanded of someone leaving).
  const reviewUpdate = resolveRemovalReviewUpdate({
    booking,
    actorRole,
    actorMemberId,
    nowFlagged: requiresAdultSupervisionReview(remainingGuests),
    removedGuestName: `${guestToRemove.firstName} ${guestToRemove.lastName}`,
  });

  // Settle the reduction through the same policy-based machinery the batch
  // modify path uses (#1014): a captured payment is refunded/credited only up
  // to the cancellation-policy tier for the days until check-in, and the
  // member must choose card vs credit. Previously this path refunded the full
  // guest cost with no policy tier, bypassing the cancellation window that the
  // batch endpoint enforces for the identical economic change.
  const settlementOptions = await calculateModificationSettlementOptions({
    booking: booking as unknown as LoadedBookingForModify,
    netChargeCents: priceDiffCents,
  });
  if (settlementOptions?.requiresSettlementMethod && !settlementMethod) {
    // A settled booking needs an explicit card/credit election. The only
    // body-less caller is a linked guest self-removing to resolve a night
    // conflict; for an already-paid target the owner's funds must not be
    // settled without their choice, so block and defer to the owner/admin
    // (who edit through the batch flow's chooser).
    throw new BookingGuestRemovalError(
      "This booking has a settled payment, so a refund or account credit must be chosen. Ask the booking owner or an admin to remove this guest.",
      400,
    );
  }
  const paymentImpact = await applyPaymentAdjustments(tx, {
    booking: booking as unknown as LoadedBookingForModify,
    priceDiffCents,
    changeFeeCents: 0,
    settlementOptions,
    settlementMethod,
  });

  // Run the same lifecycle transitions the batch path applies (#1041):
  // non-member-hold recalculation (an all-member booking clears its hold),
  // PENDING -> PAYMENT_PENDING inside the hold window, zero-dollar auto-pay
  // with superseded-PaymentIntent cancellation, and review parking (#1100).
  // Parking only ever moves pre-payment bookings to AWAITING_REVIEW; a
  // paid/confirmed booking is flagged for the admin queue without a status
  // change (applyLifecycleTransitions enforces that).
  const lifecycle = await applyLifecycleTransitions(tx, {
    booking: booking as unknown as LoadedBookingForModify,
    bookingId,
    newCheckIn: booking.checkIn,
    newFinalPriceCents,
    guestsForPricing,
    skipBookingLifecycleRules:
      actorRole === "ADMIN" && !usesActiveBookingEditLifecycle(booking.status),
    reviewUpdate,
  });

  await Promise.all(
    remainingGuests.map((guest, index) =>
      tx.bookingGuest.update({
        where: { id: guest.id },
        data: { priceCents: priceBreakdown.guests[index].priceCents },
      })
    )
  );

  const updatedBooking = await tx.booking.update({
    where: { id: bookingId },
    data: {
      totalPriceCents: newTotalPriceCents,
      discountCents: promoResult.newDiscountCents,
      promoAdjustmentCents: promoResult.newPromoAdjustmentCents,
      finalPriceCents: newFinalPriceCents,
      hasNonMembers: lifecycle.hasNonMembers,
      nonMemberHoldUntil: lifecycle.newNonMemberHoldUntil,
      status: lifecycle.newStatus,
      requiresAdminReview: reviewUpdate.requiresAdminReview,
      adminReviewReason: reviewUpdate.adminReviewReason,
      memberReviewJustification: reviewUpdate.memberReviewJustification,
      adminReviewStatus: reviewUpdate.adminReviewStatus,
      adminReviewNotes: reviewUpdate.adminReviewNotes,
      adminReviewedById: reviewUpdate.adminReviewedById,
      adminReviewedAt: reviewUpdate.adminReviewedAt,
    },
    include: { guests: true, payment: true },
  });

  // #1372: did this removal newly block a paid booking on the minors-only rule?
  // Computed from the pre-removal review state and the freshly written booking.
  const minorsOnlyReviewNewlyFlagged = minorsReviewAlertShouldFire({
    previous: booking,
    updated: updatedBooking,
  });

  await reconcileBedAllocationsForBooking({
    bookingId,
    db: tx,
    previousRange: {
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
    },
  });

  const bookingModification = await tx.bookingModification.create({
    data: {
      bookingId,
      memberId: actorMemberId,
      modificationType: "GUEST_REMOVE",
      previousData: {
        guestCount: booking.guests.length,
        removedGuest: {
          firstName: guestToRemove.firstName,
          lastName: guestToRemove.lastName,
          ageTier: guestToRemove.ageTier,
          isMember: guestToRemove.isMember,
        },
        totalPriceCents: booking.totalPriceCents,
        discountCents: booking.discountCents,
        promoAdjustmentCents: booking.promoAdjustmentCents,
        finalPriceCents: booking.finalPriceCents,
      },
      newData: {
        guestCount: updatedBooking.guests.length,
        totalPriceCents: newTotalPriceCents,
        discountCents: promoResult.newDiscountCents,
        promoAdjustmentCents: promoResult.newPromoAdjustmentCents,
        finalPriceCents: newFinalPriceCents,
        settlementMethod: paymentImpact.settlementMethod,
        accountCreditAmountCents: paymentImpact.accountCreditAmountCents,
        policyRetainedAmountCents: paymentImpact.policyRetainedAmountCents,
      },
      priceDiffCents,
      changeFeeCents: 0,
    },
  });

  if (paymentImpact.accountCreditAmountCents > 0) {
    await createBookingModificationCredit(
      booking.memberId,
      paymentImpact.accountCreditAmountCents,
      bookingId,
      bookingModification.id,
      undefined,
      tx,
      booking.payment?.id,
    );
  }

  return {
    booking: updatedBooking,
    removedGuest: guestToRemove,
    priceDiffCents,
    refundAmountCents: paymentImpact.refundAmountCents,
    accountCreditAmountCents: paymentImpact.accountCreditAmountCents,
    pendingRefundAmountCents: paymentImpact.pendingRefundAmountCents,
    additionalAmountCents: paymentImpact.additionalAmountCents,
    settlementMethod: paymentImpact.settlementMethod,
    policyRetainedAmountCents: paymentImpact.policyRetainedAmountCents,
    xeroRefundAmountCents: paymentImpact.xeroRefundAmountCents,
    xeroAdditionalAmountCents: paymentImpact.xeroAdditionalAmountCents,
    hasSucceededPayment: paymentImpact.hasSucceededPayment,
    hasIssuedXeroInvoice: paymentImpact.hasIssuedXeroInvoice,
    paymentStatus: booking.payment?.status ?? null,
    paymentId: booking.payment?.id ?? null,
    paymentCustomerId: booking.payment?.stripeCustomerId ?? null,
    memberEmail: booking.member.email,
    memberName: `${booking.member.firstName} ${booking.member.lastName}`,
    memberId: booking.memberId,
    promoRemoved: promoResult.promoRemoved,
    choreWarnings,
    oldGuestCount: booking.guests.length,
    bookingModificationId: bookingModification.id,
    zeroDollarAutoPaid: lifecycle.zeroDollarAutoPaid,
    supersededPrimaryPaymentIntents: lifecycle.supersededPrimaryPaymentIntents,
    minorsOnlyReviewNewlyFlagged,
    notifyMember: effectiveNotifyMember,
  };
}

export async function loadSeasonRateData(
  tx: Prisma.TransactionClient,
  lodgeId?: string,
): Promise<SeasonRateData[]> {
  const seasons = await tx.season.findMany({
    where: { active: true, ...(lodgeId ? lodgeNullTolerantScope(lodgeId) : {}) },
    include: { rates: true },
  });

  return seasons.map((season) => ({
    seasonId: season.id,
    startDate: season.startDate,
    endDate: season.endDate,
    rates: season.rates.map((rate) => ({
      ageTier: rate.ageTier,
      isMember: rate.isMember,
      pricePerNightCents: rate.pricePerNightCents,
    })),
  }));
}

async function removeGuestChoreAssignments(
  tx: Prisma.TransactionClient,
  guestId: string
) {
  const choreWarnings: string[] = [];
  const guestAssignments = await tx.choreAssignment.findMany({
    where: { bookingGuestId: guestId },
    include: { choreTemplate: true },
  });

  for (const assignment of guestAssignments) {
    if (
      assignment.status === "CONFIRMED" ||
      assignment.status === "COMPLETED"
    ) {
      choreWarnings.push(
        `${assignment.choreTemplate.name} on ${assignment.date.toISOString().split("T")[0]} was ${assignment.status}`
      );
    }
  }

  await tx.choreAssignment.deleteMany({
    where: { bookingGuestId: guestId },
  });

  return choreWarnings;
}

export async function recalculateBookingPromo({
  tx,
  bookingId,
  booking,
  newTotalPriceCents,
  guestNightRates,
}: {
  tx: Prisma.TransactionClient;
  bookingId: string;
  booking: Prisma.BookingGetPayload<{
    include: {
          promoRedemption: {
            include: {
              guestTargets: { select: { bookingGuestId: true } };
              promoCode: {
                include: {
                  assignments: { select: { memberId: true } };
                  lodges: { select: { lodgeId: true } };
                };
              };
            };
          };
    };
  }>;
  newTotalPriceCents: number;
  guestNightRates: Array<{
    bookingGuestId?: string | null;
    memberId: string | null;
    isMember: boolean;
    perNightRates: number[];
    firstNight?: Date | null;
  }>;
}) {
  let newDiscountCents = 0;
  let newPromoAdjustmentCents = 0;
  let promoRemoved = false;

  if (booking.promoRedemption?.promoCode) {
    const promo = booking.promoRedemption.promoCode;
    const selectedGuestIndexes = selectedIndexesForStoredGuestTargets(
      booking.promoRedemption,
      guestNightRates
    );
    const bookingLodgeId = booking.lodgeId ?? (await getDefaultLodgeId(tx));
    const application = await validateAndCalculatePromoDiscount(
      promo,
      {
        memberId: booking.memberId,
        bookingCheckIn: booking.checkIn,
        totalPriceCents: newTotalPriceCents,
        guests: guestNightRates,
      },
      promo.assignments.length > 0
        ? promo.assignments.map((assignment) => assignment.memberId)
        : null,
      { excludeBookingId: bookingId, db: tx, selectedGuestIndexes, lodgeId: bookingLodgeId },
    );

    if (application.error || !application.discount) {
      promoRemoved = true;
      await deletePromoRedemptionAndAdjustCount(tx, booking.promoRedemption);
    } else {
      const discount = application.discount;
      newDiscountCents = discount.discountCents;
      newPromoAdjustmentCents = discount.priceAdjustmentCents;

      await replacePromoRedemptionAllocations(
        tx,
        booking.promoRedemption,
        newDiscountCents,
        newPromoAdjustmentCents,
        discount.freeNightsUsed,
        discount.eligibleGuestCount,
        discount.allocations,
        targetBookingGuestIdsForSelectedIndexes(
          guestNightRates,
          application.selectedGuestIndexes
        ),
      );
    }
  }

  return { newDiscountCents, newPromoAdjustmentCents, promoRemoved };
}
