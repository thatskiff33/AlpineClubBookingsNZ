import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { getDetailedHealthReport } from "@/lib/health-check";
import { prisma } from "@/lib/prisma";
import { getWebhookStats } from "@/lib/webhook-log";
import { getExhaustedEmailFailureReviewQueue } from "@/lib/email-failure-review";
import { getEmailDeliverabilityTelemetry } from "@/lib/email-suppression";
import { getAdminAlertDeliveryEscalations } from "@/lib/email-admin-alert-escalation";
import { getTokenEmailRecoveryQueue } from "@/lib/token-email-recovery";
import {
  buildCronHealthReport,
  getAdminCronJobDefinitions,
  groupCronRunsByJob,
} from "@/lib/admin-cron-health";
// Shared with the AI Diagnostics background-job evidence tool (#2375) so both
// surfaces classify job health from the same rows.
import { getCronRunsForAdminHealth } from "@/lib/admin-cron-runs";
import logger from "@/lib/logger";
import { getClubTimeZone } from "@/lib/club-time-zone-settings";
import { readCronRuntimeZone } from "@/lib/cron-runtime-zone";

interface RuntimeStatusPayload {
  cronEnabled: boolean;
  role: string;
  /**
   * The zone the cron leader registered its jobs against, when it is running a
   * release that reports one. Optional so an older leader mid-deploy is read as
   * "unknown" rather than rejected as a malformed payload (CT-5, #2869).
   */
  clubTimeZone?: string | null;
}

function getTrimmedEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function buildSentryDashboardInfo() {
  const dsn = getTrimmedEnv("SENTRY_DSN");
  const org = getTrimmedEnv("SENTRY_ORG");
  const project = getTrimmedEnv("SENTRY_PROJECT");
  const missingFields = [
    !dsn ? "SENTRY_DSN" : null,
    !org ? "SENTRY_ORG" : null,
    !project ? "SENTRY_PROJECT" : null,
  ].filter((field): field is string => Boolean(field));
  const sentryDashboardUrl =
    missingFields.length === 0 && org && project
      ? `https://sentry.io/organizations/${encodeURIComponent(org)}/issues/?project=${encodeURIComponent(project)}`
      : null;

  return {
    sentryConfigured: Boolean(dsn),
    sentryDashboardUrl,
    sentryConfigWarning:
      missingFields.length > 0
        ? `${missingFields.join(", ")} ${missingFields.length === 1 ? "is" : "are"} not configured; admin health cannot link directly to Sentry.`
        : null,
  };
}

function isWebRuntimeRole(role: string | undefined) {
  return role === "web-blue" || role === "web-green";
}

function getCronLeaderRuntimeStatusUrl() {
  return (
    getTrimmedEnv("CRON_LEADER_RUNTIME_STATUS_URL") ??
    "http://app:3000/api/deploy/runtime-status"
  );
}

function isRuntimeStatusPayload(value: unknown): value is RuntimeStatusPayload {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as RuntimeStatusPayload).cronEnabled !== "boolean" ||
    typeof (value as RuntimeStatusPayload).role !== "string"
  ) {
    return false;
  }
  // Optional on purpose: mid-deploy the leader may be running the previous
  // release, which reports no zone at all. Absent is "unknown"; present must
  // still be a string or null, so a malformed value cannot reach the report.
  const zone = (value as RuntimeStatusPayload).clubTimeZone;
  return zone === undefined || zone === null || typeof zone === "string";
}

async function getCronLeaderRuntimeStatus(): Promise<RuntimeStatusPayload | null> {
  const cronSecret = getTrimmedEnv("CRON_SECRET");
  if (!cronSecret) {
    return null;
  }

  try {
    const response = await fetch(getCronLeaderRuntimeStatusUrl(), {
      cache: "no-store",
      headers: {
        "x-cron-secret": cronSecret,
      },
    });

    if (!response.ok) {
      logger.warn(
        { status: response.status },
        "Unable to read cron leader runtime status"
      );
      return null;
    }

    const payload: unknown = await response.json();
    if (!isRuntimeStatusPayload(payload)) {
      logger.warn("Cron leader runtime status response had an unexpected shape");
      return null;
    }

    return payload;
  } catch (err) {
    logger.warn({ err }, "Unable to read cron leader runtime status");
    return null;
  }
}

