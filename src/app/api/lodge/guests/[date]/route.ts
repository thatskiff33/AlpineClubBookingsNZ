import { NextRequest, NextResponse } from "next/server";
import { checkLodgeAuth } from "@/lib/lodge-auth";
import { getBookingGuestDisplayAgeTier } from "@/lib/booking-guests";
import {
  addDaysDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import { formatXeroPhone } from "@/lib/phone";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { OPERATIONAL_STAY_BOOKING_STATUSES } from "@/lib/booking-status";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const LODGE_LIST_SCOPE = "lodge-list";

/**
 * GET /api/lodge/guests/[date]
 * Returns the lodge list for a date: all confirmed guests grouped by booking,
 * with arriving/departing indicators and expected arrival times.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  const { date: dateStr } = await params;

  const { error, status, tier } = await checkLodgeAuth(dateStr, {
    request: req,
  });
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
  const scope = new URL(req.url).searchParams.get("scope");
  const isLodgeListScope = scope === LODGE_LIST_SCOPE;

  // Default scope is stay-night compatible for roster allocation.
  // Lodge-list scope also includes guests on their checkout/departure date.
  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
      checkIn: { lte: date },
      checkOut: isLodgeListScope ? { gte: date } : { gt: date },
    },
    include: {
      guests: {
        include: {
          member: {
            select: {
              ageTier: true,
              phoneCountryCode: true,
              phoneAreaCode: true,
              phoneNumber: true,
            },
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
    guests: b.guests.map((g) => {
      const ageTier = getBookingGuestDisplayAgeTier(g);

      return {
        id: g.id,
        firstName: g.firstName,
        lastName: g.lastName,
        ageTier,
        isMember: g.isMember,
        isArriving: b.checkIn.getTime() === date.getTime(),
        isDeparting: isLodgeListScope
          ? b.checkOut.getTime() === date.getTime()
          : b.checkOut.getTime() === nextDay.getTime(),
        arrivedAt: g.arrivedAt?.toISOString() ?? null,
        departedAt: g.departedAt?.toISOString() ?? null,
        phone: ageTier === "ADULT" && g.member ? formatXeroPhone(g.member) : null,
      };
    }),
  }));

  return NextResponse.json({
    date: dateStr,
    tier,
    bookings: result,
    totalGuests: result.reduce((sum, b) => sum + b.guests.length, 0),
  });
}
