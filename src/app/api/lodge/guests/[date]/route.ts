import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * GET /api/lodge/guests/[date]
 * Returns the lodge list for a date: all confirmed guests grouped by booking,
 * with arriving/departing indicators.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  if (session.user.role !== "LODGE" && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { date: dateStr } = await params;
  if (!dateSchema.safeParse(dateStr).success) {
    return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
  }

  const date = new Date(dateStr + "T00:00:00");
  if (isNaN(date.getTime())) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 });
  }

  const nextDay = new Date(date);
  nextDay.setDate(nextDay.getDate() + 1);

  // Guests staying on this date: checkIn <= date < checkOut
  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: ["CONFIRMED", "COMPLETED"] },
      checkIn: { lte: date },
      checkOut: { gt: date },
    },
    include: {
      guests: true,
      member: { select: { firstName: true, lastName: true } },
    },
    orderBy: { checkIn: "asc" },
  });

  const result = bookings.map((b) => ({
    bookingId: b.id,
    memberName: `${b.member.firstName} ${b.member.lastName}`,
    guests: b.guests.map((g) => ({
      id: g.id,
      firstName: g.firstName,
      lastName: g.lastName,
      ageTier: g.ageTier,
      isMember: g.isMember,
      isArriving: b.checkIn.getTime() === date.getTime(),
      isDeparting: b.checkOut.getTime() === nextDay.getTime(),
      arrivedAt: g.arrivedAt?.toISOString() ?? null,
      departedAt: g.departedAt?.toISOString() ?? null,
    })),
  }));

  return NextResponse.json({
    date: dateStr,
    bookings: result,
    totalGuests: result.reduce((sum, b) => sum + b.guests.length, 0),
  });
}
