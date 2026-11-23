/**
 * The email retry job, every 30 minutes (`instrumentation.node.ts`): first the
 * sweep of owed notices (#5433, `owed-notice/drain.ts`), then the replay of
 * `FAILED` email rows (`retryFailedEmails`).
 *
 * The sweep goes first because it never throws, while the replay throws on a
 * mail configuration fault. A notice the sweep sends while mail is
 * misconfigured leaves a `FAILED` row with its block reason, which the replay
 * sends once the configuration is corrected, so the marker is settled either
 * way. The sweep also runs from the confirm-pending job; two at once are safe,
 * because every marker is claimed before anything is sent.
 */
import { retryFailedEmails } from "@/lib/cron-email-retry";
import { drainOwedNotices } from "@/lib/owed-notice/drain";

export async function runEmailRetryJob() {
  const owedNotices = await drainOwedNotices();
  return { ...(await retryFailedEmails()), owedNotices };
}
