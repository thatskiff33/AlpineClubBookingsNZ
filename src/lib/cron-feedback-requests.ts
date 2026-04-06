/**
 * N-12: Post-Stay Feedback Request
 * Sends feedback request emails for bookings where checkOut was yesterday.
 * Respects notification preferences (bookingReminder category).
 */
import { prisma } from "@/lib/prisma";
import { sendEmail, shouldSendEmail } from "@/lib/email";
import { postStayFeedbackTemplate } from "@/lib/email-templates";
import logger from "@/lib/logger";

export async function sendFeedbackRequests(): Promise<{
  sent: number;
  skippedPreference: number;
  failed: number;
}> {
  // Calculate "yesterday" in NZST
  const now = new Date();
  const nzFormatter = new Intl.DateTimeFormat("en-NZ", {
    timeZone: "Pacific/Auckland",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = nzFormatter.formatToParts(now);
  const year = parts.find((p) => p.type === "year")!.value;
  const month = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;

  const todayNZ = new Date(`${year}-${month}-${day}T00:00:00Z`);
  const yesterdayNZ = new Date(todayNZ);
  yesterdayNZ.setDate(yesterdayNZ.getDate() - 1);

  // Find CONFIRMED or COMPLETED bookings where checkOut = yesterday
  const bookings = await prisma.booking.findMany({
    where: {
      checkOut: yesterdayNZ,
      status: { in: ["CONFIRMED", "COMPLETED"] },
    },
    include: {
      member: {
        select: { id: true, email: true, firstName: true },
      },
    },
  });

  let sent = 0;
  let skippedPreference = 0;
  let failed = 0;

  for (const booking of bookings) {
    // Check notification preference (bookingReminder gates general booking comms)
    const shouldSend = await shouldSendEmail(
      booking.member.id,
      "bookingReminder"
    );
    if (!shouldSend) {
      skippedPreference++;
      logger.info(
        { bookingId: booking.id, memberId: booking.member.id },
        "Skipping feedback request (preference disabled)"
      );
      continue;
    }

    try {
      await sendEmail({
        to: booking.member.email,
        subject: "How was your stay? - TAC Lodge",
        html: postStayFeedbackTemplate(
          booking.member.firstName,
          booking.checkIn,
          booking.checkOut
        ),
        templateName: "post-stay-feedback",
      });
      sent++;
    } catch (err) {
      failed++;
      logger.error(
        { err, bookingId: booking.id },
        "Failed to send feedback request email"
      );
    }
  }

  return { sent, skippedPreference, failed };
}
