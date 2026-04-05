/**
 * Next.js instrumentation hook.
 * Runs once when the server starts.
 * Used to schedule cron jobs for auto-confirming pending bookings.
 */
export async function register() {
  // Only run cron in the Node.js runtime (not Edge)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const cron = await import("node-cron");
    const { default: logger } = await import("./lib/logger");
    const { prisma } = await import("./lib/prisma");

    // Overlap guards: prevent concurrent execution of the same cron job
    let isPendingCronRunning = false;
    let isXeroCronRunning = false;

    // Helper: record a cron job run
    async function recordCronRun(
      jobName: string,
      startedAt: Date,
      status: string,
      resultSummary?: Record<string, unknown>,
      error?: string
    ) {
      const completedAt = new Date();
      const durationMs = completedAt.getTime() - startedAt.getTime();
      try {
        await prisma.cronJobRun.create({
          data: {
            jobName,
            startedAt,
            completedAt,
            durationMs,
            status,
            resultSummary: resultSummary ? JSON.parse(JSON.stringify(resultSummary)) : undefined,
            error: error ?? undefined,
          },
        });
      } catch (err) {
        logger.error({ err, job: jobName }, "Failed to record cron job run");
      }
    }

    // Auto-prune old CronJobRun records (older than 90 days)
    async function pruneCronRuns() {
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

    // Run every 3 hours to check for pending bookings past their hold deadline
    cron.default.schedule("0 */3 * * *", async () => {
      if (isPendingCronRunning) {
        logger.info({ job: "confirm-pending" }, "Already running, skipping");
        return;
      }
      isPendingCronRunning = true;
      const startedAt = new Date();
      logger.info({ job: "confirm-pending" }, "Checking pending bookings for auto-confirmation");
      try {
        const { confirmPendingBookings } = await import(
          "./lib/cron-confirm-pending"
        );
        const result = await confirmPendingBookings();
        const summary = {
          confirmed: result.confirmedBookingIds.length,
          bumped: result.bumpedBookingIds.length,
          failed: result.failedBookingIds.length,
        };
        logger.info({ job: "confirm-pending", ...summary }, "Pending booking confirmation complete");
        await recordCronRun("confirm-pending", startedAt, "SUCCESS", summary);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err, job: "confirm-pending" }, "Error in pending booking confirmation");
        await recordCronRun("confirm-pending", startedAt, "FAILURE", undefined, message);
      } finally {
        isPendingCronRunning = false;
      }
    });

    logger.info({ job: "confirm-pending" }, "Scheduled pending booking confirmation (every 3 hours)");

    // Run daily at 2 AM to refresh Xero membership statuses
    cron.default.schedule("0 2 * * *", async () => {
      if (isXeroCronRunning) {
        logger.info({ job: "xero-membership-refresh" }, "Already running, skipping");
        return;
      }
      isXeroCronRunning = true;
      const startedAt = new Date();
      logger.info({ job: "xero-membership-refresh" }, "Refreshing Xero membership statuses");
      try {
        const { isXeroConnected, refreshAllMembershipStatuses } = await import(
          "./lib/xero"
        );
        if (!(await isXeroConnected())) {
          logger.info({ job: "xero-membership-refresh" }, "Xero not connected, skipping");
          await recordCronRun("xero-membership-refresh", startedAt, "SKIPPED", { reason: "Xero not connected" });
          return;
        }
        const result = await refreshAllMembershipStatuses();
        logger.info({ job: "xero-membership-refresh", ...result }, "Xero membership refresh complete");
        await recordCronRun("xero-membership-refresh", startedAt, "SUCCESS", result as Record<string, unknown>);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err, job: "xero-membership-refresh" }, "Error refreshing Xero memberships");
        await recordCronRun("xero-membership-refresh", startedAt, "FAILURE", undefined, message);
      } finally {
        isXeroCronRunning = false;
      }
    });

    logger.info({ job: "xero-membership-refresh" }, "Scheduled Xero membership refresh (daily at 2 AM)");

    // Database backup - daily at 3 AM (configurable via BACKUP_CRON_SCHEDULE)
    let isBackupRunning = false;
    const backupSchedule = process.env.BACKUP_CRON_SCHEDULE || "0 3 * * *";

    cron.default.schedule(backupSchedule, async () => {
      if (isBackupRunning) {
        logger.info({ job: "backup" }, "Already running, skipping");
        return;
      }
      isBackupRunning = true;
      const startedAt = new Date();
      logger.info({ job: "backup" }, "Starting database backup");
      try {
        const { runDatabaseBackup } = await import("./lib/backup");
        const result = await runDatabaseBackup();
        if (result.success) {
          const summary = {
            filename: result.filename,
            sizeBytes: result.sizeBytes,
            s3: result.uploadedToS3,
          };
          logger.info({ job: "backup", ...summary }, "Database backup complete");
          await recordCronRun("backup", startedAt, "SUCCESS", summary);
        } else {
          logger.error({ job: "backup", error: result.error }, "Database backup failed");
          await recordCronRun("backup", startedAt, "FAILURE", undefined, result.error);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err, job: "backup" }, "Error running database backup");
        await recordCronRun("backup", startedAt, "FAILURE", undefined, message);
      } finally {
        isBackupRunning = false;
      }

      // Prune old cron runs after backup
      await pruneCronRuns();
    });

    logger.info({ job: "backup", schedule: backupSchedule }, "Scheduled database backup");
  }
}
