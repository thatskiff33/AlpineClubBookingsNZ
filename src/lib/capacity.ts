import { prisma } from "./prisma";
import { CAPACITY_HOLDING_BOOKING_STATUSES } from "@/lib/booking-status";
import { LODGE_CAPACITY } from "@/lib/lodge-capacity";
import {
  eachDateOnlyInRange,
  formatDateOnly,
  formatDateOnlyForTimeZone,
  normalizeDateOnlyForTimeZone,
  parseDateOnly,
} from "@/lib/date-only";

type PrismaClient = typeof prisma;
type TransactionClient = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

export { LODGE_CAPACITY } from "@/lib/lodge-capacity";

export interface NightAvailability {
  date: Date;
  occupiedBeds: number;
  availableBeds: number;
}

function getMonthStartDateOnly(year: number, month: number): Date {
  const date = parseDateOnly(
    `${year}-${String(month + 1).padStart(2, "0")}-01`
  );

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid month for availability: ${year}-${month + 1}`);
  }

  return date;
}

function getNextMonthStartDateOnly(year: number, month: number): Date {
  const nextMonth = month === 11 ? 0 : month + 1;
  const nextMonthYear = month === 11 ? year + 1 : year;
  return getMonthStartDateOnly(nextMonthYear, nextMonth);
}

function getOccupiedBedsForNight(
  night: Date,
  bookings: Array<{ checkIn: Date; checkOut: Date; guests: unknown[] }>
): number {
  const nightKey = formatDateOnly(night);
  let occupiedBeds = 0;

  for (const booking of bookings) {
    const bookingCheckInKey = formatDateOnlyForTimeZone(booking.checkIn);
    const bookingCheckOutKey = formatDateOnlyForTimeZone(booking.checkOut);

    if (nightKey >= bookingCheckInKey && nightKey < bookingCheckOutKey) {
      occupiedBeds += booking.guests.length;
    }
  }

  return occupiedBeds;
}

/**
 * Get the number of occupied beds for each night in a date range.
 * A booking occupies beds from checkIn to checkOut-1 (nights).
 * Only counts bookings that intentionally reserve capacity.
 */
export async function getAvailability(
  checkIn: Date,
  checkOut: Date
): Promise<NightAvailability[]> {
  const start = normalizeDateOnlyForTimeZone(checkIn);
  const exclusiveEnd = normalizeDateOnlyForTimeZone(checkOut);
  const nights = eachDateOnlyInRange(start, exclusiveEnd);

  const overlappingBookings = await prisma.booking.findMany({
    where: {
      checkIn: { lt: exclusiveEnd },
      checkOut: { gt: start },
      status: { in: [...CAPACITY_HOLDING_BOOKING_STATUSES] },
    },
    include: {
      guests: true,
    },
  });

  return nights.map((night) => {
    const occupiedBeds = getOccupiedBedsForNight(night, overlappingBookings);

    return {
      date: night,
      occupiedBeds,
      availableBeds: LODGE_CAPACITY - occupiedBeds,
    };
  });
}

/**
 * Check if there's enough capacity for a given number of guests across all nights.
 */
export async function checkCapacity(
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  excludeBookingId?: string,
  tx?: TransactionClient
): Promise<{ available: boolean; minAvailable: number; nightDetails: NightAvailability[] }> {
  const db = tx ?? prisma;
  const start = normalizeDateOnlyForTimeZone(checkIn);
  const exclusiveEnd = normalizeDateOnlyForTimeZone(checkOut);
  const nights = eachDateOnlyInRange(start, exclusiveEnd);

  const overlappingBookings = await db.booking.findMany({
    where: {
      checkIn: { lt: exclusiveEnd },
      checkOut: { gt: start },
      status: { in: [...CAPACITY_HOLDING_BOOKING_STATUSES] },
      ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
    },
    include: {
      guests: true,
    },
  });

  const nightDetails: NightAvailability[] = nights.map((night) => {
    const occupiedBeds = getOccupiedBedsForNight(night, overlappingBookings);

    return {
      date: night,
      occupiedBeds,
      availableBeds: LODGE_CAPACITY - occupiedBeds,
    };
  });

  const minAvailable = Math.min(...nightDetails.map((n) => n.availableBeds));

  return {
    available: minAvailable >= guestCount,
    minAvailable,
    nightDetails,
  };
}

/**
 * Get a monthly availability summary for calendar display.
 */
export async function getMonthAvailability(
  year: number,
  month: number
): Promise<Map<string, number>> {
  const startDate = getMonthStartDateOnly(year, month);
  const endDate = getNextMonthStartDateOnly(year, month);

  const overlappingBookings = await prisma.booking.findMany({
    where: {
      checkIn: { lt: endDate },
      checkOut: { gt: startDate },
      status: { in: [...CAPACITY_HOLDING_BOOKING_STATUSES] },
    },
    include: {
      guests: true,
    },
  });

  const availability = new Map<string, number>();
  const nights = eachDateOnlyInRange(startDate, endDate);

  for (const night of nights) {
    const occupiedBeds = getOccupiedBedsForNight(night, overlappingBookings);

    const key = formatDateOnly(night);
    availability.set(key, occupiedBeds);
  }

  return availability;
}
