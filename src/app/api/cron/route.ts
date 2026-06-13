import { NextRequest, NextResponse } from "next/server";
import { confirmPendingBookings } from "@/lib/cron-confirm-pending";
import { sendPreArrivalReminders } from "@/lib/cron-pre-arrival-reminders";
import { requireCronSecret } from "@/lib/cron-auth";
import { recordCronJobRunSafe } from "@/lib/cron-job-run";
import logger from "@/lib/logger";

/**
 * Manual trigger for the pending booking confirmation cron job.
 * Secured with CRON_SECRET header.
 */
export async function POST(request: NextRequest) {
  const unauthorized = requireCronSecret(request);
  if (unauthorized) return unauthorized;

  const confirmStartedAt = new Date();
  let confirmResult: Awaited<ReturnType<typeof confirmPendingBookings>>;
  try {
    confirmResult = await confirmPendingBookings();
    await recordCronJobRunSafe({
      jobName: "confirm-pending",
      startedAt: confirmStartedAt,
      status: "SUCCESS",
      resultSummary: confirmResult,
    });
  } catch (err) {
    logger.error({ err }, "Pending confirmation cron endpoint error");
    await recordCronJobRunSafe({
      jobName: "confirm-pending",
      startedAt: confirmStartedAt,
      status: "FAILURE",
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Failed to process pending bookings" },
      { status: 500 }
    );
  }

  const reminderStartedAt = new Date();
  let reminderResult: Awaited<ReturnType<typeof sendPreArrivalReminders>>;
  try {
    reminderResult = await sendPreArrivalReminders();
    await recordCronJobRunSafe({
      jobName: "pre-arrival-reminders",
      startedAt: reminderStartedAt,
      status: "SUCCESS",
      resultSummary: reminderResult,
    });
  } catch (err) {
    logger.error({ err }, "Pre-arrival reminder cron endpoint error");
    await recordCronJobRunSafe({
      jobName: "pre-arrival-reminders",
      startedAt: reminderStartedAt,
      status: "FAILURE",
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Failed to process pre-arrival reminders" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    success: true,
    confirmed: confirmResult.confirmedBookingIds,
    bumped: confirmResult.bumpedBookingIds,
    failed: confirmResult.failedBookingIds,
    preArrivalReminders: reminderResult,
  });
}
