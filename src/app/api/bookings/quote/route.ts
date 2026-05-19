import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import {
  isGroupDiscountAppliedToBooking,
  priceBookingGuests,
  toGroupDiscountConfig,
  toSeasonRateData,
} from "@/lib/policies/booking-route-decisions";
import { getMemberCreditBalance } from "@/lib/member-credit";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { z } from "zod";
import { ageTierEnum } from "@/lib/age-tier-schema";
import {
  assertLinkedBookingMembersCanBeBooked,
  BookingGuestValidationError,
  getBookingGuestValidationErrorResponse,
  normalizeBookingGuestPricingInputs,
  resolveLinkedBookingMembers,
} from "@/lib/booking-guests";

const quoteSchema = z.object({
  checkIn: z.string().transform((s) => new Date(s)),
  checkOut: z.string().transform((s) => new Date(s)),
  guests: z.array(
    z.object({
      ageTier: ageTierEnum,
      isMember: z.boolean(),
      memberId: z.string().min(1).optional(),
    })
  ).min(1),
  forMemberId: z.string().optional(),
});

export async function POST(request: NextRequest) {
  const rateLimited = applyRateLimit(rateLimiters.bookingQuery, request);
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
  const parsed = quoteSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { checkIn, checkOut } = parsed.data;
  let { guests } = parsed.data;

  if (checkOut <= checkIn) {
    return NextResponse.json({ error: "Check-out must be after check-in" }, { status: 400 });
  }

  const isAdminOnBehalf =
    session.user.role === "ADMIN" && Boolean(parsed.data.forMemberId);
  const effectiveMemberId = isAdminOnBehalf
    ? parsed.data.forMemberId!
    : session.user.id;

  try {
    const linkedMembers = await resolveLinkedBookingMembers(
      prisma,
      effectiveMemberId,
      guests.map((guest) => guest.memberId),
      { skipAuthorization: isAdminOnBehalf }
    );
    await assertLinkedBookingMembersCanBeBooked(
      prisma,
      linkedMembers,
      session.user.id,
      {
        actorRole: session.user.role,
        onBehalfOfMemberId: isAdminOnBehalf ? effectiveMemberId : null,
      }
    );
    guests = normalizeBookingGuestPricingInputs(guests, linkedMembers);
  } catch (error) {
    if (error instanceof BookingGuestValidationError) {
      return NextResponse.json(
        getBookingGuestValidationErrorResponse(error),
        { status: error.status }
      );
    }
    throw error;
  }

  // Fetch seasons that cover the booking dates
  const seasons = await prisma.season.findMany({
    where: {
      active: true,
      startDate: { lte: checkOut },
      endDate: { gte: checkIn },
    },
    include: { rates: true },
  });

  const seasonData = toSeasonRateData(seasons);

  // Load group discount settings
  const gds = await prisma.groupDiscountSetting.findUnique({ where: { id: "default" } });
  const groupDiscount = toGroupDiscountConfig(gds);

  try {
    const price = priceBookingGuests({
      checkIn,
      checkOut,
      guests,
      seasons: seasonData,
      groupDiscount,
    });
    const availableCreditCents = await getMemberCreditBalance(effectiveMemberId);
    const groupDiscountApplied = isGroupDiscountAppliedToBooking({
      checkIn,
      checkOut,
      guestCount: guests.length,
      seasons: seasonData,
      groupDiscount,
    });

    return NextResponse.json({
      ...price,
      availableCreditCents,
      groupDiscountApplied,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to calculate price";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
