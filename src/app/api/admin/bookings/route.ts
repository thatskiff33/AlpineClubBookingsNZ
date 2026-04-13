import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { getMonthAvailability, LODGE_CAPACITY } from "@/lib/capacity";
import logger from "@/lib/logger";

/**
 * GET /api/admin/bookings?calendarMonth=YYYY-MM
 * Returns bookings overlapping the given month for calendar view,
 * plus per-day availability data.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const calendarMonth = request.nextUrl.searchParams.get("calendarMonth");
  if (!calendarMonth || !/^\d{4}-\d{2}$/.test(calendarMonth)) {
    return NextResponse.json({ error: "calendarMonth parameter required (YYYY-MM)" }, { status: 400 });
  }

  const [yearStr, monthStr] = calendarMonth.split("-");
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 0); // last day of month

  const VALID_STATUSES = new Set(["DRAFT", "PENDING", "CONFIRMED", "PAID", "COMPLETED", "CANCELLED", "BUMPED", "WAITLISTED", "WAITLIST_OFFERED"]);
  const statusParam = request.nextUrl.searchParams.get("status");
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
    const [bookings, occupancyMap] = await Promise.all([
      prisma.booking.findMany({
        where: {
          ...statusFilter,
          checkIn: { lte: monthEnd },
          checkOut: { gte: monthStart },
        },
        include: {
          member: { select: { firstName: true, lastName: true } },
          _count: { select: { guests: true } },
        },
        orderBy: { checkIn: "asc" },
      }),
      getMonthAvailability(year, month - 1), // month is 0-indexed in getMonthAvailability
    ]);

    const result = bookings.map((b) => ({
      id: b.id,
      memberName: `${b.member.firstName} ${b.member.lastName}`,
      checkIn: b.checkIn.toISOString().split("T")[0],
      checkOut: b.checkOut.toISOString().split("T")[0],
      status: b.status,
      guestCount: b._count.guests,
    }));

    // Convert occupancy map to availability object: { "2026-04-01": 25, ... }
    const availability: Record<string, number> = {};
    for (const [date, occupied] of occupancyMap.entries()) {
      availability[date] = LODGE_CAPACITY - occupied;
    }

    return NextResponse.json({ bookings: result, availability });
  } catch (err) {
    logger.error({ err }, "Error fetching admin bookings");
    return NextResponse.json({ error: "Failed to fetch bookings" }, { status: 500 });
  }
}
