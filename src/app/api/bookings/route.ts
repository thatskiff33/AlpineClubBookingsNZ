import { NextRequest, NextResponse } from "next/server";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { auth } from "@/lib/auth";
import { BOOKING_LODGE_REQUIRED_CODE } from "@/lib/booking-lodge-scope";
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
import { ARRIVAL_TIME_ERROR_MESSAGE, ARRIVAL_TIME_PATTERN } from "@/lib/arrival-time";
import { getLodgeCapacity } from "@/lib/lodge-capacity";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { ApiError } from "@/lib/api-error";
import { getMemberCreditBalance } from "@/lib/member-credit";
import { findUnpaidMemberGuests } from "@/lib/booking-member-guest-subscriptions";
import logger from "@/lib/logger";
import { seasonYearOfStoredDate } from "@/lib/financial-year";
import {
  assertMembershipTypeBookingAllowed,
  getMembershipTypeBookingPolicyErrorBody,
  MembershipTypeBookingPolicyError,
  requiresPaidSubscriptionForMemberForBooking,
} from "@/lib/membership-type-policy";
import { resolveSubscriptionLockoutMode } from "@/lib/member-subscription-eligibility";
import {
  buildPaidUpAdultRefusalBody,
  evaluateNonMemberPricingRequirements,
  toSubscriptionLockoutParticipants,
  type NonMemberPricingRequirements,
} from "@/lib/subscription-lockout-enforcement";
import {
  assertLinkedBookingMembersCanBeBooked,
  BookingGuestValidationError,
  getBookingGuestValidationErrorResponse,
  normalizeBookingGuestInputs,
  resolveLinkedBookingMembersWithBoundary,
} from "@/lib/booking-guests";
import {
  loadMemberGuestAddPolicy,
  matchMemberGuestNotificationRows,
  planMemberGuestConsentWrites,
  type MemberGuestConsentWritePlanEntry,
} from "@/lib/member-guest-add-policy";
import {
  handleMemberGuestAddRefusal,
  memberGuestAddThrottleHook,
  MemberGuestAddThrottledError,
  startMemberGuestRefusalClock,
} from "@/lib/member-guest-probe-guard";
import type { MemberGuestAddActor } from "@/lib/member-guest-consent";
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
import { OverCapacityConfirmationRequiredError } from "@/lib/over-capacity-confirmation";
import {
  assertCheckInClearsXeroLockDate,
  getXeroLockGuardErrorResponse,
} from "@/lib/xero-period-lock-guard";
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
  isDateOnlyString,
  parseDateOnly,
} from "@/lib/date-only";
import { dateOnlyInstantOf } from "@/lib/club-time";
import { clubTime } from "@/lib/club-time/server";
import { resolveOptionalActiveLodgeId } from "@/lib/lodges";
import { aggregatePolicyExceptionViolations } from "@/lib/booking-policy-exceptions";
import {
  buildAdultMemberHostingRefusalBody,
  evaluateProposedAdultMemberHosting,
} from "@/lib/adult-member-hosting-review";
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
  // #2621: display-only information for the hut leader — the shared pattern,
  // never a re-spelled literal. The copy that used to sit here read `[0-5]0` and
  // let a booking be created with an arrival time (:10/:20/:40/:50) that the
  // picker on the booking page could never show back to the member.
  expectedArrivalTime: z
    .string()
    .regex(ARRIVAL_TIME_PATTERN, ARRIVAL_TIME_ERROR_MESSAGE)
    .optional(),
  requestedRoomId: z.string().min(1).optional(),
  // Lodge the booking is for (multi-lodge phase 8). Optional at schema-parse
  // time only, so the route can return its own BOOKING_LODGE_REQUIRED 400;
  // every create must name a lodge and omission never defaults one.
  lodgeId: z.string().min(1).optional(),
  // Cross-lodge waitlist opt-in (ADR-004): other lodges the member would
  // also accept. Only meaningful with waitlist: true; ignored otherwise.
  alternateLodgeIds: z.array(z.string().min(1)).max(20).optional(),
  cancelIfGuestsBumped: z.boolean().optional(),
  // Account credit the member asks to put towards this booking, integer cents.
  // The upper bound is deliberately absurd rather than tight — the real limits
  // are the member's balance and the booking price, enforced downstream — but
  // it has to exist: without it a fat-fingered or hostile value sails past
  // validation and only fails deep in the money path, as an opaque 400 or a
  // 500, instead of as a plain field error on the credit input (#2265).
  // $1,000,000 is far above any club booking or balance.
  applyCreditCents: z.number().int().min(0).max(100_000_000).optional(),
  forMemberId: z.string().optional(),
  memberReviewJustification: z.string().trim().min(1).max(1000).optional(),
  // The admin's explicit on-behalf confirmation that they are accepting an
  // adult-member hosting exception (#2364, epic decision D-R4). Honoured ONLY
  // on an authorised on-behalf booking, and only as a reason — never as a bare
  // boolean, because "an admin ticked a box" is not an answer anybody can audit.
  // A dual-hat admin booking for themselves is a member here, exactly as #1442
  // decided for minimum stay, and this field does nothing for them.
  adultMemberHostingReason: z.string().trim().min(1).max(500).optional(),
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
  // #2388: taken at the top so the collapsed-refusal timing floor covers the
  // whole request, not only the part after the refusal was detected.
  const startedAt = startMemberGuestRefusalClock();
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
    (allowPastDatesFlag !== undefined ||
      notifyMemberFlag !== undefined ||
      confirmOverCapacityFlag !== undefined) &&
    !parsed.data.forMemberId
  ) {
    return NextResponse.json(
      {
        error:
          "allowPastDates, notifyMember and confirmOverCapacity are only available when booking on behalf of a member",
      },
      { status: 400 },
    );
  }
  // The over-capacity confirmation resolves a create that would otherwise be
  // admitted; a draft never runs the capacity check and a waitlist opt-in
  // needs the capacity-exceeded outcome to fall through (#1767).
  if (
    confirmOverCapacityFlag !== undefined &&
    (parsed.data.draft === true || parsed.data.waitlist === true)
  ) {
    return NextResponse.json(
      { error: "confirmOverCapacity cannot be combined with draft or waitlist" },
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
  let paidUpAdultViolation: NonNullable<
    NonMemberPricingRequirements["violation"]
  > | null = null;

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
    adultMemberHostingReason,
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

  // "+ Add Member Guest" (epic #2305, MG2 #2307). Read the module flag and the
  // policy singleton HERE — one read each, before any transaction is opened —
  // then pass the answers down. The create service opens the booking transaction
  // and takes the per-lodge capacity lock; a settings read in there would hold
  // that lock across an extra query for nothing.
  const memberGuestPolicy = await loadMemberGuestAddPolicy();
  // MG4-D-a, brought forward into MG2: an on-behalf create is an ADMIN add, so a
  // cross-family guest is consent-free and always-notify, stamped with the acting
  // admin rather than left PENDING. `isAuthorizedOnBehalf` is exactly the flag
  // that passes `skipAuthorization` below, so the two can never disagree.
  const memberGuestActor: MemberGuestAddActor = isAuthorizedOnBehalf
    ? { kind: "ADMIN", adminMemberId: session.user.id }
    : { kind: "MEMBER" };
  let memberGuestEntries = new Map<string, MemberGuestConsentWritePlanEntry>();

  try {
    const { members: linkedMembers, boundary } =
      await resolveLinkedBookingMembersWithBoundary(
        prisma,
        effectiveMemberId,
        guests.map((guest) => guest.memberId),
        {
          skipAuthorization: isAuthorizedOnBehalf,
          memberGuestWideningEnabled: memberGuestPolicy.wideningEnabled,
          // #2388: the per-acting-member throttle, counted only on an attempt
          // that actually names a beyond-family member, and spent the moment the
          // family boundary is known — before any member row is read (H1), so a
          // real member and an id with nobody behind it answer identically once
          // the budget is gone.
          onBoundaryResolved: memberGuestAddThrottleHook({
            request,
            actorMemberId: session.user.id,
            skipAuthorization: isAuthorizedOnBehalf,
          }),
        }
      );

    await assertLinkedBookingMembersCanBeBooked(
      prisma,
      linkedMembers,
      session.user.id,
      {
        actorRole,
        onBehalfOfMemberId: isAuthorizedOnBehalf ? effectiveMemberId : null,
        // D-8: a blocked cross-family member gets the one neutral refusal
        // instead of their name, their missing profile fields and their login
        // state.
        crossFamilyMemberIds: boundary.beyondFamilyMemberIds,
      }
    );
    const normalizedGuests = normalizeBookingGuestInputs(guests, linkedMembers);
    const consentPlan = planMemberGuestConsentWrites({
      guests: normalizeGuestStayRanges(normalizedGuests, { checkIn, checkOut }),
      boundary,
      actor: memberGuestActor,
      now: new Date(),
      bookingCheckIn: checkIn,
      policy: memberGuestPolicy,
    });
    guestInputs = consentPlan.guests;
    memberGuestEntries = consentPlan.entriesByMemberId;
  } catch (error) {
    if (error instanceof MemberGuestAddThrottledError) return error.response;
    if (error instanceof BookingGuestValidationError) {
      await handleMemberGuestAddRefusal({
        request,
        actorMemberId: session.user.id,
        error: error,
        route: "bookings/create",
        startedAt,
        throttle: "ALREADY_CHARGED",
        skipAuthorization: isAuthorizedOnBehalf,
      });
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

  /**
   * Tell the cross-family guests this create just added, AFTER it committed.
   *
   * AWAITED, not fire-and-forget, unlike the booking-confirmation email beside
   * it. Two reasons: a lost consent request is not a lost courtesy but a bed held
   * (D-4) for a member nobody ever asked, which only the nightly sweep will
   * clear; and a `void` promise is exactly what a serverless freeze after the
   * response drops. The dispatcher never rejects and returns immediately when
   * there is nothing owed, so every booking without a cross-family guest — which
   * is nearly all of them — pays nothing for this.
   */
  const notifyMemberGuestAdds = async (created: {
    id: string;
    guests: Array<{ id: string; memberId: string | null }>;
  }) => {
    // Nothing was planned, so nothing was written and nobody is owed anything —
    // the state of every booking on a club that has not turned the module on, and
    // of every booking whose guests are all inside the booker's family. Checked
    // first so the ordinary path does no work at all.
    if (memberGuestEntries.size === 0) return;
    const rows = matchMemberGuestNotificationRows({
      createdGuests: created.guests,
      entriesByMemberId: memberGuestEntries,
    });
    if (rows.length === 0) return;
    // Loaded lazily on purpose: the sender pulls in the whole email/template
    // graph, and only a booking that actually added a cross-family member guest
    // needs it. A club with the module off never loads the mailer through this
    // path at all.
    const { sendMemberGuestAddNotifications } = await import(
      "@/lib/member-guest-consent-notifications"
    );
    // Belt and braces around a function that is documented never to reject: the
    // booking is ALREADY COMMITTED at this point, so an unexpected throw here
    // would hand the member an error for a booking that exists and was paid for.
    // A notification problem is logged, never surfaced as a booking failure.
    try {
      await sendMemberGuestAddNotifications({
        bookingId: created.id,
        rows,
        actor: memberGuestActor,
      });
    } catch (err) {
      logger.error(
        { err, bookingId: created.id },
        "Failed to dispatch member-guest add notifications",
      );
    }
  };

  /**
   * #2284 (S2): tell a FAMILY co-member (or the adults acting for them) that this
   * create just put them on a booking — the missing half of #2250 self-removal.
   *
   * Runs regardless of the memberGuests module and independently of the
   * member-guest dispatch above; the dispatcher itself filters to family scope,
   * so a beyond-family member guest handled above is never double-notified. AWAITED
   * and try/caught for the same reason as the member-guest dispatch: the booking
   * is already committed, so a notification problem is logged, never surfaced.
   */
  const notifyFamilyAdds = async (created: {
    id: string;
    guests: Array<{ id: string; memberId: string | null }>;
  }) => {
    const addedMemberIds = created.guests
      .map((guest) => guest.memberId)
      .filter((memberId): memberId is string => Boolean(memberId));
    if (addedMemberIds.length === 0) return;
    const { sendFamilyMemberBookingAddNotifications } = await import(
      "@/lib/family-booking-add-notifications"
    );
    try {
      await sendFamilyMemberBookingAddNotifications({
        bookingId: created.id,
        bookerMemberId: effectiveMemberId,
        actorMemberId: session.user.id,
        addedMemberIds,
      });
    } catch (err) {
      logger.error(
        { err, bookingId: created.id },
        "Failed to dispatch family booking-add notifications",
      );
    }
  };

  // CT-4 (#2870): the club's day, from the persisted ClubTimeSettings zone and
  // not the container's TZ (INV-CONFIG-002, INV-DATE-019), encoded at UTC
  // midnight so it shares a frame with the parsed dates and addDaysDateOnly.
  //
  // #3123 review — resolved HERE, above the person-night pre-flight, and used by
  // everything on this route that needs a day: the retroactive gate below, the
  // conflict scan's self-removal window, and `createConfirmedBooking`, which is
  // transaction-aware and so cannot resolve one for itself (`INV-LOCK-004`).
  // `clubTime()` is request-memoised, but ONE binding is what makes "one club
  // day per request" a property of the code rather than of the cache.
  const todayAtClub = (await clubTime()).today();
  const today = dateOnlyInstantOf(todayAtClub);

  // D-8: with a cross-family guest in the party this refuses NEUTRALLY rather
  // than returning the conflict body, because that body would name the nights a
  // member the caller may never have met is already booked for.
  let memberNightConflicts;
  try {
    memberNightConflicts = await findBookingMemberNightConflicts(prisma, {
      actorMemberId: session.user.id,
      actorRole,
      checkIn,
      checkOut,
      guests: guestInputs,
      today,
    });
  } catch (error) {
    if (error instanceof BookingGuestValidationError) {
      await handleMemberGuestAddRefusal({
        request,
        actorMemberId: session.user.id,
        error: error,
        route: "bookings/create",
        startedAt,
        throttle: "ALREADY_CHARGED",
        skipAuthorization: isAuthorizedOnBehalf,
      });
      return NextResponse.json(
        getBookingGuestValidationErrorResponse(error),
        { status: error.status },
      );
    }
    throw error;
  }
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
    // Xero lock-date guard (#1695; shared with the admin override modify paths
    // via #1697): the booking's invoice issue date is its check-in, so a past
    // check-in must not fall on or before a locked accounting period. Skipped
    // when Xero is not connected; fails closed (retryable 503) when the lock
    // dates cannot be read. The Xero call stays outside any DB transaction.
    try {
      await assertCheckInClearsXeroLockDate(envelopeCheckIn, {
        xeroIntegrationEnabled,
      });
    } catch (error) {
      const guardResponse = getXeroLockGuardErrorResponse(error);
      if (guardResponse) {
        return NextResponse.json(guardResponse.body, {
          status: guardResponse.status,
        });
      }
      throw error;
    }
  }

  /*
   * A BOOKING MUST NAME ITS LODGE. THE SERVER NO LONGER FILLS THE BLANK (#2701).
   *
   * `resolveOptionalActiveLodgeId` answers a missing id with the club's DEFAULT
   * lodge. On a read that is a reasonable convenience; on a CREATE it is how a
   * guest ends up booked — and paid up — at a lodge nobody ever showed them.
   * The reachable path was not a hand-made request: when `/api/admin/lodges` or
   * `/api/lodges` fails, `useLodgeOptions` returns an empty list, `LodgeSelect`
   * normalises the selection to `null` and renders nothing at all (ADR-002),
   * and both booking wizards then posted `lodgeId: undefined`. In a multi-lodge
   * club that silently stamped the default lodge on a real booking, and the
   * member's own review step suppressed its "Lodge:" line in exactly that
   * state, so nothing on screen contradicted it.
   *
   * Ten client surfaces are fixed alongside this, but the refusal is what closes
   * the class: one gate instead of ten, so the eleventh screen somebody writes
   * next year fails loudly here rather than writing quietly to the wrong lodge.
   *
   * Deliberately NOT done by making the shared helper strict. That helper also
   * serves reads where an omitted lodge legitimately means "the whole club", and
   * `INV-INT-016` retains exactly such a mode on `GET /api/bookings/rooms` for
   * consumers outside this repository. The two are consistent rather than in
   * tension: an unscoped DISCOVERY read is a real question ("where could I
   * book?"), an unscoped CREATE is not — you cannot book "somewhere". So the
   * strictness lives here, on the write, and the read contract is untouched.
   */
  if (!parsed.data.lodgeId) {
    return NextResponse.json(
      {
        error:
          "This booking did not say which lodge it is for. Choose a lodge and try again.",
        code: BOOKING_LODGE_REQUIRED_CODE,
      },
      { status: 400 },
    );
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
      seasonYear: seasonYearOfStoredDate(checkIn),
      // Finding 2 (privacy re-review of MG3 #2308).
      skipAuthorization: isAuthorizedOnBehalf,
    });
  } catch (err) {
    if (err instanceof MembershipTypeBookingPolicyError) {
      // Finding 2 (privacy re-review of MG3 #2308). The membership-type refusal
      // is D-8's FOURTH collapsing refusal, so when it collapsed it owes the
      // same three mitigations as its siblings — the throttle unit, the audit
      // row naming actor and target, and the timing floor. A no-op for every
      // other membership-type block: the handler returns immediately unless the
      // error carries `crossFamilyMemberIds`, which only a collapsed one does.
      await handleMemberGuestAddRefusal({
        request,
        actorMemberId: session.user.id,
        error: err,
        route: "bookings/create",
        startedAt,
        throttle: "ALREADY_CHARGED",
        skipAuthorization: isAuthorizedOnBehalf,
      });
      return NextResponse.json(
        getMembershipTypeBookingPolicyErrorBody(err),
        { status: err.status },
      );
    }
    throw err;
  }

  // #2543 — the club's three-way subscription-lockout policy, resolved ONCE for
  // this request so the owner gate, the member-guest gate and the paid-up-adult
  // requirement below cannot branch on different answers if an admin saves the
  // setting mid-request.
  const subscriptionLockoutMode = await resolveSubscriptionLockoutMode();

  // Subscription gate for the booking owner. Bypassed when the Xero module
  // is effectively off, because subscriptions are invoiced through Xero, and
  // (#2543) when the club has chosen NON_MEMBER_PRICING — there the unpaid owner
  // books and is repriced by `resolveGuestRateMembershipTypes` instead.
  if (
    subscriptionLockoutMode === "HARD_BLOCK" &&
    !isAuthorizedOnBehalf &&
    await requiresPaidSubscriptionForMemberForBooking(prisma, {
      memberId: effectiveMemberId,
      seasonYear: seasonYearOfStoredDate(checkIn),
      ageTier: effectiveMemberAgeTier,
    })
  ) {
    const seasonYear = seasonYearOfStoredDate(checkIn);
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
    // D-8: for a cross-family guest this throws the one neutral refusal instead
    // of returning the member's name, subscription status, invoice number and a
    // link to their invoice.
    let unpaidMemberGuests;
    try {
      unpaidMemberGuests = await findUnpaidMemberGuests(prisma, {
        bookingMemberId: effectiveMemberId,
        checkIn,
        guests: guestInputs,
      });
    } catch (error) {
      if (error instanceof BookingGuestValidationError) {
        await handleMemberGuestAddRefusal({
          request,
          actorMemberId: session.user.id,
          error: error,
          route: "bookings/create",
          startedAt,
          throttle: "ALREADY_CHARGED",
          skipAuthorization: isAuthorizedOnBehalf,
        });
        return NextResponse.json(
          getBookingGuestValidationErrorResponse(error),
          { status: error.status },
        );
      }
      throw error;
    }

    // #2543: under NON_MEMBER_PRICING an unpaid member guest is repriced, not
    // refused. `findUnpaidMemberGuests` above still RUNS in that mode, and
    // deliberately: it is what raises the D-8 neutral refusal for an unpaid
    // member guest from beyond the booker's family, and that privacy boundary is
    // not the lockout policy's to relax. Only the refusal below is mode-gated.
    if (subscriptionLockoutMode === "HARD_BLOCK" && unpaidMemberGuests.length > 0) {
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

  // #2543 — under NON_MEMBER_PRICING the booking must contain at least one
  // paid-up adult member. Refused when it does not, but refused with a door: the
  // response carries the frozen, exception-eligible violation, so the member can
  // ask a Booking Officer to allow it through the #2365 request workflow, and
  // the HOLD capacity mode keeps their beds while that decision is pending.
  //
  // Skipped for an authorized on-behalf booking, exactly like the two gates
  // above (#1442) and for the same reason as the hosting rule's D-R4: the person
  // who would approve the override is the person making the booking.
  if (!isAuthorizedOnBehalf) {
    const nonMemberPricing = await evaluateNonMemberPricingRequirements(prisma, {
      mode: subscriptionLockoutMode,
      lodgeId: bookingLodgeId,
      seasonYear: seasonYearOfStoredDate(checkIn),
      checkIn,
      checkOut,
      // Owner decision, 3 Aug 2026: the requirement follows the unfinancial
      // member, not only their bed. The HARD_BLOCK gate above refuses this same
      // person outright, as a person, whether or not they are staying; keyed only
      // on the guest rows, the relaxed mode let an unfinancial member book a party
      // of non-members with no reprice, no requirement and no notice — the one
      // case the strict mode most reliably closes.
      bookingOwnerMemberId: effectiveMemberId,
      // D-12 on a PRE-PERSIST party. `guestInputs` is `consentPlan.guests`, so
      // every cross-family member guest already carries the `memberGuestConsent`
      // columns this request is about to write — including the PENDING status.
      // Passing the raw list read `operationallyPresent` as absent, i.e. present,
      // and made the requirement trivially satisfiable: name any paid-up adult
      // member from beyond your family, and the invite need never be accepted.
      // The D-4 sweep then removes the row and the booking stands with no
      // paid-up adult member on it, with nothing to re-evaluate it. This
      // evaluation is the only enforcement on the create path, so unlike #2364 —
      // whose create-time answer is later re-derived by a reconciler that does
      // apply consent — nothing would ever correct it.
      participants: toSubscriptionLockoutParticipants(guestInputs),
    });
    paidUpAdultViolation = nonMemberPricing?.violation ?? null;
  }

  // Minimum stay policy (skipped only for authorized on-behalf bookings —
  // self-bookings always enforce it, #1442).
  if (!isAuthorizedOnBehalf) {
    const { validateMinimumStay, formatViolationsDetail } = await import("@/lib/booking-policies");
    const stayResult = await validateMinimumStay(checkIn, checkOut, bookingLodgeId);
    if (!stayResult.valid) {
      const exceptionReview = aggregatePolicyExceptionViolations(
        stayResult.violations,
      );
      return NextResponse.json(
        {
          error: "Booking does not meet minimum stay requirement",
          details: formatViolationsDetail(stayResult.violations),
          code: "MINIMUM_STAY_VIOLATION",
          violations: exceptionReview.violations,
          exceptionReview,
        },
        { status: 400 }
      );
    }
  }

  // Adult-member hosting policy (#2364, epic decisions D-R3/D-R4).
  //
  // Unlike minimum stay this is NOT a refusal for a member: the club chose
  // "admin review required", so the booking is made and an admin decides
  // afterwards. The check here exists for the one case where silence would be
  // wrong — an ADMIN booking on somebody's behalf. D-R4 says hosting is always
  // administratively overridable through an explicit reason, and the mirror of
  // that is that an admin must not override it by accident. So an on-behalf
  // booking that trips the rule is refused until the admin states a reason, and
  // that reason is then persisted against the approval.
  //
  // Deliberately pre-transaction, like every other booking check here, and
  // deliberately NOT the source of the stored snapshot: the snapshot the
  // reconciler writes inside the transaction is derived from the persisted guest
  // rows, so it references real BookingGuest ids and stays comparable with every
  // later evaluation.
  //
  // #2569 — evaluated for EVERY booker now, not only for an on-behalf admin,
  // because the ENFORCED consequence refuses the ordinary member's booking too.
  // One evaluation serves both outcomes: the violation carries the club's
  // `consequence`, so the branch below reads the club's setting rather than
  // re-resolving it. A club on DISABLED pays one narrow policy read and no member
  // read, and a club on ADMIN_REVIEW_REQUIRED behaves exactly as it did before —
  // the answer is used for the on-behalf gate and otherwise discarded, with the
  // stored snapshot still coming from the reconciler inside the transaction.
  if (!adultMemberHostingReason) {
    const hostingViolation = await evaluateProposedAdultMemberHosting(prisma, {
      bookingOwnerMemberId: effectiveMemberId,
      lodgeId: bookingLodgeId,
      checkIn,
      checkOut,
      guests: guestInputs,
    });
    if (hostingViolation && isAuthorizedOnBehalf) {
      const exceptionReview = aggregatePolicyExceptionViolations([
        hostingViolation,
      ]);
      return NextResponse.json(
        {
          error:
            "This booking has non-member guests on nights when no adult member is staying. Give a reason to record with the booking, then submit again.",
          details: hostingViolation.message,
          code: "ADULT_MEMBER_HOSTING_CONFIRM_REQUIRED",
          violations: exceptionReview.violations,
          exceptionReview,
        },
        { status: 409 },
      );
    }
    // The ENFORCED refusal (#2569 §1), pre-transaction like every other booking
    // check here. The reconciler would refuse this booking anyway from inside the
    // creating transaction, but refusing before it opens means the member is not
    // charged for a capacity lock and a full write that is about to roll back —
    // and it is the only place the member can be handed the exception door with
    // the party they actually submitted.
    if (hostingViolation?.consequence === "ENFORCED") {
      if (paidUpAdultViolation) {
        const hostingRefusal = buildAdultMemberHostingRefusalBody(hostingViolation);
        const exceptionReview = aggregatePolicyExceptionViolations([
          paidUpAdultViolation,
          ...hostingRefusal.violations,
        ]);
        return NextResponse.json(
          {
            error:
              "This booking needs both a paid-up adult member and adult member cover for every required night.",
            details: exceptionReview.violations
              .map((violation) => violation.message)
              .join(" "),
            code: "BOOKING_POLICY_REQUIREMENTS_NOT_MET",
            reasonCodes: exceptionReview.violations.map(
              (violation) => violation.reasonCode,
            ),
            violations: exceptionReview.violations,
            exceptionReview,
            exceptionRequestPath: hostingRefusal.exceptionRequestPath,
          },
          { status: 409 },
        );
      }
      return NextResponse.json(
        buildAdultMemberHostingRefusalBody(hostingViolation),
        { status: 409 },
      );
    }
  }

  if (paidUpAdultViolation) {
    return NextResponse.json(
      buildPaidUpAdultRefusalBody(paidUpAdultViolation),
      { status: 409 },
    );
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
        // #2265 — the draft branch used to omit this field entirely, so a
        // member who ticked "use my credit" and then saved a draft had their
        // election silently discarded. The draft service does NOT consume the
        // credit; it stores the election on the booking and the pay path
        // applies it when the booking reaches PAYMENT_PENDING. Keep this key
        // in step with the createConfirmedBooking call below —
        // issue-2265-booking-create-money-parity.test.ts fails if the two argument
        // objects diverge on a money-bearing field again.
        applyCreditCents: parsed.data.applyCreditCents,
        groupDiscount,
        // #2543 — the mode resolved once above, handed to pricing so no path in
        // this request can price under a regime the gates did not branch on.
        subscriptionLockoutMode,
        memberReviewJustification,
        adultMemberHostingReason,
        lodgeId: parsed.data.lodgeId,
      });
      await notifyMemberGuestAdds(newBooking);
      await notifyFamilyAdds(newBooking);
      return NextResponse.json(newBooking, { status: 201 });
    } catch (err) {
      if (err instanceof BookingGuestValidationError) {
        // The in-transaction person-night guard's D-8 refusal (the pre-flight
        // check above ran before the lock, so a race lands here). The
        // transaction has already rolled back, so the #2388 handling below runs
        // outside it and holds no lock while it waits.
      await handleMemberGuestAddRefusal({
          request,
          actorMemberId: session.user.id,
          error: err,
          route: "bookings/create",
          startedAt,
          throttle: "ALREADY_CHARGED",
          skipAuthorization: isAuthorizedOnBehalf,
        });
        return NextResponse.json(
          getBookingGuestValidationErrorResponse(err),
          { status: err.status },
        );
      }
      if (err instanceof MembershipTypeBookingPolicyError) {
      // Finding 2 (privacy re-review of MG3 #2308). The membership-type refusal
      // is D-8's FOURTH collapsing refusal, so when it collapsed it owes the
      // same three mitigations as its siblings — the throttle unit, the audit
      // row naming actor and target, and the timing floor. A no-op for every
      // other membership-type block: the handler returns immediately unless the
      // error carries `crossFamilyMemberIds`, which only a collapsed one does.
        await handleMemberGuestAddRefusal({
          request,
          actorMemberId: session.user.id,
          error: err,
          route: "bookings/create",
          startedAt,
          throttle: "ALREADY_CHARGED",
          skipAuthorization: isAuthorizedOnBehalf,
        });
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
      if (err instanceof BookingPromoError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      if (err instanceof BookingLodgeError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      if (err instanceof LodgeBookingEligibilityError) {
        return NextResponse.json(
          { error: err.message },
          { status: err.status },
        );
      }
      if (err instanceof ApiError) {
        return NextResponse.json(
          { error: err.message },
          { status: err.status },
        );
      }
      // #1888 — unexpected (non-typed) errors must not leak their message to
      // the client; the raw error stays in the log only.
      logger.error({ err }, "Failed to create draft booking");
      return NextResponse.json(
        { error: "Failed to create draft booking" },
        { status: 400 }
      );
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
        // #3123 — the SAME club day this route already resolved above for the
        // retroactive-create gate, not a second answer from the environment.
        today,
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
      // #3123 review — the SAME club day this route already gated the
      // retroactive envelope on, so the service's defence-in-depth re-check
      // cannot land on a different day (`INV-LOCK-004`).
      todayAtClub,
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
      // #2543 — see the draft branch above.
      subscriptionLockoutMode,
      status,
      shouldBePending,
      holdDays: holdPolicy.holdDays,
      paymentMethod,
      internetBankingSettings,
      memberReviewJustification,
      adultMemberHostingReason,
      lodgeId: parsed.data.lodgeId,
      allowPastDates: retroactiveCreate,
      confirmOverCapacity: parsed.data.confirmOverCapacity,
      notifyMember: parsed.data.notifyMember,
      waitlistIntent: waitlist === true,
    });

    if (outcome.type === "created") {
      await notifyMemberGuestAdds(outcome.booking);
      await notifyFamilyAdds(outcome.booking);
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
        // #2543 — see the draft branch above.
        subscriptionLockoutMode,
        memberReviewJustification,
        adultMemberHostingReason,
        lodgeId: parsed.data.lodgeId,
        alternateLodgeIds: parsed.data.alternateLodgeIds,
        notifyMember: parsed.data.notifyMember,
      });
      await notifyMemberGuestAdds(waitlisted.booking);
      await notifyFamilyAdds(waitlisted.booking);
      return NextResponse.json(waitlisted.booking, { status: 201 });
    } catch (waitlistErr) {
      if (waitlistErr instanceof BookingGuestValidationError) {
      await handleMemberGuestAddRefusal({
          request,
          actorMemberId: session.user.id,
          error: waitlistErr,
          route: "bookings/create",
          startedAt,
          throttle: "ALREADY_CHARGED",
          skipAuthorization: isAuthorizedOnBehalf,
        });
        return NextResponse.json(
          getBookingGuestValidationErrorResponse(waitlistErr),
          { status: waitlistErr.status },
        );
      }
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
    const hostingRetry = hostingCoverageParticipantRetryResponse(err);
    if (hostingRetry) return hostingRetry;
    if (err instanceof BookingGuestValidationError) {
      // The in-transaction person-night guard's D-8 refusal, reached on a race
      // with the pre-flight check above.
      await handleMemberGuestAddRefusal({
        request,
        actorMemberId: session.user.id,
        error: err,
        route: "bookings/create",
        startedAt,
        throttle: "ALREADY_CHARGED",
        skipAuthorization: isAuthorizedOnBehalf,
      });
      return NextResponse.json(
        getBookingGuestValidationErrorResponse(err),
        { status: err.status },
      );
    }
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
    // Retroactive over-capacity warn-and-confirm (#1695): surface the code and
    // the over-capacity nights so the admin can confirm and resubmit. Imported
    // from its own module so blanket @/lib/capacity mocks don't break instanceof.
    if (err instanceof OverCapacityConfirmationRequiredError) {
      return NextResponse.json(
        { error: err.message, code: err.code, nightDetails: err.nightDetails },
        { status: 409 },
      );
    }
    if (err instanceof BookingPromoError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof BookingLodgeError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof LodgeBookingEligibilityError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status },
      );
    }
    if (err instanceof ApiError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status },
      );
    }
    // #1888 — unexpected (non-typed) errors must not leak their message to
    // the client; the raw error stays in the log only.
    logger.error({ err }, "Failed to create booking");
    return NextResponse.json(
      { error: "Failed to create booking" },
      { status: 400 }
    );
  }
}
