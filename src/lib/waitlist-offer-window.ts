/**
 * The waitlist offer's window: how long a member has to accept an offer, and
 * (#5433, owner decision D2, 23 Nov 2026) the window an offer gets when its
 * email is really sent by a later run instead of straight after the offer.
 * One definition for the offer pass (`waitlist.ts`), the restart
 * (`waitlist-offer-window-restart.ts`) and the offer notice's cut-off
 * (`waitlist-offer-notices.ts`), so they cannot drift (`INV-SSOT-001`).
 *
 * A leaf module: no database, no settings read. The club's timezone is read by
 * the caller, outside any transaction, and passed in.
 */
import { calendarDateOfDateOnlyInstant, startOfClubDay, type ClubTimeZone } from "@/lib/club-time";

/**
 * How long a waitlist notice's owed marker waits after its stamp before a
 * sweep takes it, so the attempt right after the change goes first. Also the
 * floor of a window worth telling a member about: a deadline closer than this
 * could pass before the email's row exists (#5433 review D).
 */
export const WAITLIST_NOTICE_SWEEP_AFTER_MS = 30 * 60 * 1000;

/** Hours a member has to accept a waitlist offer. */
export const WAITLIST_OFFER_HOURS = Number(process.env.WAITLIST_OFFER_HOURS) || 48;

const HOUR_MS = 60 * 60 * 1000;

/** When an offer made (or whose email is sent) at `from` expires: a full window later. */
export function waitlistOfferExpiresAt(from: Date): Date {
  return new Date(from.getTime() + WAITLIST_OFFER_HOURS * HOUR_MS);
}

/**
 * The latest a restarted window may end (D2: "capped at the check-in date"):
 * the start of the check-in date in the club's time zone (owner decision D6,
 * 24 Nov 2026). `checkIn` is the stored date-only lodge night; the club-time
 * kernel turns it into that instant.
 */
export function waitlistOfferRestartCap(checkIn: Date, zone: ClubTimeZone): Date {
  return startOfClubDay(calendarDateOfDateOnlyInstant(checkIn), zone);
}

/**
 * The deadline an offer carries once its email is really sent at `sentAt` by a
 * later run: a full window from the send, capped at the check-in date. It never
 * moves a deadline earlier: an offer made close to its check-in date already
 * carries a deadline past the cap, and the restart keeps it.
 */
export function restartedWaitlistOfferExpiry({
  sentAt,
  currentExpiresAt,
  checkIn,
  zone,
}: {
  sentAt: Date;
  currentExpiresAt: Date | null;
  checkIn: Date;
  zone: ClubTimeZone;
}): Date {
  const capped = Math.min(waitlistOfferExpiresAt(sentAt).getTime(), waitlistOfferRestartCap(checkIn, zone).getTime());
  return new Date(Math.max(currentExpiresAt?.getTime() ?? Number.NEGATIVE_INFINITY, capped));
}
