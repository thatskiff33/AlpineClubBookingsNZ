/**
 * The email retry job, every 30 minutes (`instrumentation.node.ts`): first the
 * sweep of owed notices (#5433, `owed-notice/drain.ts`), then the replay of
 * `FAILED` email rows (`retryFailedEmails`).
 *
 * The sweep is capped (`EMAIL_RETRY_OWED_NOTICE_CAP`: 100 markers or two minutes)
 * and leaves the rest, still owed, for the next run, so a large backlog cannot
 * push this job past its half-hour slot and make the next run skip. It never
 * throws; should it ever, the error is logged and the replay runs anyway. The
 * replay throws on a mail configuration fault; the sweep's counts are then
 * attached to the error (`resultSummary`), so the failed run's record still
 * carries them. A notice the sweep sends while mail is misconfigured leaves a
 * `FAILED` row with its block reason, which the replay sends once the
 * configuration is corrected, so the marker is settled either way. The sweep
 * also runs from the confirm-pending job; two at once are safe, because every
 * marker is claimed before anything is sent.
 */
import { retryFailedEmails } from "@/lib/cron-email-retry";
import logger from "@/lib/logger";
import { drainOwedNotices, EMAIL_RETRY_OWED_NOTICE_CAP, type OwedNoticeSweepResult } from "@/lib/owed-notice/drain";

const JOB = "email-retry";

type SweepRecord = OwedNoticeSweepResult | { failed: string };

async function sweepOwedNotices(): Promise<SweepRecord> {
  try {
    return await drainOwedNotices(new Date(), { ...EMAIL_RETRY_OWED_NOTICE_CAP, job: JOB });
  } catch (err) {
    logger.error({ err, job: JOB }, "The owed-notice sweep threw; replaying failed emails anyway");
    return { failed: err instanceof Error ? err.message : String(err) };
  }
}

/** The replay's error, carrying the sweep's counts for the cron-run record. */
function withSweepRecord(err: unknown, owedNotices: SweepRecord): unknown {
  const resultSummary = { owedNotices };
  if (typeof err === "object" && err !== null) {
    Object.defineProperty(err, "resultSummary", { value: resultSummary, enumerable: false, configurable: true });
    return err;
  }
  return Object.assign(new Error(String(err)), { resultSummary });
}

export async function runEmailRetryJob() {
  const owedNotices = await sweepOwedNotices();
  try {
    return { ...(await retryFailedEmails()), owedNotices };
  } catch (err) {
    throw withSweepRecord(err, owedNotices);
  }
}
