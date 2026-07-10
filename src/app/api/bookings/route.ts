import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { getNonMemberHoldPolicy } from "@/lib/cancellation";
import {
  calculateBookingHoldDecision,
  toGroupDiscountConfig,
} from "@/lib/policies/booking-route-decisions";
import { AgeTier, BookingStatus } from "@prisma/client";
import { z } from "zod";
import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import { getLodgeCapacity } from "@/lib/lodge-capacity";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { getMemberCreditBalance } from "@/lib/member-credit";
import { findUnpaidMemberGuests } from "@/lib/booking-member-guest-subscriptions";
import logger from "@/lib/logger";
import { getSeasonYear } from "@/lib/utils";
import {
  assertMembershipTypeBookingAllowed,
  getMembershipTypeBookingPolicyErrorBody,
  MembershipTypeBookingPolicyError,
  requiresPaidSubscriptionForMemberForBooking,
} from "@/lib/membership-type-policy";
import {
  assertLinkedBookingMembersCanBeBooked,
  BookingGuestValidationError,
  getBookingGuestValidationErrorResponse,
  normalizeBookingGuestInputs,
  resolveLinkedBookingMembers,
} from "@/lib/booking-guests";
import { nameField } from "@/lib/zod-helpers";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import {
  checkInternetBankingLeadTime,
  loadInternetBankingPaymentSettings,
  type InternetBankingPaymentSettingsValues,
} from "@/lib/internet-banking-settings";
import {
  BOOKING_PAYMENT_METHOD_VALUES,
  DEFAULT_BOOKING_PAYMENT_METHOD,
} from "@/lib/booking-payment-methods";
import {
  BookingLodgeError,
  BookingPromoError,
  BookingReviewJustificationRequiredError,
  createConfirmedBooking,
  createDraftBooking,
  createWaitlistedBooking,
  RETROACTIVE_BOOKING_MAX_LOOKBACK_DAYS,
  type BookingGuestInput,
} from "@/lib/booking-create";
import { resolveBookingDateEnvelope } from "@/lib/booking-create-guests";
// Imported from the types module (not @/lib/booking-create) so a booking-create
// mock in the route tests can't shadow the class and break `instanceof`, the
// same precedent as OverCapacityConfirmationRequiredError below.
import { RetroactiveCardPaymentError } from "@/lib/booking-create-types";
import { OverCapacityConfirmationRequiredError } from "@/lib/over-capacity-confirmation";
import { isXeroConnected } from "@/lib/xero";
import {
  getEffectiveXeroLockDate,
  getXeroLockDates,
} from "@/lib/xero-organisation";
import { LodgeBookingEligibilityError } from "@/lib/lodge-access";
import {
  BookingMemberNightConflictError,
  findBookingMemberNightConflicts,
  getBookingMemberNightConflictResponse,
} from "@/lib/booking-member-night-conflicts";
import {
  BookingGuestStayRangeValidationError,
  normalizeGuestStayRanges,
} from "@/lib/booking-guest-stay-range-input";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  addDaysDateOnly,
  formatDateOnly,
  getTodayDateOnly,
  isDateOnlyString,
  parseDateOnly,
} from "@/lib/date-only";
import { resolveOptionalActiveLodgeId } from "@/lib/lodges";
import {
  hasAccessRole,
  hasAdminAccess,
} from "@/lib/access-roles";
import { bookingManagementAuthorizationRole } from "@/lib/admin-permissions";

const dateOnlyString = z.string().refine(isDateOnlyString, {
  message: "Date must be YYYY-MM-DD",
});

