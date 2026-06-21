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
  type AdminCronJobDefinition,
  type AdminCronRun,
} from "@/lib/admin-cron-health";
import logger from "@/lib/logger";

const RECENT_CRON_RUN_LIMIT = 200;
const EXPECTED_CRON_RUN_HISTORY_LIMIT = 5;

interface RuntimeStatusPayload {
  cronEnabled: boolean;
  role: string;
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
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RuntimeStatusPayload).cronEnabled === "boolean" &&
    typeof (value as RuntimeStatusPayload).role === "string"
  );
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

async function getCronJobDefinitionsForHealthReport() {
  if (!isWebRuntimeRole(process.env.APP_RUNTIME_ROLE)) {
    return getAdminCronJobDefinitions();
  }

  const cronLeaderRuntimeStatus = await getCronLeaderRuntimeStatus();
  if (!cronLeaderRuntimeStatus) {
    return getAdminCronJobDefinitions();
  }

  return getAdminCronJobDefinitions({
    ...process.env,
    APP_RUNTIME_ROLE: cronLeaderRuntimeStatus.role,
    CRON_ENABLED: cronLeaderRuntimeStatus.cronEnabled ? "true" : "false",
  });
}

function getCronRunTime(run: AdminCronRun): number {
  return new Date(run.startedAt ?? run.createdAt ?? 0).getTime();
}

function dedupeCronRuns(runs: AdminCronRun[]): AdminCronRun[] {
  const byId = new Map<string, AdminCronRun>();
  for (const run of runs) {
    byId.set(run.id, run);
  }

  return [...byId.values()].sort((a, b) => getCronRunTime(b) - getCronRunTime(a));
}

async function getExpectedJobCronRuns(jobName: string): Promise<AdminCronRun[]> {
  const [recentRuns, latestSuccess, latestFailure] = await Promise.all([
    prisma.cronJobRun.findMany({
      where: { jobName },
      orderBy: { startedAt: "desc" },
      take: EXPECTED_CRON_RUN_HISTORY_LIMIT,
    }),
    prisma.cronJobRun.findMany({
      where: { jobName, status: "SUCCESS" },
      orderBy: { startedAt: "desc" },
      take: 1,
    }),
    prisma.cronJobRun.findMany({
      where: { jobName, status: "FAILURE" },
      orderBy: { startedAt: "desc" },
      take: 1,
    }),
  ]);

  return [...recentRuns, ...latestSuccess, ...latestFailure];
}

async function getCronRunsForAdminHealth(
  definitions: AdminCronJobDefinition[]
): Promise<AdminCronRun[]> {
  const expectedJobNames = [
    ...new Set(
      definitions
        .filter((definition) => definition.recordsRuns)
        .map((definition) => definition.jobName)
    ),
  ];

  const [recentRuns, expectedJobRuns] = await Promise.all([
    prisma.cronJobRun.findMany({
      orderBy: { startedAt: "desc" },
      take: RECENT_CRON_RUN_LIMIT,
    }),
    Promise.all(expectedJobNames.map(getExpectedJobCronRuns)),
  ]);

  return dedupeCronRuns([...recentRuns, ...expectedJobRuns.flat()]);
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
    const cronDefinitions = await getCronJobDefinitionsForHealthReport();

    // Keep the global recent window for the UI, then add bounded per-job
    // history so high-frequency jobs cannot hide daily expected jobs.
    const cronRuns = await getCronRunsForAdminHealth(cronDefinitions);

    // Group cron runs by job name, take last 5 each
    const cronByJob = groupCronRunsByJob(cronRuns);
    const cronHealth = buildCronHealthReport({
      definitions: cronDefinitions,
      runs: cronRuns,
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
