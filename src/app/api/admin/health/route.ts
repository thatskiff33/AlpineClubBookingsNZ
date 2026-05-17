import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { getDetailedHealthReport } from "@/lib/health-check";
import { prisma } from "@/lib/prisma";
import { getWebhookStats } from "@/lib/webhook-log";
import { getExhaustedEmailFailureReviewQueue } from "@/lib/email-failure-review";
import { getEmailDeliverabilityTelemetry } from "@/lib/email-suppression";
import {
  buildCronHealthReport,
  getAdminCronJobDefinitions,
  groupCronRunsByJob,
} from "@/lib/admin-cron-health";
import logger from "@/lib/logger";

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

/**
 * GET /api/admin/health
 * Returns system health data for the admin dashboard including:
 * - Health check results (from /api/health)
 * - Recent cron job runs
 * - Webhook stats (24h)
 * - System info (version, Node version, uptime, memory)
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  try {
    const { report: healthResponse } = await getDetailedHealthReport();

    // Recent cron job runs. Fetch enough history to classify stale jobs even
    // when several high-frequency jobs have recent entries.
    const cronRuns = await prisma.cronJobRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 200,
    });

    // Group cron runs by job name, take last 5 each
    const cronByJob = groupCronRunsByJob(cronRuns);
    const cronHealth = buildCronHealthReport({
      definitions: await getCronJobDefinitionsForHealthReport(),
      runs: cronRuns,
    });

    // Webhook stats and SES suppression telemetry
    const [webhookStats, emailDeliverability, emailFailures] = await Promise.all([
      getWebhookStats(24),
      getEmailDeliverabilityTelemetry(),
      getExhaustedEmailFailureReviewQueue(),
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