const createBookingSchema = z.object({
  checkIn: dateOnlyString.transform(parseDateOnly),
  checkOut: dateOnlyString.transform(parseDateOnly),
  guests: z
    .array(
      z.object({
        firstName: nameField(),
        lastName: nameField(),
        ageTier: bookableAgeTierEnum,
        isMember: z.boolean(),
        memberId: z.string().min(1).optional(),
        stayStart: z.string().optional(),
        stayEnd: z.string().optional(),
        // Explicit included nights for a multi date range stay (issue #713).
        // When present, the guest stays exactly these nights (may be
        // non-contiguous) and the booking range auto-expands to cover them.
        nights: z.array(dateOnlyString).max(370).optional(),
      })
    )
    .min(1)
    .max(200),
  notes: z.string().max(500).optional(),
  promoCode: z.string().max(50).optional(),
  promoGuestIndexes: z.array(z.number().int().min(0)).optional(),
  workPartyEventId: z.string().min(1).optional(),
  draft: z.boolean().optional(),
  waitlist: z.boolean().optional(),
  expectedArrivalTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]0$/).optional(),
  requestedRoomId: z.string().min(1).optional(),
  // Lodge the booking is for (multi-lodge phase 8). Optional so existing
  // single-lodge clients keep working; omitted resolves to the default lodge.
  lodgeId: z.string().min(1).optional(),
  // Cross-lodge waitlist opt-in (ADR-004): other lodges the member would
  // also accept. Only meaningful with waitlist: true; ignored otherwise.
  alternateLodgeIds: z.array(z.string().min(1)).max(20).optional(),
  cancelIfGuestsBumped: z.boolean().optional(),
  applyCreditCents: z.number().int().min(0).optional(),
  forMemberId: z.string().optional(),
  memberReviewJustification: z.string().trim().min(1).max(1000).optional(),
  paymentMethod: z
    .enum(BOOKING_PAYMENT_METHOD_VALUES)
    .optional()
    .default(DEFAULT_BOOKING_PAYMENT_METHOD),
  // Retroactive booking + email-choice flags (#1695). Admin-only, gated below;
  // a caller-controlled boolean can never widen authority (mirrors #1668).
  allowPastDates: z.boolean().optional(),
  confirmOverCapacity: z.boolean().optional(),
  notifyMember: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  const rateLimited = await applyRateLimit(rateLimiters.bookingCreate, request);
  if (rateLimited) return rateLimited;

  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }
  const isAdmin = hasAdminAccess(session.user);
  // Dual-hat detection: a USER token alongside admin roles means this account
  // books for itself through the member flow under full member rules (#1442).
  const isMember = hasAccessRole(session.user, "USER");
  // bookings:edit holders (Full Admin, Booking Officer, custom roles) may
  // create on-behalf bookings — aligned with the modification path (#1313).
  const canManageBookings =
    bookingManagementAuthorizationRole(session.user) === "ADMIN";
  const actorRole = bookingManagementAuthorizationRole(session.user);

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;

  const parsed = createBookingSchema.safeParse(json.body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // Retroactive-create + email-choice gating (issue #1695), mirroring the
  // #1668 modify-dates override gating: any of the three flags present (even a
  // `false` value) requires the booking-management ADMIN role, so a
  // caller-controlled boolean can never widen the standard path's authority.
  const {
    allowPastDates: allowPastDatesFlag,
    confirmOverCapacity: confirmOverCapacityFlag,
    notifyMember: notifyMemberFlag,
  } = parsed.data;
  const hasOverrideFlags =
    allowPastDatesFlag !== undefined ||
    confirmOverCapacityFlag !== undefined ||
    notifyMemberFlag !== undefined;
  if (hasOverrideFlags && actorRole !== "ADMIN") {
    return NextResponse.json(
      { error: "Admin override is not available for this account" },
      { status: 403 },
    );
  }
  if (
    (allowPastDatesFlag !== undefined || notifyMemberFlag !== undefined) &&
    !parsed.data.forMemberId
  ) {
    return NextResponse.json(
      {
        error:
          "allowPastDates and notifyMember are only available when booking on behalf of a member",
      },
      { status: 400 },
    );
  }
  if (confirmOverCapacityFlag !== undefined && allowPastDatesFlag !== true) {
    return NextResponse.json(
      { error: "confirmOverCapacity requires allowPastDates" },
      { status: 400 },
    );
  }
  // Drafts do not invoice at create time, so the create-time Xero lock-date
  // guard would be skipped; block retroactive drafts/waitlists (relaxable).
  if (
    allowPastDatesFlag === true &&
    (parsed.data.draft === true || parsed.data.waitlist === true)
  ) {
    return NextResponse.json(
      { error: "Retroactive bookings cannot be saved as a draft or waitlisted" },
      { status: 400 },
    );
  }

  const xeroIntegrationEnabled = (await loadEffectiveModuleFlags()).xeroIntegration;

  // Resolve effective member: authorized on-behalf booking for another member.
  let effectiveMemberId = session.user.id;
  let isAuthorizedOnBehalf = false;
  let effectiveMemberAgeTier: AgeTier | null = null;

  // Only admin-only accounts (no USER token) are forced onto the on-behalf
  // page; dual-hat admins self-book here under full member rules (#1442).
  if (isAdmin && !isMember && !parsed.data.forMemberId) {
    return NextResponse.json(
      { error: "Admins must book on behalf of a member. Use the admin booking page.", code: "ADMIN_MUST_BOOK_ON_BEHALF" },
      { status: 403 }
    );
  }

  if (parsed.data.forMemberId) {
    if (!canManageBookings) {
      return NextResponse.json({ error: "Only admins can book on behalf of another member" }, { status: 403 });
    }
    // Separation of duties: no on-behalf actor may target themselves — their
    // own bookings go through the member flow and normal payment paths.
    if (parsed.data.forMemberId === session.user.id) {
      return NextResponse.json({ error: "Booking managers cannot book for themselves — book your own stay through the member booking page" }, { status: 400 });
    }
    const targetMember = await prisma.member.findUnique({
      where: { id: parsed.data.forMemberId },
      select: { active: true },
    });
    if (!targetMember?.active) {
      return NextResponse.json({ error: "Target member not found or inactive" }, { status: 400 });
    }
    effectiveMemberId = parsed.data.forMemberId;
    isAuthorizedOnBehalf = true;
  }

  if (!isAuthorizedOnBehalf) {
    const member = await prisma.member.findUnique({
      where: { id: session.user.id },
      select: { emailVerified: true, xeroContactId: true, ageTier: true },
    });
    effectiveMemberAgeTier = member?.ageTier ?? null;

    if (!member?.emailVerified) {
      return NextResponse.json({ error: "Email not verified" }, { status: 403 });
    }

    // Self-bookings get no admin leniency: the Xero-link requirement applies
    // to every booking owner, dual-hat admins included (#1442).
    if (xeroIntegrationEnabled && !member?.xeroContactId) {
      return NextResponse.json(
        {
          error: "Your account is not yet linked to Xero. Please contact the club administrator to link your membership before booking.",
          code: "XERO_CONTACT_REQUIRED",
        },
        { status: 403 }
      );
    }
  }

  const {
    checkIn,
    checkOut,
    guests,
    notes,
    promoCode: promoCodeStr,
    promoGuestIndexes,
    workPartyEventId,
    draft,
    waitlist,
    expectedArrivalTime,
    requestedRoomId,
    cancelIfGuestsBumped,
    memberReviewJustification,
    paymentMethod,
  } = parsed.data;
  let guestInputs: BookingGuestInput[] = [];

  if (checkOut <= checkIn) {
    return NextResponse.json({ error: "Check-out must be after check-in" }, { status: 400 });
  }

  if (requestedRoomId) {
    const modules = await loadEffectiveModuleFlags();
    if (!modules.bedAllocation) {
      return NextResponse.json({ error: "Room requests are not available." }, { status: 400 });
    }
    const requestedRoom = await prisma.lodgeRoom.findUnique({
      where: { id: requestedRoomId },
      select: { id: true },
    });
    if (!requestedRoom) {
      return NextResponse.json({ error: "Invalid requested room" }, { status: 400 });
    }
  }

  try {
    const linkedMembers = await resolveLinkedBookingMembers(
      prisma,
      effectiveMemberId,
      guests.map((guest) => guest.memberId),
      { skipAuthorization: isAuthorizedOnBehalf }
    );
    await assertLinkedBookingMembersCanBeBooked(
      prisma,
      linkedMembers,
      session.user.id,
      {
        actorRole,
        onBehalfOfMemberId: isAuthorizedOnBehalf ? effectiveMemberId : null,
      }
    );
    const normalizedGuests = normalizeBookingGuestInputs(guests, linkedMembers);
    guestInputs = normalizeGuestStayRanges(normalizedGuests, { checkIn, checkOut });
  } catch (error) {
    if (error instanceof BookingGuestValidationError) {
      return NextResponse.json(
        getBookingGuestValidationErrorResponse(error),
        { status: error.status }
      );
    }
    if (error instanceof BookingGuestStayRangeValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const memberNightConflicts = await findBookingMemberNightConflicts(prisma, {
    actorMemberId: session.user.id,
    actorRole,
    checkIn,
    checkOut,
    guests: guestInputs,
  });
  if (memberNightConflicts.length > 0) {
    return NextResponse.json(
      getBookingMemberNightConflictResponse(memberNightConflicts),
      { status: 409 },
    );
  }

  // Retroactive booking (#1695): a past check-in is allowed only for an admin
  // on-behalf create that opted into allowPastDates, and only within the
  // rolling lookback. Everything else keeps the original today-or-future rule.
  const retroactiveCreate =
    parsed.data.allowPastDates === true && isAuthorizedOnBehalf;
  const today = getTodayDateOnly();
  // The flag is strictly retroactive: a today-or-future check-in carrying it is
  // rejected rather than silently widening normal-create behaviour (lead-time
  // skip, capacity warn-and-confirm belong to past stays only).
  if (retroactiveCreate && checkIn >= today) {
    return NextResponse.json(
      { error: "allowPastDates requires a check-in in the past" },
      { status: 400 },
    );
  }
  // Guards run on the RESOLVED stay envelope: guest nights can expand the stay
  // before the requested check-in (#713), and the envelope check-in is what the
  // booking — and its Xero invoice issue date — persists.
  const envelopeCheckIn = retroactiveCreate
    ? resolveBookingDateEnvelope(guestInputs, checkIn, checkOut).checkIn
    : checkIn;
  if (checkIn < today) {
    if (!retroactiveCreate) {
      return NextResponse.json({ error: "Cannot book in the past" }, { status: 400 });
    }
    if (envelopeCheckIn < addDaysDateOnly(today, -RETROACTIVE_BOOKING_MAX_LOOKBACK_DAYS)) {
      return NextResponse.json(
        {
          error: `Retroactive bookings can go back at most ${RETROACTIVE_BOOKING_MAX_LOOKBACK_DAYS} days.`,
        },
        { status: 400 },
      );
    }
    // Xero lock-date guard: the booking's invoice issue date is its check-in,
    // so a past check-in must not fall on or before a locked accounting period.
    // Skipped when Xero is not connected; fails closed (retryable 503) when the
    // lock dates cannot be read. The Xero call stays outside any DB transaction.
    if (xeroIntegrationEnabled && (await isXeroConnected())) {
      let lockDates;
      try {
        lockDates = await getXeroLockDates();
      } catch {
        return NextResponse.json(
          {
            error: "Could not verify the Xero lock dates. Please try again.",
            code: "XERO_LOCK_DATE_CHECK_FAILED",
          },
          { status: 503 },
        );
      }
      const effectiveLock = getEffectiveXeroLockDate(lockDates);
      if (effectiveLock && envelopeCheckIn <= effectiveLock) {
        const lockDate = formatDateOnly(effectiveLock);
        return NextResponse.json(
          {
            error: `The check-in date falls on or before the Xero lock date (${lockDate}). Unlock the period in Xero (Settings → Advanced → Financial settings → Lock dates) or choose a later check-in.`,
            code: "XERO_PERIOD_LOCKED",
            lockDate,
          },
          { status: 409 },
        );
      }
    }
  }

  const bookingLodgeId = await resolveOptionalActiveLodgeId(
    prisma,
    parsed.data.lodgeId,
  );
  if (!bookingLodgeId) {
    return NextResponse.json(
      { error: "Unknown or inactive lodgeId" },
      { status: 400 },
    );
  }

  const lodgeCapacity = await getLodgeCapacity(bookingLodgeId);
  if (guestInputs.length > lodgeCapacity) {
    return NextResponse.json(
      { error: `A booking cannot exceed ${lodgeCapacity} guests` },
      { status: 400 },
    );
  }

  try {
    await assertMembershipTypeBookingAllowed(prisma, {
      ownerMemberId: effectiveMemberId,
      guests: guestInputs,
      seasonYear: getSeasonYear(checkIn),
    });
  } catch (err) {
    if (err instanceof MembershipTypeBookingPolicyError) {
      return NextResponse.json(
        getMembershipTypeBookingPolicyErrorBody(err),
        { status: err.status },
      );
    }
    throw err;
  }

  // Subscription gate for the booking owner. Bypassed when the Xero module
  // is effectively off, because subscriptions are invoiced through Xero.
  if (
    !isAuthorizedOnBehalf &&
    await requiresPaidSubscriptionForMemberForBooking(prisma, {
      memberId: effectiveMemberId,
      seasonYear: getSeasonYear(checkIn),
      ageTier: effectiveMemberAgeTier,
    })
  ) {
    const seasonYear = getSeasonYear(checkIn);
    const paidSub = await prisma.memberSubscription.findFirst({
      where: { memberId: effectiveMemberId, seasonYear, status: "PAID" },
    });
    if (!paidSub) {
      const subscription = await prisma.memberSubscription.findFirst({
        where: { memberId: effectiveMemberId, seasonYear },
        orderBy: { updatedAt: "desc" },
      });
      const seasonDisplay = `${seasonYear}/${seasonYear + 1}`;
      return NextResponse.json(
        {
          error: `Your membership subscription for the ${seasonDisplay} season is not paid. Please contact the club to arrange payment before booking.`,
          code: "SUBSCRIPTION_REQUIRED",
          invoiceUrl: subscription?.xeroOnlineInvoiceUrl ?? null,
          invoiceNumber: subscription?.xeroInvoiceNumber ?? null,
        },
        { status: 403 }
      );
    }
  }

  // Subscription gate for member guests (skipped only for authorized
  // on-behalf bookings — self-bookings always enforce it, #1442).
  if (!isAuthorizedOnBehalf) {
    const unpaidMemberGuests = await findUnpaidMemberGuests(prisma, {
      bookingMemberId: effectiveMemberId,
      checkIn,
      guests: guestInputs,
    });

    if (unpaidMemberGuests.length > 0) {
      const unpaidMemberNames = unpaidMemberGuests.map((member) => member.name);
      return NextResponse.json(
        {
          error: `The following member guests have unpaid subscriptions: ${unpaidMemberNames.join(", ")}. All member guests must have a paid subscription before booking.`,
          code: "GUEST_SUBSCRIPTION_REQUIRED",
          unpaidMembers: unpaidMemberNames,
          unpaidMemberInvoices: unpaidMemberGuests.map((member) => ({
            memberId: member.memberId,
            name: member.name,
            status: member.status,
            invoiceUrl: member.invoiceUrl,
            invoiceNumber: member.invoiceNumber,
          })),
        },
        { status: 403 }
      );
    }
  }

  // Minimum stay policy (skipped only for authorized on-behalf bookings —
  // self-bookings always enforce it, #1442).
  if (!isAuthorizedOnBehalf) {
    const { validateMinimumStay, formatViolationsDetail } = await import("@/lib/booking-policies");
    const stayResult = await validateMinimumStay(checkIn, checkOut, bookingLodgeId);
    if (!stayResult.valid) {
      return NextResponse.json(
        {
          error: "Booking does not meet minimum stay requirement",
          details: formatViolationsDetail(stayResult.violations),
          code: "MINIMUM_STAY_VIOLATION",
          violations: stayResult.violations,
        },
        { status: 400 }
      );
    }
  }

  const gds = await prisma.groupDiscountSetting.findUnique({ where: { id: "default" } });
  const groupDiscount = toGroupDiscountConfig(gds);

  if (draft) {
    try {
      const newBooking = await createDraftBooking({
        effectiveMemberId,
        isOnBehalf: isAuthorizedOnBehalf,
        sessionUserId: session.user.id,
        checkIn,
        checkOut,
        guests: guestInputs,
        notes,
        promoCodeStr,
        promoGuestIndexes,
        workPartyEventId,
        expectedArrivalTime,
        requestedRoomId,
        cancelIfGuestsBumped,
        groupDiscount,
        memberReviewJustification,
        lodgeId: parsed.data.lodgeId,
      });
      return NextResponse.json(newBooking, { status: 201 });
    } catch (err) {
      if (err instanceof MembershipTypeBookingPolicyError) {
        return NextResponse.json(
          getMembershipTypeBookingPolicyErrorBody(err),
          { status: err.status },
        );
      }
      if (err instanceof BookingReviewJustificationRequiredError) {
        return NextResponse.json(
          { error: err.message, code: "REVIEW_JUSTIFICATION_REQUIRED" },
          { status: 400 }
        );
      }
      if (err instanceof BookingMemberNightConflictError) {
        return NextResponse.json(
          getBookingMemberNightConflictResponse(err.conflicts),
          { status: 409 },
        );
      }
      const message = err instanceof BookingPromoError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Failed to create draft booking";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }

  let internetBankingSettings: InternetBankingPaymentSettingsValues | undefined;
  if (paymentMethod === "internet_banking") {
    const modules = await loadEffectiveModuleFlags();
    if (!modules.xeroIntegration || !modules.internetBankingPayments) {
      return NextResponse.json(
        { error: "Internet Banking payments are not available." },
        { status: 400 }
      );
    }

    internetBankingSettings = await loadInternetBankingPaymentSettings();
    // The lead-time cutoff exists to collect payment before the stay; for a
    // retroactive booking the stay already happened, so skip the rejection
    // (the module-enabled check above still applies). (#1695)
    if (!retroactiveCreate) {
      const leadTime = checkInternetBankingLeadTime({
        checkIn,
        settings: internetBankingSettings,
      });
      if (!leadTime.allowed) {
        return NextResponse.json(
          {
            error: leadTime.unavailableReason ?? "Internet Banking is not available for this check-in date.",
            code: "INTERNET_BANKING_CUTOFF",
            minimumDaysBeforeCheckIn: leadTime.minimumDaysBeforeCheckIn,
            checkIn: leadTime.checkIn,
          },
          { status: 400 }
        );
      }
    }
  }

  const hasNonMembers = guestInputs.some((g) => !g.isMember);
  const holdPolicy = hasNonMembers
    ? await getNonMemberHoldPolicy(checkIn, parsed.data.lodgeId ?? null)
    : { enabled: false, holdDays: 0, source: "default" as const };
  const { shouldBePending, status } = calculateBookingHoldDecision({
    hasNonMembers,
    checkIn,
    holdDays: holdPolicy.holdDays,
    holdEnabled: holdPolicy.enabled,
  });

  // Pre-warm the credit balance only if requested; the service will load
  // it again inside the transaction. This call is kept here to preserve
  // the previous behaviour of issuing a credit lookup before the lock.
  if ((parsed.data.applyCreditCents ?? 0) > 0 && status === BookingStatus.PAYMENT_PENDING) {
    await getMemberCreditBalance(effectiveMemberId, prisma);
  }

  try {
    const outcome = await createConfirmedBooking({
      effectiveMemberId,
      isOnBehalf: isAuthorizedOnBehalf,
      sessionUserId: session.user.id,
      checkIn,
      checkOut,
      guests: guestInputs,
      notes,
      promoCodeStr,
      promoGuestIndexes,
      workPartyEventId,
      expectedArrivalTime,
      requestedRoomId,
      cancelIfGuestsBumped,
      applyCreditCents: parsed.data.applyCreditCents,
      groupDiscount,
      status,
      shouldBePending,
      holdDays: holdPolicy.holdDays,
      paymentMethod,
      internetBankingSettings,
      memberReviewJustification,
      lodgeId: parsed.data.lodgeId,
      allowPastDates: retroactiveCreate,
      confirmOverCapacity: parsed.data.confirmOverCapacity,
      notifyMember: parsed.data.notifyMember,
    });

    if (outcome.type === "created") {
      return NextResponse.json(outcome.booking, { status: 201 });
    }

    // Capacity exceeded path: 409 unless the caller already opted into
    // the waitlist, in which case we create the WAITLISTED booking.
    if (!waitlist) {
      return NextResponse.json(
        {
          error: "The lodge is fully booked on some of your requested dates.",
          code: "CAPACITY_EXCEEDED",
          fullNights: outcome.fullNights,
          canWaitlist: true,
        },
        { status: 409 }
      );
    }

    try {
      const waitlisted = await createWaitlistedBooking({
        effectiveMemberId,
        isOnBehalf: isAuthorizedOnBehalf,
        sessionUserId: session.user.id,
        checkIn,
        checkOut,
        guests: guestInputs,
        notes,
        promoCodeStr,
        promoGuestIndexes,
        workPartyEventId,
        expectedArrivalTime,
        requestedRoomId,
        groupDiscount,
        memberReviewJustification,
        lodgeId: parsed.data.lodgeId,
        alternateLodgeIds: parsed.data.alternateLodgeIds,
        notifyMember: parsed.data.notifyMember,
      });
      return NextResponse.json(waitlisted.booking, { status: 201 });
    } catch (waitlistErr) {
      if (waitlistErr instanceof MembershipTypeBookingPolicyError) {
        return NextResponse.json(
          getMembershipTypeBookingPolicyErrorBody(waitlistErr),
          { status: waitlistErr.status },
        );
      }
      if (waitlistErr instanceof BookingReviewJustificationRequiredError) {
        return NextResponse.json(
          { error: waitlistErr.message, code: "REVIEW_JUSTIFICATION_REQUIRED" },
          { status: 400 }
        );
      }
      if (waitlistErr instanceof BookingMemberNightConflictError) {
        return NextResponse.json(
          getBookingMemberNightConflictResponse(waitlistErr.conflicts),
          { status: 409 },
        );
      }
      if (waitlistErr instanceof BookingPromoError) {
        return NextResponse.json({ error: waitlistErr.message }, { status: 400 });
      }
      if (waitlistErr instanceof BookingLodgeError) {
        return NextResponse.json({ error: waitlistErr.message }, { status: 400 });
      }
      if (waitlistErr instanceof LodgeBookingEligibilityError) {
        return NextResponse.json(
          { error: waitlistErr.message },
          { status: waitlistErr.status },
        );
      }
      logger.error({ err: waitlistErr }, "Failed to create waitlisted booking");
      return NextResponse.json({ error: "Failed to create waitlisted booking" }, { status: 500 });
    }
  } catch (err) {
    if (err instanceof MembershipTypeBookingPolicyError) {
      return NextResponse.json(
        getMembershipTypeBookingPolicyErrorBody(err),
        { status: err.status },
      );
    }
    if (err instanceof BookingReviewJustificationRequiredError) {
      return NextResponse.json(
        { error: err.message, code: "REVIEW_JUSTIFICATION_REQUIRED" },
        { status: 400 }
      );
    }
    if (err instanceof BookingMemberNightConflictError) {
      return NextResponse.json(
        getBookingMemberNightConflictResponse(err.conflicts),
        { status: 409 },
      );
    }
    // Retroactive card path rejected (#1709): a past stay's outstanding balance
    // can't sit on the card PAYMENT_PENDING path; steer the admin to internet
    // banking, account credit, or a $0/comp booking.
    if (err instanceof RetroactiveCardPaymentError) {
      return NextResponse.json(
        { error: err.message, code: "RETROACTIVE_CARD_NOT_ALLOWED" },
        { status: 400 },
      );
    }
    // Retroactive over-capacity warn-and-confirm (#1695): surface the code and
    // the over-capacity nights so the admin can confirm and resubmit. Imported
    // from its own module so blanket @/lib/capacity mocks don't break instanceof.
    if (err instanceof OverCapacityConfirmationRequiredError) {
      return NextResponse.json(
        { error: err.message, code: err.code, nightDetails: err.nightDetails },
        { status: 409 },
      );
    }
    const message = err instanceof Error ? err.message : "Failed to create booking";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
