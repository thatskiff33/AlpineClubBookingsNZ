import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { calculateBookingPrice, type SeasonRateData, type GroupDiscountConfig } from "@/lib/pricing";
import { getMemberCreditBalance } from "@/lib/member-credit";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { z } from "zod";
import { ageTierEnum } from "@/lib/age-tier-schema";
import {
  BookingGuestValidationError,
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

  const effectiveMemberId =
    parsed.data.forMemberId && session.user.role === "ADMIN"
      ? parsed.data.forMemberId
      : session.user.id;

  try {
    const linkedMembers = await resolveLinkedBookingMembers(
      prisma,
      effectiveMemberId,
      guests.map((guest) => guest.memberId),
      { skipAuthorization: session.user.role === "ADMIN" && Boolean(parsed.data.forMemberId) }
    );
    guests = normalizeBookingGuestPricingInputs(guests, linkedMembers);
  } catch (error) {
    if (error instanceof BookingGuestValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
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

  const seasonData: SeasonRateData[] = seasons.map((s) => ({
    seasonId: s.id,
    startDate: s.startDate,
    endDate: s.endDate,
    type: s.type,
    rates: s.rates.map((r) => ({
      ageTier: r.ageTier,
      isMember: r.isMember,
      pricePerNightCents: r.pricePerNightCents,
    })),
  }));

  // Load group discount settings
  let groupDiscount: GroupDiscountConfig | undefined;
  const gds = await prisma.groupDiscountSetting.findUnique({ where: { id: "default" } });
  if (gds && gds.enabled) {
    groupDiscount = { minGroupSize: gds.minGroupSize, summerOnly: gds.summerOnly, enabled: true };
  }

  try {
    const price = calculateBookingPrice(checkIn, checkOut, guests, seasonData, groupDiscount);
    const availableCreditCents = await getMemberCreditBalance(effectiveMemberId);
    return NextResponse.json({ ...price, availableCreditCents, groupDiscountApplied: !!groupDiscount && guests.length >= (groupDiscount.minGroupSize) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to calculate price";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
