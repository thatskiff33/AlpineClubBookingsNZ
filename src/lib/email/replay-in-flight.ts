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
 * With the default timeouts it is 20.5 minutes (30 seconds plus ten times 2
 * minutes); with every timeout at its 600-second maximum, 110 minutes.
 */
import { EMAIL_RETRY_BACKOFF_MS } from "@/lib/email/retry-selection";
import { type EnvMap, readTransportTimeouts } from "@/lib/email-transport-timeouts";

/**
 * Server replies one message can wait for once the setup deadline
 * (`connectionTimeout`: connect, greeting and the TLS handshake) is spent,
 * each bounded only by `socketTimeout` of inactivity. Traced in the installed
 * mail library (nodemailer's SMTP connection, round 5): on a STARTTLS
 * connection, EHLO, the STARTTLS reply, a second EHLO, AUTH, MAIL FROM,
 * RCPT TO, DATA and the end of the data (8), and two more when the server
 * offers AUTH LOGIN first (its username and password prompts): 10. Every
 * transport this product supports is SMTP (SES's SMTP endpoint, a relay, a
 * capture mailbox), so this is the bound for each of them.
 */
export const SMTP_REPLIES_PER_MESSAGE = 10;

/** The window, in milliseconds, read from `env` (the process's own by default). */
export function replayInFlightWindowMs(env: EnvMap = process.env): number {
  const { connectionTimeout, socketTimeout } = readTransportTimeouts(env, []);
  return Math.max(EMAIL_RETRY_BACKOFF_MS, connectionTimeout + SMTP_REPLIES_PER_MESSAGE * socketTimeout);
}
