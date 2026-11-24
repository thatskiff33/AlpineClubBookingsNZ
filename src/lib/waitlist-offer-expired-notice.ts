/**
 * #5433 (WL-2): THE "OFFER EXPIRED" EMAIL IS OWED UNTIL SENT.
 *
 * `expireStaleOffers` reverts each stale offer to `WAITLISTED` and then emails
 * the member (`waitlist-offer-expired`) with their place in the queue. The
 * email goes after the revert commits, and a rerun finds the booking already
 * `WAITLISTED`. So the revert records it as owed IN THE SAME TRANSACTION
 * (`recordWaitlistOfferExpiredNoticesOwed`): one `OwedNotice` marker per
 * lapse, keyed by booking and the lapse's time. After the commit
 * `deliverWaitlistOfferExpiredNotice` sends it and clears the marker; the sweep
 * sends what that attempt never did. `expireStaleOffers` makes that attempt
 * after its re-offer passes, not straight after the commit (#5433 review F).
 *
 * - wait: `WAITLIST_NOTICE_SWEEP_AFTER_MS` after the lapse or the last attempt;
 * - event key `<bookingId>:<expiredAtMs>`: one email per lapse;
 * - "moved on": the booking is gone or no longer `WAITLISTED` (re-offered,
 *   confirmed, cancelled);
 * - the position: the one the revert's transaction worked out, when
 *   `expireStaleOffers` delivers it after that run's re-offer passes (to a
 *   booking still `WAITLISTED` then); the queue as it stands when a sweep
 *   sends it;
 * - "moved on" also once the stay has ended at the club (its check-out date
 *   has begun): a release notice is worth sending until the check-out date
 *   (#5433, settled by the lane), and the past-date waitlist cron cancels such
 *   a booking anyway; this does not wait for it;
 * - cut-off: seven days; past it the notice is cleared and the officers are
 *   alerted once.
 *
 * OWNER DECISION D2 (23 Nov 2026): no "offer expired" email for an offer the
 * member was never told about. The revert reads which lapsed offers those are
 * (`findNeverToldWaitlistOffers`) and writes no offer-expired marker for them;
 * nothing else about the lapse changes (the revert, the re-offer pass and its
 * rotation, `INV-CAP-042`).
 *
 * OWNER DECISION D5 (24 Nov 2026): instead, the officers are alerted once, so
 * a person can step in (`waitlist-offer-lapsed-untold`, an officers' kind
 * written in the same insert with the offer's time in its payload). The alert
 * is `admin-waitlist-notice-unsent`, sent through the offer email's own
 * once-ever claim (`waitlistOfferMemberMarker`): if that email's past-cut-off
 * step already alerted the officers, the lapse sends nothing, and if the lapse
 * alerted first, the past-cut-off step sends nothing. One alert per offer.
 *
 * Locks (`INV-LOCK-001`): the markers join the revert's transaction under the
 * global and lodge keys it already holds, one insert; everything else runs
 * after the commit with no advisory key.
 */
import { BookingStatus, Prisma } from "@prisma/client";

import { ALERT_NOBODY_ELIGIBLE_RETRY_MS } from "@/lib/alert-cooldown";
import { bookingOwner } from "@/lib/booking-owner";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { sendWaitlistOfferExpiredEmail } from "@/lib/email";
import logger from "@/lib/logger";
import {
  deliverOwedNotice,
  OWED_OFFICER_ALERT_MAX_AGE_MS,
  type OwedNoticeDeliverer,
  type OwedNoticeOutcome,
  type OwedNoticeRun,
} from "@/lib/owed-notice/deliver";
import type { OwedNoticeKind } from "@/lib/owed-notice/kinds";
import { owedNoticeEventKey, owedNoticeMarker, recordOwedNotices, type OwedNoticeMarker } from "@/lib/owed-notice/store";
import { prisma } from "@/lib/prisma";
import {
  alertOfficersWaitlistNoticeUnsent,
  WAITLIST_MEMBER_NOTICE_MAX_AGE_MS,
  waitlistOfferMemberMarker,
} from "@/lib/waitlist-offer-notices";
import { WAITLIST_NOTICE_SWEEP_AFTER_MS } from "@/lib/waitlist-offer-window";
import { clubTodayAsStoredDate, waitlistStayHasEnded } from "@/lib/waitlist-stay-ended";
import { getWaitlistPositionOf } from "@/lib/waitlist-queue";

