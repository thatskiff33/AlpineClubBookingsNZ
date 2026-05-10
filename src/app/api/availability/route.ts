import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { eachDayOfInterval, subDays } from "date-fns";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { z } from "zod";
import { CAPACITY_HOLDING_BOOKING_STATUSES } from "@/lib/booking-status";

const availabilityQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(0).max(11),
});

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

  const startDate = new Date(year, month, 1);
  const endDate = new Date(year, month + 1, 1);

  const [overlappingBookings, activeSeasons] = await Promise.all([
    prisma.booking.findMany({
      where: {
        checkIn: { lt: endDate },
        checkOut: { gt: startDate },
        status: { in: [...CAPACITY_HOLDING_BOOKING_STATUSES] },
      },
      include: { guests: true },
    }),
    prisma.season.findMany({
      where: {
        startDate: { lte: endDate },
        endDate: { gte: startDate },
        active: true,
      },
      select: { name: true, type: true, startDate: true, endDate: true },
    }),
  ]);

  const availability: Record<string, number> = {};
  const seasons: Record<string, { name: string; type: string }> = {};

  const nights = eachDayOfInterval({
    start: startDate,
    end: subDays(endDate, 1),
  });

  for (const night of nights) {
    const nightTime = night.getTime();
    let occupiedBeds = 0;

    for (const booking of overlappingBookings) {
      const bookingCheckIn = new Date(booking.checkIn).getTime();
      const bookingCheckOut = new Date(booking.checkOut).getTime();
      if (nightTime >= bookingCheckIn && nightTime < bookingCheckOut) {
        occupiedBeds += booking.guests.length;
      }
    }

    const key = night.toISOString().split("T")[0];
    availability[key] = occupiedBeds;

    // Determine which season this date falls in
    for (const season of activeSeasons) {
      const sStart = new Date(season.startDate).toISOString().split("T")[0];
      const sEnd = new Date(season.endDate).toISOString().split("T")[0];
      if (key >= sStart && key <= sEnd) {
        seasons[key] = { name: season.name, type: season.type };
        break;
      }
    }
  }

  return NextResponse.json({ availability, seasons });
}
