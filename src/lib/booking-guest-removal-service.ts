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
  lockAndRefreshPromoCodeUsage,
  replacePromoRedemptionAllocations,
  validateAndCalculatePromoDiscount,
} from "@/lib/promo";
import {
  describePromoCapCoverage,
  type PromoCoverageNotice,
} from "@/lib/promo-cap-coverage";
import {
  toEditTimeGroupDiscountConfig,
  toSeasonRateData,
} from "@/lib/policies/booking-route-decisions";
import {
  ADULT_SUPERVISION_REVIEW_REASON,
  minorsReviewAlertShouldFire,
  requiresAdultSupervisionReview,
} from "@/lib/booking-review";
import type { HostingCoverageOverrideInput } from "@/lib/adult-member-hosting-same-owner";
import {
  hostingCoverageActorOptions,
  reconcileAdultMemberHostingReviewWithSiblings,
} from "@/lib/adult-member-hosting-review";
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
  rateSnapshotUpdateForRepricedGuest,
  type BookingModificationSettlementMethod,
  type LoadedBookingForModify,
} from "@/lib/booking-modify";
import type { SupersededPrimaryPaymentIntent } from "@/lib/booking-payment-cleanup";
import { createBookingModificationCredit } from "@/lib/member-credit";
import { reconcileBedAllocationsForBookingWithLodgeLockHeld } from "@/lib/bed-allocation-lifecycle";
import { lockRosterDates } from "@/lib/roster-lock";
import { seasonYearOfStoredDate } from "@/lib/financial-year";
import type { SubscriptionLockoutMode } from "@/lib/membership-lockout-settings";
import {
  evaluateNonMemberPricingRequirements,
  PaidUpAdultMemberRequiredError,
  toSubscriptionLockoutParticipants,
} from "@/lib/subscription-lockout-enforcement";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { getDefaultLodgeId, lodgeNullTolerantScope } from "@/lib/lodges";
import { formatDateOnly } from "@/lib/date-only";
import { storedDateOnly } from "@/lib/stored-calendar-day";
import {
  calendarDateOfDateOnlyInstant,
  type CalendarDate,
} from "@/lib/club-time";
// #2250 — the status half of the self-removal rule now lives in one module so
// the booking page's affordance and the night-conflict card cannot drift from
// this authoritative gate. The gate itself is unchanged.
import { SELF_REMOVABLE_GUEST_BOOKING_STATUSES } from "@/lib/booking-guest-self-removal";

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
  // #2390: set only when a usage cap stopped the promotion reaching somebody
  // this edit added; null means everybody the code applies to is covered.
  promoCoverage: PromoCoverageNotice | null;
  choreWarnings: string[];
  oldGuestCount: number;
  bookingModificationId: string;
  zeroDollarAutoPaid: boolean;
  supersededPrimaryPaymentIntents: SupersededPrimaryPaymentIntent[];
  // #1372: this removal newly dropped a paid (capacity-holding) booking into the
  // blocked minors-only review state, so the route should alert admins.
  minorsOnlyReviewNewlyFlagged: boolean;
};

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
  consentAuthority,
  subscriptionLockoutMode,
  hostingCoverageOverride,
  today,
}: {
  tx: Prisma.TransactionClient;
  bookingId: string;
  guestId: string;
  actorMemberId: string;
  actorRole: string;
  settlementMethod?: BookingModificationSettlementMethod;
  /**
   * #2576 §7: the officer's explicit confirmation and mandatory reason for
   * overriding a same-owner coverage refusal. Ignored for a non-officer actor —
   * including a self-removing member guest, whose change is never blocked and never
   * discloses the owner's other bookings (see `resolveDependentDisposition`).
   */
  hostingCoverageOverride?: HostingCoverageOverrideInput | null;
  /**
   * The club's subscription-lockout mode (#2543), resolved by the caller BEFORE it
   * opened this transaction — `resolveSubscriptionLockoutMode` can refresh the
   * financial-year cache from Xero, which must never happen under the locks this
   * transaction holds. Omitted, the paid-up-adult re-evaluation below falls back to
   * a peek; a consent-authority removal never reaches it at all.
   */
  subscriptionLockoutMode?: SubscriptionLockoutMode;
  /**
   * The club's today (#3123), resolved by the caller BEFORE it opened this
   * transaction, exactly like `subscriptionLockoutMode` above and for the same
   * reason: reading the club's persisted timezone is a
   * `clubTimeSettings.findUnique`, and this transaction holds the per-lodge
   * capacity key (`INV-LOCK-004`). It is the UTC-midnight `@db.Date` encoding
   * (`INV-DATE-026`), and it is REQUIRED rather than defaulted — the default
   * is what let the self-removal window be judged against the container's
   * timezone instead of the club's (`INV-CONFIG-002`).
   */
  today: Date;
  /**
   * Member-guest consent (#2307, epic #2305): the narrow authority that lets a
   * DECLINE or an EXPIRY reach this function at all.
   *
   * Without it, two of the three consent removals are simply unauthorized here.
   * The gate below admits the booking owner, an `ADMIN`, or the guest
   * themselves — and a **delegate** answering for a target who cannot log in
   * (owner decisions D-5/D-10) is none of the three, while the **expiry cron**
   * has no actor at all.
   *
   * WHAT IT DOES, AND WHAT IT DELIBERATELY DOES NOT DO. It authorizes the
   * removal of exactly the one guest id it names, and only once that row already
   * carries the terminal consent status the caller claims — i.e. only after the
   * status-guarded claim in `member-guest-consent-service.ts` has already
   * succeeded **inside this same transaction**. From there the removal runs the
   * *self-removal* gate set, not the owner gate set, so owner decision D-14 is
   * honoured to the letter: a consent removal is refused in exactly the cases a
   * member's own self-removal would be refused, and those refusals are what land
   * a row on the admin exception list (D-15). It grants no new powers on any
   * existing path and cannot remove any other guest — a test asserts that.
   *
   * `actorMemberId` stays the truthful actor. For a delegate decline it is the
   * delegate, so the audit trail names who actually refused rather than writing
   * the target's id into an act the target did not perform. For the cron there
   * is no person, so the caller passes the **booking owner** — the party whose
   * booking is being repriced and who receives the account credit — and the real
   * actor is recorded separately as `cron:member-guest-consent-expiry` in the
   * audit log. Neither case impersonates the target.
   */
  consentAuthority?: {
    kind: "CONSENT_DECLINE" | "CONSENT_EXPIRY";
    /** The only `BookingGuest` id this authority may remove. */
    guestId: string;
    /** Must equal that row's `memberId`, or the authority does not apply. */
    targetMemberId: string;
  };
}): Promise<RemoveBookingGuestResult> {
  // Two-tier lock protocol (#1881). A single-guest removal computes a reduction
  // refund (money) AND re-checks capacity, so it takes BOTH locks: the global
  // lock(1) FIRST so it mutually excludes cancel / settlement / hold-release,
  // then the per-lodge lock. The caller runs this inside prisma.$transaction, so
  // lock(1) here is the transaction's first lock (global-before-per-lodge order).
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
  // Pre-lock read: only the lodge lock key. lodgeId is immutable, so keying the
  // per-lodge lock from this read is safe; the guest set, pricing and refund
  // below consume ONLY the post-lock re-read.
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

  // The consent authority (#2307) is checked against the POST-LOCK re-read, not
  // against anything the caller told us: the guest id must be the one the
  // authority names, the row must belong to the target it names, and the row
  // must ALREADY carry the terminal consent status. That last conjunct is what
  // binds this to the status-guarded claim earlier in the same transaction — an
  // authority cannot be used to remove a live PENDING (or CONFIRMED) row.
  const consentAuthorityApplies =
    consentAuthority !== undefined &&
    consentAuthority.guestId === guestId &&
    guestToRemove !== undefined &&
    guestToRemove.memberId !== null &&
    guestToRemove.memberId === consentAuthority.targetMemberId &&
    guestToRemove.consentStatus ===
      (consentAuthority.kind === "CONSENT_DECLINE" ? "DECLINED" : "EXPIRED");

  const isOwnerOrAdmin =
    !consentAuthorityApplies &&
    (booking.memberId === actorMemberId || actorRole === "ADMIN");
  // A consent removal runs the SELF-REMOVAL gate set on purpose (D-14): the
  // cases in which a never-consented member is trapped on a booking must be
  // exactly the cases in which they could not have taken themselves off, and
  // those refusals are what D-15 routes to the admin exception list.
  const isSelfRemoval =
    consentAuthorityApplies ||
    (!isOwnerOrAdmin && guestToRemove?.memberId === actorMemberId);
  const isLinkedGuestViewer = booking.guests.some(
    (guest) => guest.memberId === actorMemberId,
  );

  if (!isOwnerOrAdmin && !isSelfRemoval && !isLinkedGuestViewer) {
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
    // #3123 — the SAME club day the self-removal test below uses, and the same
    // one the caller resolved before opening this transaction. The policy used
    // to read the environment's day for itself, so the two sides of this
    // function's date reasoning could disagree.
    today,
  });
  // #3123 — BOTH operands moved together, deliberately. `booking.checkIn` is a
  // `@db.Date` and therefore a CALENDAR DAY that takes no timezone at all, so
  // it is decoded zone-free (`storedDateOnly`, `INV-DATE-026`); the right-hand
  // side is a real question about the club's clock and arrives already resolved
  // from outside this transaction. Moving one side alone is the #3107 shape,
  // where two projections cancelled and fixing one of them broke a path that
  // had been working.
  const selfRemovalIsFuture =
    isSelfRemoval && storedDateOnly(booking.checkIn) > today;
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
  const seasonYear = seasonYearOfStoredDate(booking.checkIn);
  await assertMembershipTypeBookingAllowed(tx, {
    ownerMemberId: booking.memberId,
    guests: guestsForPricing,
    seasonYear,
    // Finding 2 (privacy re-review of MG3 #2308): a member removing a guest must
    // not be told the NAME and membership category of a beyond-family member
    // still on the booking; an admin doing the same is entitled to both.
    //
    // A CONSENT-AUTHORITY removal is exempt as well, and for a different reason
    // than the admin one. It is a decline, an expiry sweep or a delegate answer:
    // the acting party is the member being taken OFF the booking, or the cron,
    // and the refusal message is carried back as the operator-visible reason a
    // PENDING row could not be released (D-15's exception list). Collapsing it
    // would blank that reason for the person who has to act on it while
    // disclosing nothing to anybody new — the target can already see the whole
    // booking and its other guests, which is exactly what D-11 tells them before
    // they agree.
    skipAuthorization: actorRole === "ADMIN" || Boolean(consentAuthority),
  });

  // #2543 — the paid-up-adult requirement, re-evaluated over what is LEFT.
  //
  // The requirement used to be checked on additive writes only, so any party
  // could reach the forbidden state in two requests: book with a paid-up adult
  // member (allowed, the unpaid member repriced on the strength of their
  // presence), then remove that adult. Nothing re-evaluated, and no admin review
  // was raised.
  //
  // REFUSED ONLY FOR A VOLUNTARY REMOVAL. A consent DECLINE or EXPIRY must always
  // be able to take its target off the booking — that is owner decision D-14, and
  // refusing it would trap a member on a booking they have declined — and an ADMIN
  // is skipped here exactly as on every other #2543 gate, because the person who
  // would approve the override is the person doing the removal. What is left is
  // the case the finding is about: the booking owner, or a member removing
  // themselves, choosing to take the party's last paid-up adult member off it.
  if (actorRole !== "ADMIN" && !consentAuthority) {
    const nonMemberPricing = await evaluateNonMemberPricingRequirements(tx, {
      mode: subscriptionLockoutMode,
      lodgeId: bookingLodgeId,
      seasonYear: seasonYearOfStoredDate(booking.checkIn),
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      // Owner decision, 3 Aug 2026. It matters most on this path: an unfinancial
      // owner who removes their OWN guest row would otherwise walk out from under
      // the requirement entirely, leaving a party they still own and still pay for
      // with nobody paid-up on it.
      bookingOwnerMemberId: booking.memberId,
      participants: toSubscriptionLockoutParticipants(remainingGuests),
    });
    if (nonMemberPricing?.violation) {
      // AUDIENCE, not authorisation. This is the ONE #2543 gate whose refusal can
      // be delivered to somebody other than the unfinancial member: a member may
      // take their OWN guest row off a booking they do not own, and the owner arm
      // above can then fire alone. `repricedUnpaidMemberCount: 0` would tell that
      // member — often from another family — that the booking owner's subscription
      // is unpaid, which they can learn nowhere else in the app. The refusal, the
      // wording, the HOLD and the override door are unchanged; only that one count
      // is withheld. See `PaidUpAdultRefusalAudience`.
      throw new PaidUpAdultMemberRequiredError(
        nonMemberPricing.violation,
        booking.memberId === actorMemberId ? "BOOKER" : "OTHER_PARTY_MEMBER",
      );
    }
  }

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
    //
    // Edit-time mapper (#2770, INV-MOD-026). A removal buys nothing, so on a
    // healthy booking every remaining night is locked and the switch cannot
    // move a cent either way. It is still gated here rather than left on the
    // creation mapper, because ONE value per edit is the invariant: a club with
    // the switch off must not have its add priced one way and its removal
    // another. Where it can be observed is the documented degradation both
    // INV-MOD-005 and INV-MOD-025 already name — a legacy guest with no stored
    // night rows, whose nights price at current rates; with the switch off
    // those rates are undiscounted, which is the club's stated intent for the
    // edit rather than a reprice of history (no stored price is overwritten).
    groupDiscount: toEditTimeGroupDiscountConfig(groupDiscountSetting),
    seasonYear,
    skipAuthorization: actorRole === "ADMIN",
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
  // #3123 — the SAME club day the caller resolved before it opened this
  // transaction, re-expressed as the calendar day the promo window and the
  // refund tier are written in. `today` arrives as the UTC-midnight `@db.Date`
  // encoding of that day (`INV-DATE-026`) because the self-removal comparison
  // above is written in `Date`s; `calendarDateOfDateOnlyInstant` is its exact
  // inverse, so this is one day in two encodings and NOT a second reading of
  // the club's clock.
  const todayAtClub = calendarDateOfDateOnlyInstant(today);
  const promoResult = await recalculateBookingPromo({
    tx,
    bookingId,
    booking,
    newTotalPriceCents,
    guestNightRates,
    todayAtClub,
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
    db: tx, // locked transaction; see `CancellationPolicyDb`
    // #3123 — the refund tier for this reduction, on the club's day.
    todayAtClub,
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
        // Overwrite the rate-type snapshot alongside the repriced total
        // (#1930, E4) — unless this guest kept a locked night, in which case the
        // stored snapshot stays, because one item code per guest cannot describe
        // a stay that mixes locked member-rate nights with newly priced ones
        // (#2543). See `rateSnapshotUpdateForRepricedGuest`.
        data: {
          priceCents: priceBreakdown.guests[index].priceCents,
          rateMembershipTypeId: rateSnapshotUpdateForRepricedGuest(
            priceBreakdown.guests[index],
            guestsForPricing[index]?.lockedNightPrices,
          ),
        },
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

  await reconcileBedAllocationsForBookingWithLodgeLockHeld({
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
        // #2390: the same sentence the member saw when they made the edit,
        // kept on the booking's own history so "why was I charged that?" has
        // an answer months later. Absent unless a cap left somebody out.
        ...(promoResult.promoCoverage
          ? { promoCoverageNote: promoResult.promoCoverage.message }
          : {}),
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

  // #2364. Removing a guest cuts both ways: taking out the only adult member
  // opens a hosting review, and taking out the last non-member guest closes one.
  // Both are derived from the rows this transaction just wrote, using its own
  // client because it holds the global booking lock and the per-lodge lock.
  //
  // #2576 §6: removing the qualifying adult member is the change class the owner
  // names first, and it can strand ANOTHER booking on this account. The
  // disposition travels with the actor — a member is refused and rolled back, an
  // officer is allowed and escalated.
  await reconcileAdultMemberHostingReviewWithSiblings(bookingId, tx, {
    ...hostingCoverageActorOptions({
      actorRole,
      actorMemberId,
      ...(hostingCoverageOverride ? { override: hostingCoverageOverride } : {}),
    }),
  });

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
    promoCoverage: promoResult.promoCoverage,
    choreWarnings,
    oldGuestCount: booking.guests.length,
    bookingModificationId: bookingModification.id,
    zeroDollarAutoPaid: lifecycle.zeroDollarAutoPaid,
    supersededPrimaryPaymentIntents: lifecycle.supersededPrimaryPaymentIntents,
    minorsOnlyReviewNewlyFlagged,
  };
}

export async function loadSeasonRateData(
  tx: Prisma.TransactionClient,
  lodgeId?: string,
): Promise<SeasonRateData[]> {
  const seasons = await tx.season.findMany({
    where: { active: true, ...(lodgeId ? lodgeNullTolerantScope(lodgeId) : {}) },
    include: { membershipTypeRates: true },
  });

  // #2756: through the shared mapper, which carries the season's `type`. Mapped
  // by hand without it, `summerOnly` — the schema DEFAULT — could never be
  // satisfied, so the guest-removal reprice and the waitlist confirm that shares
  // this loader both priced at the full rate whatever the club had configured.
  return toSeasonRateData(seasons);
}

async function removeGuestChoreAssignments(
  tx: Prisma.TransactionClient,
  guestId: string
) {
  const choreWarnings: string[] = [];
  const lockCandidates = await tx.choreAssignment.findMany({
    where: { bookingGuestId: guestId },
    select: { date: true },
  });

  await lockRosterDates(tx, lockCandidates.map((assignment) => assignment.date));

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
        `${assignment.choreTemplate.name} on ${formatDateOnly(assignment.date)} was ${assignment.status}`
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
  todayAtClub,
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
  /**
   * The club's own calendar day (#3123, `INV-CONFIG-002`), resolved by whichever
   * caller opened the transaction `tx` belongs to, BEFORE it opened it.
   *
   * REQUIRED. `INV-LOCK-004` names the club timezone as one of only two reads
   * that cannot take a transaction client, and both callers hold the per-lodge
   * capacity key and the promo row lock here. It decides the promotion's
   * validity window inside `validateAndCalculatePromoDiscount`.
   */
  todayAtClub: CalendarDate;
}) {
  let newDiscountCents = 0;
  let newPromoAdjustmentCents = 0;
  let promoRemoved = false;
  let promoCoverage: PromoCoverageNotice | null = null;

  if (booking.promoRedemption?.promoCode) {
    // Row-lock the promo code and re-read its usage counter before the caps are
    // checked (#2299). Removing guests can drop the booking's benefit to
    // nothing and RELEASE a total-redemptions slot, so this transaction is a
    // promo-counter writer and must serialise with the others. The per-lodge
    // capacity lock is already held, so the order stays lodge -> promo row.
    const promo = await lockAndRefreshPromoCodeUsage(
      tx,
      booking.promoRedemption.promoCode
    );
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
      {
        excludeBookingId: bookingId,
        db: tx,
        selectedGuestIndexes,
        lodgeId: bookingLodgeId,
        // #2390: never refuse the edit over somebody else's cap consumption —
        // keep whoever is already benefiting and leave out only new people.
        capOverflow: "coverExisting",
        // #3123 — resolved outside this transaction by the caller.
        todayAtClub,
      },
    );

    if (application.error || !application.discount) {
      promoRemoved = true;
      await deletePromoRedemptionAndAdjustCount(tx, booking.promoRedemption);
    } else {
      const discount = application.discount;
      newDiscountCents = discount.discountCents;
      newPromoAdjustmentCents = discount.priceAdjustmentCents;
      promoCoverage = await describePromoCapCoverage(tx, {
        promoCode: promo.code,
        capCoverage: application.capCoverage,
      });

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

  return { newDiscountCents, newPromoAdjustmentCents, promoRemoved, promoCoverage };
}
