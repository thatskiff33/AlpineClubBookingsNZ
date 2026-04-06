import { prisma } from "./prisma";
import logger from "./logger";

/**
 * OBS-08: Record a webhook invocation for monitoring.
 */
export async function recordWebhookLog(data: {
  source: string;
  eventType: string;
  eventId: string;
  status: "success" | "failure";
  durationMs: number;
  error?: string;
}) {
  try {
    await prisma.webhookLog.create({ data });
  } catch (err) {
    logger.error({ err, ...data }, "Failed to record webhook log");
  }
}

/**
 * OBS-08: Get webhook stats for the admin health dashboard.
 * Returns success/failure counts by source for the last 24 hours.
 */
export async function getWebhookStats(hours = 24) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const logs = await prisma.webhookLog.groupBy({
    by: ["source", "status"],
    where: { createdAt: { gte: since } },
    _count: { id: true },
  });

  const stats: Record<string, { success: number; failure: number; total: number }> = {};

  for (const row of logs) {
    if (!stats[row.source]) {
      stats[row.source] = { success: 0, failure: 0, total: 0 };
    }
    const count = row._count.id;
    if (row.status === "success") {
      stats[row.source].success += count;
    } else {
      stats[row.source].failure += count;
    }
    stats[row.source].total += count;
  }

  return stats;
}

/**
 * OBS-08: Prune webhook logs older than 30 days.
 */
export async function pruneWebhookLogs() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const { count } = await prisma.webhookLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  if (count > 0) {
    logger.info({ deletedCount: count }, "Pruned old webhook logs");
  }
  return count;
}
