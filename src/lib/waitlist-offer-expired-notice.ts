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
 * sends what that attempt never did.
 *
 * - wait: `WAITLIST_NOTICE_SWEEP_AFTER_MS` after the lapse or the last attempt;
 * - event key `<bookingId>:<expiredAtMs>`: one email per lapse;
 * - "moved on": the booking is gone or no longer `WAITLISTED` (re-offered,
 *   confirmed, cancelled);
 * - the position: the one the revert's transaction worked out, straight after
 *   the commit; the queue as it stands when a sweep sends it;
 * - "moved on" also once the stay has ended at the club (its check-out date
 *   has begun): a release notice is worth sending until the check-out date
 *   (#5433, settled by the lane), and the past-date waitlist cron cancels such
 *   a booking anyway; this does not wait for it;
 * - cut-off: seven days; past it the notice is cleared and the officers are
 *   alerted once.
 *
 * OWNER DECISION D2 (23 Nov 2026): no "offer expired" email for an offer the
 * member was never told about. The revert reads which lapsed offers those are
 * (`findNeverToldWaitlistOffers`) and writes no marker for them; nothing else
 * about the lapse changes (the revert, the re-offer pass and its rotation,
 * `INV-CAP-042`).
 *
 * Locks (`INV-LOCK-001`): the markers join the revert's transaction under the
 * global and lodge keys it already holds, one insert; everything else runs
 * after the commit with no advisory key.
 */
import { BookingStatus, Prisma } from "@prisma/client";

import { ALERT_NOBODY_ELIGIBLE_RETRY_MS } from "@/lib/alert-cooldown";
import { bookingOwner } from "@/lib/booking-owner";
import { clubToday, dateOnlyInstantOf } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { sendWaitlistOfferExpiredEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { deliverOwedNotice, type OwedNoticeDeliverer, type OwedNoticeOutcome } from "@/lib/owed-notice/deliver";
import type { OwedNoticeKind } from "@/lib/owed-notice/kinds";
import { owedNoticeMarker, recordOwedNotices } from "@/lib/owed-notice/store";
import { prisma } from "@/lib/prisma";
import {
  alertOfficersWaitlistNoticeUnsent,
  WAITLIST_MEMBER_NOTICE_MAX_AGE_MS,
  WAITLIST_NOTICE_SWEEP_AFTER_MS,
} from "@/lib/waitlist-offer-notices";
import { getWaitlistPositionOf } from "@/lib/waitlist-queue";

const KIND: OwedNoticeKind = "waitlist-offer-expired";

/** One lapse's owed notice: the booking and the instant that keys and stamps its marker. */
export interface OwedWaitlistOfferExpired {
  bookingId: string;
  expiredAt: Date;
}

const markerInput = (owed: OwedWaitlistOfferExpired) => ({ kind: KIND, subjectId: owed.bookingId, eventAt: owed.expiredAt });

/**
 * Inside the revert's transaction, under its global and lodge keys: record
 * each lapse's email as owed. One insert for all of them, skipping a marker
 * already there, never a caught unique-key error.
 */
export async function recordWaitlistOfferExpiredNoticesOwed(
  tx: Pick<Prisma.TransactionClient, "owedNotice">,
  owed: readonly OwedWaitlistOfferExpired[],
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
  const today = dateOnlyInstantOf(clubToday(await readClubTimeZoneOutsideRequest()));
  return notice.checkOut.getTime() > today.getTime() ? true : "the stay has ended";
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
  idempotencyKey: (marker) => `${marker.subjectId}:${marker.eventAt.getTime()}`,
  deliver: (notice, _marker, context) => sendExpiredEmail(notice, context),
};

/** The kind, as the registry lists it. */
export const WAITLIST_OFFER_EXPIRED_NOTICE_DELIVERER: OwedNoticeDeliverer<WaitlistOfferExpiredNotice> = EXPIRED;

/**
 * After the revert commits: deliver one lapse's email, from what the revert
 * knew. The claim is taken on the stamp the transaction wrote. Never throws.
 */
export async function deliverWaitlistOfferExpiredNotice(
  notice: WaitlistOfferExpiredNotice,
  owed: OwedWaitlistOfferExpired,
): Promise<void> {
  await deliverOwedNotice(EXPIRED, owedNoticeMarker(markerInput(owed)), notice);
}
