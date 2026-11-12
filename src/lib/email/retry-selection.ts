import type { Prisma } from "@prisma/client";

/**
 * The email retry ceiling: the cron replays a `FAILED` row only while
 * `attempts` is below it, and at it the row enters the operator's
 * email-failure review queue. The environment gate writes a body-less blocked
 * row straight to it, and a waitlist offer's email reads as exhausted at it.
 *
 * One number for all of them, so a row cannot leave the retry query without
 * entering the review queue (#3035). It lives here, beside the retry selection
 * and free of runtime imports, so the mailer can import it without depending on
 * the cron that depends on the mailer.
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
