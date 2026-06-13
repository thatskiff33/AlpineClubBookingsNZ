import { prisma } from "./prisma";
import { sendAdminCapacityWarningAlert } from "./email";
import { getLodgeCapacity, getOccupiedBedsForNight } from "./capacity";
import { getNZSTToday } from "./nzst-date";
import { eachDayOfInterval, addDays } from "date-fns";
import logger from "@/lib/logger";
import { CAPACITY_HOLDING_BOOKING_STATUSES } from "@/lib/booking-status";

const WARN_THRESHOLD_BEDS = 5; // Alert when <= 5 beds remaining

/**
 * N-03: Check capacity for the next 14 days and alert admins
 * about high-occupancy days.
 * Runs daily at 7:00 AM NZST.
 */
export async function checkCapacityWarnings(): Promise<{ alertedDays: number }> {
  const todayNZ = getNZSTToday();
  const endDate = addDays(todayNZ, 14);
  const lodgeCapacity = await getLodgeCapacity();

  const nights = eachDayOfInterval({
    start: todayNZ,
    end: addDays(endDate, -1),
  });

  // Find all overlapping bookings for the 14-day window
  const overlappingBookings = await prisma.booking.findMany({
    where: {
      checkIn: { lt: endDate },
      checkOut: { gt: todayNZ },
      status: { in: [...CAPACITY_HOLDING_BOOKING_STATUSES] },
    },
    include: { guests: true },
  });

  const highOccupancyDays: Array<{
    date: Date;
    occupiedBeds: number;
    availableBeds: number;
  }> = [];

  for (const night of nights) {
    const occupiedBeds = getOccupiedBedsForNight(night, overlappingBookings);

    const availableBeds = lodgeCapacity - occupiedBeds;
    if (availableBeds <= WARN_THRESHOLD_BEDS) {
      highOccupancyDays.push({ date: night, occupiedBeds, availableBeds });
    }
  }

  if (highOccupancyDays.length === 0) {
    return { alertedDays: 0 };
  }

  try {
    await sendAdminCapacityWarningAlert(highOccupancyDays, lodgeCapacity);
  } catch (err) {
    logger.error({ err }, "Failed to send capacity warning admin alert");
  }

  return { alertedDays: highOccupancyDays.length };
}
