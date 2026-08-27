import {
  type AgeTier,
  type Booking,
  type BookingGuest,
  type Payment,
  PaymentSource,
  PaymentStatus,
  type Role,
} from "@prisma/client";

import { ApiError } from "@/lib/api-error";
import { MinimumStayPolicyViolationError } from "@/lib/booking-policy-exceptions";
import { logAudit } from "@/lib/audit";
import {
  queueSupersededPrimaryIntentCancellations,
} from "@/lib/booking-payment-cleanup";
import {
  canModifyBookingStatusForRole,
  getBookingEditPolicy,
  usesActiveBookingEditLifecycle,
} from "@/lib/booking-edit-policy";
import { clubTime, clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { dateOnlyInstantOf } from "@/lib/club-time";
import { linkModificationToOutstandingChangeRequest } from "@/lib/booking-change-request-linkage";
import { assertBookingEnvelopeInvariants } from "@/lib/booking-envelope-invariants";
import {
  hostingCoverageActorOptions,
  reconcileAdultMemberHostingReviewWithSiblings,
} from "@/lib/adult-member-hosting-review";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import type { HostingCoverageOverrideInput } from "@/lib/adult-member-hosting-same-owner";
import {
  createModificationAdditionalPaymentIntent,
  executeBookingModificationRefund,
  type BookingModificationPaymentContext,
} from "@/lib/booking-modification-settlement";
import {
  acquireLodgeCapacityLock,
  checkCapacity,
  checkCapacityForGuestRanges,
} from "@/lib/capacity";
import {
  OverCapacityConfirmationRequiredError,
  overCapacityNights,
  wholeLodgeBlockedNights,
  WholeLodgeHoldBlockedError,
} from "@/lib/over-capacity-confirmation";
import { getDefaultLodgeId, lodgeNullTolerantScope } from "@/lib/lodges";
import {
  applyPaymentAdjustments,
  assertBookingNotQuotePriced,
  calculateModificationSettlementOptions,
  lockedNightPricesForGuest,
  rateSnapshotUpdateForRepricedGuest,
  type BookingModificationSettlementMethod,
  type LoadedBookingForModify,
} from "@/lib/booking-modify";
import { assertNoBookingMemberNightConflicts } from "@/lib/booking-member-night-conflicts";
import { markCrossFamilyGuestsOnBooking } from "@/lib/member-guest-add-policy";
import {
  clampAppliedCreditToBookingPrice,
  createBookingModificationCredit,
  deriveBookingAppliedCreditCents,
} from "@/lib/member-credit";
import { clearStaleCreditElection } from "@/lib/booking-credit-election";
import {
  daysUntilDate,
  getNonMemberHoldPolicy,
  loadCancellationPolicy,
} from "@/lib/cancellation";
import { calculateChangeFee } from "@/lib/change-fee";
import {
  cleanupChoreAssignmentsForDateChange,
  cleanupChoreAssignmentsForGuestStayRanges,
} from "@/lib/chore-cleanup";
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import { storedDateOnly } from "@/lib/stored-calendar-day";
import { sendBookingModifiedEmail } from "@/lib/email";
import logger from "@/lib/logger";
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
import { prisma } from "@/lib/prisma";
import {
  type SeasonRateData,
} from "@/lib/pricing";
import {
  assertMembershipTypeBookingAllowed,
  MembershipTypeBookingPolicyError,
  priceBookingGuestsWithMembershipTypePolicy,
} from "@/lib/membership-type-policy";
import {
  calculateBookingHoldDecision,
  toEditTimeGroupDiscountConfig,
  toSeasonRateData,
} from "@/lib/policies/booking-route-decisions";
import {
  lockRosterDateRangesAndDates,
  rosterOperationalDayRange,
} from "@/lib/roster-lock";
import { processWaitlistForDates } from "@/lib/waitlist";
import { queueXeroBookingEditSettlement } from "@/lib/xero-booking-edit-settlement";
import {
  assertProposedCheckInClearsXeroLockDate,
  assertProposedDateEditClearsXeroLockDate,
} from "@/lib/xero-period-lock-guard";
import { reconcileBedAllocationsForBookingWithLodgeLockHeld } from "@/lib/bed-allocation-lifecycle";
import { seasonYearOfStoredDate } from "@/lib/financial-year";

export type ModifyBookingDatesInput = {
  checkIn?: string;
  checkOut?: string;
  settlementMethod?: BookingModificationSettlementMethod;
  // Admin-only date override (issue #1668). Only honoured for actor.role ADMIN.
  // adminOverride lifts the date-window locks (in-progress / fully-past);
  // confirmOverCapacity turns an over-capacity target from a throw into a
  // confirmed overbooking. pricingMode "shift" is dispatched at the route to
  // adminShiftBookingDates and never reaches modifyBookingDates; only
  // "recalculate" flows through here.
  adminOverride?: boolean;
  confirmOverCapacity?: boolean;
  // Owner decision (#1668 review): the admin chooses per override edit whether
  // the member receives the change-notification email. Absent = notify.
  notifyMember?: boolean;
};

type ModifiedBooking = Booking & {
  guests: BookingGuest[];
  payment: Payment | null;
};

type DateModificationTransactionResult =
  BookingModificationPaymentContext & {
    booking: ModifiedBooking;
    priceDiffCents: number;
    changeFeeCents: number;
    refundAmountCents: number;
    accountCreditAmountCents: number;
    settlementMethod: BookingModificationSettlementMethod | null;
    policyRetainedAmountCents: number;
    promoRemoved: boolean;
    // #2390: set only when a usage cap stopped the promotion reaching somebody
    // on the repriced booking; null means everyone it applies to is covered.
    promoCoverage: PromoCoverageNotice | null;
    choreWarnings: string[];
    datesChanged: boolean;
    adminOverride: boolean;
    notifyMember: boolean;
    capacityOverridden: boolean;
    oldCheckIn: Date;
    oldCheckOut: Date;
    hasIssuedXeroInvoice: boolean;
    paymentStatus: PaymentStatus | null;
    paymentSource: PaymentSource | null;
    paymentReference: string | null;
    xeroInvoiceNumber: string | null;
    xeroRefundAmountCents: number;
    xeroAdditionalAmountCents: number;
    // F20 (#1887): the reprice landed the booking fully credit-covered and it
    // was auto-confirmed at $0, so the primary Xero invoice must be created.
    zeroDollarAutoPaid: boolean;
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

export type DateModificationResponse = {
  booking: ModifiedBooking;
  priceDiffCents: number;
  changeFeeCents: number;
  refundAmountCents: number;
  accountCreditAmountCents: number;
  settlementMethod: BookingModificationSettlementMethod | null;
  policyRetainedAmountCents: number;
  additionalAmountCents: number;
  additionalPaymentClientSecret: string | null;
  stripeRefundId: string | null;
  promoRemoved: boolean;
  promoCoverage: PromoCoverageNotice | null;
  choreWarnings: string[];
  // Admin override (issue #1668): true when an over-capacity target was
  // explicitly confirmed. Always false on the standard (hard-blocked) path.
  capacityOverridden: boolean;
};

export async function modifyBookingDates({
  bookingId,
  actor,
  hostingCoverageOverride,
  input,
  ipAddress,
}: {
  bookingId: string;
  actor: { id: string; role: Role };
  /**
   * #2576 §7: the officer's explicit confirmation and mandatory reason for
   * overriding a same-owner coverage refusal. Ignored for a non-officer actor, so a
   * member cannot self-authorise past §6's block by inventing a reason.
   */
  hostingCoverageOverride?: HostingCoverageOverrideInput | null;
  input: ModifyBookingDatesInput;
  ipAddress: string;
}): Promise<DateModificationResponse> {
  const {
    checkIn: newCheckInStr,
    checkOut: newCheckOutStr,
    settlementMethod,
    confirmOverCapacity,
  } = input;
  // Issue #1668: only an admin drives the recalculate override on this route.
  const adminOverride = Boolean(input.adminOverride) && actor.role === "ADMIN";
  // Owner decision (#1668/#1696): an admin chooses per edit whether the member is
  // emailed — on override AND plain edits — with absent meaning notify. A
  // non-admin actor can never suppress (the route 403s any notify flag), so they
  // always notify (unchanged).
  const notifyMember =
    actor.role !== "ADMIN" ? true : input.notifyMember !== false;

  // Xero lock-date guard: both branches run BEFORE the transaction — the
  // guard performs a Xero API call, which must stay outside any DB
  // transaction, and the pre-read is only advisory (the outbox still fails
  // safely if the lock dates change mid-flight).
  if (adminOverride) {
    // Override path (#1697): the override on this route is always the
    // recalculate mode (shift is dispatched to adminShiftBookingDates at the
    // route), and a recalculate can queue a check-in-dated primary-invoice
    // write (date/narration update on unpaid bookings; create on zero-dollar
    // ones) — so the proposed check-in must clear the effective lock date,
    // same semantics as the retroactive create (#1695). Deliberately
    // conservative: fires even when the settlement would only write
    // today-dated documents (decision on #1697, re-affirmed on #1718).
    await assertProposedCheckInClearsXeroLockDate(
      prisma,
      bookingId,
      newCheckInStr,
    );
  } else {
    // Ordinary edits (#1729) get the NARROW guard instead: it consults the
    // lock dates only when this edit would actually queue the check-in-dated
    // invoice update (issued Xero invoice + dates changing + payment not
    // settled — the settlement classifier's own predicate), with member-
    // appropriate error text for non-admin actors.
    await assertProposedDateEditClearsXeroLockDate(
      prisma,
      bookingId,
      { checkIn: newCheckInStr, checkOut: newCheckOutStr },
      {
        audience: actor.role === "ADMIN" ? "admin" : "member",
        actorMemberId: actor.id,
      },
    );
  }

  // #3123 — the club's day, resolved BEFORE the transaction opens. The edit
  // policy inside it is a pure synchronous classifier and takes the day as a
  // value: resolving the club's persisted zone in there would be a
  // `clubTimeSettings.findUnique` on a second pooled connection while the global
  // cohort key and the lodge capacity key are both held (`INV-LOCK-004`).
  //
  // FOUR decisions inside the transaction read this ONE day: the edit policy's
  // gate, the promotion's validity window, the late-notice change fee's two
  // day-counts, and the reduction refund's settlement tier. The last three move
  // money, and two todays on one date change would price it against itself.
  const todayAtClub = (await clubTime()).today();
  const clubTodayDateOnly = dateOnlyInstantOf(todayAtClub);

  const result = await prisma.$transaction(async (tx) => {
    // Two-tier lock protocol (#1881): a date change moves money (reduction
    // refund / additional charge) AND claims capacity for the new range, so it
    // takes BOTH locks — global lock(1) FIRST (mutual exclusion with cancel /
    // settlement / hold-release), then the per-lodge lock.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    // Pre-lock read: only the lodge lock key. lodgeId is immutable, so keying the
    // per-lodge lock from this read is safe; every capacity- and price-relevant
    // field below is taken from the post-lock re-read.
    const lockTarget = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { lodgeId: true },
    });
    const bookingLodgeId = lockTarget?.lodgeId ?? (await getDefaultLodgeId(tx));
    await acquireLodgeCapacityLock(tx, bookingLodgeId);

    // Re-read the full booking under the lock; all validation, pricing, the
    // capacity check and the claim consume ONLY this post-lock snapshot.
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
      throw new ApiError("Booking not found", 404);
    }

    if (booking.memberId !== actor.id && actor.role !== "ADMIN") {
      throw new ApiError("Forbidden", 403);
    }
    await assertBookingNotQuotePriced(tx, bookingId);

    // Under an admin override the fully-past COMPLETED status is editable too
    // (issue #1668); the standard path keeps the active-lifecycle allowlist.
    const allowedStatuses = adminOverride
      ? ["PENDING", "PAYMENT_PENDING", "CONFIRMED", "PAID", "COMPLETED"]
      : ["PENDING", "PAYMENT_PENDING", "CONFIRMED", "PAID"];
    if (!allowedStatuses.includes(booking.status)) {
      throw new ApiError(
        "Only PENDING, PAYMENT_PENDING, CONFIRMED, or PAID bookings can be modified",
        400,
      );
    }

    const editPolicy = getBookingEditPolicy({
      status: booking.status,
      role: actor.role,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      adminOverride,
      today: clubTodayDateOnly,
    });
    if (!editPolicy.canModify) {
      throw new ApiError(
        editPolicy.reason ?? "This booking cannot be modified",
        400,
      );
    }
    // In-progress/fully-past date changes are still routed through the full edit
    // flow — except under an explicit admin override, whose policy mode is
    // "admin-override" (issue #1668).
    if (editPolicy.mode !== "future" && editPolicy.mode !== "admin-override") {
      throw new ApiError(
        "Use the full booking edit flow for in-progress booking date changes",
        400,
      );
    }

    const newCheckIn = newCheckInStr
      ? parseDateOnly(newCheckInStr)
      : booking.checkIn;
    const newCheckOut = newCheckOutStr
      ? parseDateOnly(newCheckOutStr)
      : booking.checkOut;

    if (
      Number.isNaN(newCheckIn.getTime()) ||
      Number.isNaN(newCheckOut.getTime())
    ) {
      throw new ApiError("Invalid booking dates", 400);
    }

    if (newCheckOut <= newCheckIn) {
      throw new ApiError("Check-out must be after check-in", 400);
    }

    const existingAssignmentDates = await tx.choreAssignment.findMany({
      where: { bookingId },
      select: { date: true },
    });
    // #2622: the ranges reach the check-out day, so the old and new check-out
    // dates — where a departure-morning chore row can now live — are inside the
    // one sorted set taken before any tuple write.
    await lockRosterDateRangesAndDates(
      tx,
      [
        rosterOperationalDayRange(booking.checkIn, booking.checkOut),
        rosterOperationalDayRange(newCheckIn, newCheckOut),
      ],
      existingAssignmentDates.map((assignment) => assignment.date),
    );

    // CT-4 (#2870), #3088: THE STORED DAY, NOT A ZONE PROJECTION OF IT. The
    // preview twin — the `editPolicy.today` gate in `modify-quote/route.ts` —
    // reads the REQUESTED day through `storedDateOnly` too, so a projection here
    // alone quoted one window and refused another, a day apart, behind
    // Greenwich. What `editPolicy.today` is — and is NOT — is stated once, at
    // `getBookingEditPolicy`. Same reads in `booking-modify-validation.ts`.
    if (
      actor.role !== "ADMIN" &&
      storedDateOnly(newCheckIn) <= editPolicy.today
    ) {
      throw new ApiError(
        "NZ today and earlier are locked for self-service changes",
        400,
      );
    }

    if (actor.role !== "ADMIN") {
      const { validateMinimumStay, formatViolationsDetail } = await import("@/lib/booking-policies");
      // `tx`, never the module client — see the composition rule on
      // `validateMinimumStay`: this check runs inside the transaction that
      // already holds the global money lock and the per-lodge capacity lock.
      const stayResult = await validateMinimumStay(
        newCheckIn,
        newCheckOut,
        bookingLodgeId,
        tx,
      );
      if (!stayResult.valid) {
        throw new MinimumStayPolicyViolationError(
          formatViolationsDetail(stayResult.violations),
          stayResult.violations,
        );
      }
    }

    // Standard path hard-blocks over capacity. Under an admin override
    // (issue #1668) the target nights warn-and-confirm instead: the per-lodge
    // lock is still held (above); over capacity throws OverCapacityConfirmation
    // RequiredError unless confirmOverCapacity was sent. A date change resets
    // every guest to the full new envelope, so the guest-range check (whose
    // availableBeds bakes in the proposed guests) is the correct signal.
    let capacityOverridden = false;
    if (adminOverride) {
      const capacity = await checkCapacityForGuestRanges(
        bookingLodgeId,
        newCheckIn,
        newCheckOut,
        booking.guests.map(() => ({
          stayStart: newCheckIn,
          stayEnd: newCheckOut,
        })),
        bookingId,
        tx,
      );
      if (!capacity.available) {
        if (!confirmOverCapacity) {
          throw new OverCapacityConfirmationRequiredError(
            overCapacityNights(capacity),
          );
        }
        // Confirmed override cannot bypass an exclusive hold (ADR-001 decision
        // 5, issue #118) — refuse before stamping capacityOverridden.
        const blocked = wholeLodgeBlockedNights(capacity);
        if (blocked.length > 0) {
          throw new WholeLodgeHoldBlockedError(blocked);
        }
        capacityOverridden = true;
      }
    } else {
      const capacity = await checkCapacity(
        bookingLodgeId,
        newCheckIn,
        newCheckOut,
        booking.guests.length,
        bookingId,
        tx,
      );

      if (!capacity.available) {
        throw new ApiError(
          "Not enough beds available for the new dates",
          400,
        );
      }
    }

    const seasons = await tx.season.findMany({
      where: { active: true, ...lodgeNullTolerantScope(bookingLodgeId) },
      include: { membershipTypeRates: true },
    });

    // #2756: through the shared mapper, which carries the season's `type`. This
    // is the ordinary date change INV-MOD-006 lists as a path the discount
    // already reached; the hand-rolled literal it used dropped `type`, so at a
    // club on the DEFAULT `summerOnly: true` setting it never did.
    const seasonRateData: SeasonRateData[] = toSeasonRateData(seasons);

    const guestsForPricing = booking.guests.map((g) => ({
      bookingGuestId: g.id,
      ageTier: g.ageTier as AgeTier,
      isMember: g.isMember,
      memberId: g.memberId ?? null,
      // Policy (#1093): a booking date change resets every guest — partial
      // stays included — to the full new range, mirroring the batch path's
      // date-change reset. That is why no per-guest night set is passed here.
      // Nights kept across the date change keep their booked price (#1036);
      // only the nights the new range adds price at current season rates.
      lockedNightPrices: lockedNightPricesForGuest(g),
    }));
    const seasonYear = seasonYearOfStoredDate(newCheckIn);
    await assertMembershipTypeBookingAllowed(tx, {
      ownerMemberId: booking.memberId,
      guests: guestsForPricing,
      seasonYear,
      // Finding 2 (privacy re-review of MG3 #2308) — see
      // `getMembershipTypeBookingPolicyBlocks`.
      skipAuthorization: actor.role === "ADMIN",
    });

    const groupDiscountSetting = await tx.groupDiscountSetting.findUnique({
      where: { id: "default" },
    });
    let priceBreakdown;
    try {
      priceBreakdown = await priceBookingGuestsWithMembershipTypePolicy(tx, {
        ownerMemberId: booking.memberId,
        checkIn: newCheckIn,
        checkOut: newCheckOut,
        guests: guestsForPricing,
        seasons: seasonRateData,
        // Group discount applies to the nights the new range adds (#1095);
        // nights kept across the date change stay at their locked prices.
        // Edit-time mapper (#2770, INV-MOD-026): a date change is a later edit,
        // so the club's `applyToEdits` switch governs the nights it buys. Off
        // resolves to no config, so the added nights price exactly as they
        // would at a club with no group discount at all.
        groupDiscount: toEditTimeGroupDiscountConfig(groupDiscountSetting),
        seasonYear,
        skipAuthorization: actor.role === "ADMIN",
      });
    } catch (error) {
      if (error instanceof MembershipTypeBookingPolicyError) {
        throw error;
      }
      throw new ApiError(
        "No season rate found for the requested dates",
        400,
      );
    }

    // One-live-booking-per-member-per-night guard (#1157, #1127 F1). A date
    // change resets every guest to the new envelope (see the write loop below),
    // so re-check that no member-linked guest lands on a night where that member
    // is already on another live booking. Mirror the ranges the service is about
    // to persist — stayStart/stayEnd = the new envelope, nights = the priced
    // night set — so the guard evaluates exactly what will exist. This runs
    // under the per-lodge acquireLodgeCapacityLock taken above and before any
    // BookingGuest/BookingGuestNight/Booking writes, so a conflict rolls back
    // with nothing written.
    //
    // C1 (privacy review of MG3 #2308): every guest here is an EXISTING one, so
    // none of them carries the add-time cross-family marker and the guard would
    // otherwise answer a stranger's occupancy in full on every date change. Mark
    // the party from the live family boundary first — see
    // `markCrossFamilyGuestsOnBooking`.
    const guestsForMemberNightGuard = await markCrossFamilyGuestsOnBooking(
      tx,
      booking.memberId,
      booking.guests.map((g, index) => ({
        memberId: g.memberId ?? null,
        stayStart: newCheckIn,
        stayEnd: newCheckOut,
        nights: priceBreakdown.guests[index].nightDates ?? [],
      })),
      { skipAuthorization: actor.role === "ADMIN", bookingId },
    );
    await assertNoBookingMemberNightConflicts(tx, {
      actorMemberId: actor.id,
      actorRole: actor.role,
      checkIn: newCheckIn,
      checkOut: newCheckOut,
      guests: guestsForMemberNightGuard,
      excludeBookingId: bookingId,
      // The club day resolved before this transaction opened, threaded in
      // rather than read under the locks (`INV-LOCK-004`). The same day the
      // edit policy, the change fee and the settlement tier above use.
      today: clubTodayDateOnly,
    });

    const newTotalPriceCents = priceBreakdown.totalPriceCents;
    const guestNightRates = guestsForPricing.map((guest, index) => ({
      bookingGuestId: guest.bookingGuestId,
      memberId: guest.memberId ?? null,
      isMember: guest.isMember,
      perNightRates: priceBreakdown.guests[index].perNightCents,
      nightDates: priceBreakdown.guests[index].nightDates,
      // Guests are priced over the full new range here, so the first rate
      // is the new check-in night. Dates the rates so internal work-party
      // promos restrict the discount to the event's night window.
      firstNight: newCheckIn,
    }));

    let newDiscountCents = 0;
    let newPromoAdjustmentCents = 0;
    let promoRemoved = false;
    let promoCoverage: PromoCoverageNotice | null = null;

    if (booking.promoRedemption?.promoCode) {
      // Row-lock the promo code and re-read its usage counter before the caps
      // are checked (#2299). This reprice can release a total-redemptions slot
      // (the new dates leave the promo with no benefit) or re-take one, so
      // check-then-consume must be serialised against every other promo writer.
      // The per-lodge capacity lock is already held, so the order stays
      // lodge -> promo row.
      const promo = await lockAndRefreshPromoCodeUsage(
        tx,
        booking.promoRedemption.promoCode
      );
      const selectedGuestIndexes = selectedIndexesForStoredGuestTargets(
        booking.promoRedemption,
        guestNightRates
      );
      const application = await validateAndCalculatePromoDiscount(
        promo,
        {
          memberId: booking.memberId,
          bookingCheckIn: newCheckIn,
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
          // #2390: a member moving their dates is never blocked by somebody
          // else's cap consumption, and never loses a discount they already had.
          capOverflow: "coverExisting",
          // #3123 — resolved above, before this transaction opened.
          todayAtClub,
        },
      );

      if (application.error || !application.discount) {
        promoRemoved = true;
        await deletePromoRedemptionAndAdjustCount(tx, booking.promoRedemption);
      } else {
        const promoResult = application.discount;
        newDiscountCents = promoResult.discountCents;
        newPromoAdjustmentCents = promoResult.priceAdjustmentCents;
        promoCoverage = await describePromoCapCoverage(tx, {
          promoCode: promo.code,
          capCoverage: application.capCoverage,
        });

        await replacePromoRedemptionAllocations(
          tx,
          booking.promoRedemption,
          newDiscountCents,
          newPromoAdjustmentCents,
          promoResult.freeNightsUsed,
          promoResult.eligibleGuestCount,
          promoResult.allocations,
          targetBookingGuestIdsForSelectedIndexes(
            guestNightRates,
            application.selectedGuestIndexes
          ),
        );
      }
    }

    const newFinalPriceCents = newTotalPriceCents + newPromoAdjustmentCents;
    const priceDiffCents = newFinalPriceCents - booking.finalPriceCents;

    let changeFeeCents = 0;
    const checkInChanged =
      newCheckIn.getTime() !== new Date(booking.checkIn).getTime();

    if (checkInChanged) {
      const policy = await loadCancellationPolicy(booking.checkIn, booking.lodgeId, tx);
      const feeResult = calculateChangeFee({
        // #3123 — one club day for both operands.
        daysUntilOriginalCheckIn: daysUntilDate(booking.checkIn, todayAtClub),
        daysUntilNewCheckIn: daysUntilDate(newCheckIn, todayAtClub),
        originalFinalPriceCents: booking.finalPriceCents,
        policyRules: policy,
      });
      changeFeeCents = feeResult.feeCents;
    }

    // Settle the date change through the same policy-based machinery the batch
    // modify path uses (#1024). netCharge folds the change fee into the price
    // delta, so the cancellation-policy tier is applied to the fee-adjusted
    // reduction and the member must choose card vs credit. Previously this
    // path refunded the full Math.abs(netAmount) with no policy tier, letting a
    // member shorten a booking inside the cancellation window and recover more
    // than cancelling or removing guests for the same nights would return.
    const netChargeCents = priceDiffCents + changeFeeCents;
    const settlementOptions = await calculateModificationSettlementOptions({
      booking: booking as unknown as LoadedBookingForModify,
      netChargeCents,
      db: tx, // locked transaction; see `CancellationPolicyDb`
      todayAtClub,
    });
    if (settlementOptions?.requiresSettlementMethod && !settlementMethod) {
      throw new ApiError(
        "Choose a refund or account credit before saving",
        400,
      );
    }
    const payments = await applyPaymentAdjustments(tx, {
      booking: booking as unknown as LoadedBookingForModify,
      priceDiffCents,
      changeFeeCents,
      settlementOptions,
      settlementMethod,
    });
    const {
      refundAmountCents,
      accountCreditAmountCents,
      additionalAmountCents,
      pendingRefundAmountCents,
      hasSucceededPayment,
      hasIssuedXeroInvoice,
      xeroRefundAmountCents,
      xeroAdditionalAmountCents,
    } = payments;

    const hasNonMembers = booking.guests.some((g) => !g.isMember);
    let newNonMemberHoldUntil = booking.nonMemberHoldUntil;
    let newStatus = booking.status;

    if (hasNonMembers) {
      const holdPolicy = await getNonMemberHoldPolicy(newCheckIn, booking.lodgeId, tx);
      const holdDecision = calculateBookingHoldDecision({
        hasNonMembers,
        checkIn: newCheckIn,
        holdDays: holdPolicy.holdDays,
        holdEnabled: holdPolicy.enabled,
      });

      if (holdDecision.shouldBePending) {
        newNonMemberHoldUntil = new Date(
          newCheckIn.getTime() - holdPolicy.holdDays * 24 * 60 * 60 * 1000,
        );
      } else {
        newNonMemberHoldUntil = null;
        if (booking.status === "PENDING") {
          newStatus = "PAYMENT_PENDING";
        }
      }
    } else {
      newNonMemberHoldUntil = null;
    }

    // F20 (#1887): a date change that reduces the price can drop finalPriceCents
    // below the account credit applied at booking-create. Refund the
    // over-consumed slice and take the EFFECTIVE (credit-reduced) price: a now
    // fully-credit-covered booking auto-confirms at $0 (mirroring both the batch
    // modify path and booking-create) instead of dead-ending at the card-intent
    // guard, which rejects effective <= 0.
    // F1 (#1887): gate on the LEDGER + a pre-payment status, NOT the payment's
    // creditAppliedCents mirror. A CARD booking has no Payment row until it
    // requests a card intent, so the mirror gate missed the card booking whose
    // dates are changed in PAYMENT_PENDING — the exact surface that would then
    // dead-end unpayable at the card-intent guard with credit over-consumed. A
    // cheap UNLOCKED ledger read keeps a no-credit date change byte-for-byte
    // unchanged (no lock, no $0 path). Restricted to PENDING/PAYMENT_PENDING so a
    // date change on a booking under review does not refund credit pre-approval
    // (F4, #1887); the clamp runs once the booking is released to PAYMENT_PENDING.
    let zeroDollarAutoPaid = false;
    const isRepriceablePrePayment =
      newStatus === "PENDING" || newStatus === "PAYMENT_PENDING";
    const appliedBeforeClamp = isRepriceablePrePayment
      ? await deriveBookingAppliedCreditCents(bookingId, tx)
      : 0;
    if (appliedBeforeClamp > 0) {
      const clampedCredit = await clampAppliedCreditToBookingPrice(
        { memberId: booking.memberId, bookingId, newFinalPriceCents },
        tx,
      );
      const effectivePriceCents =
        newFinalPriceCents - clampedCredit.appliedCreditCents;
      if (effectivePriceCents === 0 && newStatus === "PAYMENT_PENDING") {
        newStatus = "PAID";
        zeroDollarAutoPaid = true;
        // #2265 (#2319). Same as the batch-modify sibling in
        // booking-modify-settlement.ts: a booking settling at $0 owes nothing, so
        // a stored credit election is moot and must not ride into a PAID row.
        // Silent by design — no credit was consumed and none is owed, so there is
        // no unhonoured choice to report.
        await clearStaleCreditElection(tx, booking);
        await tx.payment.upsert({
          where: { bookingId },
          create: {
            bookingId,
            amountCents: 0,
            creditAppliedCents: clampedCredit.appliedCreditCents,
            status: PaymentStatus.SUCCEEDED,
          },
          update: {
            amountCents: 0,
            creditAppliedCents: clampedCredit.appliedCreditCents,
            status: PaymentStatus.SUCCEEDED,
            stripePaymentIntentId: null,
            stripePaymentMethodId: null,
            additionalPaymentIntentId: null,
            additionalAmountCents: 0,
            additionalPaymentStatus: null,
          },
        });
      }
    }

    // Re-sync each guest's BookingGuestNight rows to the priced nights of the
    // new range (#1093). Leaving the old rows in place would hand a later edit
    // a stale night set — it would price the guest over nights the booking no
    // longer covers instead of the range they now hold.
    await Promise.all(
      booking.guests.map(async (g, i) => {
        await tx.bookingGuest.update({
          where: { id: g.id },
          data: {
            stayStart: newCheckIn,
            stayEnd: newCheckOut,
            priceCents: priceBreakdown.guests[i].priceCents,
            // A date change re-bases every guest at current rates (#1930, E4):
            // overwrite the rate-type snapshot with the newly priced total —
            // EXCEPT where the new range keeps nights the guest already bought,
            // whose locked prices survive (#1036). One item code per guest
            // cannot describe a stay that mixes locked member-rate nights with
            // newly priced non-member ones, so there the stored snapshot stands
            // (#2543). See `rateSnapshotUpdateForRepricedGuest`.
            rateMembershipTypeId: rateSnapshotUpdateForRepricedGuest(
              priceBreakdown.guests[i],
              guestsForPricing[i]?.lockedNightPrices,
            ),
          },
        });
        await tx.bookingGuestNight.deleteMany({
          where: { bookingGuestId: g.id },
        });
        const nightDates = priceBreakdown.guests[i].nightDates ?? [];
        if (nightDates.length > 0) {
          await tx.bookingGuestNight.createMany({
            data: nightDates.map((stayDate, k) => ({
              bookingGuestId: g.id,
              stayDate,
              priceCents: priceBreakdown.guests[i].perNightCents[k] ?? 0,
            })),
          });
        }
      }),
    );

    const oldCheckIn = new Date(booking.checkIn);
    const oldCheckOut = new Date(booking.checkOut);
    const datesChanged =
      newCheckIn.getTime() !== oldCheckIn.getTime() ||
      newCheckOut.getTime() !== oldCheckOut.getTime();
    const dateCleanup = await cleanupChoreAssignmentsForDateChange(
      tx,
      bookingId,
      newCheckIn,
      newCheckOut,
      { rosterDatesAlreadyLocked: true },
    );
    const rangeCleanup = await cleanupChoreAssignmentsForGuestStayRanges(
      tx,
      bookingId,
      { rosterDatesAlreadyLocked: true },
    );
    const choreWarnings = [
      ...dateCleanup.choreWarnings,
      ...rangeCleanup.choreWarnings,
    ];

    const updatedBooking = await tx.booking.update({
      where: { id: bookingId },
      data: {
        checkIn: newCheckIn,
        checkOut: newCheckOut,
        totalPriceCents: newTotalPriceCents,
        discountCents: newDiscountCents,
        promoAdjustmentCents: newPromoAdjustmentCents,
        finalPriceCents: newFinalPriceCents,
        nonMemberHoldUntil: newNonMemberHoldUntil,
        status: newStatus,
        // Persisted capacity override (#1771): this date change re-evaluates
        // capacity against the *new* nights (capacityOverridden above), so the
        // marker must be RECONCILED, not just set. Stamp the acting admin when
        // the new range was admitted over capacity behind a confirm; CLEAR any
        // prior stamp when the modification moved the booking back within
        // capacity — otherwise a stale flag from the old nights would suppress
        // a legitimate cancel when the new nights later fill.
        capacityOverriddenAt: capacityOverridden ? new Date() : null,
        capacityOverriddenByMemberId: capacityOverridden ? actor.id : null,
      },
      include: { guests: true, payment: true },
    });

    await reconcileBedAllocationsForBookingWithLodgeLockHeld({
      bookingId,
      db: tx,
      previousRange: {
        checkIn: oldCheckIn,
        checkOut: oldCheckOut,
      },
    });

    if (updatedBooking.payment) {
      await queueSupersededPrimaryIntentCancellations(tx, {
        bookingId,
        paymentId: updatedBooking.payment.id,
        // A credit-covered $0 auto-pay sweeps every positive pending intent
        // (effective price 0); otherwise supersede only the intents stranded at
        // the old amount (#1161).
        newFinalPriceCents: zeroDollarAutoPaid ? 0 : newFinalPriceCents,
      });
    }

    const bookingModification = await tx.bookingModification.create({
      data: {
        bookingId,
        memberId: actor.id,
        modificationType: "DATE_CHANGE",
        previousData: {
          checkIn: formatDateOnly(oldCheckIn),
          checkOut: formatDateOnly(oldCheckOut),
          totalPriceCents: booking.totalPriceCents,
          discountCents: booking.discountCents,
          promoAdjustmentCents: booking.promoAdjustmentCents,
          finalPriceCents: booking.finalPriceCents,
        },
        newData: {
          checkIn: formatDateOnly(newCheckIn),
          checkOut: formatDateOnly(newCheckOut),
          totalPriceCents: newTotalPriceCents,
          discountCents: newDiscountCents,
          promoAdjustmentCents: newPromoAdjustmentCents,
          finalPriceCents: newFinalPriceCents,
          settlementMethod: payments.settlementMethod,
          accountCreditAmountCents: payments.accountCreditAmountCents,
          policyRetainedAmountCents: payments.policyRetainedAmountCents,
          // #2390: the same sentence the member was shown at the edit, kept on
          // the booking's own history so the split has an answer later.
          ...(promoCoverage ? { promoCoverageNote: promoCoverage.message } : {}),
          ...(adminOverride
            ? { pricingMode: "recalculate", capacityOverridden }
            : {}),
        },
        priceDiffCents,
        changeFeeCents,
      },
    });

    if (accountCreditAmountCents > 0) {
      await createBookingModificationCredit(
        booking.memberId,
        accountCreditAmountCents,
        bookingId,
        bookingModification.id,
        undefined,
        tx,
        booking.payment?.id,
      );
    }

    // Fire the deferred envelope constraint triggers here so a violation is
    // attributed to this service instead of the transaction's COMMIT.
    await assertBookingEnvelopeInvariants(tx);

    // #2364. Moving the dates moves the nights the hosting rule is evaluated on,
    // so the hazard can appear, disappear, or change shape without a single
    // guest changing. `tx` for the usual reason: this transaction holds the
    // global booking lock and the per-lodge capacity lock.
    //
    // #2576 §6: arrival and departure changes are a named change class, and moving
    // the nights can take exact-night cover away from another booking on this
    // account. The disposition travels with the actor.
    await reconcileAdultMemberHostingReviewWithSiblings(bookingId, tx, {
      ...hostingCoverageActorOptions({
        actorRole: actor.role,
        actorMemberId: actor.id,
        ...(hostingCoverageOverride ? { override: hostingCoverageOverride } : {}),
      }),
    });

    return {
      booking: updatedBooking,
      priceDiffCents,
      changeFeeCents,
      refundAmountCents,
      accountCreditAmountCents,
      settlementMethod: payments.settlementMethod,
      policyRetainedAmountCents: payments.policyRetainedAmountCents,
      additionalAmountCents,
      pendingRefundAmountCents,
      promoRemoved,
      promoCoverage,
      choreWarnings,
      datesChanged,
      adminOverride,
      notifyMember,
      capacityOverridden,
      oldCheckIn,
      oldCheckOut,
      hasSucceededPayment,
      hasIssuedXeroInvoice,
      paymentStatus: booking.payment?.status ?? null,
      paymentSource: booking.payment?.source ?? null,
      paymentReference: booking.payment?.reference ?? null,
      xeroInvoiceNumber: booking.payment?.xeroInvoiceNumber ?? null,
      xeroRefundAmountCents,
      xeroAdditionalAmountCents,
      zeroDollarAutoPaid,
      paymentId: booking.payment?.id ?? null,
      paymentCustomerId: booking.payment?.stripeCustomerId ?? null,
      memberEmail: booking.member.email,
      memberName: `${booking.member.firstName} ${booking.member.lastName}`,
      memberId: booking.memberId,
      bookingModificationId: bookingModification.id,
    } satisfies DateModificationTransactionResult;
  });

  const stripeRefundId = await executeBookingModificationRefund({
    bookingId,
    result,
    metadataReason: "date_change_price_decrease",
    idempotencyKeyPrefix: `mod_dates_refund_${bookingId}`,
    failureMessage: "Stripe refund failed after date change - enqueueing recovery",
    recoveryFailureMessage:
      "Failed to enqueue payment recovery for Stripe refund failure after date change",
  });

  const { additionalPaymentClientSecret, additionalPaymentIntentId } =
    await createModificationAdditionalPaymentIntent({
      bookingId,
      result,
      reason: "date_change_price_increase",
      idempotencyKey: `mod_dates_${bookingId}_${result.bookingModificationId}`,
      failureMessage: "Failed to create additional PaymentIntent for modification",
    });

  // Issue #1668: under an admin override, close the approve → apply trail by
  // linking this modification to the booking's most recent approved-unlinked
  // change request. Best-effort; never fails the completed edit.
  const linkedChangeRequestId = result.adminOverride
    ? await linkModificationToOutstandingChangeRequest(prisma, {
        bookingId,
        modificationId: result.bookingModificationId,
        appliedCheckIn: result.booking.checkIn,
        appliedCheckOut: result.booking.checkOut,
      })
    : null;

  // #2576 §7/§8: drain the bounded re-evaluation this edit committed, if any, now
  // that the dates really are what the queue row says they are. Best-effort; the
  // cron sweep is the authority on completion.
  await settleHostingCoverageAfterCommit({ bookingId });

  await dispatchDatePostTransactionSideEffects({
    bookingId,
    actorMemberId: actor.id,
    ipAddress,
    result,
    additionalPaymentIntentId,
    linkedChangeRequestId,
  });

  return {
    booking: result.booking,
    priceDiffCents: result.priceDiffCents,
    changeFeeCents: result.changeFeeCents,
    refundAmountCents: result.refundAmountCents,
    accountCreditAmountCents: result.accountCreditAmountCents,
    settlementMethod: result.settlementMethod,
    policyRetainedAmountCents: result.policyRetainedAmountCents,
    additionalAmountCents: result.additionalAmountCents,
    additionalPaymentClientSecret: additionalPaymentClientSecret ?? null,
    stripeRefundId: stripeRefundId ?? null,
    promoRemoved: result.promoRemoved,
    promoCoverage: result.promoCoverage,
    choreWarnings: result.choreWarnings,
    capacityOverridden: result.capacityOverridden,
  };
}

