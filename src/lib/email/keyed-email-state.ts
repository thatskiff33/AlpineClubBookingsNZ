/**
 * #5433: WHETHER A MEMBER WAS TOLD, read from a keyed email's own `EmailLog`
 * row. An owed notice sends with an event key, so its email has at most one
 * row, at a known id (`durableEmailLogId`), and that row's status is the
 * answer, never the fact that a send returned: the email core returns without
 * throwing for a suppressed address (`BOUNCED`), a fail-closed "No emails"
 * read or an environment fault (`FAILED`), and an empty or placeholder
 * address (no row at all).
 *
 * One rule for every template that asks it (`INV-SSOT-001`): the waitlist
 * offer (`waitlist-offer-email-state.ts`, which adds what only an offer has)
 * and the paid booking confirmation (`paid-booking-confirmation-notice.ts`).
 *
 * - `sent`: `SENT`, or `QUEUED` on its first attempt (the stated
 *   crash-during-the-provider-call limit: the provider may have it), or such a
 *   row the stranded-email sweep has since flagged `UNCONFIRMED` at the retry
 *   ceiling (#5298, `INV-INT-043`): it may still have been delivered, so it
 *   reads as it did while `QUEUED` until an officer's Try again requeues it;
 * - `withheld`: held back by design, the booking's "No emails" or a
 *   non-production copy. Told, for every decision but the admin waitlist page,
 *   which still shows a live offer nobody was told about;
 * - `retrying`: the email retry cron holds it: `FAILED` and replayable
 *   (`isReplayableFailedEmail`), or `QUEUED` past its first attempt and
 *   claimed within `replayInFlightWindowMs()` (the cron claims a row as
 *   `QUEUED` while it replays it; the window is the longest a replay can still
 *   be sending, from the transport timeouts). An older such row is left `QUEUED` by a
 *   replay whose `SENT` write failed after the provider accepted it, or that
 *   died mid-send, and nothing moves it on; it reads as `sent`, the same
 *   stated limit as a first attempt (round 3, item 1). A template whose body
 *   is never kept (`booking-confirmed`) is never replayed, so never `retrying`;
 * - `undeliverable`: `FAILED` with nothing left to replay it, or `BOUNCED`
 *   (including a bounce that arrived after `SENT`). It cannot be sent again
 *   under the same key;
 * - `not-sent`: no row.
 * Told means `sent` or `withheld`, and nothing else.
 */
import { EmailHandoverState, EmailLogStatus } from "@prisma/client";

import { replayInFlightWindowMs } from "@/lib/email/replay-in-flight";
import { EMAIL_RETRY_MAX_ATTEMPTS, isReplayableFailedEmail } from "@/lib/email/retry-selection";
import { prisma } from "@/lib/prisma";

export type KeyedEmailState = "sent" | "withheld" | "retrying" | "undeliverable" | "not-sent";

/** What a row's status alone says; a `FAILED` row still needs its bodies to tell replayable from not. */
type StatusReading = "sent" | "withheld" | "replaying" | "failed" | "undeliverable";

/** The fields of a keyed email's row the told rule needs. */
export type KeyedEmailRowStatus = {
  status: EmailLogStatus;
  attempts: number;
  lastAttemptAt: Date;
  handoverState?: EmailHandoverState | null;
};

function readStatus({ status, attempts, lastAttemptAt, handoverState }: KeyedEmailRowStatus, now: Date): StatusReading {
  switch (status) {
    case EmailLogStatus.SENT:
      return "sent";
    case EmailLogStatus.QUEUED:
      return attempts > 1 && now.getTime() - lastAttemptAt.getTime() < replayInFlightWindowMs() ? "replaying" : "sent";
    case EmailLogStatus.SKIPPED_NO_EMAILS:
    case EmailLogStatus.SKIPPED_NON_PRODUCTION:
      return "withheld";
    case EmailLogStatus.FAILED:
      return handoverState === EmailHandoverState.UNCONFIRMED && attempts >= EMAIL_RETRY_MAX_ATTEMPTS ? "sent" : "failed";
    case EmailLogStatus.BOUNCED:
      return "undeliverable";
    default: {
      // A status added later fails to compile here until it is classified.
      const unclassified: never = status;
      return unclassified;
    }
  }
}

/** Whether a row says the member was told: its status alone decides. */
export function isKeyedEmailRowTold(row: KeyedEmailRowStatus, now: Date = new Date()): boolean {
  const reading = readStatus(row, now);
  return reading === "sent" || reading === "withheld";
}

/** A row's full state, or `not-sent` for none. */
export function keyedEmailRowState(
  row: (KeyedEmailRowStatus & { htmlBody: string | null; bookingRetryHtmlBody: string | null }) | null,
  now: Date = new Date(),
): KeyedEmailState {
  if (!row) return "not-sent";
  const reading = readStatus(row, now);
  switch (reading) {
    case "sent":
    case "withheld":
    case "undeliverable":
      return reading;
    case "replaying":
      return "retrying";
    case "failed":
      return isReplayableFailedEmail(row) ? "retrying" : "undeliverable";
  }
}

export const isToldKeyedEmailState = (state: KeyedEmailState) => state === "sent" || state === "withheld";

/** The columns `keyedEmailRowState` reads. */
export const KEYED_EMAIL_ROW_SELECT = {
  status: true,
  attempts: true,
  lastAttemptAt: true,
  handoverState: true,
  htmlBody: true,
  bookingRetryHtmlBody: true,
} as const;

/** The state of the keyed email at `emailLogId`, read outside any transaction. */
export async function readKeyedEmailState(emailLogId: string): Promise<KeyedEmailState> {
  const row = await prisma.emailLog.findUnique({ where: { id: emailLogId }, select: KEYED_EMAIL_ROW_SELECT });
  return keyedEmailRowState(row);
}
