/**
 * #5433 review (round 2, item 5a): "the email retry cron can still replay this
 * row" is one rule in two forms over one set of constants: the filter the cron
 * selects with and the predicate a caller holding a row applies. Here the two
 * give the same answer on every shape of row that decides it.
 */
import { describe, expect, it } from "vitest";

import { EMAIL_RETRY_MAX_ATTEMPTS, isReplayableFailedEmail, REPLAYABLE_FAILED_EMAIL_WHERE } from "@/lib/email/retry-selection";

type Row = { status: string; attempts: number; htmlBody: string | null; bookingRetryHtmlBody: string | null };

/** The filter, applied to a row in memory, for the three fields it names. */
function filterMatches(row: Row): boolean {
  const where = REPLAYABLE_FAILED_EMAIL_WHERE;
  if (row.status !== where.status) return false;
  if (!(row.attempts < where.attempts.lt)) return false;
  return where.OR.some((arm) =>
    "htmlBody" in arm ? row.htmlBody !== null : row.bookingRetryHtmlBody !== null,
  );
}

const rows: [string, Row][] = [
  ["FAILED, first attempt, legacy body", { status: "FAILED", attempts: 1, htmlBody: "<p>x</p>", bookingRetryHtmlBody: null }],
  ["FAILED, booking retry body", { status: "FAILED", attempts: EMAIL_RETRY_MAX_ATTEMPTS - 1, htmlBody: null, bookingRetryHtmlBody: "<p>x</p>" }],
  ["FAILED at the ceiling", { status: "FAILED", attempts: EMAIL_RETRY_MAX_ATTEMPTS, htmlBody: "<p>x</p>", bookingRetryHtmlBody: null }],
  ["FAILED with no body", { status: "FAILED", attempts: 1, htmlBody: null, bookingRetryHtmlBody: null }],
  ["QUEUED", { status: "QUEUED", attempts: 1, htmlBody: "<p>x</p>", bookingRetryHtmlBody: null }],
  ["BOUNCED", { status: "BOUNCED", attempts: 1, htmlBody: "<p>x</p>", bookingRetryHtmlBody: null }],
  ["SENT", { status: "SENT", attempts: 1, htmlBody: "<p>x</p>", bookingRetryHtmlBody: null }],
];

describe("the replayable-row rule", () => {
  it.each(rows)("agrees in both forms for %s", (_case, row) => {
    expect(isReplayableFailedEmail(row)).toBe(filterMatches(row));
  });

  it("replays only a FAILED row below the ceiling that keeps a body", () => {
    expect(rows.filter(([, row]) => isReplayableFailedEmail(row)).map(([name]) => name)).toEqual([
      "FAILED, first attempt, legacy body",
      "FAILED, booking retry body",
    ]);
  });
});
