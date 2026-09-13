import { prisma } from "./prisma";
import { sendAdminDailyDigestAlert } from "./email";
import logger from "@/lib/logger";
import { shouldSendAdminSystemEmail } from "@/lib/notification-delivery-policies";

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
  "admin-xero-repeated-failure",
] as const;

type TemplateName = typeof ADMIN_TEMPLATE_NAMES[number];

/** The countable sections below, minus the derived `totalAlerts`. */
type AlertSectionKey =
  | "newBookings"
  | "paymentFailures"
  | "capacityWarnings"
  | "bookingsBumped"
  | "pendingDeadlines"
  | "xeroErrors";

const TEMPLATE_TO_SECTION: Record<TemplateName, AlertSectionKey> = {
  "admin-new-booking": "newBookings",
  "admin-payment-failure": "paymentFailures",
  "admin-capacity-warning": "capacityWarnings",
  "admin-booking-bumped": "bookingsBumped",
  "admin-pending-deadline": "pendingDeadlines",
  "admin-xero-sync-error": "xeroErrors",
  "admin-xero-repeated-failure": "xeroErrors",
};

export async function sendAdminDigest(): Promise<{
  totalAlerts: number;
  sent: boolean;
  deliveryMode?: string;
  skippedReason?: string;
}> {
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
    sections[sectionKey]++;
  }

  sections.totalAlerts = sections.newBookings + sections.paymentFailures +
    sections.capacityWarnings + sections.bookingsBumped +
    sections.pendingDeadlines + sections.xeroErrors;

  const delivery = await shouldSendAdminSystemEmail({
    templateName: "admin-daily-digest",
    hasContent: sections.totalAlerts > 0,
  });
  if (!delivery.send) {
    logger.info(
      {
        totalAlerts: sections.totalAlerts,
        deliveryMode: delivery.mode,
        reason: delivery.reason,
      },
      "Skipped admin daily digest email by delivery policy"
    );
    return {
      totalAlerts: sections.totalAlerts,
      sent: false,
      deliveryMode: delivery.mode,
      skippedReason: delivery.reason,
    };
  }

  try {
    await sendAdminDailyDigestAlert(sections);
    return {
      totalAlerts: sections.totalAlerts,
      sent: true,
      deliveryMode: delivery.mode,
    };
  } catch (err) {
    logger.error({ err }, "Failed to send admin daily digest");
    return {
      totalAlerts: sections.totalAlerts,
      sent: false,
      deliveryMode: delivery.mode,
    };
  }
}
