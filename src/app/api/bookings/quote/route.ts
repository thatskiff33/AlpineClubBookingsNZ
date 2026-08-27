import { NextRequest, NextResponse } from "next/server";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { auth } from "@/lib/auth";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { isMemberEligibleToBookLodge } from "@/lib/lodge-access";
import { getDefaultLodgeId, lodgeNullTolerantScope } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import {
  calculateBookingHoldDecision,
  isGroupDiscountAppliedToBooking,
  priceDeferredNonMemberPortion,
  toGroupDiscountConfig,
  toSeasonRateData,
} from "@/lib/policies/booking-route-decisions";
import { getNonMemberHoldPolicy } from "@/lib/cancellation";
import {
  getMembershipTypeBookingPolicyErrorBody,
  MembershipTypeBookingPolicyError,
  priceBookingGuestsWithMembershipTypePolicy,
} from "@/lib/membership-type-policy";
import { getMemberCreditBalance } from "@/lib/member-credit";
import { resolveSubscriptionLockoutMode } from "@/lib/member-subscription-eligibility";
import { evaluateNonMemberPricingRequirements } from "@/lib/subscription-lockout-enforcement";
import { seasonYearOfStoredDate } from "@/lib/financial-year";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { z } from "zod";
import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  assertLinkedBookingMembersCanBeBooked,
  BookingGuestValidationError,
  getBookingGuestValidationErrorResponse,
  type BookingGuestPricingInput,
  normalizeBookingGuestPricingInputs,
  resolveLinkedBookingMembersWithBoundary,
} from "@/lib/booking-guests";
import {
  loadMemberGuestAddPolicy,
  markCrossFamilyMemberGuests,
  type MemberGuestConsentGuestFields,
} from "@/lib/member-guest-add-policy";
import {
  BookingGuestStayRangeValidationError,
  type NormalizedBookingGuestStayRange,
  normalizeGuestStayRanges,
} from "@/lib/booking-guest-stay-range-input";
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { bookingManagementAuthorizationRole } from "@/lib/admin-permissions";
import {
  findBookingMemberNightConflicts,
  getBookingMemberNightConflictResponse,
} from "@/lib/booking-member-night-conflicts";
import {
  handleMemberGuestAddRefusal,
  memberGuestAddThrottleHook,
  MemberGuestAddThrottledError,
  startMemberGuestRefusalClock,
} from "@/lib/member-guest-probe-guard";

const dateOnlyString = z.string().refine(isDateOnlyString, {
  message: "Date must be YYYY-MM-DD",
});

const quoteSchema = z.object({
  checkIn: dateOnlyString.transform(parseDateOnly),
  checkOut: dateOnlyString.transform(parseDateOnly),
  lodgeId: z.string().min(1).optional(),
  guests: z.array(
    z.object({
      ageTier: bookableAgeTierEnum,
      isMember: z.boolean(),
      memberId: z.string().min(1).optional(),
      stayStart: z.string().optional(),
      stayEnd: z.string().optional(),
      // Explicit included nights for a multi date range stay (issue #713).
      nights: z.array(z.string()).max(370).optional(),
    })
  ).min(1),
  forMemberId: z.string().optional(),
});