async function dispatchDatePostTransactionSideEffects({
  bookingId,
  actorMemberId,
  ipAddress,
  result,
  additionalPaymentIntentId,
  linkedChangeRequestId,
}: {
  bookingId: string;
  actorMemberId: string;
  ipAddress: string;
  result: DateModificationTransactionResult;
  additionalPaymentIntentId: string | undefined;
  linkedChangeRequestId: string | null;
}): Promise<void> {
  // Issue #1668: an admin override records the pricing mode, capacity decision
  // and linked change request alongside the standard date-change audit fields.
  // Issue #1696: a non-override admin edit that suppressed the member email
  // records notifyMember: false too (notifyMember is false only when an admin
  // opted out — members always notify), so every suppressed edit is auditable.
  const overrideAuditFields = result.adminOverride
    ? {
        adminOverride: true,
        pricingMode: "recalculate",
        confirmOverCapacity: result.capacityOverridden,
        notifyMember: result.notifyMember,
        capacityOverridden: result.capacityOverridden,
        linkedChangeRequestId,
      }
    : result.notifyMember
      ? {}
      : { notifyMember: false };
  logAudit({
    action: result.adminOverride
      ? "booking.modify.admin_override"
      : "booking.modify.dates",
    memberId: actorMemberId,
    targetId: bookingId,
    subjectMemberId: result.booking.memberId,
    entityType: "BookingModification",
    entityId: result.bookingModificationId,
    category: "booking",
    outcome: "success",
    summary: result.adminOverride
      ? "Admin override: booking dates recalculated"
      : "Booking dates modified",
    details: JSON.stringify({
      ...overrideAuditFields,
      oldCheckIn: formatDateOnly(result.oldCheckIn),
      oldCheckOut: formatDateOnly(result.oldCheckOut),
      newCheckIn: result.booking.checkIn,
      newCheckOut: result.booking.checkOut,
      priceDiffCents: result.priceDiffCents,
      changeFeeCents: result.changeFeeCents,
      refundAmountCents: result.refundAmountCents,
      accountCreditAmountCents: result.accountCreditAmountCents,
      settlementMethod: result.settlementMethod,
      policyRetainedAmountCents: result.policyRetainedAmountCents,
      promoRemoved: result.promoRemoved,
      promoCoverageNote: result.promoCoverage?.message ?? null,
    }),
    metadata: {
      bookingId,
      ...overrideAuditFields,
      oldCheckIn: formatDateOnly(result.oldCheckIn),
      oldCheckOut: formatDateOnly(result.oldCheckOut),
      newCheckIn: formatDateOnly(result.booking.checkIn),
      newCheckOut: formatDateOnly(result.booking.checkOut),
      priceDiffCents: result.priceDiffCents,
      changeFeeCents: result.changeFeeCents,
      refundAmountCents: result.refundAmountCents,
      accountCreditAmountCents: result.accountCreditAmountCents,
      settlementMethod: result.settlementMethod,
      policyRetainedAmountCents: result.policyRetainedAmountCents,
      promoRemoved: result.promoRemoved,
      promoCoverageNote: result.promoCoverage?.message ?? null,
    },
    ipAddress,
  });

  void queueXeroBookingEditSettlement({
    bookingId,
    bookingModificationId: result.bookingModificationId,
    createdByMemberId: actorMemberId,
    hasIssuedXeroInvoice: result.hasIssuedXeroInvoice,
    originalPaymentStatus: result.paymentStatus,
    priceDiffCents: result.priceDiffCents,
    changeFeeCents: result.changeFeeCents,
    datesChanged: result.datesChanged,
    // Policy-limited settlement amount + method so a captured-payment reduction
    // issues the correct (card vs credit) modification credit note; an unpaid
    // issued invoice falls back to the full delta inside classify when null.
    settlementAmountCents: result.xeroRefundAmountCents,
    settlementMethod: result.settlementMethod,
    // F20 (#1887): a reprice that landed the booking fully credit-covered
    // auto-confirmed it at $0, so create the primary invoice if none was issued
    // (mirrors the batch modify path).
    createPrimaryInvoiceWhenMissing:
      result.zeroDollarAutoPaid && !result.hasIssuedXeroInvoice,
    requiresAdditionalStripePayment:
      result.xeroAdditionalAmountCents > 0 && result.hasSucceededPayment,
    additionalPaymentIntentId,
  }).catch((err) =>
    logger.error({ err, bookingId }, "Failed to queue Xero settlement for date modification"),
  );

  // Owner decision (#1668 review): an override admin may choose not to email
  // the member; the choice is recorded in the audit fields above.
  const member = result.notifyMember
    ? await prisma.member.findUnique({
        where: { id: result.booking.memberId },
      })
    : null;
  if (member) {
    sendBookingModifiedEmail({
      bookingId: result.booking.id,
      recipientMemberId: member.id,
      email: member.email,
      firstName: member.firstName,
      modificationType: "DATE_CHANGE",
      oldCheckIn: result.oldCheckIn,
      oldCheckOut: result.oldCheckOut,
      newCheckIn: result.booking.checkIn,
      newCheckOut: result.booking.checkOut,
      oldGuestCount: result.booking.guests.length,
      newGuestCount: result.booking.guests.length,
      oldFinalPriceCents: result.booking.finalPriceCents - result.priceDiffCents,
      newFinalPriceCents: result.booking.finalPriceCents,
      changeFeeCents: result.changeFeeCents,
      refundAmountCents: result.refundAmountCents,
      accountCreditAmountCents: result.accountCreditAmountCents,
      additionalAmountCents: result.additionalAmountCents,
      additionalPaymentMethod:
        result.additionalAmountCents > 0 &&
        result.paymentSource === PaymentSource.INTERNET_BANKING
          ? "INTERNET_BANKING"
          : result.additionalAmountCents > 0 && result.hasSucceededPayment
            ? "STRIPE"
            : undefined,
      paymentReference: result.paymentReference,
      xeroInvoiceNumber: result.xeroInvoiceNumber,
      // #2390: same words as the edit preview and the booking history.
      promoCoverageNote: result.promoCoverage?.message ?? null,
      lodgeId: result.booking.lodgeId,
    }).catch((err) =>
      logger.error({ err, bookingId }, "Failed to send booking modified email"),
    );
  }

  if (
    result.oldCheckIn.getTime() !== result.booking.checkIn.getTime() ||
    result.oldCheckOut.getTime() !== result.booking.checkOut.getTime()
  ) {
    processWaitlistForDates({
      checkIn: result.oldCheckIn,
      checkOut: result.oldCheckOut,
      lodgeId: result.booking.lodgeId,
    }).catch((err) =>
      logger.error({ err, bookingId }, "Failed to process waitlist after date modification"),
    );
  }
}

