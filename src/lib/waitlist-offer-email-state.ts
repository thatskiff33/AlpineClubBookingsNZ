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
 *   (`isReplayableFailedEmail`), or `QUEUED` past its first attempt and
 *   claimed within `replayInFlightWindowMs()` (the cron claims a row as
 *   `QUEUED` while it replays it; the window is the longest a replay can still
 *   be sending, from the transport timeouts). An older such row is left `QUEUED` by a
 *   replay whose `SENT` write failed after the provider accepted it, or that
 *   died mid-send, and nothing moves it on; it reads as `sent`, the same
 *   stated limit as a first attempt (round 3, item 1);
 * - `undeliverable`: `FAILED` with nothing left to replay it, or `BOUNCED`
 *   (including a bounce that arrived after `SENT`). It cannot be sent again
 *   under the same key;
 * - `not-sent`: no row.
 * Told means `sent` or `withheld`, and nothing else.
 *
 * An offer made by the release before #5433 has no keyed row: its email was
 * sent with no key, under a random id. Every reading here is by the keyed id,
 * so such an offer reads as `not-sent` with no owed notice, which the lapse
 * counts as told, exactly as that release did; and the retry job replays its
 * row while the booking is still offered (`waitlistOfferEmailStillWanted`).
 */
import { BookingStatus, EmailLogStatus, type Prisma } from "@prisma/client";

import { durableEmailLogId } from "@/lib/email/attempt-log";
import { retireReplayableEmailRow } from "@/lib/email/retire-replayable";
import { replayInFlightWindowMs } from "@/lib/email/replay-in-flight";
import { isReplayableFailedEmail } from "@/lib/email/retry-selection";
import { WAITLIST_OFFER_TEMPLATE_NAME } from "@/lib/email/waitlist-offer-template";
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

/**
 * The offer a keyed offer email row is for, read back from its id; null for a
 * row without this release's key (one the release before #5433 wrote, under a
 * random id). Exact: the id must be the one `offerEmailLogId` gives for that
 * time.
 */
export function offerTimeOfEmailLogId(bookingId: string, id: string): Date | null {
  const prefix = offerEmailLogId(bookingId, new Date(0)).slice(0, -1);
  // Exact by round trip: another prefix, or a tail that is not the canonical
  // number (empty, "soon", "0123", "1e3"), gives back a different id.
  const offeredAt = new Date(Number(id.slice(prefix.length)));
  return Number.isNaN(offeredAt.getTime()) || offerEmailLogId(bookingId, offeredAt) !== id ? null : offeredAt;
}

/**
 * How far before an offer's `waitlistOfferedAt` its email's row may be dated
 * and still be that offer's. The row's `createdAt` is the database's clock and
 * `waitlistOfferedAt` the application's, so this is the tolerance for the two
 * differing. One definition for the admin waitlist page, which ties the
 * latest row to the offer by it, and the retry job's check of an unkeyed row
 * (round 5, F2).
 */
export const WAITLIST_EMAIL_LOOKBACK_MS = 2 * 60 * 1000;

/** The earliest `createdAt` an offer email row may carry and still be the offer made at `offeredAt`. */
export function offerEmailLookupStart(offeredAt: Date): Date {
  return new Date(offeredAt.getTime() - WAITLIST_EMAIL_LOOKBACK_MS);
}

/**
 * THE one "is this still the same live offer?" rule (round 4, item 4): null
 * when the booking still holds the offer made at `offeredAt`; otherwise why it
 * moved on. Used by the owed notices' sweep and the retry job's check alike.
 */
export function waitlistOfferMovedOn(
  booking: { status: BookingStatus; waitlistOfferedAt: Date | null },
  offeredAt: Date,
): string | null {
  if (booking.status !== BookingStatus.WAITLIST_OFFERED) return `the booking is ${booking.status}`;
  if (booking.waitlistOfferedAt?.getTime() !== offeredAt.getTime()) return "the booking holds a different offer";
  return null;
}

/** What a row's status alone says; a `FAILED` row still needs its bodies to tell replayable from not. */
type StatusReading = "sent" | "withheld" | "replaying" | "failed" | "undeliverable";

/** The fields of an offer email's row the reading needs. */
export type OfferEmailRowStatus = { status: EmailLogStatus; attempts: number; lastAttemptAt: Date };