export async function POST(request: NextRequest) {
  // #2388: read once, at the very top, so the response-timing floor on a
  // collapsed cross-family refusal covers the WHOLE request rather than only the
  // part after the refusal was detected.
  const startedAt = startMemberGuestRefusalClock();
  const rateLimited = await applyRateLimit(rateLimiters.bookingQuery, request);
  if (rateLimited) return rateLimited;

  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }
  // bookings:edit holders (Full Admin, Booking Officer, custom roles) may
  // quote on-behalf — aligned with booking create and the modification path
  // (#1313/#1442).
  const canManageBookings =
    bookingManagementAuthorizationRole(session.user) === "ADMIN";
  const actorRole = bookingManagementAuthorizationRole(session.user);

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;

  const parsed = quoteSchema.safeParse(json.body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { checkIn, checkOut } = parsed.data;
  const rawGuests: BookingGuestPricingInput[] = parsed.data.guests;
  // The MG2 field set is part of the declared type rather than smuggled through
  // at runtime, so the D-8 marker is visible to the type system all the way to
  // the person-night guard instead of being an untyped property a refactor could
  // silently drop.
  let guests: Array<
    BookingGuestPricingInput &
      NormalizedBookingGuestStayRange &
      MemberGuestConsentGuestFields
  >;

  if (checkOut <= checkIn) {
    return NextResponse.json({ error: "Check-out must be after check-in" }, { status: 400 });
  }

  // A quote with forMemberId must never silently price the caller instead of
  // the target: unauthorized callers are rejected, mirroring create (#1442).
  if (parsed.data.forMemberId) {
    if (!canManageBookings) {
      return NextResponse.json(
        { error: "Only admins can book on behalf of another member" },
        { status: 403 }
      );
    }
    if (parsed.data.forMemberId === session.user.id) {
      return NextResponse.json(
        { error: "Booking managers cannot book for themselves — book your own stay through the member booking page" },
        { status: 400 }
      );
    }
  }
  const isAuthorizedOnBehalf = Boolean(parsed.data.forMemberId);
  const effectiveMemberId = isAuthorizedOnBehalf
    ? parsed.data.forMemberId!
    : session.user.id;

  // "+ Add Member Guest" (epic #2305, MG2 #2307). THIS ROUTE PERSISTS NOTHING, so
  // it plans no consent and notifies nobody — but it must resolve a cross-family
  // member all the same, or it prices the party wrongly. A member guest prices at
  // member rates and counts toward the group discount and the non-member hold
  // decision, so a quote that refused them would show the booker a total the
  // create path immediately contradicts. Only the module flag is needed here; the
  // policy singleton decides how a row is WRITTEN, and there is no row.
  const memberGuestPolicy = await loadMemberGuestAddPolicy();

  try {
    const { members: linkedMembers, boundary } =
      await resolveLinkedBookingMembersWithBoundary(
        prisma,
        effectiveMemberId,
        rawGuests.map((guest) => guest.memberId),
        {
          skipAuthorization: isAuthorizedOnBehalf,
          memberGuestWideningEnabled: memberGuestPolicy.wideningEnabled,
          // #2388, owner decision 31 Jul: per-ACTING-MEMBER throttling on the
          // add paths. Applied only when the attempt actually names a
          // beyond-family member, so an ordinary family booking is never
          // rate-limited by it — and applied the moment the family boundary is
          // known, BEFORE any member record is read (H1) and before the checks
          // whose pattern of answers is the channel. Spending it any later made
          // a real member answer 429 while an id with nobody behind it answered
          // 403, which is an existence oracle made out of the mitigation.
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
        // D-8, and this route needs it most: a quote is side-effect-free and
        // rate-limited as a read, so it is the cheapest surface on which to probe
        // a stranger's profile, occupancy or subscription status.
        crossFamilyMemberIds: boundary.beyondFamilyMemberIds,
      }
    );
    guests = markCrossFamilyMemberGuests(
      normalizeGuestStayRanges(
        normalizeBookingGuestPricingInputs(rawGuests, linkedMembers),
        { checkIn, checkOut }
      ),
      boundary,
    );
  } catch (error) {
    if (error instanceof MemberGuestAddThrottledError) return error.response;
    if (error instanceof BookingGuestValidationError) {
      await handleMemberGuestAddRefusal({
        request,
        actorMemberId: session.user.id,
        error,
        route: "bookings/quote",
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

  // Resolve the lodge being quoted: an explicit lodgeId must be a real,
  // active lodge; otherwise the club's default lodge is quoted.
  let quoteLodgeId: string;
  if (parsed.data.lodgeId) {
    const lodge = await prisma.lodge.findUnique({
      where: { id: parsed.data.lodgeId },
      select: { id: true, active: true },
    });
    if (!lodge || !lodge.active) {
      return NextResponse.json(
        { error: "Unknown or inactive lodgeId" },
        { status: 400 },
      );
    }
    quoteLodgeId = lodge.id;
  } else {
    quoteLodgeId = await getDefaultLodgeId(prisma);
  }

  // A BOOKING_RESTRICTION-ed member must not read a forbidden lodge's pricing.
  // Mirror the create path exactly: admin on-behalf quotes bypass the
  // restriction (the audited override), everyone else is checked.
  if (
    !isAuthorizedOnBehalf &&
    !(await isMemberEligibleToBookLodge(prisma, effectiveMemberId, quoteLodgeId))
  ) {
    return NextResponse.json(
      { error: "This member cannot book the selected lodge." },
      { status: 403 }
    );
  }

  // #3123 — the CLUB's day, from its persisted `ClubTimeSettings.timeZone`
  // (`INV-CONFIG-002`), encoded at UTC midnight for the `@db.Date` frame the
  // guard compares against (`INV-DATE-026`). The person-night guard never
  // resolves one for itself: its authoritative callers reach it from inside
  // booking-write transactions holding `pg_advisory_xact_lock(1)` and the
  // per-lodge capacity key, where a `clubTimeSettings` read would take a second
  // pooled connection (`INV-LOCK-004`). This quote path holds no locks and
  // supplies the value the same way every other caller does.
  const today = await clubTodayDateOnlyInstant();

  // Duplicate member nights (upstream #80cbdf4c): a member cannot hold two
  // bookings covering the same night. D-8: for a cross-family guest this refuses
  // neutrally instead of returning that member's already-booked nights.
  let memberNightConflicts;
  try {
    memberNightConflicts = await findBookingMemberNightConflicts(prisma, {
      actorMemberId: session.user.id,
      actorRole,
      checkIn,
      checkOut,
      guests,
      today,
    });
  } catch (error) {
    if (error instanceof BookingGuestValidationError) {
      // The person-night guard's collapsed refusal is the single most
      // date-dependent answer this route gives, so it is the one #2388's
      // correlation channel is actually built out of.
      await handleMemberGuestAddRefusal({
        request,
        actorMemberId: session.user.id,
        error,
        route: "bookings/quote",
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

  // Fetch seasons that cover the booking dates
  const seasons = await prisma.season.findMany({
    where: {
      active: true,
      startDate: { lte: checkOut },
      endDate: { gte: checkIn },
      ...lodgeNullTolerantScope(quoteLodgeId),
    },
    include: { membershipTypeRates: true },
  });

  const seasonData = toSeasonRateData(seasons);

  // Load group discount settings
  const gds = await prisma.groupDiscountSetting.findUnique({ where: { id: "default" } });
  const groupDiscount = toGroupDiscountConfig(gds);

  // #2543 — resolved ONCE for this request. The quote prices the party and then
  // explains the price; both must be judged against the same mode, or an admin
  // saving the panel between the two calls makes the notice describe a regime the
  // number was not computed under.
  const subscriptionLockoutMode = await resolveSubscriptionLockoutMode();

  try {
    const price = await priceBookingGuestsWithMembershipTypePolicy(prisma, {
      // Finding 2 (privacy re-review of MG3 #2308).
      skipAuthorization: isAuthorizedOnBehalf,
      ownerMemberId: effectiveMemberId,
      checkIn,
      checkOut,
      guests,
      seasons: seasonData,
      groupDiscount,
      subscriptionLockoutMode,
    });
    // Deferred non-member "guest portion" (#2003): when a split creates a
    // provisional non-member child, its charge is the non-member SUBSET priced
    // on its own — which the group discount may treat differently than the
    // whole-party quote (the subset can fall under minGroupSize while the party
    // meets it). Price it here through the SAME helper booking-create charges,
    // so the review-step "about $X" banner shows the figure that is actually
    // deferred rather than a whole-party non-member sum that under-quotes under
    // group discounts. Null when the party has no non-member guests. This is a
    // display-only read; the route performs no writes.
    const deferredPortion = await priceDeferredNonMemberPortion(prisma, {
      checkIn,
      checkOut,
      guests,
      seasons: seasonData,
      groupDiscount,
    });
    const deferredGuestPortionCents = deferredPortion?.totalPriceCents ?? null;
    const availableCreditCents = await getMemberCreditBalance(effectiveMemberId);
    const groupDiscountApplied = isGroupDiscountAppliedToBooking({
      checkIn,
      checkOut,
      guestCount: guests.length,
      guests,
      seasons: seasonData,
      groupDiscount,
    });
    const hasNonMembers = guests.some((guest) => !guest.isMember);
    const holdPolicy = hasNonMembers
      ? await getNonMemberHoldPolicy(checkIn)
      : { enabled: false, holdDays: 0, source: "default" as const };
    const holdDecision = calculateBookingHoldDecision({
      hasNonMembers,
      checkIn,
      holdDays: holdPolicy.holdDays,
      holdEnabled: holdPolicy.enabled,
    });

    // #2543 — "tell them why". The quote is the screen on which the member sees
    // the number, so it is the screen that owes them the explanation for it.
    // Null unless the club runs NON_MEMBER_PRICING and somebody on this party is
    // being repriced; the quote is otherwise untouched. Read-only: the
    // evaluation performs no writes and, because it also reports whether a
    // paid-up adult is present, the quote can warn BEFORE the member fills in
    // the rest of the wizard and gets refused at the end.
    const nonMemberPricing = await evaluateNonMemberPricingRequirements(prisma, {
      mode: subscriptionLockoutMode,
      lodgeId: quoteLodgeId,
      seasonYear: seasonYearOfStoredDate(checkIn),
      checkIn,
      checkOut,
      // Owner decision, 3 Aug 2026: an unfinancial member triggers the
      // requirement whether or not they are staying, so the quote must warn about
      // that party too — otherwise the wizard stays silent about a booking the
      // create path then refuses, which is the late surprise this warning exists
      // to prevent.
      bookingOwnerMemberId: effectiveMemberId,
      // D-12 on a party that persists NOTHING. This route plans no consent
      // columns, so operational presence is derived from the same three facts
      // `buildMemberGuestConsentWrite` would use on save: a cross-family member
      // guest lands PENDING exactly when the module is on, the club requires
      // approval, and the actor is a member rather than an admin acting on their
      // behalf. Without this the preview would stay silent about a party the
      // create path then refuses — which is precisely the late surprise the
      // early warning exists to prevent.
      participants: guests.map((guest) => ({
        isMember: guest.isMember,
        memberId: guest.memberId ?? null,
        stayStart: guest.stayStart ?? null,
        stayEnd: guest.stayEnd ?? null,
        nights: guest.nights ?? null,
        operationallyPresent: !(
          guest.crossFamilyMemberGuest === true &&
          memberGuestPolicy.wideningEnabled &&
          memberGuestPolicy.approvalRequired &&
          !isAuthorizedOnBehalf
        ),
      })),
    });

    return NextResponse.json({
      ...price,
      availableCreditCents,
      deferredGuestPortionCents,
      groupDiscountApplied,
      subscriptionMemberRateNotice: nonMemberPricing?.memberRateNotice ?? null,
      /**
       * True when saving this party WOULD be refused for having no paid-up adult
       * member on it. Derived from the same violation the write paths refuse on,
       * not from `hasPaidUpAdultMember` alone: a party that owes no paid-up adult
       * — nobody repriced, and a financial booker — has no missing one either, and
       * warning about it would be both wrong and alarming. Reading the violation
       * rather than re-deriving the trigger is also what made this flag cover the
       * unfinancial-booker case for free when that trigger was added.
       */
      paidUpAdultMemberMissing: nonMemberPricing?.violation != null,
      nonMemberHoldDecision: {
        enabled: holdPolicy.enabled,
        holdDays: holdPolicy.holdDays,
        source: holdPolicy.source,
        daysUntilCheckIn: holdDecision.daysUntilCheckIn,
        shouldBePending: holdDecision.shouldBePending,
        status: holdDecision.status,
      },
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
        route: "bookings/quote",
        startedAt,
        throttle: "ALREADY_CHARGED",
        skipAuthorization: isAuthorizedOnBehalf,
      });
      return NextResponse.json(
        getMembershipTypeBookingPolicyErrorBody(err),
        { status: err.status },
      );
    }
    // #1888 — unexpected (non-typed) errors must not leak their message to
    // the client; the raw error stays in the log only.
    logger.error({ err }, "Booking quote failed");
    return NextResponse.json(
      { error: "Failed to calculate price" },
      { status: 400 }
    );
  }
}
