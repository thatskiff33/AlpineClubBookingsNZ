import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { getNonMemberHoldDays } from "@/lib/cancellation";
import {
  calculateBookingHoldDecision,
  toGroupDiscountConfig,
} from "@/lib/policies/booking-route-decisions";
import { AgeTier, BookingStatus } from "@prisma/client";
import { z } from "zod";
import { ageTierEnum } from "@/lib/age-tier-schema";
import { LODGE_CAPACITY } from "@/lib/lodge-capacity";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { getMemberCreditBalance } from "@/lib/member-credit";
import { findUnpaidMemberGuests } from "@/lib/booking-member-guest-subscriptions";
import logger from "@/lib/logger";
import { getSeasonYear } from "@/lib/utils";
import { requiresPaidSubscriptionForAgeTierFromSettings } from "@/lib/member-subscription-eligibility";
import {
  assertLinkedBookingMembersCanBeBooked,
  BookingGuestValidationError,
  getBookingGuestValidationErrorResponse,
  normalizeBookingGuestInputs,
  resolveLinkedBookingMembers,
} from "@/lib/booking-guests";
import { nameField } from "@/lib/zod-helpers";
import { isFeatureEnabled } from "@/config/features";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import {
  BOOKING_PAYMENT_METHOD_VALUES,
  DEFAULT_BOOKING_PAYMENT_METHOD,
} from "@/lib/booking-payment-methods";
import {
  BookingPromoError,
  BookingReviewJustificationRequiredError,
  createConfirmedBooking,
  createDraftBooking,
  createWaitlistedBooking,
  type BookingGuestInput,
} from "@/lib/booking-create";
import {
  BookingGuestStayRangeValidationError,
  normalizeGuestStayRanges,
} from "@/lib/booking-guest-stay-range-input";

const createBookingSchema = z.object({
  checkIn: z.string().transform((s) => new Date(s)),
  checkOut: z.string().transform((s) => new Date(s)),
  guests: z
    .array(
      z.object({
        firstName: nameField(),
        lastName: nameField(),
        ageTier: ageTierEnum,
        isMember: z.boolean(),
        memberId: z.string().min(1).optional(),
        stayStart: z.string().optional(),
        stayEnd: z.string().optional(),
      })
    )
    .min(1)
    .max(LODGE_CAPACITY),
  notes: z.string().max(500).optional(),
  promoCode: z.string().max(50).optional(),
  draft: z.boolean().optional(),
  waitlist: z.boolean().optional(),
  expectedArrivalTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]0$/).optional(),
  applyCreditCents: z.number().int().min(0).optional(),
  forMemberId: z.string().optional(),
  memberReviewJustification: z.string().trim().min(1).max(1000).optional(),
  paymentMethod: z
    .enum(BOOKING_PAYMENT_METHOD_VALUES)
    .optional()
    .default(DEFAULT_BOOKING_PAYMENT_METHOD),
});

