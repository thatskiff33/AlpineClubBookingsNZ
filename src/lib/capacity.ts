import { prisma } from "./prisma";
import { BookingStatus, Prisma } from "@prisma/client";
import { eachDayOfInterval, subDays } from "date-fns";

type PrismaClient = typeof prisma;
type TransactionClient = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

export const LODGE_CAPACITY = 29;

export interface NightAvailability {
  date: Date;
  occupiedBeds: number;
  availableBeds: number;
}

/**
 * Get the number of occupied beds for each night in a date range.
 * A booking occupies beds from checkIn to checkOut-1 (nights).
 * Only counts CONFIRMED and PENDING bookings.
 */
export async function getAvailability(
  checkIn: Date,
  checkOut: Date
): Promise<NightAvailability[]> {
  const nights = eachDayOfInterval({
    start: checkIn,
    end: subDays(checkOut, 1),
  });

  const overlappingBookings = await prisma.booking.findMany({
    where: {
      checkIn: { lt: checkOut },
      checkOut: { gt: checkIn },
      status: { in: [BookingStatus.CONFIRMED, BookingStatus.PAID, BookingStatus.PENDING] },
    },
    include: {
      guests: true,
    },
  });

  return nights.map((night) => {
    const nightTime = night.getTime();
    let occupiedBeds = 0;

    for (const booking of overlappingBookings) {
      const bookingCheckIn = new Date(booking.checkIn).getTime();
      const bookingCheckOut = new Date(booking.checkOut).getTime();

      if (nightTime >= bookingCheckIn && nightTime < bookingCheckOut) {
        occupiedBeds += booking.guests.length;
      }
    }

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
  const nights = eachDayOfInterval({
    start: checkIn,
    end: subDays(checkOut, 1),
  });

  const overlappingBookings = await db.booking.findMany({
    where: {
      checkIn: { lt: checkOut },
      checkOut: { gt: checkIn },
      status: { in: [BookingStatus.CONFIRMED, BookingStatus.PAID, BookingStatus.PENDING] },
      ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
    },
    include: {
      guests: true,
    },
  });

  const nightDetails: NightAvailability[] = nights.map((night) => {
    const nightTime = night.getTime();
    let occupiedBeds = 0;

    for (const booking of overlappingBookings) {
      const bookingCheckIn = new Date(booking.checkIn).getTime();
      const bookingCheckOut = new Date(booking.checkOut).getTime();
      if (nightTime >= bookingCheckIn && nightTime < bookingCheckOut) {
        occupiedBeds += booking.guests.length;
      }
    }

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
  const startDate = new Date(year, month, 1);
  const endDate = new Date(year, month + 1, 1);

  const overlappingBookings = await prisma.booking.findMany({
    where: {
      checkIn: { lt: endDate },
      checkOut: { gt: startDate },
      status: { in: [BookingStatus.CONFIRMED, BookingStatus.PAID, BookingStatus.PENDING] },
    },
    include: {
      guests: true,
    },
  });

  const availability = new Map<string, number>();
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
    availability.set(key, occupiedBeds);
  }

  return availability;
}