function readStatus({ status, attempts, lastAttemptAt }: OfferEmailRowStatus, now: Date): StatusReading {
  switch (status) {
    case EmailLogStatus.SENT:
      return "sent";
    case EmailLogStatus.QUEUED:
      return attempts > 1 && now.getTime() - lastAttemptAt.getTime() < replayInFlightWindowMs() ? "replaying" : "sent";
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
export function isOfferEmailRowTold(row: OfferEmailRowStatus, now: Date = new Date()): boolean {
  const reading = readStatus(row, now);
  return reading === "sent" || reading === "withheld";
}

/** A row's full state, or `not-sent` for none. */
export function offerEmailRowState(
  row: (OfferEmailRowStatus & { htmlBody: string | null; bookingRetryHtmlBody: string | null }) | null,
  now: Date = new Date(),
): OfferEmailState {
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

export const isToldOfferEmailState = (state: OfferEmailState) => state === "sent" || state === "withheld";

const OFFER_EMAIL_ROW_SELECT = { status: true, attempts: true, lastAttemptAt: true, htmlBody: true, bookingRetryHtmlBody: true } as const;

/** The offer email's state, read outside any transaction. */
export async function readOfferEmailState(bookingId: string, offeredAt: Date): Promise<OfferEmailState> {
  const row = await prisma.emailLog.findUnique({ where: { id: offerEmailLogId(bookingId, offeredAt) }, select: OFFER_EMAIL_ROW_SELECT });
  return offerEmailRowState(row);
}

const retiredMessage = (why: string) => `Not replayed: the waitlist offer is over (${why}) (#5433)`;

/**
 * Retire these offer emails' rows where the retry cron could still replay
 * them, through `db`: the lapse runs it inside its own transaction, before it
 * decides who was told, so the decision and the retirement agree (round 3,
 * item 2). Database-only; status-guarded on each row as read, so it and the
 * cron's claim cannot both win. Throws, as a write inside a transaction must.
 */
export async function retireReplayableOfferEmails(
  db: Pick<Prisma.TransactionClient, "emailLog">,
  offers: readonly { bookingId: string; offeredAt: Date | null }[],
  why: string,
): Promise<string[]> {
  const ids = offers.flatMap(({ bookingId, offeredAt }) => (offeredAt ? [offerEmailLogId(bookingId, offeredAt)] : []));
  if (ids.length === 0) return [];
  const rows = await db.emailLog.findMany({ where: { id: { in: ids } }, select: { id: true, ...OFFER_EMAIL_ROW_SELECT } });
  const retired: string[] = [];
  // One after another: inside a transaction they share its one connection.
  for (const row of rows.filter(isReplayableFailedEmail)) {
    const { count } = await retireReplayableEmailRow({ ...row, errorMessage: retiredMessage(why) }, db);
    if (count === 1) retired.push(row.id);
  }
  return retired;
}

/**
 * When the offer is over (the booking moved on): retire the offer email's row
 * if the retry cron could still replay it, so the member is not sent an offer
 * stating a dead deadline (round 2, item 4). Never throws.
 */
export async function retireOfferEmailIfReplayable(bookingId: string, offeredAt: Date, why: string): Promise<void> {
  try {
    const retired = await retireReplayableOfferEmails(prisma, [{ bookingId, offeredAt }], why);
    if (retired.length > 0) logger.info({ bookingId, emailLogId: retired[0] }, "Retired a replayable waitlist offer email: the offer is over");
  } catch (err) {
    logger.error({ err, bookingId, emailLogId: offerEmailLogId(bookingId, offeredAt) }, "Failed to retire a replayable waitlist offer email");
  }
}

/**
 * The email retry job's "still wanted?" check for `waitlist-offer`
 * (`email/retry-still-wanted.ts`, round 3, item 2): only while the booking
 * still holds the very offer the row is for (`waitlistOfferMovedOn`). Covers
 * every way an offer ends (confirm, decline, cancel, admin force-confirm or
 * return to the waitlist, the lapse, a re-offer) without a hook in each.
 *
 * A row without this release's key (round 4, item 1) was written by the
 * release before #5433 and has no offer time in its id. It is wanted while it
 * could be the current offer's: the booking is offered and the row is no
 * older than that offer, less the clock tolerance (`offerEmailLookupStart`,
 * the admin page's own rule; round 5, F2). So a live offer made before the
 * upgrade is not left untold, and an earlier offer's email is not replayed
 * for a later one. Otherwise it is retired. Throws on a failed read; the job
 * then leaves the row as found.
 */
export async function waitlistOfferEmailStillWanted(row: { id: string; bookingId: string | null; createdAt: Date }): Promise<true | string> {
  if (!row.bookingId) return "the email names no booking";
  const booking = await prisma.booking.findUnique({
    where: { id: row.bookingId },
    select: { status: true, waitlistOfferedAt: true },
  });
  if (!booking) return "the booking no longer exists";
  const offeredAt = offerTimeOfEmailLogId(row.bookingId, row.id);
  if (offeredAt === null) {
    if (booking.status !== BookingStatus.WAITLIST_OFFERED) return `the booking is ${booking.status}`;
    if (booking.waitlistOfferedAt && row.createdAt < offerEmailLookupStart(booking.waitlistOfferedAt)) {
      return "the email predates the booking's current offer";
    }
    return true;
  }
  return waitlistOfferMovedOn(booking, offeredAt) ?? true;
}
