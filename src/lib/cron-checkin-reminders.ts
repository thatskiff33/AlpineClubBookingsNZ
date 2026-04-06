import { prisma } from "./prisma";
import { BookingStatus } from "@prisma/client";
import { sendCheckinReminderEmail } from "./email";
import logger from "@/lib/logger";

/**
 * N-01: Send check-in reminder emails for bookings checking in tomorrow.
 * Runs daily at 9:00 AM NZST.
 * Skips bookings where a reminder has already been sent (checks EmailLog).
 */
export async function sendCheckinReminders(): Promise<{ sent: number; skipped: number }> {
  // Calculate "tomorrow" in Pacific/Auckland timezone
  const nzFormatter = new Intl.DateTimeFormat("en-NZ", {
    timeZone: "Pacific/Auckland",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const now = new Date();
  const parts = nzFormatter.formatToParts(now);
  const year = parts.find((p) => p.type === "year")!.value;
  const month = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;

  const todayNZ = new Date(`${year}-${month}-${day}T00:00:00`);
  const tomorrowNZ = new Date(todayNZ);
  tomorrowNZ.setDate(tomorrowNZ.getDate() + 1);
  const dayAfterNZ = new Date(tomorrowNZ);
  dayAfterNZ.setDate(dayAfterNZ.getDate() + 1);

  // Find CONFIRMED bookings checking in tomorrow
  const bookings = await prisma.booking.findMany({
    where: {
      status: BookingStatus.CONFIRMED,
      checkIn: {
        gte: tomorrowNZ,
        lt: dayAfterNZ,
      },
    },
    include: {
      member: true,
      guests: true,
      choreAssignments: {
        where: {
          date: {
            gte: tomorrowNZ,
            lt: dayAfterNZ,
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
    // Check if reminder already sent (look for checkin-reminder template for this booking's email+subject)
    const alreadySent = await prisma.emailLog.findFirst({
      where: {
        templateName: "checkin-reminder",
        to: booking.member.email,
        subject: "Check-in Reminder - TAC Lodge",
        status: { in: ["SENT", "QUEUED"] },
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
        booking.member.email,
        booking.member.firstName,
        booking.checkIn,
        booking.checkOut,
        guests,
        chores
      );
      sent++;
    } catch (err) {
      logger.error({ err, bookingId: booking.id }, "Failed to send check-in reminder");
    }
  }

  return { sent, skipped };
}
