import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { getDetailedHealthReport } from "@/lib/health-check";
import { prisma } from "@/lib/prisma";
import { getWebhookStats } from "@/lib/webhook-log";
import { getEmailDeliverabilityTelemetry } from "@/lib/email-suppression";
import logger from "@/lib/logger";

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

    // Recent cron job runs (last 5 per job)
    const cronRuns = await prisma.cronJobRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 20,
    });

    // Group cron runs by job name, take last 5 each
    const cronByJob: Record<string, typeof cronRuns> = {};
    for (const run of cronRuns) {
      if (!cronByJob[run.jobName]) {
        cronByJob[run.jobName] = [];
      }
      if (cronByJob[run.jobName].length < 5) {
        cronByJob[run.jobName].push(run);
      }
    }

    // Webhook stats and SES suppression telemetry
    const [webhookStats, emailDeliverability] = await Promise.all([
      getWebhookStats(24),
      getEmailDeliverabilityTelemetry(),
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
      sentryConfigured: !!process.env.SENTRY_DSN,
      sentryDashboardUrl: process.env.SENTRY_DSN
        ? `https://sentry.io/organizations/${process.env.SENTRY_ORG || "your-org"}/issues/?project=${process.env.SENTRY_PROJECT || "your-project"}`
        : null,
    };

    return NextResponse.json({
      health: healthResponse,
      cronJobs: cronByJob,
      webhookStats,
      recentWebhooks,
      emailDeliverability,
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
