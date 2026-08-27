import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { getLodgeCapacity, getMonthAvailability } from "@/lib/capacity";
import { countActiveLodges, getDefaultLodgeId, lodgeNullTolerantScope } from "@/lib/lodges";
import {
  buildBookingDeletedWhere,
  parseBookingDeletedVisibility,
} from "@/lib/booking-delete-visibility";
import { calendarDateOfDateOnlyInstant } from "@/lib/club-time";
import { eachDateOnlyInRange, parseDateOnly } from "@/lib/date-only";
import { countActiveGuestsForNight } from "@/lib/booking-guest-stay-ranges";
import logger from "@/lib/logger";

/*
  EVERY VALUE IN HERE IS A CALENDAR DAY, SO NO ZONE APPEARS IN THIS FUNCTION
  (CT-4, #2870). `checkIn`/`checkOut` are `@db.Date` lodge nights and arrive as
  their UTC-midnight encoding; `monthStart`/`nextMonthStart` are built the same
  way by `parseDateOnly`, so comparing and ranging them is date-only arithmetic
  with nothing to convert.

  Each of the four reads below used to be wrapped in `normalizeDateOnlyForTimeZone`,
  which round-trips a value through the club zone. That is the identity for a
  club at or ahead of UTC — which is why it has always looked right here — and
  lands on the PREVIOUS DAY for a club behind it, where the calendar day would
  silently drop out of the visible month by one night.
*/
function getMaxActiveGuestsInVisibleMonth(booking: {
  checkIn: Date;
  checkOut: Date;
  guests: Array<{ stayStart?: Date | null; stayEnd?: Date | null }>;
}, monthStart: Date, nextMonthStart: Date) {
  const visibleStart =
    booking.checkIn > monthStart ? booking.checkIn : monthStart;
  const visibleEnd =
    booking.checkOut < nextMonthStart ? booking.checkOut : nextMonthStart;

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
    // Multi-lodge (#9): scope the calendar to the selected lodge, matching the
    // list. A specific lodge shows its own bookings + bed count. With no lodge
    // filter, a single-lodge club still shows its sole lodge's beds (ADR-002);
    // a multi-lodge "All lodges" view hides the per-day count for now, since a
    // single summed figure across non-fungible lodges would mislead (see the
    // "All lodges bed display" discussion). Bookings stay unfiltered across all.
    const lodgeParam = request.nextUrl.searchParams.get("lodgeId");
    const specificLodge = lodgeParam && lodgeParam !== "all" ? lodgeParam : null;
    const bedsLodgeId =
      specificLodge ??
      ((await countActiveLodges(prisma)) > 1 ? null : await getDefaultLodgeId(prisma));

    const [bookings, occupancyMap, lodgeCapacity] = await Promise.all([
      prisma.booking.findMany({
        where: {
          ...statusFilter,
          ...buildBookingDeletedWhere(deletedVisibility),
          ...(specificLodge ? lodgeNullTolerantScope(specificLodge) : {}),
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
      bedsLodgeId
        ? getMonthAvailability(bedsLodgeId, year, month - 1) // month is 0-indexed
        : Promise.resolve(null),
      bedsLodgeId ? getLodgeCapacity(bedsLodgeId) : Promise.resolve(null),
    ]);

    const result = bookings.map((b) => ({
      id: b.id,
      memberName: `${b.member.firstName} ${b.member.lastName}`,
      // Lodge nights, so the wire shape is the stored calendar day with no
      // zone conversion (CT-4, #2870). The zoned encoder this replaced read a
      // `@db.Date` value as if it were a moment.
      checkIn: calendarDateOfDateOnlyInstant(b.checkIn),
      checkOut: calendarDateOfDateOnlyInstant(b.checkOut),
      status: b.status,
      deletedAt: b.deletedAt?.toISOString() ?? null,
      guestCount: getMaxActiveGuestsInVisibleMonth(
        b,
        monthStart,
        nextMonthStart
      ),
    }));

    // Convert occupancy map to availability object: { "2026-04-01": 25, ... }
    // Empty when beds are hidden (multi-lodge "All lodges"); the calendar then
    // renders no per-day count.
    const availability: Record<string, number> = {};
    if (occupancyMap && lodgeCapacity !== null) {
      for (const [date, occupied] of occupancyMap.entries()) {
        availability[date] = lodgeCapacity - occupied;
      }
    }

    return NextResponse.json({ bookings: result, availability });
  } catch (err) {
    logger.error({ err }, "Error fetching admin bookings");
    return NextResponse.json({ error: "Failed to fetch bookings" }, { status: 500 });
  }
}
