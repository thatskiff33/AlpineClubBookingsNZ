import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { z } from "zod";
import { getMonthAvailability } from "@/lib/capacity";
import { isMemberEligibleToBookLodge } from "@/lib/lodge-access";
import { getDefaultLodgeId, lodgeNullTolerantScope } from "@/lib/lodges";
import {
  eachDateOnlyInRange,
  formatDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import { calendarDateOfDateOnlyInstant } from "@/lib/club-time";

const availabilityQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(0).max(11),
  lodgeId: z.string().min(1).optional(),
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
  const rateLimited = await applyRateLimit(rateLimiters.bookingQuery, request);
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
    lodgeId: request.nextUrl.searchParams.get("lodgeId") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { year, month, lodgeId: requestedLodgeId } = parsed.data;

  let lodgeId: string;
  if (requestedLodgeId) {
    const lodge = await prisma.lodge.findUnique({
      where: { id: requestedLodgeId },
      select: { id: true, active: true },
    });
    if (!lodge || !lodge.active) {
      return NextResponse.json({ error: "Unknown or inactive lodgeId" }, { status: 400 });
    }
    lodgeId = lodge.id;
  } else {
    lodgeId = await getDefaultLodgeId(prisma);
  }

  // A BOOKING_RESTRICTION-ed member must not read a forbidden lodge's
  // availability, mirroring the booking create path (assertMemberMayBookLodge).
  if (!(await isMemberEligibleToBookLodge(prisma, session.user.id, lodgeId))) {
    return NextResponse.json(
      { error: "This member cannot book the selected lodge." },
      { status: 403 }
    );
  }

  const startDate = getMonthStartDateOnly(year, month);
  const endDate = getNextMonthStartDateOnly(year, month);

  const [occupancyMap, activeSeasons] = await Promise.all([
    getMonthAvailability(lodgeId, year, month),
    prisma.season.findMany({
      where: {
        startDate: { lt: endDate },
        endDate: { gte: startDate },
        active: true,
        ...lodgeNullTolerantScope(lodgeId),
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

    // Determine which season this date falls in.
    //
    // CT-4 (#2870): `Season.startDate`/`endDate` are `@db.Date` — a calendar day
    // encoded as UTC midnight and not a moment (INV-DATE-010) — so they are
    // decoded in UTC and NEVER projected through a timezone. The decode is
    // INV-DATE-019's first exact boundary with INV-DATE-026; cite those for it
    // and not INV-DATE-010 (#3080). Projecting them landed on
    // the same day in New Zealand and on the PREVIOUS day for any club behind
    // UTC, which shifted every season label on the availability grid by a night.
    for (const season of activeSeasons) {
      const sStart = calendarDateOfDateOnlyInstant(season.startDate);
      const sEnd = calendarDateOfDateOnlyInstant(season.endDate);
      if (key >= sStart && key <= sEnd) {
        seasons[key] = { name: season.name, type: season.type };
        break;
      }
    }
  }

  return NextResponse.json({ availability, seasons });
}
