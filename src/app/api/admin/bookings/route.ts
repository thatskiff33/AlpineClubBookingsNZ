import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { getLodgeCapacity, getMonthAvailability } from "@/lib/capacity";
import {
  buildBookingDeletedWhere,
  parseBookingDeletedVisibility,
} from "@/lib/booking-delete-visibility";
import {
  eachDateOnlyInRange,
  formatDateOnlyForTimeZone,
  normalizeDateOnlyForTimeZone,
  parseDateOnly,
} from "@/lib/date-only";
import { countActiveGuestsForNight } from "@/lib/booking-guest-stay-ranges";
import logger from "@/lib/logger";

function getMaxActiveGuestsInVisibleMonth(booking: {
  checkIn: Date;
  checkOut: Date;
  guests: Array<{ stayStart?: Date | null; stayEnd?: Date | null }>;
}, monthStart: Date, nextMonthStart: Date) {
  const visibleStart =
    normalizeDateOnlyForTimeZone(booking.checkIn) > monthStart
      ? normalizeDateOnlyForTimeZone(booking.checkIn)
      : monthStart;
  const visibleEnd =
    normalizeDateOnlyForTimeZone(booking.checkOut) < nextMonthStart
      ? normalizeDateOnlyForTimeZone(booking.checkOut)
      : nextMonthStart;

  const nights = eachDateOnlyInRange(visibleStart, visibleEnd);
  if (nights.length === 0) {
    return 0;
  }

  return Math.max(
    ...nights.map((night) =>
      countActiveGuestsForNight(booking.guests, night, {
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
      })
    )
  );
}

/**
 * GET /api/admin/bookings?calendarMonth=YYYY-MM
 * Returns bookings overlapping the given month for calendar view,
 * plus per-day availability data.
 */
export async function GET(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const calendarMonth = request.nextUrl.searchParams.get("calendarMonth");
  if (!calendarMonth || !/^\d{4}-\d{2}$/.test(calendarMonth)) {
    return NextResponse.json({ error: "calendarMonth parameter required (YYYY-MM)" }, { status: 400 });
  }

  const [yearStr, monthStr] = calendarMonth.split("-");
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  if (month < 1 || month > 12) {
    return NextResponse.json({ error: "calendarMonth must use a month from 01 to 12" }, { status: 400 });
  }

  const monthStart = parseDateOnly(`${yearStr}-${monthStr}-01`);
  const nextMonthStart = month === 12
    ? parseDateOnly(`${year + 1}-01-01`)
    : parseDateOnly(`${yearStr}-${String(month + 1).padStart(2, "0")}-01`);

  const VALID_STATUSES = new Set(["DRAFT", "PENDING", "PAYMENT_PENDING", "CONFIRMED", "PAID", "COMPLETED", "CANCELLED", "BUMPED", "WAITLISTED", "WAITLIST_OFFERED"]);
  const statusParam = request.nextUrl.searchParams.get("status");
  const deletedVisibility = parseBookingDeletedVisibility(
    request.nextUrl.searchParams.get("deleted")
  );
  const statusFilter: Record<string, unknown> = {};
  if (statusParam && statusParam !== "all") {
    const statuses = statusParam.split(",").map((s) => s.trim()).filter(Boolean);
    const validStatuses = statuses.filter((s) => VALID_STATUSES.has(s));
    if (validStatuses.length > 0) {
      statusFilter.status = validStatuses.length === 1 ? validStatuses[0] : { in: validStatuses };
    }
  } else {
    statusFilter.status = { not: "DRAFT" };
  }

  try {
    const [bookings, occupancyMap, lodgeCapacity] = await Promise.all([
      prisma.booking.findMany({
        where: {
          ...statusFilter,
          ...buildBookingDeletedWhere(deletedVisibility),
          checkIn: { lt: nextMonthStart },
          checkOut: { gt: monthStart },
        },
        include: {
          member: { select: { firstName: true, lastName: true } },
          guests: {
            select: {
              stayStart: true,
              stayEnd: true,
            },
          },
        },
        orderBy: { checkIn: "asc" },
      }),
      getMonthAvailability(year, month - 1), // month is 0-indexed in getMonthAvailability
      getLodgeCapacity(),
    ]);

    const result = bookings.map((b) => ({
      id: b.id,
      memberName: `${b.member.firstName} ${b.member.lastName}`,
      checkIn: formatDateOnlyForTimeZone(b.checkIn),
      checkOut: formatDateOnlyForTimeZone(b.checkOut),
      status: b.status,
      deletedAt: b.deletedAt?.toISOString() ?? null,
      guestCount: getMaxActiveGuestsInVisibleMonth(
        b,
        monthStart,
        nextMonthStart
      ),
    }));

    // Convert occupancy map to availability object: { "2026-04-01": 25, ... }
    const availability: Record<string, number> = {};
    for (const [date, occupied] of occupancyMap.entries()) {
      availability[date] = lodgeCapacity - occupied;
    }

    return NextResponse.json({ bookings: result, availability });
  } catch (err) {
    logger.error({ err }, "Error fetching admin bookings");
    return NextResponse.json({ error: "Failed to fetch bookings" }, { status: 500 });
  }
}
