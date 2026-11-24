/**
 * #5433 (round 4, item 6): how long after the email retry job claims a row
 * (`QUEUED`, `lastAttemptAt` stamped) its replay may still be sending. Past
 * this a row left `QUEUED` is a replay that ended without its `SENT` write (the
 * write failed after the provider accepted it, or the process died), not one
 * in flight.
 *
 * An upper bound from the configured mail transport timeouts
 * (`email-transport-timeouts.ts`): the whole connection setup, plus one
 * inactivity timeout for each server reply one message waits for once
 * connected. It is generous on purpose: a stalled replay read as finished
 * would count as sent and settle the notice with no officer told if it then
 * failed. Never less than the job's own backoff, `EMAIL_RETRY_BACKOFF_MS`.
 * With the default timeouts that floor is the answer (15 minutes); with every
 * timeout at its 600-second maximum it is 70 minutes.
 */
import { EMAIL_RETRY_BACKOFF_MS } from "@/lib/email/retry-selection";
import { type EnvMap, readTransportTimeouts } from "@/lib/email-transport-timeouts";

/**
 * Server replies one message waits for after the connection is set up: EHLO,
 * AUTH, MAIL FROM, RCPT TO, DATA and the end of the data. Each may take up to
 * `socketTimeout` of inactivity.
 */
export const SMTP_REPLIES_PER_MESSAGE = 6;

/** The window, in milliseconds, read from `env` (the process's own by default). */
export function replayInFlightWindowMs(env: EnvMap = process.env): number {
  const { connectionTimeout, socketTimeout } = readTransportTimeouts(env, []);
  return Math.max(EMAIL_RETRY_BACKOFF_MS, connectionTimeout + SMTP_REPLIES_PER_MESSAGE * socketTimeout);
}
