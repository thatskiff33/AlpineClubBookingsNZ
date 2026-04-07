/**
 * Next.js instrumentation hook.
 * Runs once when the server starts.
 * Initializes Sentry and schedules cron jobs.
 */
export async function register() {
  // OBS-01: Initialize Sentry for the Node.js runtime
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }

  // Only run cron in the Node.js runtime (not Edge)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const cron = await import("node-cron");
    const Sentry = await import("@sentry/nextjs");
    const { default: logger } = await import("./lib/logger");
    const { prisma } = await import("./lib/prisma");

    // Verify Prisma client is ready before starting cron jobs
    try {
      await prisma.$queryRawUnsafe("SELECT 1");
      logger.info("Prisma client verified — database connection OK");
    } catch (err) {
      logger.error({ err }, "Prisma client startup check failed — cron jobs may be unreliable");
      Sentry.captureException(err);
    }

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

    // OBS-03: Cron job 1 - Pending booking confirmation (every 3 hours)
    cron.default.schedule("0 */3 * * *", async () => {
      if (isPendingCronRunning) {
        logger.info({ job: "confirm-pending" }, "Already running, skipping");
        return;
      }
      isPendingCronRunning = true;
      const startedAt = new Date();
      logger.info({ job: "confirm-pending" }, "Checking pending bookings for auto-confirmation");

      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "confirm-pending-bookings", status: "in_progress" },
        { schedule: { type: "crontab", value: "0 */3 * * *" }, checkinMargin: 10, maxRuntime: 30 }
      );

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
        Sentry.captureCheckIn({ checkInId, monitorSlug: "confirm-pending-bookings", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err, job: "confirm-pending" }, "Error in pending booking confirmation");
        Sentry.captureException(err);
        await recordCronRun("confirm-pending", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "confirm-pending-bookings", status: "error" });
      } finally {
        isPendingCronRunning = false;
      }
    }, { timezone: "Pacific/Auckland" });

    logger.info({ job: "confirm-pending" }, "Scheduled pending booking confirmation (every 3 hours)");

    // OBS-03: Cron job 2 - Xero membership refresh (daily at 2 AM)
    cron.default.schedule("0 2 * * *", async () => {
      if (isXeroCronRunning) {
        logger.info({ job: "xero-membership-refresh" }, "Already running, skipping");
        return;
      }
      isXeroCronRunning = true;
      const startedAt = new Date();
      logger.info({ job: "xero-membership-refresh" }, "Refreshing Xero membership statuses");

      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "xero-membership-refresh", status: "in_progress" },
        { schedule: { type: "crontab", value: "0 2 * * *" }, checkinMargin: 10, maxRuntime: 60 }
      );

      try {
        const { isXeroConnected, refreshAllMembershipStatuses } = await import(
          "./lib/xero"
        );
        if (!(await isXeroConnected())) {
          logger.info({ job: "xero-membership-refresh" }, "Xero not connected, skipping");
          await recordCronRun("xero-membership-refresh", startedAt, "SKIPPED", { reason: "Xero not connected" });
          Sentry.captureCheckIn({ checkInId, monitorSlug: "xero-membership-refresh", status: "ok" });
          return;
        }
        const result = await refreshAllMembershipStatuses();
        logger.info({ job: "xero-membership-refresh", ...result }, "Xero membership refresh complete");
        await recordCronRun("xero-membership-refresh", startedAt, "SUCCESS", result as Record<string, unknown>);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "xero-membership-refresh", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err, job: "xero-membership-refresh" }, "Error refreshing Xero memberships");
        Sentry.captureException(err);
        await recordCronRun("xero-membership-refresh", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "xero-membership-refresh", status: "error" });
      } finally {
        isXeroCronRunning = false;
      }
    }, { timezone: "Pacific/Auckland" });

    logger.info({ job: "xero-membership-refresh" }, "Scheduled Xero membership refresh (daily at 2 AM NZST)");

    // OBS-03: Cron job 3 - Database backup (daily at 3 AM)
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

      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "database-backup", status: "in_progress" },
        { schedule: { type: "crontab", value: backupSchedule }, checkinMargin: 10, maxRuntime: 30 }
      );

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
          Sentry.captureCheckIn({ checkInId, monitorSlug: "database-backup", status: "ok" });
        } else {
          logger.error({ job: "backup", error: result.error }, "Database backup failed");
          await recordCronRun("backup", startedAt, "FAILURE", undefined, result.error);
          Sentry.captureCheckIn({ checkInId, monitorSlug: "database-backup", status: "error" });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err, job: "backup" }, "Error running database backup");
        Sentry.captureException(err);
        await recordCronRun("backup", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "database-backup", status: "error" });
      } finally {
        isBackupRunning = false;
      }

      // Delete expired DRAFT bookings (and their promo redemptions via cascade)
      try {
        const expiredDrafts = await prisma.booking.findMany({
          where: { status: "DRAFT", draftExpiresAt: { lt: new Date() } },
          select: { id: true, promoRedemption: { select: { id: true, promoCodeId: true } } },
        });
        if (expiredDrafts.length > 0) {
          // Decrement promo code redemption counts for expired drafts (parallel)
          const promoDecrements = expiredDrafts
            .filter((d) => d.promoRedemption)
            .map((d) =>
              prisma.promoCode.update({
                where: { id: d.promoRedemption!.promoCodeId },
                data: { currentRedemptions: { decrement: 1 } },
              })
            );
          if (promoDecrements.length > 0) {
            await Promise.all(promoDecrements);
          }
          const { count } = await prisma.booking.deleteMany({
            where: { status: "DRAFT", draftExpiresAt: { lt: new Date() } },
          });
          logger.info({ job: "backup", deletedDrafts: count }, "Deleted expired draft bookings");
        }
      } catch (err) {
        logger.error({ err }, "Failed to delete expired draft bookings");
      }
    }, { timezone: "Pacific/Auckland" });

    logger.info({ job: "backup", schedule: backupSchedule }, "Scheduled database backup");

    // Data pruning cron (daily at 3:00 AM NZST)
    cron.default.schedule("0 3 * * *", async () => {
      const startedAt = new Date();
      try {
        const { pruneCronRuns } = await import("./lib/cron-job-run");
        const { pruneWebhookLogs } = await import("./lib/webhook-log");
        await pruneCronRuns();
        await pruneWebhookLogs();
        // Prune expired tokens
        await prisma.emailVerificationToken.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });
        await prisma.emailChangeToken.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });
        await prisma.guestChoreToken.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });
        await prisma.passwordResetToken.deleteMany({
          where: { expiresAt: { lt: new Date() }, used: true },
        });
        logger.info({ job: "data-pruning" }, "Data pruning complete");
        await recordCronRun("data-pruning", startedAt, "SUCCESS");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err, job: "data-pruning" }, "Error in data pruning");
        Sentry.captureException(err);
        await recordCronRun("data-pruning", startedAt, "FAILURE", undefined, message);
      }
    }, { timezone: "Pacific/Auckland" });

    logger.info({ job: "data-pruning" }, "Scheduled data pruning (daily at 3:00 AM NZST)");

    // N-06: Cron job - Pending deadline alerts (daily at 8:00 AM NZST)
    let isPendingDeadlineRunning = false;
    cron.default.schedule("0 8 * * *", async () => {
      if (isPendingDeadlineRunning) {
        logger.info({ job: "pending-deadline-alerts" }, "Already running, skipping");
        return;
      }
      isPendingDeadlineRunning = true;
      const startedAt = new Date();
      logger.info({ job: "pending-deadline-alerts" }, "Checking for pending bookings approaching deadline");

      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "pending-deadline-alerts", status: "in_progress" },
        { schedule: { type: "crontab", value: "0 8 * * *" }, checkinMargin: 10, maxRuntime: 10 }
      );

      try {
        const { checkPendingDeadlines } = await import("./lib/cron-pending-deadline-alerts");
        const result = await checkPendingDeadlines();
        logger.info({ job: "pending-deadline-alerts", ...result }, "Pending deadline alerts complete");
        await recordCronRun("pending-deadline-alerts", startedAt, "SUCCESS", result);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "pending-deadline-alerts", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err, job: "pending-deadline-alerts" }, "Error in pending deadline alerts");
        Sentry.captureException(err);
        await recordCronRun("pending-deadline-alerts", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "pending-deadline-alerts", status: "error" });
      } finally {
        isPendingDeadlineRunning = false;
      }
    }, { timezone: "Pacific/Auckland" });

    logger.info({ job: "pending-deadline-alerts" }, "Scheduled pending deadline alerts (daily at 8:00 AM NZST)");

    // N-01: Cron job - Check-in reminders (daily at 9:00 AM NZST)
    let isCheckinReminderRunning = false;
    cron.default.schedule("0 9 * * *", async () => {
      if (isCheckinReminderRunning) {
        logger.info({ job: "checkin-reminders" }, "Already running, skipping");
        return;
      }
      isCheckinReminderRunning = true;
      const startedAt = new Date();
      logger.info({ job: "checkin-reminders" }, "Sending check-in reminders");

      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "checkin-reminders", status: "in_progress" },
        { schedule: { type: "crontab", value: "0 9 * * *" }, checkinMargin: 10, maxRuntime: 15 }
      );

      try {
        const { sendCheckinReminders } = await import("./lib/cron-checkin-reminders");
        const result = await sendCheckinReminders();
        logger.info({ job: "checkin-reminders", ...result }, "Check-in reminders complete");
        await recordCronRun("checkin-reminders", startedAt, "SUCCESS", result);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "checkin-reminders", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err, job: "checkin-reminders" }, "Error in check-in reminders");
        Sentry.captureException(err);
        await recordCronRun("checkin-reminders", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "checkin-reminders", status: "error" });
      } finally {
        isCheckinReminderRunning = false;
      }
    }, { timezone: "Pacific/Auckland" });

    logger.info({ job: "checkin-reminders" }, "Scheduled check-in reminders (daily at 9:00 AM NZST)");

    // N-03: Cron job - Capacity warnings (daily at 7:00 AM NZST)
    let isCapacityWarningRunning = false;
    cron.default.schedule("0 7 * * *", async () => {
      if (isCapacityWarningRunning) {
        logger.info({ job: "capacity-warnings" }, "Already running, skipping");
        return;
      }
      isCapacityWarningRunning = true;
      const startedAt = new Date();
      logger.info({ job: "capacity-warnings" }, "Checking capacity for upcoming days");

      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "capacity-warnings", status: "in_progress" },
        { schedule: { type: "crontab", value: "0 7 * * *" }, checkinMargin: 10, maxRuntime: 10 }
      );

      try {
        const { checkCapacityWarnings } = await import("./lib/cron-capacity-warnings");
        const result = await checkCapacityWarnings();
        logger.info({ job: "capacity-warnings", ...result }, "Capacity warnings check complete");
        await recordCronRun("capacity-warnings", startedAt, "SUCCESS", result);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "capacity-warnings", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err, job: "capacity-warnings" }, "Error in capacity warnings");
        Sentry.captureException(err);
        await recordCronRun("capacity-warnings", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "capacity-warnings", status: "error" });
      } finally {
        isCapacityWarningRunning = false;
      }
    }, { timezone: "Pacific/Auckland" });

    logger.info({ job: "capacity-warnings" }, "Scheduled capacity warnings (daily at 7:00 AM NZST)");

    // N-13: Cron job - Admin daily digest (daily at 7:30 AM NZST)
    let isAdminDigestRunning = false;
    cron.default.schedule("30 7 * * *", async () => {
      if (isAdminDigestRunning) {
        logger.info({ job: "admin-digest" }, "Already running, skipping");
        return;
      }
      isAdminDigestRunning = true;
      const startedAt = new Date();
      logger.info({ job: "admin-digest" }, "Sending admin daily digest");

      try {
        const { sendAdminDigest } = await import("./lib/cron-admin-digest");
        const result = await sendAdminDigest();
        logger.info({ job: "admin-digest", ...result }, "Admin daily digest complete");
        await recordCronRun("admin-digest", startedAt, "SUCCESS", result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err, job: "admin-digest" }, "Error in admin daily digest");
        Sentry.captureException(err);
        await recordCronRun("admin-digest", startedAt, "FAILURE", undefined, message);
      } finally {
        isAdminDigestRunning = false;
      }
    }, { timezone: "Pacific/Auckland" });

    logger.info({ job: "admin-digest" }, "Scheduled admin daily digest (daily at 7:30 AM NZST)");

    // N-11: Cron job - Email retry (every 30 minutes)
    let isEmailRetryRunning = false;
    cron.default.schedule("*/30 * * * *", async () => {
      if (isEmailRetryRunning) {
        logger.info({ job: "email-retry" }, "Already running, skipping");
        return;
      }
      isEmailRetryRunning = true;
      const startedAt = new Date();
      logger.info({ job: "email-retry" }, "Retrying failed emails");

      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "email-retry", status: "in_progress" },
        { schedule: { type: "crontab", value: "*/30 * * * *" }, checkinMargin: 10, maxRuntime: 10 }
      );

      try {
        const { retryFailedEmails } = await import("./lib/cron-email-retry");
        const result = await retryFailedEmails();
        logger.info({ job: "email-retry", ...result }, "Email retry complete");
        await recordCronRun("email-retry", startedAt, "SUCCESS", result);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "email-retry", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err, job: "email-retry" }, "Error in email retry");
        Sentry.captureException(err);
        await recordCronRun("email-retry", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "email-retry", status: "error" });
      } finally {
        isEmailRetryRunning = false;
      }
    });

    logger.info({ job: "email-retry" }, "Scheduled email retry (every 30 minutes)");

    // N-12: Cron job - Post-stay feedback requests (daily at 10:00 AM NZST)
    let isFeedbackRequestRunning = false;
    cron.default.schedule("0 10 * * *", async () => {
      if (isFeedbackRequestRunning) {
        logger.info({ job: "feedback-requests" }, "Already running, skipping");
        return;
      }
      isFeedbackRequestRunning = true;
      const startedAt = new Date();
      logger.info({ job: "feedback-requests" }, "Sending post-stay feedback requests");

      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "feedback-requests", status: "in_progress" },
        { schedule: { type: "crontab", value: "0 10 * * *" }, checkinMargin: 10, maxRuntime: 10 }
      );

      try {
        const { sendFeedbackRequests } = await import("./lib/cron-feedback-requests");
        const result = await sendFeedbackRequests();
        logger.info({ job: "feedback-requests", ...result }, "Feedback requests complete");
        await recordCronRun("feedback-requests", startedAt, "SUCCESS", result);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "feedback-requests", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err, job: "feedback-requests" }, "Error in feedback requests");
        Sentry.captureException(err);
        await recordCronRun("feedback-requests", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "feedback-requests", status: "error" });
      } finally {
        isFeedbackRequestRunning = false;
      }
    }, { timezone: "Pacific/Auckland" });

    logger.info({ job: "feedback-requests" }, "Scheduled post-stay feedback requests (daily at 10:00 AM NZST)");

    // Cron job - Complete bookings (daily at 1:00 AM NZST)
    // Transitions PAID bookings to COMPLETED once check-in date has passed
    let isCompleteBookingsRunning = false;
    cron.default.schedule("0 1 * * *", async () => {
      if (isCompleteBookingsRunning) {
        logger.info({ job: "complete-bookings" }, "Already running, skipping");
        return;
      }
      isCompleteBookingsRunning = true;
      const startedAt = new Date();
      logger.info({ job: "complete-bookings" }, "Transitioning PAID bookings to COMPLETED");

      try {
        const { completeBookings } = await import("./lib/cron-complete-bookings");
        const result = await completeBookings();
        logger.info({ job: "complete-bookings", ...result }, "Complete bookings cron finished");
        await recordCronRun("complete-bookings", startedAt, "SUCCESS", result as unknown as Record<string, unknown>);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err, job: "complete-bookings" }, "Error in complete bookings cron");
        Sentry.captureException(err);
        await recordCronRun("complete-bookings", startedAt, "FAILURE", undefined, message);
      } finally {
        isCompleteBookingsRunning = false;
      }
    }, { timezone: "Pacific/Auckland" });

    logger.info({ job: "complete-bookings" }, "Scheduled complete bookings (daily at 1:00 AM NZST)");

    // Hut leader auto-assign (daily at 6:00 AM NZST)
    let isHutLeaderAutoAssignRunning = false;
    cron.default.schedule("0 6 * * *", async () => {
      if (isHutLeaderAutoAssignRunning) {
        logger.info({ job: "hut-leader-auto-assign" }, "Already running, skipping");
        return;
      }
      isHutLeaderAutoAssignRunning = true;
      const startedAt = new Date();
      logger.info({ job: "hut-leader-auto-assign" }, "Running hut leader auto-assign");

      try {
        const { autoAssignHutLeaders } = await import("./lib/cron-hut-leader-auto-assign");
        const result = await autoAssignHutLeaders();
        logger.info({ job: "hut-leader-auto-assign", ...result }, "Hut leader auto-assign complete");
        await recordCronRun("hut-leader-auto-assign", startedAt, "SUCCESS", result as unknown as Record<string, unknown>);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err, job: "hut-leader-auto-assign" }, "Error in hut leader auto-assign");
        Sentry.captureException(err);
        await recordCronRun("hut-leader-auto-assign", startedAt, "FAILURE", undefined, message);
      } finally {
        isHutLeaderAutoAssignRunning = false;
      }
    }, { timezone: "Pacific/Auckland" });

    logger.info({ job: "hut-leader-auto-assign" }, "Scheduled hut leader auto-assign (daily at 6:00 AM NZST)");

    // Age-up cron (daily at 6:30 AM NZST) — detect members turning 18, grant login
    let isAgeUpRunning = false;
    cron.default.schedule("30 6 * * *", async () => {
      if (isAgeUpRunning) {
        logger.info({ job: "age-up" }, "Already running, skipping");
        return;
      }
      isAgeUpRunning = true;
      const startedAt = new Date();
      logger.info({ job: "age-up" }, "Checking for members who have turned 18");

      try {
        const { checkAgeUpMembers } = await import("./lib/cron-age-up");
        const result = await checkAgeUpMembers();
        logger.info({ job: "age-up", ...result }, "Age-up check complete");
        await recordCronRun("age-up", startedAt, "SUCCESS", result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err, job: "age-up" }, "Error in age-up check");
        Sentry.captureException(err);
        await recordCronRun("age-up", startedAt, "FAILURE", undefined, message);
      } finally {
        isAgeUpRunning = false;
      }
    }, { timezone: "Pacific/Auckland" });

    logger.info({ job: "age-up" }, "Scheduled age-up check (daily at 6:30 AM NZST)");
  }
}

// OBS-02: Sentry onRequestError handler for server-side errors
export const onRequestError = async (
  err: unknown,
  request: { method: string; url: string; headers: Record<string, string> },
  context: { routerKind: string; routePath: string; routeType: string; renderSource: string }
) => {
  const Sentry = await import("@sentry/nextjs");
  Sentry.captureException(err, {
    tags: {
      routerKind: context.routerKind,
      routePath: context.routePath,
      routeType: context.routeType,
      renderSource: context.renderSource,
    },
    extra: {
      method: request.method,
      url: request.url,
    },
  });
};