const SHIFT_LENGTH_MISMATCH_MESSAGE =
  'Shift dates only moves the stay without changing its length — use "Recalculate price" to change the number of nights';

/**
 * Admin override "shift dates only" (issue #1668): pure translation of a stay.
 * Every cent is frozen — booking totals, per-guest priceCents, per-night
 * BookingGuestNight.priceCents, promo rows, payment and Xero are all untouched
 * — and the stay is moved by a whole-day delta with its night count preserved.
 * Intended for operational relocations (e.g. a road closure) where the member
 * must not be charged. No settlement, change fee, Stripe or Xero calls.
 *
 * Deliberately NOT behind the Xero lock-date guard (#1697): a shift writes no
 * Xero documents, so it cannot strand an outbox operation in a locked period.
 *
 * The caller (route) guarantees the actor is an admin; this asserts it anyway.
 */
export async function adminShiftBookingDates({
  bookingId,
  actor,
  hostingCoverageOverride,
  input,
  ipAddress,
}: {
  bookingId: string;
  actor: { id: string; role: Role };
  /**
   * #2576 §7: the officer's explicit confirmation and mandatory reason for
   * overriding a same-owner coverage refusal. Ignored for a non-officer actor, so a
   * member cannot self-authorise past §6's block by inventing a reason.
   */
  hostingCoverageOverride?: HostingCoverageOverrideInput | null;
  input: {
    checkIn?: string;
    checkOut?: string;
    confirmOverCapacity?: boolean;
    notifyMember?: boolean;
  };
  ipAddress: string;
}): Promise<DateModificationResponse> {
  if (actor.role !== "ADMIN") {
    throw new ApiError("Admin override is not available for this account", 403);
  }
  // Owner decision (#1668 review): the admin chooses whether the member is
  // emailed about the change; absent means notify (no silent default).
  const notifyMember = input.notifyMember !== false;

  // #3123 — the club's day, resolved BEFORE the transaction opens. The edit
  // policy inside it is a pure synchronous classifier and takes the day as a
  // value: resolving the club's persisted zone in there would be a
  // `clubTimeSettings.findUnique` on a second pooled connection while the global
  // cohort key and the lodge capacity key are both held (`INV-LOCK-004`).
  const clubTodayDateOnly = await clubTodayDateOnlyInstant();

  const result = await prisma.$transaction(async (tx) => {
    // Two-tier lock protocol (#1881): this admin date move claims capacity for
    // the new range and can move money (recalculate mode), so it takes BOTH
    // locks — global lock(1) FIRST (mutual exclusion with cancel / settlement),
    // then the per-lodge lock. Even a frozen-cent shift takes lock(1) so its
    // status/date commit can never clobber a booking a concurrent cancel just
    // terminated.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    // Pre-lock read of only the lodge lock key; lodgeId is immutable.
    const lockTarget = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { lodgeId: true },
    });
    const bookingLodgeId = lockTarget?.lodgeId ?? (await getDefaultLodgeId(tx));
    await acquireLodgeCapacityLock(tx, bookingLodgeId);

    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      include: {
        guests: {
          include: { nights: { select: { stayDate: true, priceCents: true } } },
        },
        payment: true,
        member: true,
      },
    });
    if (!booking) {
      throw new ApiError("Booking not found", 404);
    }

    // Negotiated-price (booking-request) bookings stay out of scope — same
    // block/message as every standard edit path.
    await assertBookingNotQuotePriced(tx, bookingId);

    if (!canModifyBookingStatusForRole(booking.status, "ADMIN")) {
      throw new ApiError(
        "This booking cannot be modified in its current status",
        400,
      );
    }
    const editPolicy = getBookingEditPolicy({
      status: booking.status,
      role: "ADMIN",
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      adminOverride: true,
      today: clubTodayDateOnly,
    });
    if (!editPolicy.canModify) {
      throw new ApiError(
        editPolicy.reason ?? "This booking cannot be modified",
        400,
      );
    }

    // Resolve target dates with night-count parity. All date math is date-only:
    // both bounds are normalised to UTC midnight first, so the delta and every
    // shift are DST-safe (addDaysDateOnly for shifting, never raw ms on unnorm-
    // alised Dates).
    // The stored days, matching `buildShiftPreviewResponse` read for read — see
    // the note at the self-service gate above. The night count, the delta and
    // every translated guest row below all derive from these two.
    const oldCheckIn = storedDateOnly(booking.checkIn);
    const oldCheckOut = storedDateOnly(booking.checkOut);
    const originalNightCount = eachDateOnlyInRange(oldCheckIn, oldCheckOut).length;

    const providedCheckIn = input.checkIn ? parseDateOnly(input.checkIn) : null;
    const providedCheckOut = input.checkOut ? parseDateOnly(input.checkOut) : null;
    if (
      (providedCheckIn && Number.isNaN(providedCheckIn.getTime())) ||
      (providedCheckOut && Number.isNaN(providedCheckOut.getTime()))
    ) {
      throw new ApiError("Invalid booking dates", 400);
    }

    let newCheckIn: Date;
    let newCheckOut: Date;
    if (providedCheckIn && providedCheckOut) {
      newCheckIn = providedCheckIn;
      newCheckOut = providedCheckOut;
    } else if (providedCheckIn) {
      // Derive the missing check-out to preserve the original length.
      newCheckIn = providedCheckIn;
      newCheckOut = addDaysDateOnly(providedCheckIn, originalNightCount);
    } else if (providedCheckOut) {
      newCheckOut = providedCheckOut;
      newCheckIn = addDaysDateOnly(providedCheckOut, -originalNightCount);
    } else {
      throw new ApiError("Provide a new check-in or check-out date", 400);
    }

    if (newCheckOut <= newCheckIn) {
      throw new ApiError("Check-out must be after check-in", 400);
    }
    const newNightCount = eachDateOnlyInRange(newCheckIn, newCheckOut).length;
    if (newNightCount !== originalNightCount) {
      throw new ApiError(SHIFT_LENGTH_MISMATCH_MESSAGE, 400);
    }
    if (
      newCheckIn.getTime() === oldCheckIn.getTime() &&
      newCheckOut.getTime() === oldCheckOut.getTime()
    ) {
      throw new ApiError("The booking already has these dates", 400);
    }

    const existingAssignmentDates = await tx.choreAssignment.findMany({
      where: { bookingId },
      select: { date: true },
    });
    // #2622: checkout-inclusive on both envelopes — see `modifyBookingDates`.
    await lockRosterDateRangesAndDates(
      tx,
      [
        rosterOperationalDayRange(oldCheckIn, oldCheckOut),
        rosterOperationalDayRange(newCheckIn, newCheckOut),
      ],
      existingAssignmentDates.map((assignment) => assignment.date),
    );

    // Whole-day delta between two UTC-midnight date-only values (DST-safe).
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const deltaDays = Math.round(
      (newCheckIn.getTime() - oldCheckIn.getTime()) / MS_PER_DAY,
    );

    // Translate every guest's envelope and night rows by the same delta; each
    // stored night keeps its exact priceCents (partial stays and gaps move with
    // the stay). Guests with no night rows keep envelope-only semantics.
    const translatedGuests = booking.guests.map((guest) => ({
      guest,
      stayStart: addDaysDateOnly(storedDateOnly(guest.stayStart), deltaDays),
      stayEnd: addDaysDateOnly(storedDateOnly(guest.stayEnd), deltaDays),
      nights: guest.nights.map((night) => ({
        stayDate: addDaysDateOnly(storedDateOnly(night.stayDate), deltaDays),
        priceCents: night.priceCents,
      })),
    }));

    const capacityRanges = translatedGuests.map((entry) => ({
      memberId: entry.guest.memberId ?? null,
      stayStart: entry.stayStart,
      stayEnd: entry.stayEnd,
      nights: entry.nights.map((night) => night.stayDate),
    }));

    // Non-lifecycle statuses (DRAFT, WAITLISTED, WAITLIST_OFFERED, BUMPED) hold
    // no capacity, so a shift cannot overbook — skip the check exactly like the
    // recalculate path's skipBookingLifecycleRules does, or the admin would be
    // forced through a meaningless over-capacity confirm and the audit would
    // record a capacityOverridden that overbooked nothing.
    const capacity = usesActiveBookingEditLifecycle(booking.status)
      ? await checkCapacityForGuestRanges(
          bookingLodgeId,
          newCheckIn,
          newCheckOut,
          capacityRanges,
          bookingId,
          tx,
        )
      : { available: true, minAvailable: Number.POSITIVE_INFINITY, nightDetails: [] };
    let capacityOverridden = false;
    if (!capacity.available) {
      if (!input.confirmOverCapacity) {
        throw new OverCapacityConfirmationRequiredError(
          overCapacityNights(capacity),
        );
      }
      // Confirmed override cannot bypass an exclusive hold (ADR-001 decision 5,
      // issue #118) — refuse before stamping capacityOverridden.
      const blocked = wholeLodgeBlockedNights(capacity);
      if (blocked.length > 0) {
        throw new WholeLodgeHoldBlockedError(blocked);
      }
      capacityOverridden = true;
    }

    // C1 (privacy re-review of MG3 #2308, LOW-3). The file's SECOND person-night
    // guard call, and the source contract now checks every one rather than only
    // the first. `adminShiftBookingDates` is admin-only — the call below hard-codes
    // `actorRole: "ADMIN"` — so this marking is a no-op that costs no query, but
    // "the second caller happens to be admin-only" is a fact about today's
    // routing, and an unmarked party is exactly the silent read-out C1 closed.
    const capacityRangesForGuard = await markCrossFamilyGuestsOnBooking(
      tx,
      booking.memberId,
      capacityRanges,
      { skipAuthorization: true, bookingId },
    );
    await assertNoBookingMemberNightConflicts(tx, {
      actorMemberId: actor.id,
      actorRole: "ADMIN",
      checkIn: newCheckIn,
      checkOut: newCheckOut,
      guests: capacityRangesForGuard,
      excludeBookingId: bookingId,
      // Resolved before this transaction opened (`INV-LOCK-004`); the same day
      // the shift's edit-policy gate reads.
      today: clubTodayDateOnly,
    });

    // Writes: translate each guest's envelope and rebuild its night rows at the
    // shifted dates with the SAME priceCents. Guest priceCents is untouched.
    for (const entry of translatedGuests) {
      await tx.bookingGuest.update({
        where: { id: entry.guest.id },
        data: { stayStart: entry.stayStart, stayEnd: entry.stayEnd },
      });
      await tx.bookingGuestNight.deleteMany({
        where: { bookingGuestId: entry.guest.id },
      });
      if (entry.nights.length > 0) {
        await tx.bookingGuestNight.createMany({
          data: entry.nights.map((night) => ({
            bookingGuestId: entry.guest.id,
            stayDate: night.stayDate,
            priceCents: night.priceCents,
          })),
        });
      }
    }

    // Non-member hold recalculation, mirroring modifyBookingDates: the hold
    // window and the PENDING → PAYMENT_PENDING release both key off the new
    // check-in. Status is otherwise unchanged.
    const hasNonMembers = booking.guests.some((guest) => !guest.isMember);
    let newNonMemberHoldUntil = booking.nonMemberHoldUntil;
    let newStatus = booking.status;
    if (hasNonMembers) {
      const holdPolicy = await getNonMemberHoldPolicy(newCheckIn, booking.lodgeId, tx);
      const holdDecision = calculateBookingHoldDecision({
        hasNonMembers,
        checkIn: newCheckIn,
        holdDays: holdPolicy.holdDays,
        holdEnabled: holdPolicy.enabled,
      });
      if (holdDecision.shouldBePending) {
        newNonMemberHoldUntil = new Date(
          newCheckIn.getTime() - holdPolicy.holdDays * 24 * 60 * 60 * 1000,
        );
      } else {
        newNonMemberHoldUntil = null;
        if (booking.status === "PENDING") {
          newStatus = "PAYMENT_PENDING";
        }
      }
    } else {
      newNonMemberHoldUntil = null;
    }

    // Update the booking envelope ONLY — every price field is left as booked.
    const updatedBooking = await tx.booking.update({
      where: { id: bookingId },
      data: {
        checkIn: newCheckIn,
        checkOut: newCheckOut,
        nonMemberHoldUntil: newNonMemberHoldUntil,
        status: newStatus,
        // Persisted capacity override (#1771): this shift re-evaluates capacity
        // against the *new* nights, so RECONCILE the marker — stamp when the
        // shift was admitted over capacity behind a confirm, and CLEAR any
        // prior stamp when the shift moved the booking back within capacity (or
        // into a status that holds no bed), so a stale flag can't suppress a
        // legitimate cancel on the new nights later.
        capacityOverriddenAt: capacityOverridden ? new Date() : null,
        capacityOverriddenByMemberId: capacityOverridden ? actor.id : null,
      },
      include: { guests: true, payment: true },
    });

    const dateCleanup = await cleanupChoreAssignmentsForDateChange(
      tx,
      bookingId,
      newCheckIn,
      newCheckOut,
      { rosterDatesAlreadyLocked: true },
    );
    const rangeCleanup = await cleanupChoreAssignmentsForGuestStayRanges(
      tx,
      bookingId,
      { rosterDatesAlreadyLocked: true },
    );
    const choreWarnings = [
      ...dateCleanup.choreWarnings,
      ...rangeCleanup.choreWarnings,
    ];

    await reconcileBedAllocationsForBookingWithLodgeLockHeld({
      bookingId,
      db: tx,
      previousRange: { checkIn: oldCheckIn, checkOut: oldCheckOut },
    });

    const bookingModification = await tx.bookingModification.create({
      data: {
        bookingId,
        memberId: actor.id,
        modificationType: "ADMIN_DATE_SHIFT",
        previousData: {
          checkIn: formatDateOnly(oldCheckIn),
          checkOut: formatDateOnly(oldCheckOut),
          totalPriceCents: booking.totalPriceCents,
          discountCents: booking.discountCents,
          promoAdjustmentCents: booking.promoAdjustmentCents,
          finalPriceCents: booking.finalPriceCents,
        },
        newData: {
          checkIn: formatDateOnly(newCheckIn),
          checkOut: formatDateOnly(newCheckOut),
          totalPriceCents: booking.totalPriceCents,
          discountCents: booking.discountCents,
          promoAdjustmentCents: booking.promoAdjustmentCents,
          finalPriceCents: booking.finalPriceCents,
          pricingMode: "shift",
          capacityOverridden,
        },
        priceDiffCents: 0,
        changeFeeCents: 0,
      },
    });

    await assertBookingEnvelopeInvariants(tx);

    // #2364. An admin date SHIFT keeps every price and every guest, but it does
    // move the nights, so the hosting evaluation has to run again.
    //
    // #2576 §7: this interactive officer path uses the same two-step override as
    // every other coverage-breaking edit. The real officer id and the exact-state
    // token both travel into the under-lock comparison; dropping either makes the
    // 409 retry impossible or turns an attributable override into a system change.
    await reconcileAdultMemberHostingReviewWithSiblings(bookingId, tx, {
      ...hostingCoverageActorOptions({
        actorRole: actor.role,
        actorMemberId: actor.id,
        ...(hostingCoverageOverride ? { override: hostingCoverageOverride } : {}),
      }),
    });

    return {
      booking: updatedBooking,
      oldCheckIn,
      oldCheckOut,
      newCheckIn,
      newCheckOut,
      capacityOverridden,
      choreWarnings,
      bookingModificationId: bookingModification.id,
      memberId: booking.memberId,
      memberEmail: booking.member.email,
      memberFirstName: booking.member.firstName,
      guestCount: booking.guests.length,
      finalPriceCents: booking.finalPriceCents,
      paymentReference: booking.payment?.reference ?? null,
      xeroInvoiceNumber: booking.payment?.xeroInvoiceNumber ?? null,
      paymentSource: booking.payment?.source ?? null,
      lodgeId: booking.lodgeId,
    };
  });

  // Post-transaction (no Stripe/Xero/payment mutations at all).
  const linkedChangeRequestId = await linkModificationToOutstandingChangeRequest(
    prisma,
    {
      bookingId,
      modificationId: result.bookingModificationId,
      appliedCheckIn: result.newCheckIn,
      appliedCheckOut: result.newCheckOut,
    },
  );

  const overrideAuditPayload = {
    pricingMode: "shift",
    confirmOverCapacity: Boolean(input.confirmOverCapacity),
    notifyMember,
    capacityOverridden: result.capacityOverridden,
    linkedChangeRequestId,
    oldCheckIn: formatDateOnly(result.oldCheckIn),
    oldCheckOut: formatDateOnly(result.oldCheckOut),
    newCheckIn: formatDateOnly(result.newCheckIn),
    newCheckOut: formatDateOnly(result.newCheckOut),
  };
  logAudit({
    action: "booking.modify.admin_override",
    memberId: actor.id,
    targetId: bookingId,
    subjectMemberId: result.memberId,
    entityType: "BookingModification",
    entityId: result.bookingModificationId,
    category: "booking",
    outcome: "success",
    summary: "Admin override: booking dates shifted",
    details: JSON.stringify(overrideAuditPayload),
    metadata: { bookingId, ...overrideAuditPayload },
    ipAddress,
  });

  // Owner decision (#1668 review): the admin explicitly chose in the override
  // dialog whether to send the change email; the choice is audited above.
  if (notifyMember) {
    sendBookingModifiedEmail({
      bookingId: result.booking.id,
      recipientMemberId: result.memberId,
      email: result.memberEmail,
      firstName: result.memberFirstName,
      modificationType: "DATE_CHANGE",
      oldCheckIn: result.oldCheckIn,
      oldCheckOut: result.oldCheckOut,
      newCheckIn: result.newCheckIn,
      newCheckOut: result.newCheckOut,
      oldGuestCount: result.guestCount,
      newGuestCount: result.guestCount,
      oldFinalPriceCents: result.finalPriceCents,
      newFinalPriceCents: result.finalPriceCents,
      changeFeeCents: 0,
      refundAmountCents: 0,
      accountCreditAmountCents: 0,
      additionalAmountCents: 0,
      additionalPaymentMethod: undefined,
      paymentReference: result.paymentReference,
      xeroInvoiceNumber: result.xeroInvoiceNumber,
      lodgeId: result.lodgeId,
    }).catch((err) =>
      logger.error({ err, bookingId }, "Failed to send admin override date-shift email"),
    );
  }

  // Free the old range for the waitlist (unconditional on a change, matching the
  // standard date path).
  processWaitlistForDates({
    checkIn: result.oldCheckIn,
    checkOut: result.oldCheckOut,
    lodgeId: result.lodgeId,
  }).catch((err) =>
    logger.error({ err, bookingId }, "Failed to process waitlist after admin date shift"),
  );

  // #2576 §7/§8. An officer's date shift is never refused, so this is the path on
  // which the escalation actually happens: the shift committed a bounded
  // re-evaluation row, and this opens the urgent incident and notifies the owner.
  await settleHostingCoverageAfterCommit({ bookingId });

  return {
    booking: result.booking,
    priceDiffCents: 0,
    changeFeeCents: 0,
    refundAmountCents: 0,
    accountCreditAmountCents: 0,
    settlementMethod: null,
    policyRetainedAmountCents: 0,
    additionalAmountCents: 0,
    additionalPaymentClientSecret: null,
    stripeRefundId: null,
    promoRemoved: false,
    // The admin date SHIFT keeps every price exactly as it stands, so it never
    // re-runs the promo caps and can never change who a promotion covers.
    promoCoverage: null,
    choreWarnings: result.choreWarnings,
    capacityOverridden: result.capacityOverridden,
  };
}