function getCronJobDefinitionsForHealthReport(
  clubTimeZone: string,
  cronLeaderRuntimeStatus: RuntimeStatusPayload | null,
) {
  if (!cronLeaderRuntimeStatus) {
    return getAdminCronJobDefinitions(clubTimeZone);
  }

  return getAdminCronJobDefinitions(clubTimeZone, {
    ...process.env,
    APP_RUNTIME_ROLE: cronLeaderRuntimeStatus.role,
    CRON_ENABLED: cronLeaderRuntimeStatus.cronEnabled ? "true" : "false",
  });
}

/**
 * GET /api/admin/health
 * Returns system health data for the admin dashboard including:
 * - Health check results (from /api/health)
 * - Recent cron job runs
 * - Webhook stats (24h)
 * - System info (version, Node version, uptime, memory)
 */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  try {
    const { report: healthResponse } = await getDetailedHealthReport();
    /*
      TWO ZONES, AND REPORTING THE WRONG ONE IS THE DEFECT (CT-5, #2869 review).
      `getClubTimeZone()` is the club's persisted SETTING, which is what a job
      will run on after the next restart. `node-cron` pinned its zone when the
      jobs were registered, so between an admin changing the setting and that
      restart the two disagree — and this page was stating the new one across
      about forty "expected local time" sentences for jobs still firing on the
      old one.

      So the running zone is preferred where it can be established: from the
      cron leader's runtime status on a blue/green web slot, and from this
      process when it is the one that registered the jobs. `null` means neither
      could answer, and the report then says plainly that what it shows is the
      configured value.
    */
    const configuredClubTimeZone = await getClubTimeZone();
    const cronLeaderRuntimeStatus = isWebRuntimeRole(process.env.APP_RUNTIME_ROLE)
      ? await getCronLeaderRuntimeStatus()
      : null;
    const runningClubTimeZone =
      cronLeaderRuntimeStatus?.clubTimeZone ?? readCronRuntimeZone();
    const clubTimeZone = runningClubTimeZone ?? configuredClubTimeZone;
    const cronDefinitions = getCronJobDefinitionsForHealthReport(
      clubTimeZone,
      cronLeaderRuntimeStatus,
    );

    // Keep the global recent window for the UI, then add bounded per-job
    // history so high-frequency jobs cannot hide daily expected jobs.
    const cronRuns = await getCronRunsForAdminHealth(cronDefinitions);

    // Group cron runs by job name, take last 5 each
    const cronByJob = groupCronRunsByJob(cronRuns);
    const cronHealth = buildCronHealthReport({
      definitions: cronDefinitions,
      runs: cronRuns,
      clubTimeZone: configuredClubTimeZone,
      runningTimeZone: runningClubTimeZone,
    });

    // Webhook stats and SES suppression telemetry
    const [
      webhookStats,
      emailDeliverability,
      emailFailures,
      adminAlertDelivery,
      tokenEmailRecovery,
    ] = await Promise.all([
      getWebhookStats(24),
      getEmailDeliverabilityTelemetry(),
      getExhaustedEmailFailureReviewQueue(),
      getAdminAlertDeliveryEscalations(),
      getTokenEmailRecoveryQueue(),
    ]);

    // Recent webhook logs (last 10)
    const recentWebhooks = await prisma.webhookLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    // System info
    const memUsage = process.memoryUsage();
    const systemInfo = {
      version: process.env.npm_package_version || "0.1.0",
      nodeVersion: process.version,
      uptime: Math.floor(process.uptime()),
      memoryMb: {
        rss: Math.round(memUsage.rss / 1024 / 1024),
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
      },
      ...buildSentryDashboardInfo(),
    };

    return NextResponse.json({
      health: healthResponse,
      cronJobs: cronByJob,
      cronHealth,
      webhookStats,
      recentWebhooks,
      emailDeliverability,
      emailFailures,
      adminAlertDelivery,
      tokenEmailRecovery,
      systemInfo,
    });
  } catch (err) {
    logger.error({ err }, "Failed to fetch admin health data");
    return NextResponse.json(
      { error: "Failed to fetch health data" },
      { status: 500 }
    );
  }
}
