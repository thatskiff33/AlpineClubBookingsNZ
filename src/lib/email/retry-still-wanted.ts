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

/** A row the job is about to claim: its durable id and the booking it is about. */
export interface RetryCandidate {
  id: string;
  bookingId: string | null;
}

/** `true` to send; otherwise why the email is no longer wanted. May throw; the job then leaves the row as found. */
export type EmailStillWantedCheck = (row: RetryCandidate) => Promise<true | string>;

// A Map, not an object literal: a template name such as "constructor" must find nothing.
const STILL_WANTED_CHECKS: ReadonlyMap<string, () => Promise<EmailStillWantedCheck>> = new Map<string, () => Promise<EmailStillWantedCheck>>([
  ["waitlist-offer", async () => (await import("@/lib/waitlist-offer-email-state")).waitlistOfferEmailStillWanted],
]);

/** The templates that register a check. */
export const STILL_WANTED_TEMPLATE_NAMES: readonly string[] = [...STILL_WANTED_CHECKS.keys()];

/** Whether the job should still replay this row: `true` for a template with no check. */
export async function emailStillWanted(row: RetryCandidate & { templateName: string }): Promise<true | string> {
  const load = STILL_WANTED_CHECKS.get(row.templateName);
  if (!load) return true;
  return (await load())({ id: row.id, bookingId: row.bookingId });
}
