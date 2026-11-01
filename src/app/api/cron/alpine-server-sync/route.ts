import { NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth";
import { alpineServerSyncRunStatus, syncOtherClubsWithServer } from "@/lib/cron-alpine-server-sync";
import { recordCronJobRunSafe } from "@/lib/cron-job-run";
import logger from "@/lib/logger";

const JOB_NAME = "alpine-server-other-lodges-sync";

/**
 * POST /api/cron/alpine-server-sync — daily (03:00) bidirectional Other Clubs
 * sync with the Alpine Central Server. Uploads local rows changed since the last
 * upload and downloads centrally-distributed rows changed since the last cursor.
 * Secured with the CRON_SECRET header.
 */
export async function POST(request: NextRequest) {
  const unauthorized = requireCronSecret(request);
  if (unauthorized) return unauthorized;

  const startedAt = new Date();
  try {
    const result = await syncOtherClubsWithServer();
    await recordCronJobRunSafe({
      jobName: JOB_NAME,
      startedAt,
      status: alpineServerSyncRunStatus(result),
      resultSummary: result,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, job: JOB_NAME }, "Alpine Central Server sync cron failed");
    await recordCronJobRunSafe({
      jobName: JOB_NAME,
      startedAt,
      status: "FAILURE",
      error: message,
    });
    return NextResponse.json(
      { error: "Alpine Central Server sync failed" },
      { status: 500 },
    );
  }
}
