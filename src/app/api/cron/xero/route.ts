import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { refreshAllMembershipStatuses, isXeroConnected } from "@/lib/xero";
import { processQueuedXeroOperationRetries } from "@/lib/xero-operation-queue";
import { processStoredXeroInboundEvents } from "@/lib/xero-inbound-reconciliation";
import {
  backfillHistoricalXeroObjectLinks,
  sendXeroReconciliationReport,
} from "@/lib/xero-hardening";
import logger from "@/lib/logger";
import { isXeroDailyMembershipRefreshEnabled } from "@/lib/xero-feature-flags";

/**
 * POST /api/cron/xero
 * Daily cron endpoint for refreshing membership statuses from Xero.
 * Secured with CRON_SECRET to prevent unauthorized access.
 */
export async function POST(request: NextRequest) {
  const cronSecret = request.headers.get("x-cron-secret");
  const expected = process.env.CRON_SECRET;
  if (
    !cronSecret ||
    !expected ||
    cronSecret.length !== expected.length ||
    !timingSafeEqual(Buffer.from(cronSecret), Buffer.from(expected))
  ) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const task = request.nextUrl.searchParams.get("task") ?? "memberships";
  if (!["memberships", "retries", "inbound", "backfill", "report", "all"].includes(task)) {
    return NextResponse.json(
      { error: "Invalid task. Expected memberships, retries, inbound, backfill, report, or all." },
      { status: 400 }
    );
  }

  const connected = await isXeroConnected();

  try {
    const membershipRefresh =
      task === "memberships" || task === "all"
        ? !isXeroDailyMembershipRefreshEnabled()
          ? {
              skipped: true,
              reason:
                "Daily membership refresh disabled by XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH",
            }
          : connected
            ? await refreshAllMembershipStatuses()
            : { skipped: true, reason: "Xero not connected" }
        : null;
    const queuedRetries =
      task === "retries" || task === "all"
        ? connected
          ? await processQueuedXeroOperationRetries()
          : { skipped: true, reason: "Xero not connected" }
        : null;
    const inboundReconciliation =
      task === "inbound" || task === "all"
        ? connected
          ? await processStoredXeroInboundEvents()
          : { skipped: true, reason: "Xero not connected" }
        : null;
    const linkBackfill =
      task === "backfill" || task === "all"
        ? await backfillHistoricalXeroObjectLinks()
        : null;
    const reconciliationReport =
      task === "report" || task === "all"
        ? await sendXeroReconciliationReport()
        : null;

    return NextResponse.json({
      message:
        task === "all"
          ? "Xero cron tasks completed"
          : task === "report"
            ? "Xero reconciliation report completed"
            : task === "backfill"
              ? "Historical Xero link backfill completed"
            : task === "inbound"
              ? "Xero inbound reconciliation processed"
              : task === "retries"
                ? "Queued Xero retries processed"
                : "Membership status refresh completed",
      task,
      connected,
      membershipRefresh,
      queuedRetries,
      inboundReconciliation,
      linkBackfill,
      reconciliationReport,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cron job failed";
    logger.error({ err: message, task }, "Xero cron job error");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