export async function POST(request: NextRequest) {
  const rateLimited = applyRateLimit(rateLimiters.bookingCreate, request);
  if (rateLimited) return rateLimited;

  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const body = await request.json();
  const parsed = createBookingSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const xeroIntegrationEnabled = isFeatureEnabled("xeroIntegration");

  // Resolve effective member: admin booking on behalf of another member.
  let effectiveMemberId = session.user.id;
  let isOnBehalf = false;
  let effectiveMemberAgeTier: AgeTier | null = null;

  if (session.user.role === "ADMIN" && !parsed.data.forMemberId) {
    return NextResponse.json(
      { error: "Admins must book on behalf of a member. Use the admin booking page.", code: "ADMIN_MUST_BOOK_ON_BEHALF" },
      { status: 403 }
    );
  }

  if (parsed.data.forMemberId) {
    if (session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Only admins can book on behalf of another member" }, { status: 403 });
    }
    if (parsed.data.forMemberId === session.user.id) {
      return NextResponse.json({ error: "Admins cannot book for themselves — use the admin booking page to book on behalf of a member" }, { status: 400 });
    }
    const targetMember = await prisma.member.findUnique({
      where: { id: parsed.data.forMemberId },
      select: { active: true },
    });
    if (!targetMember?.active) {
      return NextResponse.json({ error: "Target member not found or inactive" }, { status: 400 });
    }
    effectiveMemberId = parsed.data.forMemberId;
    isOnBehalf = true;
  }

  if (!isOnBehalf) {
    const member = await prisma.member.findUnique({
      where: { id: session.user.id },
      select: { emailVerified: true, xeroContactId: true, ageTier: true },
    });
    effectiveMemberAgeTier = member?.ageTier ?? null;

    if (!member?.emailVerified) {
      return NextResponse.json({ error: "Email not verified" }, { status: 403 });
    }

    if (xeroIntegrationEnabled && !member?.xeroContactId && session.user.role !== "ADMIN") {
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
    draft,
    waitlist,
    expectedArrivalTime,
    memberReviewJustification,
    paymentMethod,
  } = parsed.data;
  let guestInputs: BookingGuestInput[] = [];

  if (checkOut <= checkIn) {
    return NextResponse.json({ error: "Check-out must be after check-in" }, { status: 400 });
  }

  try {
    const linkedMembers = await resolveLinkedBookingMembers(
      prisma,
      effectiveMemberId,
      guests.map((guest) => guest.memberId),
      { skipAuthorization: isOnBehalf }
    );
    await assertLinkedBookingMembersCanBeBooked(
      prisma,
      linkedMembers,
      session.user.id,
      {
        actorRole: session.user.role,
        onBehalfOfMemberId: isOnBehalf ? effectiveMemberId : null,
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

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (checkIn < today) {
    return NextResponse.json({ error: "Cannot book in the past" }, { status: 400 });
  }

  // Subscription gate for the booking owner.
  if (
    session.user.role !== "ADMIN" &&
    await requiresPaidSubscriptionForAgeTierFromSettings(effectiveMemberAgeTier)
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

  // Subscription gate for member guests (skip for admins).
  if (session.user.role !== "ADMIN") {
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

  // Minimum stay policy (skip for admins).
  if (session.user.role !== "ADMIN") {
    const { validateMinimumStay, formatViolationsDetail } = await import("@/lib/booking-policies");
    const stayResult = await validateMinimumStay(checkIn, checkOut);
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
        isOnBehalf,
        sessionUserId: session.user.id,
        checkIn,
        checkOut,
        guests: guestInputs,
        notes,
        promoCodeStr,
        expectedArrivalTime,
        groupDiscount,
        memberReviewJustification,
      });
      return NextResponse.json(newBooking, { status: 201 });
    } catch (err) {
      if (err instanceof BookingReviewJustificationRequiredError) {
        return NextResponse.json(
          { error: err.message, code: "REVIEW_JUSTIFICATION_REQUIRED" },
          { status: 400 }
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

  if (paymentMethod === "internet_banking") {
    const modules = await loadEffectiveModuleFlags();
    if (!modules.xeroIntegration || !modules.internetBankingPayments) {
      return NextResponse.json(
        { error: "Internet Banking payments are not available." },
        { status: 400 }
      );
    }
  }

  const hasNonMembers = guestInputs.some((g) => !g.isMember);
  const holdDays = hasNonMembers ? await getNonMemberHoldDays(checkIn) : 7;
  const { shouldBePending, status } = calculateBookingHoldDecision({
    hasNonMembers,
    checkIn,
    holdDays,
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
      isOnBehalf,
      sessionUserId: session.user.id,
      checkIn,
      checkOut,
      guests: guestInputs,
      notes,
      promoCodeStr,
      expectedArrivalTime,
      applyCreditCents: parsed.data.applyCreditCents,
      groupDiscount,
      status,
      shouldBePending,
      holdDays,
      allMembers: !hasNonMembers,
      paymentMethod,
      memberReviewJustification,
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
        isOnBehalf,
        sessionUserId: session.user.id,
        checkIn,
        checkOut,
        guests: guestInputs,
        notes,
        promoCodeStr,
        expectedArrivalTime,
        groupDiscount,
        memberReviewJustification,
      });
      return NextResponse.json(waitlisted.booking, { status: 201 });
    } catch (waitlistErr) {
      if (waitlistErr instanceof BookingReviewJustificationRequiredError) {
        return NextResponse.json(
          { error: waitlistErr.message, code: "REVIEW_JUSTIFICATION_REQUIRED" },
          { status: 400 }
        );
      }
      if (waitlistErr instanceof BookingPromoError) {
        return NextResponse.json({ error: waitlistErr.message }, { status: 400 });
      }
      logger.error({ err: waitlistErr }, "Failed to create waitlisted booking");
      return NextResponse.json({ error: "Failed to create waitlisted booking" }, { status: 500 });
    }
  } catch (err) {
    if (err instanceof BookingReviewJustificationRequiredError) {
      return NextResponse.json(
        { error: err.message, code: "REVIEW_JUSTIFICATION_REQUIRED" },
        { status: 400 }
      );
    }
    const message = err instanceof Error ? err.message : "Failed to create booking";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
