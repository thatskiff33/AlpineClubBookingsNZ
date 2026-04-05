import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { BookingStatus } from "@prisma/client";
import { LODGE_CAPACITY } from "@/lib/capacity";
import { eachDayOfInterval, subDays, startOfMonth, endOfMonth, format } from "date-fns";
import logger from "@/lib/logger";

const reportQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const parsed = reportQuerySchema.safeParse({
    from: searchParams.get("from"),
    to: searchParams.get("to"),
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid date range. Use ?from=YYYY-MM-DD&to=YYYY-MM-DD", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const fromDate = new Date(parsed.data.from + "T00:00:00");
  const toDate = new Date(parsed.data.to + "T23:59:59");

  if (toDate <= fromDate) {
    return NextResponse.json({ error: "to must be after from" }, { status: 400 });
  }

  try {
    // Fetch all bookings in range (by creation date)
    const bookings = await prisma.booking.findMany({
      where: {
        createdAt: { gte: fromDate, lte: toDate },
      },
      include: {
        guests: true,
        payment: true,
      },
      orderBy: { createdAt: "asc" },
    });

    // Also fetch bookings overlapping with the date range (for occupancy)
    const occupancyBookings = await prisma.booking.findMany({
      where: {
        checkIn: { lte: toDate },
        checkOut: { gte: fromDate },
        status: { in: [BookingStatus.CONFIRMED, BookingStatus.COMPLETED] },
      },
      include: { guests: true },
    });

    // 1. Occupancy by date
    const occupancyFromDate = new Date(parsed.data.from + "T00:00:00");
    const occupancyToDate = new Date(parsed.data.to + "T00:00:00");
    const days = eachDayOfInterval({ start: occupancyFromDate, end: occupancyToDate });

    const occupancyByDate = days.map((day) => {
      const dayTime = day.getTime();
      let beds = 0;
      for (const b of occupancyBookings) {
        const ci = new Date(b.checkIn).getTime();
        const co = new Date(b.checkOut).getTime();
        if (dayTime >= ci && dayTime < co) {
          beds += b.guests.length;
        }
      }
      return {
        date: format(day, "yyyy-MM-dd"),
        occupiedBeds: beds,
        availableBeds: LODGE_CAPACITY - beds,
        occupancyRate: Math.round((beds / LODGE_CAPACITY) * 100),
      };
    });

    // 2. Revenue by month
    const revenueByMonth: Record<string, { revenue: number; bookings: number }> = {};
    for (const b of bookings) {
      if (b.status === BookingStatus.CANCELLED || b.status === BookingStatus.BUMPED) continue;
      const month = format(b.createdAt, "yyyy-MM");
      if (!revenueByMonth[month]) {
        revenueByMonth[month] = { revenue: 0, bookings: 0 };
      }
      revenueByMonth[month].revenue += b.finalPriceCents;
      revenueByMonth[month].bookings += 1;
    }

    const revenueData = Object.entries(revenueByMonth)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, data]) => ({
        month,
        revenueCents: data.revenue,
        bookingCount: data.bookings,
      }));

    // 3. Booking trends by week
    const bookingsByWeek: Record<string, { total: number; confirmed: number; cancelled: number; bumped: number; pending: number }> = {};
    for (const b of bookings) {
      // ISO week start (Monday)
      const d = new Date(b.createdAt);
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      const weekStart = new Date(d.setDate(diff));
      const weekKey = format(weekStart, "yyyy-MM-dd");

      if (!bookingsByWeek[weekKey]) {
        bookingsByWeek[weekKey] = { total: 0, confirmed: 0, cancelled: 0, bumped: 0, pending: 0 };
      }
      bookingsByWeek[weekKey].total += 1;
      if (b.status === BookingStatus.CONFIRMED || b.status === BookingStatus.COMPLETED) {
        bookingsByWeek[weekKey].confirmed += 1;
      } else if (b.status === BookingStatus.CANCELLED) {
        bookingsByWeek[weekKey].cancelled += 1;
      } else if (b.status === BookingStatus.BUMPED) {
        bookingsByWeek[weekKey].bumped += 1;
      } else if (b.status === BookingStatus.PENDING) {
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
      confirmed: bookings.filter((b) => b.status === BookingStatus.CONFIRMED).length,
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
      occupancy: occupancyByDate,
      revenue: revenueData,
      trends: trendData,
    });
  } catch (err) {
    logger.error({ err }, "Error generating reports");
    return NextResponse.json({ error: "Failed to generate reports" }, { status: 500 });
  }
}