const KIND: OwedNoticeKind = "waitlist-offer-expired";
const UNTOLD_KIND: OwedNoticeKind = "waitlist-offer-lapsed-untold";

/**
 * One lapse's owed notice: the booking and the instant that keys and stamps
 * its marker. `untoldOfferedAt` is set when the member was never told of the
 * offer: the officers are then owed an alert (D5) in place of the member's
 * email (D2), and it is the lapsed offer's time.
 */
export interface OwedWaitlistLapse {
  bookingId: string;
  expiredAt: Date;
  untoldOfferedAt?: Date | null;
}

const markerInput = (owed: OwedWaitlistLapse) =>
  owed.untoldOfferedAt
    ? { kind: UNTOLD_KIND, subjectId: owed.bookingId, eventAt: owed.expiredAt, payload: { offeredAtMs: owed.untoldOfferedAt.getTime() } }
    : { kind: KIND, subjectId: owed.bookingId, eventAt: owed.expiredAt };

/**
 * Inside the revert's transaction, under its global and lodge keys: record
 * each lapse's notice as owed, the member's email or, for an offer never
 * told, the officers' alert. One insert for all of them, skipping a marker
 * already there, never a caught unique-key error.
 */
export async function recordWaitlistLapseNoticesOwed(
  tx: Pick<Prisma.TransactionClient, "owedNotice">,
  owed: readonly OwedWaitlistLapse[],
): Promise<void> {
  await recordOwedNotices(tx, owed.map(markerInput));
}

/** What the email says, as the revert knew it or as a sweep reads it again. */
export interface WaitlistOfferExpiredNotice {
  bookingId: string;
  status: BookingStatus;
  checkIn: Date;
  checkOut: Date;
  recipientMemberId: string | null;
  email: string;
  firstName: string;
  memberName: string;
  lodgeId: string;
  position: number;
}

const EXPIRED_NOTICE_SELECT = Prisma.validator<Prisma.BookingSelect>()({
  id: true,
  status: true,
  checkIn: true,
  checkOut: true,
  lodgeId: true,
  createdAt: true,
  memberId: true,
  member: { select: { id: true, email: true, firstName: true, lastName: true } },
  organisation: { select: { name: true, email: true } },
});

/** The booking as it stands now, with its place in the queue now; null when it is gone. */
async function loadExpiredNotice(marker: { subjectId: string }): Promise<WaitlistOfferExpiredNotice | null> {
  const booking = await prisma.booking.findUnique({ where: { id: marker.subjectId }, select: EXPIRED_NOTICE_SELECT });
  if (!booking) return null;
  const owner = bookingOwner(booking);
  return {
    bookingId: booking.id,
    status: booking.status,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    recipientMemberId: owner.memberId,
    email: owner.member.email,
    firstName: owner.member.firstName,
    memberName: `${owner.member.firstName} ${owner.member.lastName}`,
    lodgeId: booking.lodgeId,
    // Live at send time (#5402's reader, no lock: `INV-CAP-041`).
    position: await getWaitlistPositionOf(prisma, {
      id: booking.id,
      lodgeId: booking.lodgeId,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      createdAt: booking.createdAt,
    }),
  };
}

/** True to send; otherwise why not: no longer waitlisted, or the stay has ended at the club. */
async function expiredNoticeStillOwed(notice: WaitlistOfferExpiredNotice): Promise<true | string> {
  if (notice.status !== BookingStatus.WAITLISTED) return `the booking is ${notice.status}`;
  const today = clubTodayAsStoredDate(await readClubTimeZoneOutsideRequest());
  return waitlistStayHasEnded(notice.checkOut, today) ? "the stay has ended" : true;
}

/** The member's email, with the lapse's event key. Never throws. */
async function sendExpiredEmail(
  notice: WaitlistOfferExpiredNotice,
  { idempotencyKey, job }: { idempotencyKey: string; job: string },
): Promise<OwedNoticeOutcome> {
  try {
    await sendWaitlistOfferExpiredEmail(
      { bookingId: notice.bookingId, recipientMemberId: notice.recipientMemberId, idempotencyKey },
      notice.email,
      notice.firstName,
      notice.checkIn,
      notice.checkOut,
      notice.position,
      notice.lodgeId,
    );
    return "settled";
  } catch (err) {
    logger.error({ err, bookingId: notice.bookingId, job }, "Failed to send waitlist offer expired email");
    return "threw";
  }
}

