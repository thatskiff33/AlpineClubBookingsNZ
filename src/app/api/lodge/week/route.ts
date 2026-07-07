import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { OPERATIONAL_STAY_BOOKING_STATUSES } from "@/lib/booking-status";
import {
  getGuestStayEnd,
  getGuestStayStart,
  getLodgeVisibleGuestsForDate,
} from "@/lib/booking-guest-stay-ranges";
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import { getKioskDateRange } from "@/lib/kiosk-access";
import {
  checkLodgeAuth,
  kioskLodgeAuthErrorResponse,
  resolveKioskLodgeId,
} from "@/lib/lodge-auth";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import {
  computeRosterDayStatuses,
  type RosterDayStatus,
} from "@/lib/roster-status";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const WEEK_DAYS = 7;

type DateRange = { minDate: string; maxDate: string } | null;

function isDateAccessible(date: string, range: DateRange): boolean {
  if (!range) return true;
  return date >= range.minDate && date <= range.maxDate;
}

async function resolveWeekAuth(req: NextRequest, dates: string[]) {
  let forbidden: Awaited<ReturnType<typeof checkLodgeAuth>> | null = null;

  for (const date of dates) {
    const authResult = await checkLodgeAuth(date, { request: req });

    if (!authResult.error) {
      return { authResult, authDate: date };
    }

    if (authResult.status === 403) {
      forbidden = authResult;
      continue;
    }

    return { authResult, authDate: date };
  }

  return {
    authResult:
      forbidden ?? {
        error: "Forbidden" as const,
        status: 403 as const,
        tier: "none" as const,
        session: null,
      },
    authDate: dates[0],
  };
}

/**
 * GET /api/lodge/week?start=YYYY-MM-DD
 *
 * Returns counts-only lodge kiosk summaries for seven dates. Inaccessible dates
 * deliberately contain no counts or booking fields, so a partial hut-leader or
 * staying-guest window cannot reveal adjacent lodge activity.
 */
export async function GET(req: NextRequest) {
  const startStr = req.nextUrl.searchParams.get("start");
  if (!startStr || !dateSchema.safeParse(startStr).success) {
    return NextResponse.json(
      { error: "Invalid or missing start parameter" },
      { status: 400 }
    );
  }

  const startDate = parseDateOnly(startStr);
  if (Number.isNaN(startDate.getTime())) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 });
  }

  const endDate = addDaysDateOnly(startDate, WEEK_DAYS);
  const weekDates = eachDateOnlyInRange(startDate, endDate);
  const dateKeys = weekDates.map(formatDateOnly);
  const { authResult, authDate } = await resolveWeekAuth(req, dateKeys);

  if (authResult.error) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status! }
    );
  }

  const dateRange =
    "pinSession" in authResult && authResult.pinSession
      ? authResult.pinSession.dateRange
      : "member" in authResult && authResult.member
        ? await getKioskDateRange(authResult.member, parseDateOnly(authDate))
        : null;

  let lodgeId: string;
  try {
    lodgeId = await resolveKioskLodgeId(authResult, prisma);
  } catch (err) {
    const denied = kioskLodgeAuthErrorResponse(err);
    if (denied) return denied;
    throw err;
  }

  const endInclusive = addDaysDateOnly(endDate, -1);
  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
      checkIn: { lte: endInclusive },
      checkOut: { gte: startDate },
      ...lodgeNullTolerantScope(lodgeId),
      guests: {
        some: {
          stayStart: { lte: endInclusive },
          stayEnd: { gte: startDate },
        },
      },
    },
    select: {
      id: true,
      checkIn: true,
      checkOut: true,
      guests: {
        select: {
          stayStart: true,
          stayEnd: true,
          ageTier: true,
          nights: {
            select: {
              stayDate: true,
            },
          },
        },
      },
    },
    orderBy: [{ checkIn: "asc" }, { createdAt: "asc" }],
  });

  const assignments = await prisma.choreAssignment.findMany({
    where: {
      date: { gte: startDate, lt: endDate },
      booking: lodgeNullTolerantScope(lodgeId),
    },
    select: {
      date: true,
      status: true,
      bookingId: true,
    },
  });

  const rosterByDate = new Map<string, RosterDayStatus>(
    computeRosterDayStatuses(dateKeys, bookings, assignments).map((result) => [
      result.date,
      result.status,
    ])
  );

  const days = weekDates.map((date, index) => {
    const dateKey = dateKeys[index];

    if (!isDateAccessible(dateKey, dateRange)) {
      return { date: dateKey, accessible: false };
    }

    const visibleGuestsByBooking = bookings.map((booking) => ({
      booking,
      guests: getLodgeVisibleGuestsForDate(booking.guests, date, booking, {
        includeDepartureDate: true,
      }),
    }));
    const guestCount = visibleGuestsByBooking.reduce(
      (sum, booking) => sum + booking.guests.length,
      0
    );
    const arrivingCount = visibleGuestsByBooking.reduce(
      (sum, { booking, guests }) =>
        sum +
        guests.filter(
          (guest) => getGuestStayStart(guest, booking).getTime() === date.getTime()
        ).length,
      0
    );
    const departingCount = visibleGuestsByBooking.reduce(
      (sum, { booking, guests }) =>
        sum +
        guests.filter(
          (guest) => getGuestStayEnd(guest, booking).getTime() === date.getTime()
        ).length,
      0
    );

    return {
      date: dateKey,
      accessible: true,
      guestCount,
      arrivingCount,
      departingCount,
      rosterStatus: rosterByDate.get(dateKey) ?? "no-guests",
    };
  });

  return NextResponse.json({
    start: startStr,
    days,
  });
}
