import type { BookingStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { OPERATIONAL_STAY_BOOKING_STATUSES } from "@/lib/booking-status";
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import { getActiveGuestsForNight } from "@/lib/booking-guest-stay-ranges";
import { formatBookingReference } from "@/lib/booking-reference";

type OccupancyBookingSummary = {
  id: string;
  reference: string;
  ownerName: string;
  checkIn: string;
  checkOut: string;
  guestCount: number;
  status: BookingStatus;
};

type OccupancyNight = {
  date: string;
  guestCount: number;
  bookings: OccupancyBookingSummary[];
};

export type OccupancyMonth = {
  month: string;
  startDate: string;
  endDate: string;
  nights: OccupancyNight[];
  bookings: OccupancyBookingSummary[];
};

export function parseOccupancyMonth(month: string | null):
  | { ok: true; month: string; startDate: Date; endDate: Date }
  | { ok: false; error: string } {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return { ok: false, error: "month is required as YYYY-MM" };
  }

  const startDate = parseDateOnly(`${month}-01`);
  if (Number.isNaN(startDate.getTime())) {
    return { ok: false, error: "Invalid month" };
  }

  // The `^\d{4}-\d{2}$` check above guarantees exactly two numeric segments.
  const [yearPart, monthPart] = month.split("-").map(Number);
  if (yearPart === undefined || monthPart === undefined) {
    return { ok: false, error: "Invalid month" };
  }
  const nextYear = monthPart === 12 ? yearPart + 1 : yearPart;
  const nextMonth = monthPart === 12 ? 1 : monthPart + 1;
  const endDateString = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
  const endDate = parseDateOnly(endDateString);
  if (Number.isNaN(endDate.getTime())) {
    return { ok: false, error: "Invalid month" };
  }

  return { ok: true, month, startDate, endDate };
}

function ownerName(member: { firstName: string; lastName: string }) {
  return `${member.firstName} ${member.lastName}`.trim();
}

export async function getAdminOccupancyMonth(input: {
  month: string;
  startDate: Date;
  endDate: Date;
  lodgeId: string;
}): Promise<OccupancyMonth> {
  const bookings = await prisma.booking.findMany({
    where: {
      lodgeId: input.lodgeId,
      status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
      deletedAt: null,
      checkIn: { lt: input.endDate },
      checkOut: { gt: input.startDate },
      guests: {
        some: {
          stayStart: { lt: input.endDate },
          stayEnd: { gt: input.startDate },
        },
      },
    },
    select: {
      id: true,
      status: true,
      checkIn: true,
      checkOut: true,
      member: {
        select: {
          firstName: true,
          lastName: true,
        },
      },
      guests: {
        select: {
          id: true,
          stayStart: true,
          stayEnd: true,
          nights: {
            select: {
              stayDate: true,
            },
          },
        },
      },
    },
    orderBy: [{ checkIn: "asc" }, { createdAt: "asc" }],
  });

  const bookingSummaries = new Map<string, OccupancyBookingSummary>();
  const bookingsByNight = new Map<string, OccupancyBookingSummary[]>();

  for (const booking of bookings) {
    const bookingSummary: OccupancyBookingSummary = {
      id: booking.id,
      reference: formatBookingReference(booking.id),
      ownerName: ownerName(booking.member),
      checkIn: formatDateOnly(booking.checkIn),
      checkOut: formatDateOnly(booking.checkOut),
      guestCount: booking.guests.length,
      status: booking.status,
    };
    bookingSummaries.set(booking.id, bookingSummary);

    const rangeStart =
      booking.checkIn > input.startDate ? booking.checkIn : input.startDate;
    const rangeEnd = booking.checkOut < input.endDate ? booking.checkOut : input.endDate;
    for (const night of eachDateOnlyInRange(rangeStart, rangeEnd)) {
      const activeGuests = getActiveGuestsForNight(booking.guests, night, booking);
      if (activeGuests.length === 0) continue;

      const nightKey = formatDateOnly(night);
      const existing = bookingsByNight.get(nightKey) ?? [];
      if (!existing.some((item) => item.id === bookingSummary.id)) {
        bookingsByNight.set(nightKey, [
          ...existing,
          {
            ...bookingSummary,
            guestCount: activeGuests.length,
          },
        ]);
      }
    }
  }

  const nights = eachDateOnlyInRange(input.startDate, input.endDate).map((night) => {
    const date = formatDateOnly(night);
    const nightBookings = bookingsByNight.get(date) ?? [];
    return {
      date,
      guestCount: nightBookings.reduce((total, booking) => {
        const source = bookings.find((item) => item.id === booking.id);
        if (!source) return total;
        return total + getActiveGuestsForNight(source.guests, night, source).length;
      }, 0),
      bookings: nightBookings,
    };
  });

  return {
    month: input.month,
    startDate: formatDateOnly(input.startDate),
    endDate: formatDateOnly(addDaysDateOnly(input.endDate, -1)),
    nights,
    bookings: [...bookingSummaries.values()],
  };
}
