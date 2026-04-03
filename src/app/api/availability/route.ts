import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { BookingStatus } from "@prisma/client";
import { eachDayOfInterval, subDays } from "date-fns";
import { LODGE_CAPACITY } from "@/lib/capacity";
import { auth } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const year = parseInt(searchParams.get("year") || "");
  const month = parseInt(searchParams.get("month") || "");

  if (isNaN(year) || isNaN(month)) {
    return NextResponse.json({ error: "year and month are required" }, { status: 400 });
  }

  const startDate = new Date(year, month, 1);
  const endDate = new Date(year, month + 1, 1);

  const overlappingBookings = await prisma.booking.findMany({
    where: {
      checkIn: { lt: endDate },
      checkOut: { gt: startDate },
      status: { in: [BookingStatus.CONFIRMED, BookingStatus.PENDING] },
    },
    include: { guests: true },
  });

  const availability: Record<string, number> = {};
  const nights = eachDayOfInterval({
    start: startDate,
    end: subDays(endDate, 1),
  });

  for (const night of nights) {
    const nightTime = night.getTime();
    let occupiedBeds = 0;

    for (const booking of overlappingBookings) {
      const bookingCheckIn = new Date(booking.checkIn).getTime();
      const bookingCheckOut = new Date(booking.checkOut).getTime();
      if (nightTime >= bookingCheckIn && nightTime < bookingCheckOut) {
        occupiedBeds += booking.guests.length;
      }
    }

    const key = night.toISOString().split("T")[0];
    availability[key] = occupiedBeds;
  }

  return NextResponse.json(availability);
}
