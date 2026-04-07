import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/admin/hut-leaders/eligible-members?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 * Returns adult members who have active bookings (PENDING/CONFIRMED/PAID) overlapping the given date range,
 * along with their booking dates and suggested assignment dates.
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
      booking: {
        select: { checkIn: true, checkOut: true },
      },
    },
  });

  // Group by memberId, collecting booking dates
  const memberBookings = new Map<string, {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    bookings: { checkIn: Date; checkOut: Date }[];
  }>();

  for (const g of guests) {
    if (!g.memberId || !g.member || !g.member.active) continue;
    const existing = memberBookings.get(g.memberId);
    if (existing) {
      // Avoid duplicate booking entries
      if (!existing.bookings.some((b) => b.checkIn.getTime() === g.booking.checkIn.getTime())) {
        existing.bookings.push({ checkIn: g.booking.checkIn, checkOut: g.booking.checkOut });
      }
    } else {
      memberBookings.set(g.memberId, {
        id: g.member.id,
        firstName: g.member.firstName,
        lastName: g.member.lastName,
        email: g.member.email,
        bookings: [{ checkIn: g.booking.checkIn, checkOut: g.booking.checkOut }],
      });
    }
  }

  // Also include booking owners who are adults
  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: ["PENDING", "CONFIRMED", "PAID"] },
      checkIn: { lte: rangeEnd },
      checkOut: { gt: rangeStart },
    },
    select: {
      checkIn: true,
      checkOut: true,
      member: {
        select: { id: true, firstName: true, lastName: true, email: true, active: true, ageTier: true },
      },
    },
  });

  for (const b of bookings) {
    if (!b.member.active || b.member.ageTier !== "ADULT") continue;
    const existing = memberBookings.get(b.member.id);
    if (existing) {
      if (!existing.bookings.some((bk) => bk.checkIn.getTime() === b.checkIn.getTime())) {
        existing.bookings.push({ checkIn: b.checkIn, checkOut: b.checkOut });
      }
    } else {
      memberBookings.set(b.member.id, {
        id: b.member.id,
        firstName: b.member.firstName,
        lastName: b.member.lastName,
        email: b.member.email,
        bookings: [{ checkIn: b.checkIn, checkOut: b.checkOut }],
      });
    }
  }

  function fmt(d: Date) { return d.toISOString().split("T")[0]; }

  const members = Array.from(memberBookings.values())
    .map((m) => {
      // Find earliest checkIn and latest checkOut as suggested dates
      const earliestCheckIn = m.bookings.reduce((min, b) => b.checkIn < min ? b.checkIn : min, m.bookings[0].checkIn);
      const latestCheckOut = m.bookings.reduce((max, b) => b.checkOut > max ? b.checkOut : max, m.bookings[0].checkOut);

      return {
        id: m.id,
        firstName: m.firstName,
        lastName: m.lastName,
        email: m.email,
        bookingCheckIn: fmt(earliestCheckIn),
        bookingCheckOut: fmt(latestCheckOut),
        suggestedStartDate: fmt(earliestCheckIn),
        suggestedEndDate: fmt(latestCheckOut),
      };
    })
    .sort((a, b) => `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`));

  return NextResponse.json({ members });
}
