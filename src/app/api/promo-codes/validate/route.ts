import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import {
  calculateBookingPrice,
  type GroupDiscountConfig,
  type SeasonRateData,
} from "@/lib/pricing";
import {
  validateAndCalculatePromoDiscount,
} from "@/lib/promo";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { z } from "zod";
import { ageTierEnum } from "@/lib/age-tier-schema";

const validateSchema = z.object({
  code: z.string().min(1, "Promo code is required"),
  checkIn: z.string().transform((s) => new Date(s)),
  checkOut: z.string().transform((s) => new Date(s)),
  guests: z
    .array(
      z.object({
        ageTier: ageTierEnum,
        isMember: z.boolean(),
        memberId: z.string().min(1).optional(),
      })
    )
    .min(1),
  forMemberId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const rateLimited = applyRateLimit(rateLimiters.bookingQuery, req);
  if (rateLimited) return rateLimited;

  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const body = await req.json();
  const parsed = validateSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { code, checkIn, checkOut, guests } = parsed.data;
  const normalizedCode = code.toUpperCase().trim();

  // Use target member for admin on-behalf bookings
  const effectiveMemberId = (parsed.data.forMemberId && session.user.role === "ADMIN")
    ? parsed.data.forMemberId
    : session.user.id;

  // Look up the promo code with assignments
  const promoCode = await prisma.promoCode.findUnique({
    where: { code: normalizedCode },
    include: { assignments: { select: { memberId: true } } },
  });

  const assignedMemberIds = promoCode?.assignments?.length
    ? promoCode.assignments.map((a) => a.memberId)
    : null;

  // Calculate the booking price to determine discount
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

  let groupDiscount: GroupDiscountConfig | undefined;
  const gds = await prisma.groupDiscountSetting.findUnique({
    where: { id: "default" },
  });
  if (gds?.enabled) {
    groupDiscount = {
      minGroupSize: gds.minGroupSize,
      summerOnly: gds.summerOnly,
      enabled: true,
    };
  }

  try {
    const price = calculateBookingPrice(
      checkIn,
      checkOut,
      guests,
      seasonData,
      groupDiscount
    );

    const promoGuests = price.guests.map((g, index) => ({
      memberId: guests[index].memberId ?? null,
      isMember: g.isMember,
      perNightRates: g.perNightCents,
    }));

    const application = await validateAndCalculatePromoDiscount(
      promoCode,
      {
        memberId: effectiveMemberId,
        bookingCheckIn: checkIn,
        totalPriceCents: price.totalPriceCents,
        guests: promoGuests,
      },
      assignedMemberIds,
      { db: prisma }
    );
    if (application.error || !application.discount) {
      return NextResponse.json(
        { valid: false, error: application.error ?? "Promo code could not be applied" },
        { status: 400 }
      );
    }
    const promoResult = application.discount;

    return NextResponse.json({
      valid: true,
      code: promoCode!.code,
      description: promoCode!.description,
      type: promoCode!.type,
      discountCents: promoResult.discountCents,
      promoAdjustmentCents: promoResult.priceAdjustmentCents,
      freeNightsUsed: promoResult.freeNightsUsed,
      eligibleGuestCount: promoResult.eligibleGuestCount,
      remainingFreeNights: application.remainingFreeNights,
      totalPriceCents: price.totalPriceCents,
      finalPriceCents: price.totalPriceCents + promoResult.priceAdjustmentCents,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to calculate price";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
