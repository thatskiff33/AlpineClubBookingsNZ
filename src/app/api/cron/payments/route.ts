import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { processPaymentRecoveryOperations } from "@/lib/payment-recovery";
import { reapStaleWaitingPaymentXeroOutboxOperations } from "@/lib/xero-operation-outbox";
import logger from "@/lib/logger";

const cronTaskQuerySchema = z.object({
  task: z.enum(["recovery"]).optional().default("recovery"),
});

function isAuthorizedCronRequest(request: NextRequest) {
  const cronSecret = request.headers.get("x-cron-secret");
  const expected = process.env.CRON_SECRET;
  return !!(
    cronSecret &&
    expected &&
    cronSecret.length === expected.length &&
    timingSafeEqual(Buffer.from(cronSecret), Buffer.from(expected))
  );
}

async function recordCronRun({
  startedAt,
  status,
  resultSummary,
  error,
}: {
  startedAt: Date;
  status: "SUCCESS" | "FAILURE";
  resultSummary?: Record<string, unknown>;
  error?: string;
}) {
  const completedAt = new Date();
  try {
    await prisma.cronJobRun.create({
      data: {
        jobName: "payment-recovery",
        startedAt,
        completedAt,
        durationMs: completedAt.getTime() - startedAt.getTime(),
        status,
        resultSummary: resultSummary
          ? JSON.parse(JSON.stringify(resultSummary))
          : undefined,
        error,
      },
    });
  } catch (err) {
    logger.error({ err, job: "payment-recovery" }, "Failed to record payment recovery cron run");
  }
}

/**
 * POST /api/cron/payments?task=recovery
 * Secured manual trigger for durable Stripe payment recovery work.
 */
export async function POST(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

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

  const startedAt = new Date();
  try {
    const recovery = await processPaymentRecoveryOperations();
    const xeroOutboxReap = await reapStaleWaitingPaymentXeroOutboxOperations().catch(
      (err) => {
        logger.error(
          { err, task },
          "Failed to reap stale WAITING_PAYMENT Xero outbox operations",
        );
        return { reaped: 0, queueOperationIds: [] as string[] };
      },
    );
    await recordCronRun({
      startedAt,
      status: "SUCCESS",
      resultSummary: { ...recovery, xeroOutboxReap },
    });

    return NextResponse.json({
      message: "Payment recovery completed",
      task,
      recovery,
      xeroOutboxReap,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, task }, "Payment cron job error");
    await recordCronRun({
      startedAt,
      status: "FAILURE",
      error: message,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
