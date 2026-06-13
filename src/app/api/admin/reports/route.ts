import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { BookingStatus, SubscriptionStatus } from "@prisma/client";
import { getLodgeCapacity, getOccupiedBedsForNight } from "@/lib/capacity";
import { eachDayOfInterval, format } from "date-fns";
import logger from "@/lib/logger";
import { buildRevenueSeries } from "@/lib/admin-reports";
import { getSeasonYear } from "@/lib/utils";
import {
  OPERATIONAL_STAY_BOOKING_STATUSES,
  PAYMENT_OWED_BOOKING_STATUSES,
} from "@/lib/booking-status";
import {
  buildBookingDeletedWhere,
  parseBookingDeletedVisibility,
} from "@/lib/booking-delete-visibility";
import {
  endOfDateOnlyForTimeZone,
  parseDateOnly,
  startOfDateOnlyForTimeZone,
} from "@/lib/date-only";

const reportQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  deleted: z.enum(["hide", "include", "only"]).default("hide"),
});

export async function GET(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { searchParams } = new URL(request.url);
  const parsed = reportQuerySchema.safeParse({
    from: searchParams.get("from"),
    to: searchParams.get("to"),
    deleted: parseBookingDeletedVisibility(searchParams.get("deleted")),
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid date range. Use ?from=YYYY-MM-DD&to=YYYY-MM-DD", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const fromDate = startOfDateOnlyForTimeZone(parsed.data.from);
  const toDate = endOfDateOnlyForTimeZone(parsed.data.to);
  const occupancyFromDate = parseDateOnly(parsed.data.from);
  const occupancyToDate = parseDateOnly(parsed.data.to);
  const deletedWhere = buildBookingDeletedWhere(parsed.data.deleted);

  if (toDate <= fromDate) {
    return NextResponse.json({ error: "to must be after from" }, { status: 400 });
  }

  try {
    const currentSeasonYear = getSeasonYear(new Date());
    const currentSeasonLabel = `${currentSeasonYear}/${currentSeasonYear + 1}`;

    const [
      bookings,
      occupancyBookings,
      totalActiveMembers,
      paidMembers,
      unpaidMembers,
      overdueMembers,
      newMembers,
      lodgeCapacity,
    ] = await Promise.all([
      prisma.booking.findMany({
        where: {
          ...deletedWhere,
          createdAt: { gte: fromDate, lte: toDate },
        },
        include: {
          guests: true,
          payment: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      prisma.booking.findMany({
        where: {
          ...deletedWhere,
          checkIn: { lte: toDate },
          checkOut: { gte: fromDate },
          status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
        },
        include: { guests: true },
      }),
      prisma.member.count({
        where: {
          active: true,
        },
      }),
      prisma.memberSubscription.count({
        where: {
          seasonYear: currentSeasonYear,
          status: SubscriptionStatus.PAID,
          member: { active: true },
        },
      }),
      prisma.memberSubscription.count({
        where: {
          seasonYear: currentSeasonYear,
          status: SubscriptionStatus.UNPAID,
          member: { active: true },
        },
      }),
      prisma.memberSubscription.count({
        where: {
          seasonYear: currentSeasonYear,
          status: SubscriptionStatus.OVERDUE,
          member: { active: true },
        },
      }),
      prisma.member.count({
        where: {
          active: true,
          OR: [
            { joinedDate: { gte: fromDate, lte: toDate } },
            {
              joinedDate: null,
              createdAt: { gte: fromDate, lte: toDate },
            },
          ],
        },
      }),
      getLodgeCapacity(),
    ]);

    // 1. Occupancy by date
    const days = eachDayOfInterval({ start: occupancyFromDate, end: occupancyToDate });

    const occupancyByDate = days.map((day) => {
      const beds = getOccupiedBedsForNight(day, occupancyBookings);
      return {
        date: format(day, "yyyy-MM-dd"),
        occupiedBeds: beds,
        availableBeds: lodgeCapacity - beds,
        occupancyRate:
          lodgeCapacity > 0 ? Math.round((beds / lodgeCapacity) * 100) : 0,
      };
    });

    // 2. Revenue by dynamic granularity
    const revenueSeries = buildRevenueSeries(bookings, occupancyFromDate, occupancyToDate);

    // 3. Booking trends by week
    const bookingsByWeek: Record<string, { total: number; confirmed: number; cancelled: number; bumped: number; pending: number }> = {};
    for (const b of bookings) {
      // ISO week start (Monday) - use a copy to avoid mutation
      const d = new Date(b.createdAt);
      const day = d.getDay();
      const diff = day === 0 ? -6 : 1 - day; // days to subtract to reach Monday
      const weekStart = new Date(d);
      weekStart.setDate(d.getDate() + diff);
      const weekKey = format(weekStart, "yyyy-MM-dd");

      if (!bookingsByWeek[weekKey]) {
        bookingsByWeek[weekKey] = { total: 0, confirmed: 0, cancelled: 0, bumped: 0, pending: 0 };
      }
      bookingsByWeek[weekKey].total += 1;
      if ((OPERATIONAL_STAY_BOOKING_STATUSES as readonly string[]).includes(b.status)) {
        bookingsByWeek[weekKey].confirmed += 1;
      } else if (b.status === BookingStatus.CANCELLED) {
        bookingsByWeek[weekKey].cancelled += 1;
      } else if (b.status === BookingStatus.BUMPED) {
        bookingsByWeek[weekKey].bumped += 1;
      } else if (
        b.status === BookingStatus.PENDING ||
        (PAYMENT_OWED_BOOKING_STATUSES as readonly string[]).includes(b.status)
      ) {
        bookingsByWeek[weekKey].pending += 1;
      }
    }

    const trendData = Object.entries(bookingsByWeek)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, data]) => ({
        week,
        ...data,
      }));

    // 4. Member vs non-member split
    let memberGuests = 0;
    let nonMemberGuests = 0;
    for (const b of bookings) {
      if (b.status === BookingStatus.CANCELLED || b.status === BookingStatus.BUMPED) continue;
      for (const g of b.guests) {
        if (g.isMember) memberGuests++;
        else nonMemberGuests++;
      }
    }

    // 5. Summary stats
    const activeBookings = bookings.filter(
      (b) => b.status !== BookingStatus.CANCELLED && b.status !== BookingStatus.BUMPED
    );
    const totalRevenueCents = activeBookings.reduce((sum, b) => sum + b.finalPriceCents, 0);
    const totalGuests = activeBookings.reduce((sum, b) => sum + b.guests.length, 0);
    const avgOccupancy =
      occupancyByDate.length > 0
        ? Math.round(
            occupancyByDate.reduce((sum, d) => sum + d.occupancyRate, 0) /
              occupancyByDate.length
          )
        : 0;

    // 6. Status breakdown
    const statusBreakdown = {
      confirmed: bookings.filter((b) => b.status === BookingStatus.PAYMENT_PENDING || b.status === BookingStatus.CONFIRMED).length,
      paid: bookings.filter((b) => b.status === BookingStatus.PAID).length,
      completed: bookings.filter((b) => b.status === BookingStatus.COMPLETED).length,
      pending: bookings.filter((b) => b.status === BookingStatus.PENDING).length,
      cancelled: bookings.filter((b) => b.status === BookingStatus.CANCELLED).length,
      bumped: bookings.filter((b) => b.status === BookingStatus.BUMPED).length,
    };

    return NextResponse.json({
      summary: {
        totalBookings: activeBookings.length,
        totalRevenueCents,
        totalGuests,
        avgOccupancyRate: avgOccupancy,
        memberGuests,
        nonMemberGuests,
      },
      statusBreakdown,
      memberStats: {
        totalActiveMembers,
        paidMembers,
        unpaidMembers,
        overdueMembers,
        newMembers,
        currentSeasonYear,
        currentSeasonLabel,
      },
      occupancy: occupancyByDate,
      revenueGranularity: revenueSeries.granularity,
      revenue: revenueSeries.data,
      trends: trendData,
    });
  } catch (err) {
    logger.error({ err }, "Error generating reports");
    return NextResponse.json({ error: "Failed to generate reports" }, { status: 500 });
  }
}
