import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/admin/bookings?calendarMonth=YYYY-MM
 * Returns bookings overlapping the given month for calendar view.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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

  const statusParam = request.nextUrl.searchParams.get("status");
  const statusFilter: Record<string, unknown> = {};
  if (statusParam && statusParam !== "all") {
    const statuses = statusParam.split(",").map((s) => s.trim()).filter(Boolean);
    statusFilter.status = statuses.length === 1 ? statuses[0] : { in: statuses };
  } else {
    statusFilter.status = { notIn: ["DRAFT", "CANCELLED"] };
  }

  const bookings = await prisma.booking.findMany({
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
  });

  const result = bookings.map((b) => ({
    id: b.id,
    memberName: `${b.member.firstName} ${b.member.lastName}`,
    checkIn: b.checkIn.toISOString().split("T")[0],
    checkOut: b.checkOut.toISOString().split("T")[0],
    status: b.status,
    guestCount: b._count.guests,
  }));

  return NextResponse.json({ bookings: result });
}
