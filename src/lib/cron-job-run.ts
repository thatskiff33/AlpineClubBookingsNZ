import { prisma } from "./prisma";
import logger from "@/lib/logger";

/**
 * Auto-prune old CronJobRun records (older than 90 days).
 */
export async function pruneCronRuns() {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const { count } = await prisma.cronJobRun.deleteMany({
      where: { startedAt: { lt: cutoff } },
    });
    if (count > 0) {
      logger.info({ job: "cron-prune", deletedCount: count }, "Pruned old cron job runs");
    }
  } catch (err) {
    logger.error({ err, job: "cron-prune" }, "Failed to prune old cron job runs");
  }
}
