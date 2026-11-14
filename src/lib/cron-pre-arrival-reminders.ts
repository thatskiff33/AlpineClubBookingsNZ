import { formatDateOnly } from "@/lib/date-only";
import { clubToday } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { sendPreArrivalReminderEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { clubFormatValues } from "@/lib/club-format-server";
import {
  PRE_ARRIVAL_REMINDER_BOOKING_INCLUDE,
  PRE_ARRIVAL_REMINDER_DAYS,
  PRE_ARRIVAL_REMINDER_STATUSES,
  preArrivalReminderEmailParams,
  preArrivalReminderWindow,
} from "@/lib/pre-arrival-reminder-email";

export interface PreArrivalReminderResult {
  reminderDays: number;
  windowStart: string;
  windowEndExclusive: string;
  sentBookingIds: string[];
  skippedBookingIds: string[];
  failedBookingIds: string[];
}

export async function sendPreArrivalReminders(): Promise<PreArrivalReminderResult> {
  // The club's format (#3565), resolved once, before any transaction or
  // lock below — never per amount and never inside a transaction.
  const format = await clubFormatValues();
  const now = new Date();
  const { windowStart, windowEndExclusive } = preArrivalReminderWindow(
    clubToday(await readClubTimeZoneOutsideRequest()),
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
    // Shared with the officer's fresh-copy action (`pre-arrival-reminder-email.ts`),
    // so both render the same guest count and outstanding-balance note.
    include: PRE_ARRIVAL_REMINDER_BOOKING_INCLUDE,
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
      const outcome = await sendPreArrivalReminderEmail(
        preArrivalReminderEmailParams(booking),
        format,
      );
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
