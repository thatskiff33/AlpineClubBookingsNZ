import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { calculateBookingPrice, type SeasonRateData } from "@/lib/pricing";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { z } from "zod";

const quoteSchema = z.object({
  checkIn: z.string().transform((s) => new Date(s)),
  checkOut: z.string().transform((s) => new Date(s)),
  guests: z.array(
    z.object({
      ageTier: z.enum(["ADULT", "YOUTH", "CHILD"]),
      isMember: z.boolean(),
    })
  ).min(1),
});

export async function POST(request: NextRequest) {
  const rateLimited = applyRateLimit(rateLimiters.bookingQuery, request);
  if (rateLimited) return rateLimited;

  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const body = await request.json();
  const parsed = quoteSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { checkIn, checkOut, guests } = parsed.data;

  if (checkOut <= checkIn) {
    return NextResponse.json({ error: "Check-out must be after check-in" }, { status: 400 });
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
    rates: s.rates.map((r) => ({
      ageTier: r.ageTier,
      isMember: r.isMember,
      pricePerNightCents: r.pricePerNightCents,
    })),
  }));

  try {
    const price = calculateBookingPrice(checkIn, checkOut, guests, seasonData);
    return NextResponse.json(price);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to calculate price";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
