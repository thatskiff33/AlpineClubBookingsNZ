import type { Prisma } from "@prisma/client";

/**
 * The email retry ceiling: the cron replays a `FAILED` row only while
 * `attempts` is below it, and at it the row enters the operator's
 * email-failure review queue. The environment gate writes a body-less blocked
 * row straight to it, a waitlist offer's email reads as exhausted at it, and the
 * waitlist page's "retrying (n/max)" label shows it to the officer, and the
operator's "Try again" (`requeueExhaustedEmailFailure`) hands a row back one
below it.
 *
 * One number for all of them, so a row cannot leave the retry query without
 * entering the review queue (#3035). It lives here, beside the retry selection
 * and free of runtime imports (a type-only Prisma import is erased), so the
 * mailer and a client component can import it without depending on the cron
 * that depends on the mailer.
 */
export const EMAIL_RETRY_MAX_ATTEMPTS = 3;

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
 * #5433 review (`INV-SSOT`): THE RULE for "the email retry cron can still
 * replay this row": `FAILED`, below the attempt ceiling, and a body kept to
 * replay. In two forms over one set of constants: the filter the cron selects
 * with (beside its backoff, which is when, not whether), and the predicate a
 * caller holding a row applies (the waitlist offer email's state, its admin
 * page). `retry-selection.test.ts` holds the two to the same answers.
 */
export const REPLAYABLE_FAILED_EMAIL_WHERE = {
  status: "FAILED",
  attempts: { lt: EMAIL_RETRY_MAX_ATTEMPTS },
  ...RETAINS_REPLAYABLE_EMAIL_BODY,
} satisfies Prisma.EmailLogWhereInput;

export function isReplayableFailedEmail(row: {
  status: string;
  attempts: number;
  htmlBody: string | null;
  bookingRetryHtmlBody: string | null;
}): boolean {
  return (
    row.status === "FAILED" &&
    row.attempts < EMAIL_RETRY_MAX_ATTEMPTS &&
    (row.htmlBody !== null || row.bookingRetryHtmlBody !== null)
  );
}

/**
 * How long the email retry cron waits after a row's last attempt before it
 * selects the row again. The operator's "Try again" on an exhausted failure
 * (`requeueExhaustedEmailFailure`) dates the row back past it, so the next run
 * admits the row; both read this one value so they cannot drift apart.
 */
export const EMAIL_RETRY_BACKOFF_MS = 15 * 60 * 1000;
