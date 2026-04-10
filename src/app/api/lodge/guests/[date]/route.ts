import { NextRequest, NextResponse } from "next/server";
import { checkLodgeAuth } from "@/lib/lodge-auth";
import { getBookingGuestDisplayAgeTier } from "@/lib/booking-guests";
import { addDaysDateOnly, parseDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * GET /api/lodge/guests/[date]
 * Returns the lodge list for a date: all confirmed guests grouped by booking,
 * with arriving/departing indicators and expected arrival times.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  const { date: dateStr } = await params;

  const { error, status, tier } = await checkLodgeAuth(dateStr);
  if (error) {
    return NextResponse.json({ error }, { status: status! });
  }

  if (!dateSchema.safeParse(dateStr).success) {
    return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
  }

  const date = parseDateOnly(dateStr);
  if (isNaN(date.getTime())) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 });
  }

  const nextDay = addDaysDateOnly(date, 1);

  // Guests staying on this date: checkIn <= date < checkOut
  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: ["CONFIRMED", "PAID", "COMPLETED"] },
      checkIn: { lte: date },
      checkOut: { gt: date },
    },
    include: {
      guests: {
        include: {
          member: {
            select: { ageTier: true },
          },
        },
      },
      member: { select: { firstName: true, lastName: true } },
    },
    orderBy: { checkIn: "asc" },
  });

  const result = bookings.map((b) => ({
    bookingId: b.id,
    memberName: `${b.member.firstName} ${b.member.lastName}`,
    expectedArrivalTime: b.expectedArrivalTime,
    guests: b.guests.map((g) => ({
      id: g.id,
      firstName: g.firstName,
      lastName: g.lastName,
      ageTier: getBookingGuestDisplayAgeTier(g),
      isMember: g.isMember,
      isArriving: b.checkIn.getTime() === date.getTime(),
      isDeparting: b.checkOut.getTime() === nextDay.getTime(),
      arrivedAt: g.arrivedAt?.toISOString() ?? null,
      departedAt: g.departedAt?.toISOString() ?? null,
    })),
  }));

  return NextResponse.json({
    date: dateStr,
    tier,
    bookings: result,
    totalGuests: result.reduce((sum, b) => sum + b.guests.length, 0),
  });
}
