import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireCronSecret } from "@/lib/cron-auth";
import {
  PaymentsCronCycleError,
  runPaymentsCronCycle,
} from "@/lib/payments-cron-runner";
import logger from "@/lib/logger";

const cronTaskQuerySchema = z.object({
  task: z.enum(["recovery"]).optional().default("recovery"),
});

/**
 * POST /api/cron/payments?task=recovery
 * Secured manual trigger for the 15-minute payments cycle: Stripe payment
 * recovery, expired Internet Banking hold release and the waiting-invoice
 * reaper. The cron leader runs the SAME cycle on its own schedule (#3663), so
 * this route is a manual/external trigger, not what keeps the jobs running.
 */
export async function POST(request: NextRequest) {
  const unauthorized = requireCronSecret(request);
  if (unauthorized) return unauthorized;

  const queryEntries = Array.from(request.nextUrl.searchParams.entries());
  const seenTaskKeys = queryEntries.filter(([key]) => key === "task").length;
  if (seenTaskKeys > 1) {
    return NextResponse.json(
      {
        error: "Invalid task parameter",
        details: { task: ["task may only be provided once"] },
      },
      { status: 400 }
    );
  }

  const parsedQuery = cronTaskQuerySchema.safeParse(
    Object.fromEntries(queryEntries)
  );
  if (!parsedQuery.success) {
    return NextResponse.json(
      {
        error: "Invalid task parameter",
        details: parsedQuery.error.flatten(),
      },
      { status: 400 }
    );
  }
  const { task } = parsedQuery.data;

  try {
    const result = await runPaymentsCronCycle();
    return NextResponse.json({
      message: "Payment recovery completed",
      task,
      ...result,
    });
  } catch (error) {
    if (error instanceof PaymentsCronCycleError) {
      // Every task still ran and recorded its own CronJobRun row; the failed
      // ones carry `null` in `result` rather than invented zero counts.
      logger.error({ err: error, task, failedJobs: error.failures }, "Payment cron job error");
      return NextResponse.json(
        {
          error: "One or more payment cron jobs failed",
          task,
          failedJobs: error.failures,
          result: error.result,
        },
        { status: 500 }
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, task }, "Payment cron job error");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
