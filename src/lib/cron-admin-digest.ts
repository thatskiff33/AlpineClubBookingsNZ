import { prisma } from "./prisma";
import { sendAdminDailyDigestAlert } from "./email";
import logger from "@/lib/logger";
import { shouldSendAdminSystemEmail } from "@/lib/notification-delivery-policies";
import { readStoredServerVersion } from "@/lib/servernz-version-check";

/**
 * N-13: Admin daily digest email.
 * Consolidates admin alerts from the past 24 hours into a single summary.
 * Runs daily at 7:30 AM NZST.
 *
 * Since #49 it also carries the "central server version" entry while syncing
 * with the Alpine Central Server is paused. The entry is read from the STORED
 * answer - the 03:00 nightly sync checked it four hours earlier - so this job
 * makes no network call, and a mismatch counts as content: a digest with no
 * alerts still goes out while the versions differ.
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

/**
 * The stored server-version answer as the digest needs it, or null when the
 * versions match (or nothing is connected). A read failure is logged and
 * reads as "no entry": the digest's own counts must still go out.
 */
async function serverVersionEntry(): Promise<{
  expected: string;
  server: string;
} | null> {
  try {
    const version = await readStoredServerVersion();
    if (version.status !== "mismatch") return null;
    return { expected: version.expected, server: version.serverVersion };
  } catch (err) {
    logger.warn(
      { err },
      "Could not read the stored Alpine Central Server version for the admin digest",
    );
    return null;
  }
}

export async function sendAdminDigest(): Promise<{
  totalAlerts: number;
  sent: boolean;
  serverVersionMismatch: boolean;
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

  const serverVersion = await serverVersionEntry();
  const serverVersionMismatch = serverVersion !== null;

  const delivery = await shouldSendAdminSystemEmail({
    templateName: "admin-daily-digest",
    hasContent: sections.totalAlerts > 0 || serverVersionMismatch,
  });
  if (!delivery.send) {
    logger.info(
      {
        totalAlerts: sections.totalAlerts,
        serverVersionMismatch,
        deliveryMode: delivery.mode,
        reason: delivery.reason,
      },
      "Skipped admin daily digest email by delivery policy"
    );
    return {
      totalAlerts: sections.totalAlerts,
      sent: false,
      serverVersionMismatch,
      deliveryMode: delivery.mode,
      skippedReason: delivery.reason,
    };
  }

  try {
    await sendAdminDailyDigestAlert({ sections, serverVersion });
    return {
      totalAlerts: sections.totalAlerts,
      sent: true,
      serverVersionMismatch,
      deliveryMode: delivery.mode,
    };
  } catch (err) {
    logger.error({ err }, "Failed to send admin daily digest");
    return {
      totalAlerts: sections.totalAlerts,
      sent: false,
      serverVersionMismatch,
      deliveryMode: delivery.mode,
    };
  }
}
