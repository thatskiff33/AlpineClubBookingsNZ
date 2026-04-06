import { sendAdminXeroSyncErrorAlert } from "./email";
import logger from "@/lib/logger";
import { prisma } from "./prisma";

/**
 * N-05: Xero sync error alert with deduplication.
 * Only sends at most one Xero error alert per hour (checks EmailLog).
 */
export async function notifyXeroSyncError(data: {
  errorType: string;
  operation: string;
  errorMessage: string;
}): Promise<void> {
  try {
    // Deduplication: check if a Xero error alert was sent in the last hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentAlert = await prisma.emailLog.findFirst({
      where: {
        templateName: "admin-xero-sync-error",
        createdAt: { gte: oneHourAgo },
        status: { in: ["SENT", "QUEUED"] },
      },
    });

    if (recentAlert) {
      logger.info({ operation: data.operation }, "Xero error alert suppressed (one per hour limit)");
      return;
    }

    await sendAdminXeroSyncErrorAlert({
      ...data,
      timestamp: new Date(),
    });
  } catch (err) {
    logger.error({ err }, "Failed to send Xero sync error alert");
  }
}
