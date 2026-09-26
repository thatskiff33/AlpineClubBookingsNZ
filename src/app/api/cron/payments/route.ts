import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { releaseExpiredInternetBankingHolds } from "@/lib/internet-banking-payment-cron";
import { processPaymentRecoveryOperations } from "@/lib/payment-recovery";
import { reapStaleWaitingPaymentXeroOutboxOperations } from "@/lib/xero-waiting-invoice-reaper";
import { requireCronSecret } from "@/lib/cron-auth";
import { recordCronJobRunSafe } from "@/lib/cron-job-run";
import logger from "@/lib/logger";

const cronTaskQuerySchema = z.object({
  task: z.enum(["recovery"]).optional().default("recovery"),
});

/**
 * POST /api/cron/payments?task=recovery
 * Secured manual trigger for durable Stripe payment recovery work.
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

  const startedAt = new Date();
  try {
    const recovery = await processPaymentRecoveryOperations();
    const internetBankingHoldRelease = await releaseExpiredInternetBankingHolds().catch(
      (err) => {
        logger.error(
          { err, task },
          "Failed to release expired Internet Banking payment holds",
        );
        return {
          scanned: 0,
          released: 0,
          skipped: 0,
          bookingIds: [] as string[],
          paymentIds: [] as string[],
        };
      },
    );
    const xeroOutboxReap = await reapStaleWaitingPaymentXeroOutboxOperations().catch(
      (err) => {
        logger.error(
          { err, task },
          "Failed to reap stale WAITING_PAYMENT Xero outbox operations",
        );
        return { reaped: 0, released: 0, queueOperationIds: [] as string[] };
      },
    );
    await recordCronJobRunSafe({
      jobName: "payment-recovery",
      startedAt,
      status: "SUCCESS",
      resultSummary: { ...recovery, internetBankingHoldRelease, xeroOutboxReap },
    });

    return NextResponse.json({
      message: "Payment recovery completed",
      task,
      recovery,
      internetBankingHoldRelease,
      xeroOutboxReap,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, task }, "Payment cron job error");
    await recordCronJobRunSafe({
      jobName: "payment-recovery",
      startedAt,
      status: "FAILURE",
      error: message,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
