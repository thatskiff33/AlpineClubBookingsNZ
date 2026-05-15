import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { z } from "zod";
import { getMonthAvailability } from "@/lib/capacity";
import {
  eachDateOnlyInRange,
  formatDateOnly,
  formatDateOnlyForTimeZone,
  parseDateOnly,
} from "@/lib/date-only";

const availabilityQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(0).max(11),
});

function getMonthStartDateOnly(year: number, month: number): Date {
  return parseDateOnly(`${year}-${String(month + 1).padStart(2, "0")}-01`);
}

function getNextMonthStartDateOnly(year: number, month: number): Date {
  const nextMonth = month === 11 ? 0 : month + 1;
  const nextMonthYear = month === 11 ? year + 1 : year;
  return getMonthStartDateOnly(nextMonthYear, nextMonth);
}

export async function GET(request: NextRequest) {
  const rateLimited = applyRateLimit(rateLimiters.bookingQuery, request);
  if (rateLimited) return rateLimited;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const parsed = availabilityQuerySchema.safeParse({
    year: request.nextUrl.searchParams.get("year"),
    month: request.nextUrl.searchParams.get("month"),
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { year, month } = parsed.data;

  const startDate = getMonthStartDateOnly(year, month);
  const endDate = getNextMonthStartDateOnly(year, month);

  const [occupancyMap, activeSeasons] = await Promise.all([
    getMonthAvailability(year, month),
    prisma.season.findMany({
      where: {
        startDate: { lt: endDate },
        endDate: { gte: startDate },
        active: true,
      },
      select: { name: true, type: true, startDate: true, endDate: true },
    }),
  ]);

  const availability: Record<string, number> = {};
  const seasons: Record<string, { name: string; type: string }> = {};

  for (const [date, occupiedBeds] of occupancyMap.entries()) {
    availability[date] = occupiedBeds;
  }

  const nights = eachDateOnlyInRange(startDate, endDate);
  for (const night of nights) {
    const key = formatDateOnly(night);

    // Determine which season this date falls in
    for (const season of activeSeasons) {
      const sStart = formatDateOnlyForTimeZone(season.startDate);
      const sEnd = formatDateOnlyForTimeZone(season.endDate);
      if (key >= sStart && key <= sEnd) {
        seasons[key] = { name: season.name, type: season.type };
        break;
      }
    }
  }

  return NextResponse.json({ availability, seasons });
}