const EXPIRED: OwedNoticeDeliverer<WaitlistOfferExpiredNotice> = {
  kind: KIND,
  job: "waitlist-offer-expiry",
  audience: "member",
  sweepAfterMs: WAITLIST_NOTICE_SWEEP_AFTER_MS,
  unreachedRetryAfterMs: ALERT_NOBODY_ELIGIBLE_RETRY_MS,
  maxAgeMs: WAITLIST_MEMBER_NOTICE_MAX_AGE_MS,
  load: loadExpiredNotice,
  stillOwed: expiredNoticeStillOwed,
  sendBy: (_notice, marker) => new Date(marker.eventAt.getTime() + WAITLIST_MEMBER_NOTICE_MAX_AGE_MS),
  pastCutoff: (notice, marker) => alertOfficersWaitlistNoticeUnsent(notice, marker, "offer-expired"),
  idempotencyKey: (marker) => owedNoticeEventKey(marker.subjectId, marker.eventAt),
  deliver: (notice, _marker, context) => sendExpiredEmail(notice, context),
};

/** The lapsed offer's time, from a never-told lapse's payload; null when it cannot be read. */
function untoldOfferedAt(marker: OwedNoticeMarker): Date | null {
  const payload = marker.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const ms = (payload as Record<string, unknown>).offeredAtMs;
  return typeof ms === "number" && Number.isSafeInteger(ms) ? new Date(ms) : null;
}

/**
 * D5: alert the officers that an offer lapsed untold, through the offer
 * email's own once-ever claim, so this and that email's past-cut-off step
 * alert once between them. Never throws.
 */
async function alertOfficersOfUntoldLapse(
  notice: WaitlistOfferExpiredNotice,
  marker: OwedNoticeMarker,
  run: OwedNoticeRun,
): Promise<OwedNoticeOutcome> {
  const offeredAt = untoldOfferedAt(marker);
  if (!offeredAt) {
    logger.error({ key: marker.id, job: run.job }, "A never-told lapse's officer alert has no readable offer time; cleared without sending it");
    return "settled";
  }
  return alertOfficersWaitlistNoticeUnsent(notice, waitlistOfferMemberMarker(notice.bookingId, offeredAt), "offer-lapsed-untold");
}

const UNTOLD: OwedNoticeDeliverer<WaitlistOfferExpiredNotice> = {
  kind: UNTOLD_KIND,
  job: "waitlist-offer-expiry",
  audience: "officers",
  sweepAfterMs: WAITLIST_NOTICE_SWEEP_AFTER_MS,
  unreachedRetryAfterMs: ALERT_NOBODY_ELIGIBLE_RETRY_MS,
  maxAgeMs: OWED_OFFICER_ALERT_MAX_AGE_MS,
  load: loadExpiredNotice,
  // Moot once the member is re-offered, confirmed or cancelled, or the stay has ended.
  stillOwed: expiredNoticeStillOwed,
  sendBy: (_notice, marker) => new Date(marker.eventAt.getTime() + OWED_OFFICER_ALERT_MAX_AGE_MS),
  deliver: alertOfficersOfUntoldLapse,
};

/** The lapse's two kinds, as the registry lists them. */
export const WAITLIST_LAPSE_NOTICE_DELIVERERS: readonly OwedNoticeDeliverer<WaitlistOfferExpiredNotice>[] = [EXPIRED, UNTOLD];

/**
 * After the revert commits: deliver one lapse's notice (the member's email,
 * or the officers' alert for an offer never told), from what the revert knew.
 * The claim is taken on the stamp the transaction wrote. Never throws.
 */
export async function deliverWaitlistLapseNotice(notice: WaitlistOfferExpiredNotice, owed: OwedWaitlistLapse): Promise<void> {
  await deliverOwedNotice(owed.untoldOfferedAt ? UNTOLD : EXPIRED, owedNoticeMarker(markerInput(owed)), notice);
}
