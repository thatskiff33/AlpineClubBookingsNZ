/**
 * #5433 review B (round 2: items 2, 3, 4, 5): WHETHER A MEMBER WAS TOLD OF A
 * WAITLIST OFFER, read from the offer email's own `EmailLog` row. One
 * definition, used by the offer's owed notices (the sweep, the send, the
 * past-cut-off step, the officers' offer alert), the lapse
 * (`findNeverToldWaitlistOffers`) and the admin waitlist page
 * (`waitlist-offer-email-visibility.ts`).
 *
 * The offer email carries the event key `<bookingId>:<offeredAtMs>`, so an
 * offer made by this release has at most one row, at a known id.
 *
 * - `sent`: `SENT`, or `QUEUED` on its first attempt (the stated
 *   crash-during-the-provider-call limit: the provider may have it);
 * - `withheld`: held back by design, the booking's "No emails" or a
 *   non-production copy. Told, for every decision but the admin page, which
 *   still shows a live offer nobody was told about;
 * - `retrying`: the email retry cron holds it: `FAILED` and replayable
 *   (`isReplayableFailedEmail`), or `QUEUED` past its first attempt (the cron
 *   claims a row as `QUEUED` while it replays it);
 * - `undeliverable`: `FAILED` with nothing left to replay it, or `BOUNCED`
 *   (including a bounce that arrived after `SENT`). It cannot be sent again
 *   under the same key;
 * - `not-sent`: no row.
 * Told means `sent` or `withheld`, and nothing else.
 */
import { EmailLogStatus } from "@prisma/client";

import { durableEmailLogId } from "@/lib/email/attempt-log";
import { retireReplayableEmailRow } from "@/lib/email/retire-replayable";
import { isReplayableFailedEmail } from "@/lib/email/retry-selection";
import { WAITLIST_OFFER_TEMPLATE_NAME } from "@/lib/email/waitlist";
import logger from "@/lib/logger";
import { owedNoticeEventKey } from "@/lib/owed-notice/store";
import { prisma } from "@/lib/prisma";

export type OfferEmailState = "sent" | "withheld" | "retrying" | "undeliverable" | "not-sent";

/** The offer email's event key: one `EmailLog` row per offer, however often it is sent. */
export function waitlistOfferEmailKey(bookingId: string, offeredAt: Date): string {
  return owedNoticeEventKey(bookingId, offeredAt);
}

/** The offer email's durable `EmailLog` id. */
export function offerEmailLogId(bookingId: string, offeredAt: Date): string {
  return durableEmailLogId(WAITLIST_OFFER_TEMPLATE_NAME, waitlistOfferEmailKey(bookingId, offeredAt));
}

/** What a row's status alone says; a `FAILED` row still needs its bodies to tell replayable from not. */
type StatusReading = "sent" | "withheld" | "replaying" | "failed" | "undeliverable";

function readStatus(status: EmailLogStatus, attempts: number): StatusReading {
  switch (status) {
    case EmailLogStatus.SENT:
      return "sent";
    case EmailLogStatus.QUEUED:
      return attempts > 1 ? "replaying" : "sent";
    case EmailLogStatus.SKIPPED_NO_EMAILS:
    case EmailLogStatus.SKIPPED_NON_PRODUCTION:
      return "withheld";
    case EmailLogStatus.FAILED:
      return "failed";
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
export function isOfferEmailRowTold(row: { status: EmailLogStatus; attempts: number }): boolean {
  const reading = readStatus(row.status, row.attempts);
  return reading === "sent" || reading === "withheld";
}

/** A row's full state, or `not-sent` for none. */
export function offerEmailRowState(
  row: { status: EmailLogStatus; attempts: number; htmlBody: string | null; bookingRetryHtmlBody: string | null } | null,
): OfferEmailState {
  if (!row) return "not-sent";
  const reading = readStatus(row.status, row.attempts);
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

export const isToldOfferEmailState = (state: OfferEmailState) => state === "sent" || state === "withheld";

const OFFER_EMAIL_ROW_SELECT = { status: true, attempts: true, htmlBody: true, bookingRetryHtmlBody: true } as const;

/** The offer email's state, read outside any transaction. */
export async function readOfferEmailState(bookingId: string, offeredAt: Date): Promise<OfferEmailState> {
  const row = await prisma.emailLog.findUnique({ where: { id: offerEmailLogId(bookingId, offeredAt) }, select: OFFER_EMAIL_ROW_SELECT });
  return offerEmailRowState(row);
}

/**
 * When the offer is over (it lapsed, or the booking moved on): retire the
 * offer email's row if the retry cron could still replay it, so the member is
 * never sent an offer stating a dead deadline (round 2, item 4). Status-guarded
 * on the row as read, so it and the cron's claim cannot both win. Never throws.
 */
export async function retireOfferEmailIfReplayable(bookingId: string, offeredAt: Date, why: string): Promise<void> {
  const id = offerEmailLogId(bookingId, offeredAt);
  try {
    const row = await prisma.emailLog.findUnique({ where: { id }, select: OFFER_EMAIL_ROW_SELECT });
    if (!row || !isReplayableFailedEmail(row)) return;
    const retired = await retireReplayableEmailRow({ id, ...row, errorMessage: `Not replayed: the waitlist offer is over (${why}) (#5433)` });
    if (retired.count === 1) logger.info({ bookingId, emailLogId: id }, "Retired a replayable waitlist offer email: the offer is over");
  } catch (err) {
    logger.error({ err, bookingId, emailLogId: id }, "Failed to retire a replayable waitlist offer email");
  }
}
