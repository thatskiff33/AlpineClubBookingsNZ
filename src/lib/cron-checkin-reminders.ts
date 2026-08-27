import { prisma } from "./prisma";
import { sendCheckinReminderEmail, shouldSendEmail } from "./email";
import { addDaysDateOnly } from "./date-only";
import { clubToday, dateOnlyInstantOf } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import logger from "@/lib/logger";
import { OPERATIONAL_STAY_BOOKING_STATUSES } from "@/lib/booking-status";
import { checkinNotBlockedByPendingReviewFilter } from "@/lib/booking-review";
import { EMAIL_DEFAULT_LODGE_NAME } from "@/lib/email-message-settings";
import { OPERATIONALLY_PRESENT_GUEST_WHERE } from "@/lib/member-guest-consent";

/**
 * N-01: Send check-in reminder emails for bookings checking in tomorrow.
 * Runs daily at 9:00 AM NZST.
 * Skips bookings where a reminder has already been sent (checks EmailLog).
 */
export async function sendCheckinReminders(): Promise<{ sent: number; skipped: number }> {
  const now = new Date();
  // ONE zone read per run, both bounds derived from it. The club's day is read
  // through the runtime reader because `src/instrumentation.node.ts` loads this
  // job with a lazy `await import` and `@/lib/club-time/server` is `server-only`
  // (#3123, docs/CLUB_TIME_KERNEL.md).
  const clubZone = await readClubTimeZoneOutsideRequest();
  const tomorrow = addDaysDateOnly(dateOnlyInstantOf(clubToday(clubZone)), 1);
  // The exclusive upper bound of tomorrow's lodge night, stepped with the
  // zone-free calendar helper rather than through the host's clock face
  // (INV-DATE-014, CT-6 #2991). `setDate(getDate() + 1)` added one LOCAL day,
  // which on a daylight-saving weekend is 23 or 25 hours -- so the bound landed
  // an hour off UTC midnight and a `@db.Date` night stored exactly there fell
  // on the wrong side of it.
  const dayAfter = addDaysDateOnly(tomorrow, 1);

  // Find paid/operational bookings checking in tomorrow
  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
      checkIn: {
        gte: tomorrow,
        lt: dayAfter,
      },
      // #1422: a booking blocked by a pending admin review can't check in until
      // an admin clears the review, so it should get no "check-in coming up"
      // reminder while blocked.
      ...checkinNotBlockedByPendingReviewFilter(),
    },
    include: {
      member: true,
      // Owner decision D-12 (#2307): the check-in reminder NAMES each guest, so
      // it must not name a member whose consent to being added is still PENDING
      // — the booker would read it as settled, and the named member has not
      // agreed to be listed anywhere. They still hold a bed under D-4; that is
      // capacity's business, not this email's.
      guests: { where: { ...OPERATIONALLY_PRESENT_GUEST_WHERE } },
      choreAssignments: {
        where: {
          date: {
            gte: tomorrow,
            lt: dayAfter,
          },
        },
        include: {
          choreTemplate: true,
        },
      },
    },
  });

  let sent = 0;
  let skipped = 0;

  for (const booking of bookings) {
    // #1285: honor the member's "Check-in Reminders" notification preference.
    // Check-in reminders are optional/operational — NOT must-send transactional
    // mail — so a member who has switched this category off should not receive
    // one. (Booking confirmation/updates/cancellation notices are must-send and
    // are never gated.) `booking.member` is loaded via the `member: true`
    // include above, so the memberId is already in hand.
    const wantsReminder = await shouldSendEmail(
      booking.member.id,
      "bookingReminder",
    );
    if (!wantsReminder) {
      skipped++;
      continue;
    }

    // Check if reminder already sent (look for checkin-reminder template for this booking's email+subject)
    const alreadySent = await prisma.emailLog.findFirst({
      where: {
        templateName: "checkin-reminder",
        to: booking.member.email,
        subject: `Check-in Reminder - ${EMAIL_DEFAULT_LODGE_NAME}`,
        status: "SENT",
        // Only check within the last 48h to avoid false matches from old bookings
        createdAt: { gte: new Date(now.getTime() - 48 * 60 * 60 * 1000) },
      },
    });

    if (alreadySent) {
      skipped++;
      continue;
    }

    const chores = booking.choreAssignments.map((a) => ({
      name: a.choreTemplate.name,
      description: a.choreTemplate.description,
    }));

    const guests = booking.guests.map((g) => ({
      firstName: g.firstName,
      lastName: g.lastName,
    }));

    try {
      await sendCheckinReminderEmail(
        { bookingId: booking.id, recipientMemberId: booking.memberId },
        booking.member.email,
        booking.member.firstName,
        booking.checkIn,
        booking.checkOut,
        guests,
        chores,
        booking.lodgeId
      );
      sent++;
    } catch (err) {
      logger.error({ err, bookingId: booking.id }, "Failed to send check-in reminder");
    }
  }

  return { sent, skipped };
}
