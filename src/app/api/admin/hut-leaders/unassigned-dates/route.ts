import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { eachDayOfInterval, addDays } from "date-fns";

/**
 * GET /api/admin/hut-leaders/unassigned-dates
 * Returns dates in the next 14 days that have PAID/CONFIRMED bookings but no HutLeaderAssignment.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endDate = addDays(today, 14);

  const days = eachDayOfInterval({ start: today, end: endDate });

  // Get all hut leader assignments covering the next 14 days
  const assignments = await prisma.hutLeaderAssignment.findMany({
    where: {
      startDate: { lte: endDate },
      endDate: { gte: today },
    },
    select: { startDate: true, endDate: true },
  });

  // Get all bookings in the next 14 days
  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: ["CONFIRMED", "PAID"] },
      checkIn: { lte: endDate },
      checkOut: { gt: today },
    },
    select: {
      checkIn: true,
      checkOut: true,
      _count: { select: { guests: true } },
    },
  });

  function isDateCovered(date: Date): boolean {
    return assignments.some(
      (a) => a.startDate.getTime() <= date.getTime() && a.endDate.getTime() >= date.getTime()
    );
  }

  function getBookingStats(date: Date): { bookingCount: number; guestCount: number } {
    let bookingCount = 0;
    let guestCount = 0;
    for (const b of bookings) {
      if (b.checkIn.getTime() <= date.getTime() && b.checkOut.getTime() > date.getTime()) {
        bookingCount++;
        guestCount += b._count.guests;
      }
    }
    return { bookingCount, guestCount };
  }

  function fmt(d: Date) { return d.toISOString().split("T")[0]; }

  const unassignedDates: { date: string; bookingCount: number; guestCount: number }[] = [];

  for (const day of days) {
    if (isDateCovered(day)) continue;
    const stats = getBookingStats(day);
    if (stats.bookingCount > 0) {
      unassignedDates.push({
        date: fmt(day),
        bookingCount: stats.bookingCount,
        guestCount: stats.guestCount,
      });
    }
  }

  return NextResponse.json({ unassignedDates });
}
