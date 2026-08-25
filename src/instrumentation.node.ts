import { APP_TIME_ZONE } from "@/config/operational";
import type { FeatureFlags } from "@/config/schema";

const CRON_TIMEZONE = APP_TIME_ZONE;

// test seam
export function getOptionalCronRegistrationState(flags?: FeatureFlags) {
  void flags;

  return {
    financeDailySync: true,
    waitlistProcessor: true,
    xeroIntegration: true,
  };
}

function sentryCronMonitorConfig(
  schedule: string,
  options: { checkinMargin?: number; maxRuntime?: number } = {}
) {
  return {
    schedule: { type: "crontab" as const, value: schedule },
    timezone: CRON_TIMEZONE,
    ...options,
  };
}

/**
 * Next.js instrumentation hook.
 * Runs once when the server starts.
 * Initializes Sentry and schedules cron jobs.
 */
export async function register() {
  // OBS-01: Initialize Sentry for the Node.js runtime
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");

    // #1912: warm the HTML-email brand palette from the persisted Site Style
    // theme so the first email after a cold start uses the configured colours,
    // not the built-in default. Best-effort and runs regardless of cron config;
    // it never blocks or fails startup. Since #2900 it is an optimisation, not
    // the guarantee: if it fails, the render gate (`renderEmailHtml`) loads the
    // palette before any themed HTML is built, so a failed prime costs the
    // first email a bounded wait rather than the wrong brand.
    try {
      const { primeEmailPalette } = await import("./lib/email-theme");
      await primeEmailPalette();
    } catch {
      // Ignore — the email palette self-warms in the background on first use.
    }

    // #1943 (C2): boot-time config self-heal. Copies each registered setting's
    // current EFFECTIVE config value into its DB row IFF that row is absent, so
    // later epic-#1943 collapse children can drop their file/env fallback
    // without stranding a live deploy (`prisma migrate deploy` runs, but the
    // seed never does and a SQL migration cannot read config/club.json).
    // Create-if-absent, idempotent, and blue/green-safe. Best-effort: it runs
    // on every Node boot regardless of cron config and can never block or fail
    // startup. `runConfigSelfHeal` already swallows per-step errors; the outer
    // try/catch guards the dynamic imports themselves.
    try {
      const { prisma } = await import("./lib/prisma");
      const { runConfigSelfHeal } = await import("./lib/config-self-heal");
      await runConfigSelfHeal({ db: prisma });
    } catch (err) {
      const { default: logger } = await import("./lib/logger");
      logger.warn(
        { err, scope: "config-self-heal" },
        "Boot-time config self-heal did not run (non-fatal)",
      );
    }

    // #2021 (residual of #1986 / #2015): the email-identity env vars removed in
    // #1986 (EMAIL_FROM_NAME / SUPPORT_EMAIL / CONTACT_EMAIL /
    // NEXT_PUBLIC_CONTACT_EMAIL) are no longer read. If a deployment still sets
    // one, warn ONCE at boot that its value is ignored and email identity is
    // admin-managed (Admin → Email Messages). Best-effort: its own try/catch,
    // greppable scope, and it can never block or fail startup.
    try {
      const { getIgnoredEmailEnvWarning } = await import("./lib/ignored-email-env");
      const ignoredEmailEnv = getIgnoredEmailEnvWarning(process.env);
      if (ignoredEmailEnv) {
        const { default: logger } = await import("./lib/logger");
        logger.warn(
          { scope: "ignored-email-env", vars: ignoredEmailEnv.vars },
          ignoredEmailEnv.message,
        );
      }
    } catch {
      // Ignore — a boot-time advisory warning must never block startup.
    }

    // #1988 (C9): boot-time config-bundle auto-import (ADR-003, DR / clone).
    // Runs AFTER the self-heal. When CONFIG_BUNDLE_IMPORT_PATH names a readable
    // bundle AND the database is empty of non-seed configuration (the six
    // "no operator footprint" signals — see bootstrap-import.ts), it applies
    // the bundle non-interactively through the same validated import pipeline
    // the admin route uses (untrusted-input validation, allowlist, DMMF
    // type-checks, atomic upsert-only transaction, audit). It fails CLOSED — a
    // non-empty target, a malformed/oversized bundle, or any I/O/apply failure
    // refuses and writes nothing; the emptiness probe is re-run inside the
    // apply advisory lock, so on a multi-replica boot exactly one replica
    // applies and the others log a calm INFO refusal. Best-effort:
    // `runConfigBootstrapImport` never throws, and this outer try/catch
    // additionally guards the dynamic imports so a bootstrap bundle can never
    // block or fail startup. A successful apply re-warms the identity/email
    // caches primed earlier this boot so the imported values take effect
    // immediately.
    try {
      const { prisma } = await import("./lib/prisma");
      const { runConfigBootstrapImport } = await import(
        "./lib/config-transfer/bootstrap-import"
      );
      const bootstrap = await runConfigBootstrapImport({ db: prisma });
      if (bootstrap.outcome === "applied") {
        try {
          const { primeEmailPalette } = await import("./lib/email-theme");
          const { primeClubIdentitySync } = await import(
            "./lib/club-identity-settings"
          );
          await primeEmailPalette();
          await primeClubIdentitySync();
        } catch {
          // Non-fatal: both caches self-warm on first use.
        }
      }
    } catch (err) {
      const { default: logger } = await import("./lib/logger");
      logger.warn(
        { err, scope: "config-bootstrap-import" },
        "Boot-time config bundle auto-import did not run (non-fatal)",
      );
    }

    // ENV-SAFETY 1 (#3034, epic #2986): say at boot what this installation IS,
    // whenever that is not the ordinary answer — UNKNOWN at error level because
    // it is a fault, and a confirmed COPY at info level because it is not (the
    // else-branch below carries the measurement behind that choice). From this
    // release on, an UNKNOWN role fails closed — member email and Xero writes are
    // held back — and an operator who upgraded without setting
    // APP_ENVIRONMENT_ROLE needs to learn that from the log they are already
    // watching, not from a member asking why they stopped getting confirmations.
    //
    // IT LIVES IN THIS BLOCK, NOT AT THE END OF `register()`, and that is
    // load-bearing rather than tidy. The second `NEXT_RUNTIME === "nodejs"` block
    // below `return`s early when CRON_ENABLED is false — which is exactly what
    // app_blue and app_green set — so the end of this function is never reached on
    // the containers that serve traffic. Here it runs on every Node boot,
    // alongside the palette prime and the config self-heal.
    //
    // THE SENTENCE COMES FROM THE RESOLVER, not from here, and that is the whole
    // of this block's care (#3034 review). UNKNOWN has THREE causes and only two
    // of them are "the variable is not set": the third is a perfectly valid
    // `production` declaration whose safer override could not be READ, which is
    // what happens when somebody starts the app before running
    // `prisma migrate deploy` — the table does not exist, the read throws, and the
    // resolver correctly answers UNKNOWN. A fixed sentence naming
    // APP_ENVIRONMENT_ROLE would then send that operator to fix a variable that
    // is already right, and never mention the repair that works. `resolution.notes`
    // exists precisely so each case explains itself, so the notes ARE the message.
    //
    // Best-effort, in its own try/catch, and it can never block or fail startup:
    // a configuration advisory that stops the site coming up would be a worse
    // fault than the one it reports. The structured fields carry the two source
    // KINDS and nothing else — never `declaration.raw`, which is operator text,
    // and nothing from the database.
    try {
      const { resolveEnvironmentRole } = await import("./lib/environment-role");
      const resolution = await resolveEnvironmentRole();
      if (resolution.role === "UNKNOWN") {
        const { default: logger } = await import("./lib/logger");
        logger.error(
          {
            scope: "environment-role",
            declaration: resolution.declaration.kind,
            override: resolution.databaseOverride.kind,
          },
          `This installation's environment role is UNKNOWN, so anything whose safety depends on knowing whether these are the club's real members — sending email to members, writing to the club's Xero organisation — is held back until it is resolved. ${resolution.notes.join(" ")} See docs/guides/environment-role.md.`,
        );
      } else if (resolution.role === "NON_PRODUCTION") {
        /*
          A CONFIRMED COPY SAYS SO TOO, once, at boot.

          This is the one hole the deploy cannot close. The production deploy
          refuses a `.env` that says non-production and re-reads each container's
          own declaration before the cutover — but a site brought up by hand with
          `docker compose up` runs none of that, comes up as a copy, and holds back
          mail its members are waiting for. Nothing about the DATA can tell that
          case from a legitimate copy: a copy is restored FROM production, so it
          contains exactly the same real members. What can tell them apart is
          somebody reading this line and knowing it is wrong — which is why it
          names the source that decided it, so they know whether to look at the
          `.env` or at /admin/environment rather than guessing between two
          settings whose names differ by one word.

          INFO, NOT WARN, AND THAT WAS MEASURED RATHER THAN PREFERRED. It is not
          a fault — a copy declaring itself a copy is the system working — so
          `warn` would be the wrong volume on its own. It is also the wrong LEVEL
          for a concrete reason: `measurement/current-main-refresh/run-log-noise.sh`
          (MC-09) fails any warning-or-error signature that repeats three times
          across the producer logs, and eight of its eleven producers
          `--force-recreate app` inside their own `docker logs --since` window. So
          one line per boot is one line per producer. Measured by running
          `bin/analyse-log-noise.mjs` over eleven producer logs each holding this
          exact line: at level 40 it reports `count: 11` and THROWS
          `sustained/fatal log noise detected`; at level 30 it passes with zero
          classified lines. The analyser also text-classifies any line containing
          "error", "failed", "warning" or "exception" regardless of level, so the
          sentence below deliberately says "held back" and not "failed".

          Same best-effort try/catch as the UNKNOWN branch above, and the same
          rule about the structured fields: the two source KINDS and the decision,
          never `declaration.raw`, which is operator text.
        */
        const { default: logger } = await import("./lib/logger");
        logger.info(
          {
            scope: "environment-role",
            role: resolution.role,
            decidedBy: resolution.decidedBy,
            declaration: resolution.declaration.kind,
            override: resolution.databaseOverride.kind,
          },
          `This installation is running as a COPY: its environment role is NON_PRODUCTION, decided by ${
            resolution.decidedBy === "database-safer-override"
              ? "the safer override in this database, which an administrator switched on — it can be switched off again at /admin/environment"
              : "this deployment's own APP_ENVIRONMENT_ROLE=non-production setting"
          }. Application email to members and writes to the club's real Xero organisation are held back on a copy rather than sent. If this IS the club's live site then that answer is wrong: ${
            resolution.decidedBy === "database-safer-override"
              ? "switch the safer override off at /admin/environment"
              : "set APP_ENVIRONMENT_ROLE=production in this deployment's environment and restart"
          }. See docs/guides/environment-role.md.`,
        );
      }
    } catch {
      // Ignore — a boot-time advisory must never block startup. The setup
      // checklist and /admin/environment report the same state on demand.
    }
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }

  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { default: logger } = await import("./lib/logger");
    const cronEnabled = (process.env.CRON_ENABLED ?? "true").toLowerCase() === "true";

    if (!cronEnabled) {
      logger.info(
        { cronEnabled: process.env.CRON_ENABLED ?? "true" },
        "Cron scheduling disabled for this app instance"
      );
      return;
    }

    const cron = await import("node-cron");
    const Sentry = await import("@sentry/nextjs");
    const { prisma } = await import("./lib/prisma");
    const { deleteDraftBookingDependents } = await import("./lib/draft-booking-cleanup");
    const { isXeroDailyMembershipRefreshEnabled } = await import("./lib/xero-feature-flags");
    const { isEffectiveModuleEnabled } = await import("./lib/admin-modules");
    const { reportCronError } = await import("./lib/observability-bridge");
    const optionalCron = getOptionalCronRegistrationState();

    // Verify Prisma client is ready before starting cron jobs
    try {
      await prisma.$queryRawUnsafe("SELECT 1");
      logger.info("Prisma client verified — database connection OK");
    } catch (err) {
      logger.error({ err }, "Prisma client startup check failed — cron jobs may be unreliable");
      Sentry.captureException(err);
    }

    // Overlap guards: prevent concurrent execution of the same cron job
    let isGeneralCronRunning = false;
    let isXeroCronRunning = false;
    let isXeroBackfillCronRunning = false;
    let isXeroLinkCleanupCronRunning = false;
    let isXeroReportCronRunning = false;
    let isXeroReplayCronRunning = false;
    let isXeroInboundCronRunning = false;
    let isXeroCreditSyncCronRunning = false;
    let isPaymentRecoveryCronRunning = false;
    let isWaitlistCronRunning = false;

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

    // OBS-03: General booking and public-request cron cycle (every 3 hours)
    cron.default.schedule("0 */3 * * *", async () => {
      if (isGeneralCronRunning) {
        logger.info({ job: "general-cron" }, "Already running, skipping");
        return;
      }
      isGeneralCronRunning = true;
      logger.info(
        { job: "general-cron" },
        "Running booking and public-request cron cycle"
      );

      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "confirm-pending-bookings", status: "in_progress" },
        sentryCronMonitorConfig("0 */3 * * *", { checkinMargin: 10, maxRuntime: 30 })
      );

      try {
        const { runGeneralCronCycle } = await import(
          "./lib/general-cron-runner"
        );
        const result = await runGeneralCronCycle();
        logger.info(
          {
            job: "general-cron",
            confirmed: result.confirmPending?.confirmedBookingIds.length ?? 0,
            bumped: result.confirmPending?.bumpedBookingIds.length ?? 0,
            // #1993 Part A: split children auto-cancelled at end of check-in day.
            cancelled: result.confirmPending?.cancelledBookingIds.length ?? 0,
            failed: result.confirmPending?.failedBookingIds.length ?? 0,
            preArrivalSent:
              result.preArrivalReminders?.sentBookingIds.length ?? 0,
            quotesReminded:
              result.quoteExpiryReminders?.remindedCount ?? 0,
          },
          "Booking and public-request cron cycle complete"
        );
        Sentry.captureCheckIn({ checkInId, monitorSlug: "confirm-pending-bookings", status: "ok" });
      } catch (err) {
        // Each failed task already bridged to Sentry per-job inside the general
        // cron runner (reportCronError), so the cycle-level catch only logs the
        // aggregate + marks the monitor check-in to avoid a double-send.
        logger.error({ err, job: "general-cron" }, "Error in booking and public-request cron cycle");
        Sentry.captureCheckIn({ checkInId, monitorSlug: "confirm-pending-bookings", status: "error" });
      } finally {
        isGeneralCronRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

    logger.info(
      { job: "general-cron" },
      "Scheduled booking and public-request cron cycle (every 3 hours)"
    );

    cron.default.schedule("*/15 * * * *", async () => {
      if (isPaymentRecoveryCronRunning) {
        logger.info({ job: "payment-recovery" }, "Already running, skipping");
        return;
      }
      isPaymentRecoveryCronRunning = true;
      const startedAt = new Date();

      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "payment-recovery", status: "in_progress" },
        sentryCronMonitorConfig("*/15 * * * *", { checkinMargin: 5, maxRuntime: 10 })
      );

      try {
        const { processPaymentRecoveryOperations } = await import(
          "./lib/payment-recovery"
        );
        const result = await processPaymentRecoveryOperations();
        logger.info({ job: "payment-recovery", ...result }, "Payment recovery cron complete");
        await recordCronRun("payment-recovery", startedAt, "SUCCESS", { ...result });
        Sentry.captureCheckIn({ checkInId, monitorSlug: "payment-recovery", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "payment-recovery", err, message: "Error in payment recovery cron" });
        await recordCronRun("payment-recovery", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "payment-recovery", status: "error" });
      } finally {
        isPaymentRecoveryCronRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

    logger.info({ job: "payment-recovery" }, "Scheduled payment recovery (every 15 minutes)");

    if (optionalCron.xeroIntegration) {
      // OBS-03: Cron job 2 - Xero membership refresh safety net (daily at 2 AM)
      if (isXeroDailyMembershipRefreshEnabled()) {
        cron.default.schedule("0 2 * * *", async () => {
          if (isXeroCronRunning) {
            logger.info({ job: "xero-membership-refresh" }, "Already running, skipping");
            return;
          }
          isXeroCronRunning = true;
          logger.info(
            { job: "xero-membership-refresh" },
            "Running daily Xero membership safety-net refresh"
          );

          const checkInId = Sentry.captureCheckIn(
            { monitorSlug: "xero-membership-refresh", status: "in_progress" },
            sentryCronMonitorConfig("0 2 * * *", { checkinMargin: 10, maxRuntime: 60 })
          );

          try {
            const { runXeroCronTasks } = await import(
              "./lib/xero-cron-runner"
            );
            const result = await runXeroCronTasks("memberships");
            logger.info(
              { job: "xero-membership-refresh", result: result.membershipRefresh },
              "Xero membership safety-net refresh complete"
            );
            Sentry.captureCheckIn({ checkInId, monitorSlug: "xero-membership-refresh", status: "ok" });
          } catch (err) {
            reportCronError({
              tag: "xero-membership-refresh",
              err,
              message: "Error running Xero membership safety-net refresh",
            });
            Sentry.captureCheckIn({ checkInId, monitorSlug: "xero-membership-refresh", status: "error" });
          } finally {
            isXeroCronRunning = false;
          }
        }, { timezone: CRON_TIMEZONE });

        logger.info(
          { job: "xero-membership-refresh" },
          "Scheduled Xero membership safety-net refresh (daily at 2 AM NZST)"
        );
      } else {
        logger.info(
          { job: "xero-membership-refresh" },
          "Xero membership refresh disabled by XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH"
        );
      }

      // Historical Xero link backfill (daily at 2:20 AM NZST)
      cron.default.schedule("20 2 * * *", async () => {
        if (isXeroBackfillCronRunning) {
          logger.info({ job: "xero-link-backfill" }, "Already running, skipping");
          return;
        }
        isXeroBackfillCronRunning = true;
        logger.info({ job: "xero-link-backfill" }, "Backfilling canonical Xero links into the ledger");

        const checkInId = Sentry.captureCheckIn(
          { monitorSlug: "xero-link-backfill", status: "in_progress" },
          sentryCronMonitorConfig("20 2 * * *", { checkinMargin: 10, maxRuntime: 30 })
        );

        try {
          const { runXeroCronTasks } = await import(
            "./lib/xero-cron-runner"
          );
          const result = await runXeroCronTasks("backfill", {
            includeLinkCleanupForBackfill: false,
          });
          logger.info(
            { job: "xero-link-backfill", result: result.linkBackfill },
            "Xero link backfill complete"
          );
          Sentry.captureCheckIn({ checkInId, monitorSlug: "xero-link-backfill", status: "ok" });
        } catch (err) {
          reportCronError({ tag: "xero-link-backfill", err, message: "Error backfilling historical Xero links" });
          Sentry.captureCheckIn({ checkInId, monitorSlug: "xero-link-backfill", status: "error" });
        } finally {
          isXeroBackfillCronRunning = false;
        }
      }, { timezone: CRON_TIMEZONE });

      logger.info({ job: "xero-link-backfill" }, "Scheduled Xero link backfill (daily at 2:20 AM NZST)");

      // Stale canonical Xero link cleanup (daily at 2:25 AM NZST)
      cron.default.schedule("25 2 * * *", async () => {
        if (isXeroLinkCleanupCronRunning) {
          logger.info({ job: "xero-link-cleanup" }, "Already running, skipping");
          return;
        }
        isXeroLinkCleanupCronRunning = true;
        logger.info({ job: "xero-link-cleanup" }, "Cleaning stale canonical Xero links");

        const checkInId = Sentry.captureCheckIn(
          { monitorSlug: "xero-link-cleanup", status: "in_progress" },
          sentryCronMonitorConfig("25 2 * * *", { checkinMargin: 10, maxRuntime: 30 })
        );

        try {
          const { runXeroCronTasks } = await import(
            "./lib/xero-cron-runner"
          );
          const result = await runXeroCronTasks("link-cleanup");
          logger.info(
            { job: "xero-link-cleanup", result: result.linkCleanup },
            "Xero stale link cleanup complete"
          );
          Sentry.captureCheckIn({ checkInId, monitorSlug: "xero-link-cleanup", status: "ok" });
        } catch (err) {
          reportCronError({ tag: "xero-link-cleanup", err, message: "Error cleaning stale Xero links" });
          Sentry.captureCheckIn({ checkInId, monitorSlug: "xero-link-cleanup", status: "error" });
        } finally {
          isXeroLinkCleanupCronRunning = false;
        }
      }, { timezone: CRON_TIMEZONE });

      logger.info({ job: "xero-link-cleanup" }, "Scheduled Xero stale link cleanup (daily at 2:25 AM NZST)");

      // Nightly Xero reconciliation report (daily at 2:35 AM NZST)
      cron.default.schedule("35 2 * * *", async () => {
        if (isXeroReportCronRunning) {
          logger.info({ job: "xero-reconciliation-report" }, "Already running, skipping");
          return;
        }
        isXeroReportCronRunning = true;
        logger.info({ job: "xero-reconciliation-report" }, "Building nightly Xero reconciliation report");

        const checkInId = Sentry.captureCheckIn(
          { monitorSlug: "xero-reconciliation-report", status: "in_progress" },
          sentryCronMonitorConfig("35 2 * * *", { checkinMargin: 10, maxRuntime: 30 })
        );

        try {
          const { runXeroCronTasks } = await import(
            "./lib/xero-cron-runner"
          );
          const result = await runXeroCronTasks("report");
          logger.info(
            { job: "xero-reconciliation-report", result: result.reconciliationReport },
            "Xero reconciliation report complete"
          );
          Sentry.captureCheckIn({ checkInId, monitorSlug: "xero-reconciliation-report", status: "ok" });
        } catch (err) {
          reportCronError({ tag: "xero-reconciliation-report", err, message: "Error building Xero reconciliation report" });
          Sentry.captureCheckIn({ checkInId, monitorSlug: "xero-reconciliation-report", status: "error" });
        } finally {
          isXeroReportCronRunning = false;
        }
      }, { timezone: CRON_TIMEZONE });

      logger.info(
        { job: "xero-reconciliation-report" },
        "Scheduled Xero reconciliation report (daily at 2:35 AM NZST)"
      );

      // #2501: Xero credit-sync checker (daily at 2:45 AM NZST). Reconciles
      // BookingApp's stamped applied credit against Xero's live invoice
      // allocations and warns admins on drift. Read-only, fail-safe, and
      // internally throttled to ~daily, so a mid-cycle overlap simply skips.
      cron.default.schedule("45 2 * * *", async () => {
        if (isXeroCreditSyncCronRunning) {
          logger.info({ job: "xero-credit-sync-check" }, "Already running, skipping");
          return;
        }
        isXeroCreditSyncCronRunning = true;
        logger.info({ job: "xero-credit-sync-check" }, "Reconciling BookingApp credit against Xero allocations");

        const checkInId = Sentry.captureCheckIn(
          { monitorSlug: "xero-credit-sync-check", status: "in_progress" },
          sentryCronMonitorConfig("45 2 * * *", { checkinMargin: 10, maxRuntime: 30 })
        );

        try {
          const { runXeroCronTasks } = await import(
            "./lib/xero-cron-runner"
          );
          const result = await runXeroCronTasks("credit-sync");
          logger.info(
            { job: "xero-credit-sync-check", result: result.creditSyncCheck },
            "Xero credit-sync check complete"
          );
          Sentry.captureCheckIn({ checkInId, monitorSlug: "xero-credit-sync-check", status: "ok" });
        } catch (err) {
          reportCronError({ tag: "xero-credit-sync-check", err, message: "Error reconciling Xero credit sync" });
          Sentry.captureCheckIn({ checkInId, monitorSlug: "xero-credit-sync-check", status: "error" });
        } finally {
          isXeroCreditSyncCronRunning = false;
        }
      }, { timezone: CRON_TIMEZONE });

      logger.info(
        { job: "xero-credit-sync-check" },
        "Scheduled Xero credit-sync check (daily at 2:45 AM NZST)"
      );

      // Xero outbox and replay workers (every 15 minutes)
      cron.default.schedule("*/15 * * * *", async () => {
        if (isXeroReplayCronRunning) {
          logger.info({ job: "xero-operation-replay" }, "Already running, skipping");
          return;
        }
        isXeroReplayCronRunning = true;
        logger.info(
          { job: "xero-operation-replay" },
          "Processing queued Xero outbox operations and retries"
        );

        const checkInId = Sentry.captureCheckIn(
          { monitorSlug: "xero-operation-replay", status: "in_progress" },
          sentryCronMonitorConfig("*/15 * * * *", { checkinMargin: 10, maxRuntime: 30 })
        );

        try {
          const { runXeroCronTaskList } = await import(
            "./lib/xero-cron-runner"
          );
          const result = await runXeroCronTaskList(["outbox", "retries"], {
            taskLabel: "xero-queue",
          });
          logger.info(
            {
              job: "xero-operation-replay",
              queuedOutboxOperations: result.queuedOutboxOperations,
              queuedRetries: result.queuedRetries,
            },
            "Queued Xero outbox and retry processing complete"
          );
          Sentry.captureCheckIn({ checkInId, monitorSlug: "xero-operation-replay", status: "ok" });
        } catch (err) {
          reportCronError({ tag: "xero-operation-replay", err, message: "Error processing queued Xero work" });
          Sentry.captureCheckIn({ checkInId, monitorSlug: "xero-operation-replay", status: "error" });
        } finally {
          isXeroReplayCronRunning = false;
        }
      }, { timezone: CRON_TIMEZONE });

      logger.info(
        { job: "xero-operation-replay" },
        "Scheduled queued Xero outbox and retry processing (every 15 minutes)"
      );

      // Xero inbound webhook reconciliation safety net (every 15 minutes)
      cron.default.schedule("*/15 * * * *", async () => {
        if (isXeroInboundCronRunning) {
          logger.info({ job: "xero-inbound-reconcile" }, "Already running, skipping");
          return;
        }
        isXeroInboundCronRunning = true;
        logger.info(
          { job: "xero-inbound-reconcile" },
          "Running Xero inbound reconciliation cycle"
        );

        const checkInId = Sentry.captureCheckIn(
          { monitorSlug: "xero-inbound-reconcile", status: "in_progress" },
          sentryCronMonitorConfig("*/15 * * * *", { checkinMargin: 10, maxRuntime: 30 })
        );

        try {
          const { runXeroCronTasks } = await import(
            "./lib/xero-cron-runner"
          );
          const result = await runXeroCronTasks("inbound");
          logger.info(
            { job: "xero-inbound-reconcile", result: result.inboundReconciliation },
            "Xero inbound reconciliation cycle complete"
          );
          Sentry.captureCheckIn({ checkInId, monitorSlug: "xero-inbound-reconcile", status: "ok" });
        } catch (err) {
          reportCronError({ tag: "xero-inbound-reconcile", err, message: "Error processing stored Xero inbound events" });
          Sentry.captureCheckIn({ checkInId, monitorSlug: "xero-inbound-reconcile", status: "error" });
        } finally {
          isXeroInboundCronRunning = false;
        }
      }, { timezone: CRON_TIMEZONE });

      logger.info(
        { job: "xero-inbound-reconcile" },
        "Scheduled stored Xero inbound reconciliation (every 15 minutes)"
      );
    }

    if (optionalCron.financeDailySync) {
      const {
        FINANCE_SYNC_CRON_JOB_NAME,
        FINANCE_SYNC_CRON_SCHEDULE,
        FINANCE_SYNC_CRON_TIMEZONE,
      } = await import(
        "./lib/finance-sync-cron-config"
      );

      cron.default.schedule(
        FINANCE_SYNC_CRON_SCHEDULE,
        async () => {
          const { runDailyFinanceSyncCron } = await import(
            "./lib/finance-sync-cron"
          );
          await runDailyFinanceSyncCron({
            logger,
            isModuleEnabled: () => isEffectiveModuleEnabled("financeDashboard"),
          });
        },
        { timezone: FINANCE_SYNC_CRON_TIMEZONE }
      );

      logger.info(
        {
          job: FINANCE_SYNC_CRON_JOB_NAME,
          schedule: FINANCE_SYNC_CRON_SCHEDULE,
          timezone: FINANCE_SYNC_CRON_TIMEZONE,
        },
        "Scheduled daily finance sync"
      );
    } else {
      logger.info(
        { moduleKey: "financeDashboard", job: "finance-sync" },
        "Finance sync cron registration skipped because the module is off"
      );
    }

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
        sentryCronMonitorConfig(backupSchedule, { checkinMargin: 10, maxRuntime: 30 })
      );

      try {
        const { buildBackupCronOutcome, applyLegacyBackupEnvGate } =
          await import("./lib/backup");
        const { runManagedBackup } = await import("./lib/backup-run");
        const { detectLegacyProviderEnv } = await import("./lib/xero-config");
        const { BACKUP_PROVIDER } = await import("./lib/backup-config");
        // Claim through the DB-level cross-process lock the /admin/backups
        // run-now action also honours: if another container already holds an
        // active run, skip rather than start a second overlapping pg_dump.
        const managed = await runManagedBackup({ trigger: "scheduled" });
        if (!managed.claimed || !managed.result) {
          logger.info(
            { job: "backup" },
            "Another process is already running a backup; skipping"
          );
          await recordCronRun("backup", startedAt, "SKIPPED", {
            reason: "another process is already running a backup",
          });
          Sentry.captureCheckIn({ checkInId, monitorSlug: "database-backup", status: "ok" });
          return;
        }
        const result = managed.result;
        // A live install that still carries the legacy BACKUP_* env vars but has
        // not migrated config into the DB store would otherwise record a green
        // SKIPPED and stop backing up unnoticed (#2095 MAJOR-1). Upgrade that
        // specific state to a loud FAILURE so the monitor alerts.
        const legacyBackupEnvPresent = detectLegacyProviderEnv().some(
          (finding) => finding.provider === BACKUP_PROVIDER,
        );
        const outcome = applyLegacyBackupEnvGate(
          buildBackupCronOutcome(result),
          { legacyEnvPresent: legacyBackupEnvPresent },
        );

        if (outcome.status === "SUCCESS") {
          logger.info(
            { job: "backup", ...outcome.resultSummary },
            "Database backup complete"
          );
          await recordCronRun("backup", startedAt, "SUCCESS", outcome.resultSummary);
          Sentry.captureCheckIn({ checkInId, monitorSlug: "database-backup", status: "ok" });
        } else if (outcome.status === "SKIPPED") {
          logger.info(
            { job: "backup", ...outcome.resultSummary },
            "Database backup skipped"
          );
          await recordCronRun("backup", startedAt, "SKIPPED", outcome.resultSummary);
          Sentry.captureCheckIn({ checkInId, monitorSlug: "database-backup", status: "ok" });
        } else {
          logger.error(
            { job: "backup", error: outcome.error, ...outcome.resultSummary },
            "Database backup failed"
          );
          await recordCronRun(
            "backup",
            startedAt,
            "FAILURE",
            outcome.resultSummary,
            outcome.error
          );
          Sentry.captureCheckIn({ checkInId, monitorSlug: "database-backup", status: "error" });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "backup", err, message: "Error running database backup" });
        await recordCronRun("backup", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "database-backup", status: "error" });
      } finally {
        isBackupRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

    logger.info({ job: "backup", schedule: backupSchedule }, "Scheduled database backup");

    // Data pruning cron (daily at 3:30 AM NZST — staggered from backup at 3:00 AM)
    let isPruningRunning = false;
    cron.default.schedule("30 3 * * *", async () => {
      if (isPruningRunning) {
        logger.info({ job: "data-pruning" }, "Already running, skipping");
        return;
      }
      isPruningRunning = true;
      const startedAt = new Date();
      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "data-pruning", status: "in_progress" },
        sentryCronMonitorConfig("30 3 * * *", { checkinMargin: 10, maxRuntime: 60 })
      );
      try {
        const { pruneCronRuns } = await import("./lib/cron-job-run");
        const { pruneBackupRuns } = await import("./lib/backup-run");
        const { pruneWebhookLogs } = await import("./lib/webhook-log");
        const { runAuditLogRetentionJob } = await import("./lib/audit-retention");
        const { expireStalePartnerInviteTokens } = await import(
          "./lib/partner-invite-token"
        );
        // F27 (#1888): these cleanups are independent. Isolate each so an early
        // failure (e.g. an unreachable audit-archive DB) cannot starve the
        // privacy-driven token sweeps that follow. Every step runs regardless;
        // any step failure surfaces as an aggregate FAILURE run + Sentry error.
        const stepErrors: string[] = [];
        const runStep = async <T>(
          tag: string,
          fn: () => Promise<T>,
        ): Promise<T | undefined> => {
          try {
            return await fn();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            stepErrors.push(`${tag}: ${message}`);
            reportCronError({
              tag: `data-pruning:${tag}`,
              err,
              message: `Error in data pruning step ${tag}`,
            });
            return undefined;
          }
        };

        await runStep("prune-cron-runs", () => pruneCronRuns());
        await runStep("prune-backup-runs", () => pruneBackupRuns());
        await runStep("prune-webhook-logs", () => pruneWebhookLogs());
        const auditRetention = await runStep("audit-retention", () =>
          runAuditLogRetentionJob(),
        );
        await runStep("prune-email-verification-tokens", () =>
          prisma.emailVerificationToken.deleteMany({
            where: { expiresAt: { lt: new Date() } },
          }),
        );
        await runStep("prune-email-change-tokens", () =>
          prisma.emailChangeToken.deleteMany({
            where: { expiresAt: { lt: new Date() } },
          }),
        );
        await runStep("prune-guest-chore-tokens", () =>
          prisma.guestChoreToken.deleteMany({
            where: { expiresAt: { lt: new Date() } },
          }),
        );
        await runStep("prune-password-reset-tokens", () =>
          prisma.passwordResetToken.deleteMany({
            where: { expiresAt: { lt: new Date() } },
          }),
        );
        // Magic-link tokens (#2034): prune expired OR already-used rows. Used
        // rows are single-use and inert, so they can be swept immediately
        // alongside the expired ones.
        await runStep("prune-magic-link-tokens", () =>
          prisma.magicLinkToken.deleteMany({
            where: { OR: [{ expiresAt: { lt: new Date() } }, { used: true }] },
          }),
        );
        // Expired partner-invite tokens (#1682): idempotent hard-delete sweep.
        await runStep("expire-partner-invite-tokens", () =>
          expireStalePartnerInviteTokens(),
        );

        const auditRetentionSummary = auditRetention
          ? {
              anonymized: auditRetention.requestData.anonymized,
              archived: auditRetention.archive.archived,
              archiveSkipped: auditRetention.archive.skipped,
              mainPruned: auditRetention.mainPrune.deleted,
              archivePruned: auditRetention.archivePrune.pruned,
            }
          : null;

        if (stepErrors.length === 0) {
          logger.info({ job: "data-pruning" }, "Data pruning complete");
          await recordCronRun("data-pruning", startedAt, "SUCCESS", {
            auditRetention: auditRetentionSummary,
          });
          Sentry.captureCheckIn({ checkInId, monitorSlug: "data-pruning", status: "ok" });
        } else {
          const message = `data-pruning completed with ${stepErrors.length} failed step(s): ${stepErrors.join("; ")}`;
          logger.warn(
            { job: "data-pruning", stepErrors },
            "Data pruning completed with step failures",
          );
          await recordCronRun("data-pruning", startedAt, "FAILURE", {
            auditRetention: auditRetentionSummary,
          }, message);
          Sentry.captureCheckIn({ checkInId, monitorSlug: "data-pruning", status: "error" });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "data-pruning", err, message: "Error in data pruning" });
        await recordCronRun("data-pruning", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "data-pruning", status: "error" });
      } finally {
        isPruningRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

    logger.info({ job: "data-pruning" }, "Scheduled data pruning (daily at 3:30 AM NZST)");

    // Alpine Central Server Other Clubs sync (daily at 3:00 AM NZST). Bidirectional:
    // uploads local rows changed since the last upload watermark, then downloads the
    // centrally-distributed rows changed since the last cursor. Both directions are
    // incremental, so a quiet day makes at most one cheap request each way.
    //
    // Registration is UNCONDITIONAL and the opt-in / connection state is checked at
    // run time, so enabling Other Clubs sync (Admin → Alpine Central Server) takes
    // effect on the next tick without a restart. With sync off or the server not
    // configured the job reports SKIPPED, keeping the background-jobs health view
    // honest rather than showing a stale "last ran never".
    let isAlpineServerSyncRunning = false;
    cron.default.schedule("0 3 * * *", async () => {
      if (isAlpineServerSyncRunning) {
        logger.info({ job: "alpine-server-other-lodges-sync" }, "Already running, skipping");
        return;
      }
      isAlpineServerSyncRunning = true;
      const startedAt = new Date();
      logger.info(
        { job: "alpine-server-other-lodges-sync" },
        "Running Alpine Central Server Other Clubs sync",
      );

      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "alpine-server-other-lodges-sync", status: "in_progress" },
        sentryCronMonitorConfig("0 3 * * *", { checkinMargin: 10, maxRuntime: 15 })
      );

      try {
        const { syncOtherClubsWithServer } = await import(
          "./lib/cron-alpine-server-sync"
        );
        const result = await syncOtherClubsWithServer();
        logger.info(
          { job: "alpine-server-other-lodges-sync", result },
          "Alpine Central Server Other Clubs sync complete",
        );
        await recordCronRun(
          "alpine-server-other-lodges-sync",
          startedAt,
          result.status === "skipped" ? "SKIPPED" : "SUCCESS",
          { ...result },
        );
        Sentry.captureCheckIn({
          checkInId,
          monitorSlug: "alpine-server-other-lodges-sync",
          status: "ok",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({
          tag: "alpine-server-other-lodges-sync",
          err,
          message: "Error running Alpine Central Server Other Clubs sync",
        });
        await recordCronRun(
          "alpine-server-other-lodges-sync",
          startedAt,
          "FAILURE",
          undefined,
          message,
        );
        Sentry.captureCheckIn({
          checkInId,
          monitorSlug: "alpine-server-other-lodges-sync",
          status: "error",
        });
      } finally {
        isAlpineServerSyncRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

    logger.info(
      { job: "alpine-server-other-lodges-sync" },
      "Scheduled Alpine Central Server Other Clubs sync (daily at 3:00 AM NZST)",
    );

    // Draft expiry cleanup (daily at 4:00 AM NZST)
    let isDraftCleanupRunning = false;
    cron.default.schedule("0 4 * * *", async () => {
      if (isDraftCleanupRunning) {
        logger.info({ job: "draft-cleanup" }, "Already running, skipping");
        return;
      }
      isDraftCleanupRunning = true;
      const startedAt = new Date();
      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "draft-cleanup", status: "in_progress" },
        sentryCronMonitorConfig("0 4 * * *", { checkinMargin: 10, maxRuntime: 30 })
      );
      try {
        const { acquireLodgeCapacityLock } = await import("./lib/capacity");
        const { getDefaultLodgeId } = await import("./lib/lodges");
        const expiredBefore = new Date();
        const cleanup = await prisma.$transaction(async (tx) => {
          const expiredDrafts = await tx.booking.findMany({
            where: { status: "DRAFT", draftExpiresAt: { lt: expiredBefore } },
            select: {
              id: true,
              lodgeId: true,
              promoRedemption: { select: { id: true, promoCodeId: true } },
            },
          });

          // Expired drafts can span multiple lodges: lock every affected
          // lodge, in sorted order, before deleting anything so concurrent
          // cleanup/booking transactions can never deadlock against each other.
          const defaultLodgeId = await getDefaultLodgeId(tx);
          const affectedLodgeIds = Array.from(
            new Set(expiredDrafts.map((draft) => draft.lodgeId ?? defaultLodgeId))
          ).sort();
          for (const lodgeId of affectedLodgeIds) {
            await acquireLodgeCapacityLock(tx, lodgeId);
          }

          // Re-scan under the locks: a draft found by the unlocked scan above
          // may have been confirmed by a concurrent booking transaction before
          // the locks were acquired, and must not have its dependents deleted.
          const lockedExpiredDrafts = await tx.booking.findMany({
            where: { status: "DRAFT", draftExpiresAt: { lt: expiredBefore } },
            select: {
              id: true,
              lodgeId: true,
              promoRedemption: { select: { id: true, promoCodeId: true } },
            },
          });

          const dependents = await deleteDraftBookingDependents(tx, lockedExpiredDrafts);
          const deleted = dependents.bookingIds.length
            ? await tx.booking.deleteMany({
                where: {
                  id: { in: dependents.bookingIds },
                  status: "DRAFT",
                  draftExpiresAt: { lt: expiredBefore },
                },
              })
            : { count: 0 };

          return {
            deletedDrafts: deleted.count,
            promoRedemptions: dependents.promoRedemptions,
            changeRequests: dependents.changeRequests,
            modifications: dependents.modifications,
          };
        });

        logger.info({ job: "draft-cleanup", ...cleanup }, "Draft cleanup complete");
        await recordCronRun("draft-cleanup", startedAt, "SUCCESS", cleanup);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "draft-cleanup", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "draft-cleanup", err, message: "Failed to delete expired draft bookings" });
        await recordCronRun("draft-cleanup", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "draft-cleanup", status: "error" });
      } finally {
        isDraftCleanupRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

    logger.info({ job: "draft-cleanup" }, "Scheduled draft cleanup (daily at 4:00 AM NZST)");

    // Member-guest pending-hold expiry (#2307, epic #2305) — daily at 4:30 AM
    // NZST. Its own schedule rather than a slot in general-cron-runner's 3-hourly
    // cycle: a lapse should happen once, on a predictable day boundary, not eight
    // times a day. 4:30 is a free slot between draft-cleanup (4:00) and
    // credit-reconciliation (5:00).
    //
    // Registration is UNCONDITIONAL and the module is checked at run time, so an
    // admin switching the memberGuests module on or off takes effect on the next
    // tick without a restart. With the module off the job reports SKIPPED, which
    // is what keeps the background-jobs health view honest instead of showing a
    // stale "last ran never".
    let isMemberGuestConsentExpiryRunning = false;
    cron.default.schedule("30 4 * * *", async () => {
      if (isMemberGuestConsentExpiryRunning) {
        logger.info({ job: "member-guest-consent-expiry" }, "Already running, skipping");
        return;
      }
      isMemberGuestConsentExpiryRunning = true;
      const startedAt = new Date();
      logger.info(
        { job: "member-guest-consent-expiry" },
        "Expiring lapsed member-guest consent requests",
      );

      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "member-guest-consent-expiry", status: "in_progress" },
        sentryCronMonitorConfig("30 4 * * *", { checkinMargin: 10, maxRuntime: 15 })
      );

      try {
        const { runMemberGuestConsentExpiryCron, summariseMemberGuestConsentExpiryRun } =
          await import("./lib/cron-member-guest-consent-expiry");
        const { isEffectiveModuleEnabled } = await import("./lib/admin-modules");
        const result = await runMemberGuestConsentExpiryCron({
          isModuleEnabled: () => isEffectiveModuleEnabled("memberGuests"),
        });
        const resultSummary = summariseMemberGuestConsentExpiryRun(result);
        logger.info(
          { job: "member-guest-consent-expiry", resultSummary },
          "Member-guest consent expiry complete",
        );
        await recordCronRun(
          "member-guest-consent-expiry",
          startedAt,
          result.cronStatus,
          { resultSummary, ...result },
        );
        Sentry.captureCheckIn({
          checkInId,
          monitorSlug: "member-guest-consent-expiry",
          status: "ok",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({
          tag: "member-guest-consent-expiry",
          err,
          message: "Failed to expire lapsed member-guest consent requests",
        });
        await recordCronRun(
          "member-guest-consent-expiry",
          startedAt,
          "FAILURE",
          undefined,
          message,
        );
        Sentry.captureCheckIn({
          checkInId,
          monitorSlug: "member-guest-consent-expiry",
          status: "error",
        });
      } finally {
        isMemberGuestConsentExpiryRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

    logger.info(
      { job: "member-guest-consent-expiry" },
      "Scheduled member-guest consent expiry (daily at 4:30 AM NZST)",
    );

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
        sentryCronMonitorConfig("0 8 * * *", { checkinMargin: 10, maxRuntime: 10 })
      );

      try {
        const { checkPendingDeadlines } = await import("./lib/cron-pending-deadline-alerts");
        const result = await checkPendingDeadlines();
        logger.info({ job: "pending-deadline-alerts", ...result }, "Pending deadline alerts complete");
        await recordCronRun("pending-deadline-alerts", startedAt, "SUCCESS", result);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "pending-deadline-alerts", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "pending-deadline-alerts", err, message: "Error in pending deadline alerts" });
        await recordCronRun("pending-deadline-alerts", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "pending-deadline-alerts", status: "error" });
      } finally {
        isPendingDeadlineRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

    logger.info({ job: "pending-deadline-alerts" }, "Scheduled pending deadline alerts (daily at 8:00 AM NZST)");

    // Membership nomination reminders (daily at 8:15 AM NZST)
    let isNominationReminderRunning = false;
    cron.default.schedule("15 8 * * *", async () => {
      if (isNominationReminderRunning) {
        logger.info({ job: "nomination-reminders" }, "Already running, skipping");
        return;
      }
      isNominationReminderRunning = true;
      const startedAt = new Date();
      logger.info({ job: "nomination-reminders" }, "Checking expired nomination links for weekly reminders");

      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "nomination-reminders", status: "in_progress" },
        sentryCronMonitorConfig("15 8 * * *", { checkinMargin: 10, maxRuntime: 10 })
      );

      try {
        const { sendDueNominationReminders } = await import("./lib/nomination");
        const result = await sendDueNominationReminders();
        logger.info({ job: "nomination-reminders", ...result }, "Nomination reminders complete");
        await recordCronRun("nomination-reminders", startedAt, "SUCCESS", { ...result });
        Sentry.captureCheckIn({ checkInId, monitorSlug: "nomination-reminders", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "nomination-reminders", err, message: "Error in nomination reminders" });
        await recordCronRun("nomination-reminders", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "nomination-reminders", status: "error" });
      } finally {
        isNominationReminderRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

    logger.info({ job: "nomination-reminders" }, "Scheduled nomination reminders (daily at 8:15 AM NZST)");

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
        sentryCronMonitorConfig("0 9 * * *", { checkinMargin: 10, maxRuntime: 15 })
      );

      try {
        const { sendCheckinReminders } = await import("./lib/cron-checkin-reminders");
        const result = await sendCheckinReminders();
        logger.info({ job: "checkin-reminders", ...result }, "Check-in reminders complete");
        await recordCronRun("checkin-reminders", startedAt, "SUCCESS", result);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "checkin-reminders", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "checkin-reminders", err, message: "Error in check-in reminders" });
        await recordCronRun("checkin-reminders", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "checkin-reminders", status: "error" });
      } finally {
        isCheckinReminderRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

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
        sentryCronMonitorConfig("0 7 * * *", { checkinMargin: 10, maxRuntime: 10 })
      );

      try {
        const { checkCapacityWarnings } = await import("./lib/cron-capacity-warnings");
        const result = await checkCapacityWarnings();
        logger.info({ job: "capacity-warnings", ...result }, "Capacity warnings check complete");
        await recordCronRun("capacity-warnings", startedAt, "SUCCESS", result);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "capacity-warnings", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "capacity-warnings", err, message: "Error in capacity warnings" });
        await recordCronRun("capacity-warnings", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "capacity-warnings", status: "error" });
      } finally {
        isCapacityWarningRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

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
      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "admin-digest", status: "in_progress" },
        sentryCronMonitorConfig("30 7 * * *", { checkinMargin: 10, maxRuntime: 15 })
      );
      logger.info({ job: "admin-digest" }, "Sending admin daily digest");

      try {
        const { sendAdminDigest } = await import("./lib/cron-admin-digest");
        const result = await sendAdminDigest();
        logger.info({ job: "admin-digest", ...result }, "Admin daily digest complete");
        await recordCronRun("admin-digest", startedAt, "SUCCESS", result);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "admin-digest", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "admin-digest", err, message: "Error in admin daily digest" });
        await recordCronRun("admin-digest", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "admin-digest", status: "error" });
      } finally {
        isAdminDigestRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

    logger.info({ job: "admin-digest" }, "Scheduled admin daily digest (daily at 7:30 AM NZST)");

    // N-11: Cron job - Email retry (every 30 minutes)
    let isEmailRetryRunning = false;
    // Note: no timezone needed — runs every 30 min regardless of TZ
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
        sentryCronMonitorConfig("*/30 * * * *", { checkinMargin: 10, maxRuntime: 10 })
      );

      try {
        const { retryFailedEmails } = await import("./lib/cron-email-retry");
        const result = await retryFailedEmails();
        logger.info({ job: "email-retry", ...result }, "Email retry complete");
        await recordCronRun("email-retry", startedAt, "SUCCESS", result);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "email-retry", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "email-retry", err, message: "Error in email retry" });
        await recordCronRun("email-retry", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "email-retry", status: "error" });
      } finally {
        isEmailRetryRunning = false;
      }
    });

    logger.info({ job: "email-retry" }, "Scheduled email retry (every 30 minutes)");

    // Cron job - Complete bookings. Fires at 01:00 in APP_TIME_ZONE
    // (Pacific/Auckland) via the timezone option below; the exact fire time is
    // NOT load-bearing. Transitions PAID bookings to COMPLETED once their
    // check-out date has fully passed (#2029): the booking stays PAID/editable
    // through the whole NZ check-out day and completes on the first run where
    // checkOut < NZ today. Boundary correctness is timezone-independent —
    // getTodayDateOnly() always resolves the NZ calendar date regardless of when
    // the job runs (so re-running it, or a server-local clock, cannot shift it).
    let isCompleteBookingsRunning = false;
    cron.default.schedule("0 1 * * *", async () => {
      if (isCompleteBookingsRunning) {
        logger.info({ job: "complete-bookings" }, "Already running, skipping");
        return;
      }
      isCompleteBookingsRunning = true;
      const startedAt = new Date();
      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "complete-bookings", status: "in_progress" },
        sentryCronMonitorConfig("0 1 * * *", { checkinMargin: 10, maxRuntime: 30 })
      );
      logger.info({ job: "complete-bookings" }, "Transitioning PAID bookings to COMPLETED");

      try {
        const { completeBookings } = await import("./lib/cron-complete-bookings");
        const result = await completeBookings();
        logger.info({ job: "complete-bookings", ...result }, "Complete bookings cron finished");
        await recordCronRun("complete-bookings", startedAt, "SUCCESS", result as unknown as Record<string, unknown>);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "complete-bookings", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "complete-bookings", err, message: "Error in complete bookings cron" });
        await recordCronRun("complete-bookings", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "complete-bookings", status: "error" });
      } finally {
        isCompleteBookingsRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

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
      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "hut-leader-auto-assign", status: "in_progress" },
        sentryCronMonitorConfig("0 6 * * *", { checkinMargin: 10, maxRuntime: 15 })
      );
      logger.info({ job: "hut-leader-auto-assign" }, "Running hut leader auto-assign");

      try {
        const { autoAssignHutLeaders } = await import("./lib/cron-hut-leader-auto-assign");
        const result = await autoAssignHutLeaders();
        logger.info({ job: "hut-leader-auto-assign", ...result }, "Hut leader auto-assign complete");
        await recordCronRun("hut-leader-auto-assign", startedAt, "SUCCESS", result as unknown as Record<string, unknown>);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "hut-leader-auto-assign", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "hut-leader-auto-assign", err, message: "Error in hut leader auto-assign" });
        await recordCronRun("hut-leader-auto-assign", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "hut-leader-auto-assign", status: "error" });
      } finally {
        isHutLeaderAutoAssignRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

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
      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "age-up", status: "in_progress" },
        sentryCronMonitorConfig("30 6 * * *", { checkinMargin: 10, maxRuntime: 30 })
      );
      logger.info({ job: "age-up" }, "Checking for members who have turned 18");

      try {
        const { checkAgeUpMembers } = await import("./lib/cron-age-up");
        const result = await checkAgeUpMembers();
        logger.info({ job: "age-up", ...result }, "Age-up check complete");
        await recordCronRun("age-up", startedAt, "SUCCESS", result);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "age-up", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "age-up", err, message: "Error in age-up check" });
        await recordCronRun("age-up", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "age-up", status: "error" });
      } finally {
        isAgeUpRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

    logger.info({ job: "age-up" }, "Scheduled age-up check (daily at 6:30 AM NZST)");

    // Email-inheritance reconciliation (daily at 6:45 AM NZST) — #2716.
    // Scheduled immediately AFTER age-up deliberately: age-up is the other job
    // that moves members across the "can receive mail" line, and running the
    // sweep behind it means a member who aged up this morning has their
    // dependants' pointers settled within the same quarter hour even if the
    // age-up transaction's own re-resolution had failed.
    let isEmailInheritanceReconcileRunning = false;
    cron.default.schedule("45 6 * * *", async () => {
      if (isEmailInheritanceReconcileRunning) {
        logger.info({ job: "email-inheritance-reconcile" }, "Already running, skipping");
        return;
      }
      isEmailInheritanceReconcileRunning = true;
      const startedAt = new Date();
      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "email-inheritance-reconcile", status: "in_progress" },
        sentryCronMonitorConfig("45 6 * * *", { checkinMargin: 10, maxRuntime: 15 })
      );
      logger.info({ job: "email-inheritance-reconcile" }, "Reconciling email inheritance pointers");

      try {
        const { reconcileEmailInheritanceSweep } = await import("./lib/cron-email-inheritance-reconcile");
        const result = await reconcileEmailInheritanceSweep();
        await recordCronRun("email-inheritance-reconcile", startedAt, "SUCCESS", result);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "email-inheritance-reconcile", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "email-inheritance-reconcile", err, message: "Error in email inheritance reconciliation" });
        await recordCronRun("email-inheritance-reconcile", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "email-inheritance-reconcile", status: "error" });
      } finally {
        isEmailInheritanceReconcileRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

    logger.info({ job: "email-inheritance-reconcile" }, "Scheduled email inheritance reconciliation (daily at 6:45 AM NZST)");

    // ── Credit reconciliation (daily at 5:00 AM NZST) ──────────────────

    let isCreditReconRunning = false;

    cron.default.schedule("0 5 * * *", async () => {
      if (isCreditReconRunning) {
        logger.info({ job: "credit-reconciliation" }, "Already running, skipping");
        return;
      }
      isCreditReconRunning = true;
      const startedAt = new Date();
      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "credit-reconciliation", status: "in_progress" },
        sentryCronMonitorConfig("0 5 * * *", { checkinMargin: 10, maxRuntime: 30 })
      );
      logger.info({ job: "credit-reconciliation" }, "Starting credit balance reconciliation");

      try {
        const { reconcileCreditBalances } = await import("./lib/cron-credit-reconciliation");
        const result = await reconcileCreditBalances();
        logger.info({ job: "credit-reconciliation", ...result }, "Credit reconciliation complete");
        await recordCronRun("credit-reconciliation", startedAt, "SUCCESS", result);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "credit-reconciliation", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "credit-reconciliation", err, message: "Error in credit reconciliation" });
        await recordCronRun("credit-reconciliation", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "credit-reconciliation", status: "error" });
      } finally {
        isCreditReconRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

    logger.info({ job: "credit-reconciliation" }, "Scheduled credit reconciliation (daily at 5:00 AM NZST)");

    if (optionalCron.waitlistProcessor) {
    // Waitlist processor (every 30 minutes)
    cron.default.schedule("*/30 * * * *", async () => {
      if (isWaitlistCronRunning) {
        logger.info({ job: "waitlist-processor" }, "Already running, skipping");
        return;
      }
      isWaitlistCronRunning = true;
      const startedAt = new Date();
      logger.info({ job: "waitlist-processor" }, "Processing waitlist offers");

      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "waitlist-processor", status: "in_progress" },
        sentryCronMonitorConfig("*/30 * * * *")
      );

      try {
        const { runWaitlistProcessorCron } = await import("@/lib/cron-waitlist");
        const result = await runWaitlistProcessorCron({
          isModuleEnabled: () => isEffectiveModuleEnabled("waitlist"),
        });
        if (result.cronStatus === "SKIPPED") {
          logger.info({ job: "waitlist-processor", reason: result.reason }, "Waitlist processing skipped");
          Sentry.captureCheckIn({ checkInId, monitorSlug: "waitlist-processor", status: "ok" });
          await recordCronRun("waitlist-processor", startedAt, "SKIPPED", {
            reason: result.reason,
          });
        } else {
          logger.info({ job: "waitlist-processor", ...result }, "Waitlist processing complete");
          Sentry.captureCheckIn({ checkInId, monitorSlug: "waitlist-processor", status: "ok" });
          await recordCronRun("waitlist-processor", startedAt, "SUCCESS", result);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "waitlist-processor", err, message: "Error processing waitlist" });
        Sentry.captureCheckIn({ checkInId, monitorSlug: "waitlist-processor", status: "error" });
        await recordCronRun("waitlist-processor", startedAt, "FAILURE", undefined, message);
      } finally {
        isWaitlistCronRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

    logger.info({ job: "waitlist-processor" }, "Scheduled waitlist processor (every 30 minutes)");
    } else {
      logger.info(
        { moduleKey: "waitlist", job: "waitlist-processor" },
        "Waitlist cron registration skipped because the module is off"
      );
    }
  }
}

// OBS-02's `onRequestError` used to live here, where Next could never find it:
// the framework reads the hook off the `instrumentation` convention entry, not
// off a module that entry lazily imports. It now lives in `src/instrumentation.ts`
// (#2356 review), which is also where the edge runtime can reach it.
