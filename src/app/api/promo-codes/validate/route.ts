import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { calculateBookingPrice, calculatePromoDiscount, type SeasonRateData } from "@/lib/pricing";
import { validatePromoCodeRules } from "@/lib/promo";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { z } from "zod";

const validateSchema = z.object({
  code: z.string().min(1, "Promo code is required"),
  checkIn: z.string().transform((s) => new Date(s)),
  checkOut: z.string().transform((s) => new Date(s)),
  guests: z
    .array(
      z.object({
        ageTier: z.enum(["ADULT", "YOUTH", "CHILD"]),
        isMember: z.boolean(),
      })
    )
    .min(1),
});

export async function POST(req: NextRequest) {
  const rateLimited = applyRateLimit(rateLimiters.bookingQuery, req);
  if (rateLimited) return rateLimited;

  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

  // Look up the promo code
  const promoCode = await prisma.promoCode.findUnique({
    where: { code: normalizedCode },
  });

  // Check single-use
  let memberRedemptionCount = 0;
  if (promoCode?.singleUse) {
    memberRedemptionCount = await prisma.promoRedemption.count({
      where: {
        promoCodeId: promoCode.id,
        memberId: session.user.id,
      },
    });
  }

  const validationError = validatePromoCodeRules(
    promoCode,
    { memberId: session.user.id },
    new Date(),
    memberRedemptionCount
  );

  if (validationError) {
    return NextResponse.json({ valid: false, error: validationError }, { status: 400 });
  }

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
    rates: s.rates.map((r) => ({
      ageTier: r.ageTier,
      isMember: r.isMember,
      pricePerNightCents: r.pricePerNightCents,
    })),
  }));

  try {
    const price = calculateBookingPrice(checkIn, checkOut, guests, seasonData);

    // Collect all per-night rates across all guests for FREE_NIGHTS
    const allPerNightRates = price.guests.flatMap((g) => g.perNightCents);

    const discountCents = calculatePromoDiscount(
      {
        type: promoCode!.type,
        valueCents: promoCode!.valueCents,
        percentOff: promoCode!.percentOff,
        freeNights: promoCode!.freeNights,
      },
      price.totalPriceCents,
      allPerNightRates
    );

    return NextResponse.json({
      valid: true,
      code: promoCode!.code,
      description: promoCode!.description,
      type: promoCode!.type,
      discountCents,
      totalPriceCents: price.totalPriceCents,
      finalPriceCents: price.totalPriceCents - discountCents,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to calculate price";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
