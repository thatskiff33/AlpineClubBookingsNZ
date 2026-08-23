import { BookingStatus } from "@prisma/client";
import { isAdditionalPaymentOwed } from "@/lib/additional-payment-chase";
import { addDaysDateOnly, formatDateOnly } from "@/lib/date-only";
import { clubToday, dateOnlyInstantOf } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { sendPreArrivalReminderEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { OPERATIONALLY_PRESENT_GUEST_WHERE } from "@/lib/member-guest-consent";
import { prisma } from "@/lib/prisma";

const PRE_ARRIVAL_REMINDER_DAYS = 3;

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
  const windowStart = dateOnlyInstantOf(clubToday(await readClubTimeZoneOutsideRequest()));
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
      // Owner decision D-12 (#2307): the reminder tells a member how many
      // guests are arriving, so it counts the guests who will actually be
      // there. A member guest whose consent is still PENDING holds a bed under
      // D-4 but is not operationally present, and an inflated "Guests: 4" in an
      // email is the club telling the booker something untrue. Filtering the
      // include is what fixes `guests.length` below — the count has no separate
      // query of its own.
      guests: { where: { ...OPERATIONALLY_PRESENT_GUEST_WHERE } },
      // #2350: an upward booking change may have left money uncollected. The
      // pre-arrival note is the last thing most members read before they
      // travel, so it says so when that is true. This is the booking's own
      // balance, so it is unaffected by the guest filter above — a pending
      // member guest still holds their bed, and the money owed for it is still
      // owed.
      payment: {
        select: {
          additionalAmountCents: true,
          additionalPaymentStatus: true,
        },
      },
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
        bookingId: booking.id,
        recipientMemberId: booking.memberId,
        email: booking.member.email,
        firstName: booking.member.firstName,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        guestCount: booking.guests.length,
        expectedArrivalTime: booking.expectedArrivalTime,
        lodgeId: booking.lodgeId,
        outstandingAdditionalAmountCents: isAdditionalPaymentOwed({
          bookingStatus: booking.status,
          payment: booking.payment,
        })
          ? booking.payment?.additionalAmountCents ?? 0
          : 0,
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
