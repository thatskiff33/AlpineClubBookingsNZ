import { BookingStatus } from "@prisma/client";
import {
  addDaysDateOnly,
  formatDateOnly,
  getTodayDateOnly,
} from "@/lib/date-only";
import { sendPreArrivalReminderEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

export const PRE_ARRIVAL_REMINDER_DAYS = 3;

const PRE_ARRIVAL_REMINDER_STATUSES = [
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
] as const;

export interface PreArrivalReminderResult {
  reminderDays: number;
  windowStart: string;
  windowEndExclusive: string;
  sentBookingIds: string[];
  skippedBookingIds: string[];
  failedBookingIds: string[];
}

export async function sendPreArrivalReminders(): Promise<PreArrivalReminderResult> {
  const now = new Date();
  const windowStart = getTodayDateOnly();
  const windowEndExclusive = addDaysDateOnly(
    windowStart,
    PRE_ARRIVAL_REMINDER_DAYS + 1,
  );

  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: [...PRE_ARRIVAL_REMINDER_STATUSES] },
      deletedAt: null,
      preArrivalReminderSentAt: null,
      checkIn: {
        gte: windowStart,
        lt: windowEndExclusive,
      },
    },
    include: {
      member: true,
      guests: true,
    },
    orderBy: [{ checkIn: "asc" }, { createdAt: "asc" }],
  });

  const result: PreArrivalReminderResult = {
    reminderDays: PRE_ARRIVAL_REMINDER_DAYS,
    windowStart: formatDateOnly(windowStart),
    windowEndExclusive: formatDateOnly(windowEndExclusive),
    sentBookingIds: [],
    skippedBookingIds: [],
    failedBookingIds: [],
  };

  for (const booking of bookings) {
    const claimed = await prisma.booking.updateMany({
      where: {
        id: booking.id,
        status: { in: [...PRE_ARRIVAL_REMINDER_STATUSES] },
        deletedAt: null,
        preArrivalReminderSentAt: null,
        checkIn: {
          gte: windowStart,
          lt: windowEndExclusive,
        },
      },
      data: { preArrivalReminderSentAt: now },
    });

    if (claimed.count === 0) {
      result.skippedBookingIds.push(booking.id);
      continue;
    }

    try {
      await sendPreArrivalReminderEmail({
        email: booking.member.email,
        firstName: booking.member.firstName,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        guestCount: booking.guests.length,
        expectedArrivalTime: booking.expectedArrivalTime,
      });
      result.sentBookingIds.push(booking.id);
    } catch (err) {
      logger.error(
        { err, bookingId: booking.id, job: "preArrivalReminders" },
        "Failed to send pre-arrival reminder",
      );
      result.failedBookingIds.push(booking.id);
    }
  }

  return result;
}
