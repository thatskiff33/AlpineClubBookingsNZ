import type { Prisma } from "@prisma/client";

/**
 * The email retry cron replays a `FAILED` row only while it holds a body in one
 * of these columns (`retryFailedEmails`'s selection), and nothing it writes once
 * it has claimed a row drops that body.
 *
 * So among one attempt's rows, which all start at `attempts: 1`, a row past its
 * first attempt that still holds a body is one the cron claimed. A row written
 * straight to the retry ceiling WITHOUT a body - the environment gate's record
 * of a fault on a message that keeps none - is not one, and must not be read as
 * one (`caller-retried-alert.ts`, #4669).
 */
export const RETAINS_REPLAYABLE_EMAIL_BODY = {
  OR: [{ htmlBody: { not: null } }, { bookingRetryHtmlBody: { not: null } }],
} satisfies Prisma.EmailLogWhereInput;

/**
 * How long the email retry cron waits after a row's last attempt before it
 * selects the row again. The operator's "Try again" on an exhausted failure
 * (`requeueExhaustedEmailFailure`) dates the row back past it, so the next run
 * admits the row; both read this one value so they cannot drift apart.
 */
export const EMAIL_RETRY_BACKOFF_MS = 15 * 60 * 1000;
