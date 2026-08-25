import { BookingStatus } from "@prisma/client";
import { isAdditionalPaymentOwed } from "@/lib/additional-payment-chase";
import {
  addDaysDateOnly,
  formatDateOnly,
  getTodayDateOnly,
} from "@/lib/date-only";
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
      const outcome = await sendPreArrivalReminderEmail({
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
      /*
        THE CLAIM ABOVE IS THE ONLY THING THAT WILL EVER SELECT THIS BOOKING
        (#3035). It stamps `preArrivalReminderSentAt` BEFORE the send, and the
        query's own filter is `preArrivalReminderSentAt: null` — so a stamp
        written for a message that never went out is consumed permanently. This
        message carries the door code and the arrival instructions, so the
        member arrives at a locked lodge and nothing anywhere says why.

        `sendEmail` RETURNS rather than throws when nothing was transmitted, so
        the `catch` below never saw any of these. The same rule as the
        additional-payment reminder: hand the stamp back unless something else
        will replay the message.

        The confirmed-copy withhold is terminal (a `SKIPPED_NON_PRODUCTION` row,
        nothing to retry), so it KEEPS the stamp — a copy must not re-claim and
        re-suppress the same booking every run, which would write a new counted
        row per pass and make an idle staging box read like a live club whose
        mail is being held. Every other non-send hands the stamp back, because
        every one of them is something a person can fix: declare the role, correct
        the transport flags, clear a suppression, replace a walk-in placeholder
        address, turn the booking's switch back off.
      */
      if (outcome.status === "sent") {
        result.sentBookingIds.push(booking.id);
      } else {
        /*
          NOTHING ELSE WILL REPLAY THIS MESSAGE, which is why the rule here is
          stricter than the additional-payment reminder's. That cron hands the
          stamp back for every non-send EXCEPT the ones that leave a replayable
          `FAILED` EmailLog row for the email retry cron to pick up. This template
          has no such row to leave: `pre-arrival-reminder` carries the lodge's
          DOOR CODE, so it is in `SENSITIVE_EMAIL_LOG_TEMPLATES` and its rendered
          body is deliberately never persisted — and the retry cron only selects
          rows that still hold a body. So "the retry cron will get it" is false
          here for every reason, and the stamp comes back for all of them.
        */
        const terminalForThisInstallation =
          outcome.status === "withheld_for_environment" &&
          outcome.reason === "environment_non_production";
        const stampRestored = !terminalForThisInstallation;
        if (stampRestored) {
          await prisma.booking
            .updateMany({
              where: { id: booking.id, preArrivalReminderSentAt: now },
              data: { preArrivalReminderSentAt: null },
            })
            .catch((restoreErr) =>
              logger.error(
                { err: restoreErr, bookingId: booking.id, job: "preArrivalReminders" },
                "Failed to hand back the pre-arrival reminder claim after an undelivered email; this booking will not be reminded again",
              ),
            );
        }
        logger.warn(
          {
            bookingId: booking.id,
            job: "preArrivalReminders",
            outcome: outcome.status,
            stampRestored,
          },
          "Pre-arrival reminder was not transmitted",
        );
        result.skippedBookingIds.push(booking.id);
      }
    } catch (err) {
      /*
        A THROW BURNS THE SAME CLAIM, so it hands it back for the same reason
        (#3035). `sendEmail` only throws when the transport itself failed —
        every outcome after the provider accepted is returned, and the
        `SENT`-write failure is caught inside the mailer — so nothing reached the
        member. And `pre-arrival-reminder` is one of the templates whose rendered
        body is deliberately NOT retained (it carries a door code), so the email
        retry cron can never replay the FAILED row it leaves behind. Without this
        the stamp stays and the reminder is gone for good.

        The trade accepted, stated: if a provider accepted the message and then
        dropped the connection, the next run sends a second reminder. A duplicate
        pre-arrival note is a much smaller harm than a member arriving at a locked
        lodge with no door code, and it is the same trade the additional-payment
        reminder already makes.
      */
      await prisma.booking
        .updateMany({
          where: { id: booking.id, preArrivalReminderSentAt: now },
          data: { preArrivalReminderSentAt: null },
        })
        .catch((restoreErr) =>
          logger.error(
            { err: restoreErr, bookingId: booking.id, job: "preArrivalReminders" },
            "Failed to hand back the pre-arrival reminder claim after a send error; this booking will not be reminded again",
          ),
        );
      logger.error(
        { err, bookingId: booking.id, job: "preArrivalReminders" },
        "Failed to send pre-arrival reminder; the claim was handed back so a later run retries it",
      );
      result.failedBookingIds.push(booking.id);
    }
  }

  return result;
}
