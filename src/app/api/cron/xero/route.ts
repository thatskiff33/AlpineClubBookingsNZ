import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { refreshAllMembershipStatuses, isXeroConnected } from "@/lib/xero";
import { processQueuedXeroOperationRetries } from "@/lib/xero-operation-queue";
import logger from "@/lib/logger";

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
  if (!["memberships", "retries", "all"].includes(task)) {
    return NextResponse.json(
      { error: "Invalid task. Expected memberships, retries, or all." },
      { status: 400 }
    );
  }

  // Skip if Xero is not connected
  const connected = await isXeroConnected();
  if (!connected) {
    return NextResponse.json({
      message: "Xero not connected, skipping",
      task,
      membershipRefresh: null,
      queuedRetries: null,
    });
  }

  try {
    const membershipRefresh =
      task === "memberships" || task === "all"
        ? await refreshAllMembershipStatuses()
        : null;
    const queuedRetries =
      task === "retries" || task === "all"
        ? await processQueuedXeroOperationRetries()
        : null;

    return NextResponse.json({
      message:
        task === "all"
          ? "Xero cron tasks completed"
          : task === "retries"
            ? "Queued Xero retries processed"
            : "Membership status refresh completed",
      task,
      membershipRefresh,
      queuedRetries,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cron job failed";
    logger.error({ err: message, task }, "Xero cron job error");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
