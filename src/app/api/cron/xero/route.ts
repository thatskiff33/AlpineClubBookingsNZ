import { NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth";
import {
  isXeroCronTask,
  runXeroCronTasks,
  XeroCronRunnerError,
  type XeroCronTaskSelection,
} from "@/lib/xero-cron-runner";

/**
 * POST /api/cron/xero
 * Daily cron endpoint for refreshing membership statuses from Xero.
 * Secured with CRON_SECRET to prevent unauthorized access.
 */
export async function POST(request: NextRequest) {
  const unauthorized = requireCronSecret(request);
  if (unauthorized) return unauthorized;

  const taskParam = request.nextUrl.searchParams.get("task") ?? "memberships";
  if (taskParam !== "all" && !isXeroCronTask(taskParam)) {
    return NextResponse.json(
      { error: "Invalid task. Expected memberships, outbox, retries, inbound, backfill, link-cleanup, bank-refund-voids, report, credit-sync, or all." },
      { status: 400 }
    );
  }
  const task = taskParam as XeroCronTaskSelection;

  try {
    return NextResponse.json(await runXeroCronTasks(task));
  } catch (error) {
    if (error instanceof XeroCronRunnerError) {
      return NextResponse.json(
        {
          error: error.message,
          failedTasks: error.failures,
          ...error.payload,
        },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Cron job failed" },
      { status: 500 }
    );
  }
}
