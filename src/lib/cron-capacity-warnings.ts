import { prisma } from "./prisma";
import { BookingStatus } from "@prisma/client";
import { sendAdminCapacityWarningAlert } from "./email";
import { LODGE_CAPACITY } from "./capacity";
import { getNZSTToday } from "./nzst-date";
import { eachDayOfInterval, addDays } from "date-fns";
import logger from "@/lib/logger";

const WARN_THRESHOLD_BEDS = 5; // Alert when <= 5 beds remaining

/**
 * N-03: Check capacity for the next 14 days and alert admins
 * about high-occupancy days.
 * Runs daily at 7:00 AM NZST.
 */
export async function checkCapacityWarnings(): Promise<{ alertedDays: number }> {
  const todayNZ = getNZSTToday();
  const endDate = addDays(todayNZ, 14);

  const nights = eachDayOfInterval({
    start: todayNZ,
    end: addDays(endDate, -1),
  });

  // Find all overlapping bookings for the 14-day window
  const overlappingBookings = await prisma.booking.findMany({
    where: {
      checkIn: { lt: endDate },
      checkOut: { gt: todayNZ },
      status: { in: [BookingStatus.CONFIRMED, BookingStatus.PAID, BookingStatus.PENDING] },
    },
    include: { guests: true },
  });

  const highOccupancyDays: Array<{
    date: Date;
    occupiedBeds: number;
    availableBeds: number;
  }> = [];

  for (const night of nights) {
    const nightTime = night.getTime();
    let occupiedBeds = 0;

    for (const booking of overlappingBookings) {
      const checkIn = new Date(booking.checkIn).getTime();
      const checkOut = new Date(booking.checkOut).getTime();
      if (nightTime >= checkIn && nightTime < checkOut) {
        occupiedBeds += booking.guests.length;
      }
    }

    const availableBeds = LODGE_CAPACITY - occupiedBeds;
    if (availableBeds <= WARN_THRESHOLD_BEDS) {
      highOccupancyDays.push({ date: night, occupiedBeds, availableBeds });
    }
  }

  if (highOccupancyDays.length === 0) {
    return { alertedDays: 0 };
  }

  try {
    await sendAdminCapacityWarningAlert(highOccupancyDays);
  } catch (err) {
    logger.error({ err }, "Failed to send capacity warning admin alert");
  }

  return { alertedDays: highOccupancyDays.length };
}
