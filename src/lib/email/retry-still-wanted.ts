/**
 * #5433 (round 3, item 2): "is this email still wanted?", asked by the email
 * retry job before it claims a row, for the templates that register an answer.
 *
 * A retained body is replayed as it was rendered. For most emails that is
 * right whenever it goes; for a few it stops being true once the thing it is
 * about has moved on (a waitlist offer that was confirmed, declined, cancelled
 * or lapsed states a deadline that no longer exists). Those templates register
 * a check here, keyed by template name, and the job retires an unwanted row
 * instead of sending it. Every other template has no entry and is untouched.
 *
 * The checks are imported lazily, so the retry job depends only on this module
 * and never on the domain code that answers (the waitlist, here).
 */

import { retireReplayableEmailRow } from "@/lib/email/retire-replayable";
import { WAITLIST_OFFER_TEMPLATE_NAME } from "@/lib/email/waitlist-offer-template";
import logger from "@/lib/logger";

/** A row the job is about to claim: its id, the booking it is about, and when it was written. */
export interface RetryCandidate {
  id: string;
  bookingId: string | null;
  createdAt: Date;
}

/** `true` to send; otherwise why the email is no longer wanted. May throw; the job then leaves the row as found. */
export type EmailStillWantedCheck = (row: RetryCandidate) => Promise<true | string>;

// A Map, not an object literal: a template name such as "constructor" must find nothing.
const STILL_WANTED_CHECKS: ReadonlyMap<string, () => Promise<EmailStillWantedCheck>> = new Map<string, () => Promise<EmailStillWantedCheck>>([
  [WAITLIST_OFFER_TEMPLATE_NAME, async () => (await import("@/lib/waitlist-offer-email-state")).waitlistOfferEmailStillWanted],
]);

/** The templates that register a check. */
export const STILL_WANTED_TEMPLATE_NAMES: readonly string[] = [...STILL_WANTED_CHECKS.keys()];

/** Whether the job should still replay this row: `true` for a template with no check. */
export async function emailStillWanted(row: RetryCandidate & { templateName: string }): Promise<true | string> {
  const load = STILL_WANTED_CHECKS.get(row.templateName);
  if (!load) return true;
  return (await load())({ id: row.id, bookingId: row.bookingId, createdAt: row.createdAt });
}

/**
 * The retry job's question, answered before it claims the row: replay it
 * (`true`), or not (`false`). A row no longer wanted is retired through the
 * job's own guarded retirement, so the job's claim and this cannot both win; a
 * check that cannot answer leaves the row as found for a later run. Never
 * throws.
 */
export async function replayStillWanted(row: RetryCandidate & {
  templateName: string;
  to: string;
  attempts: number;
  htmlBody: string | null;
  bookingRetryHtmlBody: string | null;
}): Promise<boolean> {
  let answer: true | string;
  try {
    answer = await emailStillWanted(row);
  } catch (err) {
    logger.error({ err, emailLogId: row.id }, "Skipped email retry: could not tell whether it is still wanted");
    return false;
  }
  if (answer === true) return true;
  const retired = await retireReplayableEmailRow({ ...row, errorMessage: `Not retried: no longer wanted (${answer}).` }).catch((err) => {
    logger.error({ err, emailLogId: row.id }, "Failed to retire an email that is no longer wanted");
    return { count: 0 };
  });
  if (retired.count === 1) logger.warn({ emailLogId: row.id, bookingId: row.bookingId, templateName: row.templateName, to: row.to }, "Retired an email that is no longer wanted");
  return false;
}
