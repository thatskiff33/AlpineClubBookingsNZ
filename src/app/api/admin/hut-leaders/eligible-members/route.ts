import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/admin/hut-leaders/eligible-members?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 * Returns adult members who have active bookings (PENDING/CONFIRMED/PAID) overlapping the given date range.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const startDate = searchParams.get("startDate");
  const endDate = searchParams.get("endDate");

  if (!startDate || !endDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return NextResponse.json({ error: "startDate and endDate are required (YYYY-MM-DD)" }, { status: 400 });
  }

  if (startDate > endDate) {
    return NextResponse.json({ error: "startDate must be before or equal to endDate" }, { status: 400 });
  }

  const rangeStart = new Date(startDate + "T00:00:00");
  const rangeEnd = new Date(endDate + "T00:00:00");

  // Find adult booking guests whose booking overlaps the date range
  // Booking overlap: booking.checkIn < rangeEnd+1day AND booking.checkOut > rangeStart
  // (checkOut is exclusive - guest leaves on checkOut day, so they stay nights checkIn..checkOut-1)
  const guests = await prisma.bookingGuest.findMany({
    where: {
      ageTier: "ADULT",
      memberId: { not: null },
      booking: {
        status: { in: ["PENDING", "CONFIRMED", "PAID"] },
        checkIn: { lte: rangeEnd },
        checkOut: { gt: rangeStart },
      },
    },
    select: {
      memberId: true,
      member: {
        select: { id: true, firstName: true, lastName: true, email: true, active: true },
      },
    },
  });

  // Deduplicate by memberId and filter to active members
  const memberMap = new Map<string, { id: string; firstName: string; lastName: string; email: string }>();
  for (const g of guests) {
    if (g.memberId && g.member && g.member.active && !memberMap.has(g.memberId)) {
      memberMap.set(g.memberId, {
        id: g.member.id,
        firstName: g.member.firstName,
        lastName: g.member.lastName,
        email: g.member.email,
      });
    }
  }

  // Also include the booking owner (member) if they are an adult staying
  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: ["PENDING", "CONFIRMED", "PAID"] },
      checkIn: { lte: rangeEnd },
      checkOut: { gt: rangeStart },
    },
    select: {
      member: {
        select: { id: true, firstName: true, lastName: true, email: true, active: true, ageTier: true },
      },
    },
  });

  for (const b of bookings) {
    if (b.member.active && b.member.ageTier === "ADULT" && !memberMap.has(b.member.id)) {
      memberMap.set(b.member.id, {
        id: b.member.id,
        firstName: b.member.firstName,
        lastName: b.member.lastName,
        email: b.member.email,
      });
    }
  }

  const members = Array.from(memberMap.values()).sort((a, b) =>
    `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`)
  );

  return NextResponse.json({ members });
}
