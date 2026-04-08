import { prisma } from "./prisma";
import { sendAdminDailyDigestAlert } from "./email";
import logger from "@/lib/logger";

/**
 * N-13: Admin daily digest email.
 * Consolidates admin alerts from the past 24 hours into a single summary.
 * Runs daily at 7:30 AM NZST.
 */

const ADMIN_TEMPLATE_NAMES = [
  "admin-new-booking",
  "admin-payment-failure",
  "admin-capacity-warning",
  "admin-booking-bumped",
  "admin-pending-deadline",
  "admin-xero-sync-error",
] as const;

type TemplateName = typeof ADMIN_TEMPLATE_NAMES[number];

const TEMPLATE_TO_SECTION: Record<TemplateName, string> = {
  "admin-new-booking": "newBookings",
  "admin-payment-failure": "paymentFailures",
  "admin-capacity-warning": "capacityWarnings",
  "admin-booking-bumped": "bookingsBumped",
  "admin-pending-deadline": "pendingDeadlines",
  "admin-xero-sync-error": "xeroErrors",
};

export async function sendAdminDigest(): Promise<{ totalAlerts: number; sent: boolean }> {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Count distinct events per template (dedup per-admin sends by grouping on templateName+subject)
  const alertLogs = await prisma.emailLog.findMany({
    where: {
      templateName: { in: [...ADMIN_TEMPLATE_NAMES] },
      createdAt: { gte: twentyFourHoursAgo },
      status: { in: ["SENT", "QUEUED"] },
    },
    distinct: ["templateName", "subject"],
    select: { templateName: true, subject: true },
  });

  const sections = {
    newBookings: 0,
    paymentFailures: 0,
    capacityWarnings: 0,
    bookingsBumped: 0,
    pendingDeadlines: 0,
    xeroErrors: 0,
    totalAlerts: 0,
  };

  for (const row of alertLogs) {
    const sectionKey = TEMPLATE_TO_SECTION[row.templateName as TemplateName];
    if (sectionKey && sectionKey in sections) {
      (sections as Record<string, number>)[sectionKey]++;
    }
  }

  sections.totalAlerts = sections.newBookings + sections.paymentFailures +
    sections.capacityWarnings + sections.bookingsBumped +
    sections.pendingDeadlines + sections.xeroErrors;

  // Always send the digest (even if zero alerts — confirms the system is running)
  try {
    await sendAdminDailyDigestAlert(sections);
    return { totalAlerts: sections.totalAlerts, sent: true };
  } catch (err) {
    logger.error({ err }, "Failed to send admin daily digest");
    return { totalAlerts: sections.totalAlerts, sent: false };
  }
}
