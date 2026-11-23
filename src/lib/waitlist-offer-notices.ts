/**
 * #5433 (WL-1): THE WAITLIST OFFER'S NOTICES ARE OWED UNTIL SENT.
 *
 * When the offer pass (`processWaitlistForDates`) offers a place, the member is
 * emailed (`waitlist-offer`) and the officers alerted (`admin-waitlist-offer`).
 * Both go after the offer commits, and a rerun finds the booking already
 * `WAITLIST_OFFERED` and never reaches them again. So the offer records them as
 * owed IN ITS OWN TRANSACTION (`recordWaitlistOfferNoticesOwed`): one
 * `OwedNotice` marker per notice, keyed by kind, booking and the offer's time
 * (`waitlistOfferedAt`, taken once there). After the commit
 * `deliverWaitlistOfferNotices` claims each marker, sends and clears it; the
 * sweep (`drainOwedNotices`) sends what that attempt never did. The claim, the
 * clear and the sweep are the mechanism's (`owed-notice/deliver.ts`).
 *
 * The kinds:
 * - wait: `WAITLIST_NOTICE_SWEEP_AFTER_MS` (30 minutes) after the offer or the
 *   last attempt; an officers' alert that reached nobody waits a day;
 * - the member's email carries the event key `<bookingId>:<offeredAtMs>`
 *   (`waitlistOfferEmailKey`), so one offer has one `EmailLog` row and the
 *   member can never be sent it twice;
 * - "moved on": the booking is gone, no longer `WAITLIST_OFFERED`, or carries a
 *   different offer (its `waitlistOfferedAt` is not the marker's);
 * - the member's cut-off is the later of the check-in date's start and the
 *   offer's own deadline, or seven days; past it the notice is cleared and the
 *   officers are alerted once (`alertOfficersOncePastCutoff`); the officers'
 *   alert lasts seven days, with no alert past it;
 * - the officers' alert quotes the queue position worked out in the offer's
 *   transaction (the marker's payload); everything else is read again.
 *
 * OWNER DECISION D2 (23 Nov 2026): an offer whose email was never sent gets a
 * full window from when the email really goes, capped at the check-in date.
 * The attempt right after the commit sends with the window the offer was made
 * with and never moves it (`MEMBER_RIGHT_AFTER_OFFER`). The sweep's send
 * (`sendOfferEmailFromSweep`), in order:
 * 1. if the offer email's `EmailLog` row exists, the email went (or is the
 *    retry cron's): clear, with no restart and no send;
 * 2. restart the window in its own locked transaction
 *    (`restartWaitlistOfferWindow`); a lost claim sends nothing;
 * 3. send, stating the deadline that restart left in force.
 * A stop between 2 and 3 leaves the window restarted and the marker claimed;
 * the next sweep restarts it again from its own send, a little later.
 *
 * "No offer expired email for an offer the member was never told about" is
 * `findNeverToldWaitlistOffers`, which `expireStaleOffers` reads in its own
 * transaction (`waitlist-offer-expired-notice.ts`).
 *
 * Locks (`INV-LOCK-001`): the markers join the offer's transaction under the
 * global and every lodge key it already holds, one insert with no read,
 * provider call or settings query (`INV-INT-003`). Everything else runs after
 * the commit with no advisory key, except the restart, which is its own
 * registered transaction.
 */
import { BookingStatus, Prisma } from "@prisma/client";

import { ALERT_NOBODY_ELIGIBLE_RETRY_MS } from "@/lib/alert-cooldown";
import { bookingOwner } from "@/lib/booking-owner";
import type { ClubFormat } from "@/lib/club-format";
import { clubFormatValues } from "@/lib/club-format-server";
import type { ClubTimeZone } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { sendAdminWaitlistOfferAlert, sendWaitlistOfferEmail } from "@/lib/email";
import { adminAlertNeedsResend } from "@/lib/email/admin-alert-send-result";
import { sendAdminWaitlistNoticeUnsentAlert } from "@/lib/email/admin-alerts-waitlist-notice-unsent";
import { durableEmailLogId } from "@/lib/email/attempt-log";
import { WAITLIST_OFFER_TEMPLATE_NAME } from "@/lib/email/waitlist";
import { seasonYearOfStoredDate } from "@/lib/financial-year";
import logger from "@/lib/logger";
import { resolveSubscriptionLockoutMode } from "@/lib/member-subscription-eligibility";
import type { SubscriptionLockoutMode } from "@/lib/membership-lockout-settings";
import {
  deliverOwedNotice,
  OWED_OFFICER_ALERT_MAX_AGE_MS,
  type OwedNoticeDeliverer,
  type OwedNoticeOutcome,
  type OwedNoticeRun,
} from "@/lib/owed-notice/deliver";
import type { OwedNoticeKind } from "@/lib/owed-notice/kinds";
import { alertOfficersOncePastCutoff, pastCutoffAlertKey } from "@/lib/owed-notice/past-cutoff-once";
import { owedNoticeId, owedNoticeMarker, recordOwedNotices, type OwedNoticeMarker } from "@/lib/owed-notice/store";
import { prisma } from "@/lib/prisma";
import {
  evaluateNonMemberPricingRequirements,
  toSubscriptionLockoutParticipants,
} from "@/lib/subscription-lockout-enforcement";
import type { WaitlistNoticeUnsent } from "@/lib/waitlist-notice-unsent-note";
import { waitlistOfferRestartCap } from "@/lib/waitlist-offer-window";
import { restartWaitlistOfferWindow } from "@/lib/waitlist-offer-window-restart";

/** How long a waitlist marker waits after its stamp before a sweep takes it: the attempt right after the change goes first. */
export const WAITLIST_NOTICE_SWEEP_AFTER_MS = 30 * 60 * 1000;

/** A member's waitlist notice older than this is past its cut-off, whatever its own cut-off says. */
export const WAITLIST_MEMBER_NOTICE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const MEMBER_KIND: OwedNoticeKind = "waitlist-offer-member";
const OFFICERS_KIND: OwedNoticeKind = "waitlist-offer-officers";

/** The offer email's event key: one `EmailLog` row per offer, however often it is sent. */
export function waitlistOfferEmailKey(bookingId: string, offeredAt: Date): string {
  return `${bookingId}:${offeredAt.getTime()}`;
}

/** One offer's owed notices: the booking, the offer's time, and the position the officers' alert quotes. */
export interface OwedWaitlistOffer {
  bookingId: string;
  offeredAt: Date;
  position: number;
}

const memberInput = (owed: Pick<OwedWaitlistOffer, "bookingId" | "offeredAt">) => ({
  kind: MEMBER_KIND,
  subjectId: owed.bookingId,
  eventAt: owed.offeredAt,
});

/**
 * The offer email's marker, whether or not it still stands: its id keys the
 * once-ever claim of the officers' "not sent" alert for this offer, which the
 * past-cut-off step and a never-told lapse share (owner decision D5).
 */
export function waitlistOfferMemberMarker(bookingId: string, offeredAt: Date): OwedNoticeMarker {
  return owedNoticeMarker(memberInput({ bookingId, offeredAt }));
}
const officersInput = (owed: OwedWaitlistOffer) => ({
  kind: OFFICERS_KIND,
  subjectId: owed.bookingId,
  eventAt: owed.offeredAt,
  payload: { position: owed.position },
});

/**
 * Inside the offer's transaction, under its global and lodge keys: record both
 * notices as owed, stamped with the offer's time, and hand the descriptor back
 * for the delivery after the commit (`INV-SSOT-002`). One insert that skips a
 * marker already there, never a caught unique-key error.
 */
export async function recordWaitlistOfferNoticesOwed(
  tx: Pick<Prisma.TransactionClient, "owedNotice">,
  owed: OwedWaitlistOffer,
): Promise<OwedWaitlistOffer> {
  await recordOwedNotices(tx, [memberInput(owed), officersInput(owed)]);
  return owed;
}

/** What the offer's notices say, as the offer pass knew it or as a sweep reads it again. */
export interface WaitlistOfferNotice {
  bookingId: string;
  status: BookingStatus;
  /** The offer's identity, `waitlistOfferedAt`; null once the booking holds no offer. */
  offeredAt: Date | null;
  expiresAt: Date | null;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  recipientMemberId: string | null;
  email: string;
  firstName: string;
  memberName: string;
  /** The price the member pays on confirmation: the offer-time reprice, or the offered lodge's quote. */
  priceCents: number;
  /** The booking's own lodge. */
  lodgeId: string;
  /** Set only for a cross-lodge offer (ADR-004): the lodge offered, and its name. */
  offeredLodgeId: string | null;
  offeredLodgeName: string | null;
  /** The club's settings, resolved outside any transaction: by the offer pass before its own, by a sweep when it reads the offer. */
  zone: ClubTimeZone;
  format: ClubFormat;
  lockoutMode: SubscriptionLockoutMode;
}

const OFFER_NOTICE_SELECT = Prisma.validator<Prisma.BookingSelect>()({
  id: true,
  status: true,
  waitlistOfferedAt: true,
  waitlistOfferExpiresAt: true,
  waitlistOfferedLodgeId: true,
  waitlistOfferedPriceCents: true,
  waitlistOfferedLodge: { select: { name: true } },
  finalPriceCents: true,
  checkIn: true,
  checkOut: true,
  lodgeId: true,
  memberId: true,
  member: { select: { id: true, email: true, firstName: true, lastName: true } },
  organisation: { select: { name: true, email: true } },
  _count: { select: { guests: true } },
});

/** The offer as it stands now, read outside any transaction; null when the booking is gone. */
async function loadWaitlistOfferNotice(marker: OwedNoticeMarker): Promise<WaitlistOfferNotice | null> {
  const booking = await prisma.booking.findUnique({ where: { id: marker.subjectId }, select: OFFER_NOTICE_SELECT });
  if (!booking) return null;
  const owner = bookingOwner(booking);
  return {
    bookingId: booking.id,
    status: booking.status,
    offeredAt: booking.waitlistOfferedAt,
    expiresAt: booking.waitlistOfferExpiresAt,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    guestCount: booking._count.guests,
    recipientMemberId: owner.memberId,
    email: owner.member.email,
    firstName: owner.member.firstName,
    memberName: `${owner.member.firstName} ${owner.member.lastName}`,
    priceCents: booking.waitlistOfferedPriceCents ?? booking.finalPriceCents,
    lodgeId: booking.lodgeId,
    offeredLodgeId: booking.waitlistOfferedLodgeId,
    offeredLodgeName: booking.waitlistOfferedLodge?.name ?? null,
    zone: await readClubTimeZoneOutsideRequest(),
    format: await clubFormatValues(),
    lockoutMode: await resolveSubscriptionLockoutMode(),
  };
}

/** True to send; otherwise why the offer moved on. Reads current state only. */
async function offerNoticeStillOwed(notice: WaitlistOfferNotice, marker: OwedNoticeMarker): Promise<true | string> {
  if (notice.status !== BookingStatus.WAITLIST_OFFERED) return `the booking is ${notice.status}`;
  if (notice.offeredAt?.getTime() !== marker.eventAt.getTime()) return "the booking holds a different offer";
  return true;
}

/**
 * #2543: the "why is this the price" sentence, when somebody on the booking is
 * priced as a non-member for an unpaid subscription. Read on the module client
 * after the commit; a failure degrades to the old wording, because an offer is
 * never held back by an explanatory sentence.
 */
async function offerRateNotice(notice: WaitlistOfferNotice, mode: SubscriptionLockoutMode): Promise<string | null> {
  try {
    const nonMemberPricing = await evaluateNonMemberPricingRequirements(prisma, {
      mode,
      lodgeId: notice.offeredLodgeId ?? notice.lodgeId ?? "",
      seasonYear: seasonYearOfStoredDate(notice.checkIn),
      checkIn: notice.checkIn,
      checkOut: notice.checkOut,
      // Owner decision, 3 Aug 2026: threaded for consistency with the confirm
      // path, where the refusal lives; this reads only the rate notice.
      bookingOwnerMemberId: notice.recipientMemberId,
      participants: toSubscriptionLockoutParticipants(
        await prisma.bookingGuest.findMany({ where: { bookingId: notice.bookingId } }),
      ),
    });
    return nonMemberPricing?.memberRateNotice ?? null;
  } catch (err) {
    logger.error({ err, bookingId: notice.bookingId }, "Failed to resolve the #2543 member-rate notice for a waitlist offer");
    return null;
  }
}

/** The member's offer email, stating `expiresAt`, with the offer's event key. Never throws. */
async function sendOfferEmail(
  notice: WaitlistOfferNotice,
  expiresAt: Date,
  { idempotencyKey, job }: OwedNoticeRun & { idempotencyKey: string },
): Promise<OwedNoticeOutcome> {
  try {
    const rateNotice = await offerRateNotice(notice, notice.lockoutMode);
    await sendWaitlistOfferEmail(
      { bookingId: notice.bookingId, recipientMemberId: notice.recipientMemberId, idempotencyKey },
      notice.email,
      notice.firstName,
      notice.checkIn,
      notice.checkOut,
      notice.guestCount,
      expiresAt,
      notice.bookingId,
      // The price the member pays on confirmation (upstream #1035).
      notice.priceCents,
      notice.format,
      // A cross-lodge offer speaks with the offered lodge's identity and names
      // it (ADR-004 owner decision 2).
      notice.offeredLodgeId ?? notice.lodgeId,
      notice.offeredLodgeId ? { lodgeName: notice.offeredLodgeName } : null,
      rateNotice,
    );
    return "settled";
  } catch (err) {
    logger.error({ err, bookingId: notice.bookingId, job }, "Failed to send waitlist offer email");
    return "threw";
  }
}

/** Whether the offer email's `EmailLog` row exists: it was sent, is being sent, or is the retry cron's. */
async function offerEmailRecorded(marker: OwedNoticeMarker): Promise<boolean> {
  const row = await prisma.emailLog.findUnique({
    where: { id: durableEmailLogId(WAITLIST_OFFER_TEMPLATE_NAME, waitlistOfferEmailKey(marker.subjectId, marker.eventAt)) },
    select: { id: true },
  });
  return row !== null;
}

/**
 * The sweep's send (D2): no restart for an email already recorded, then the
 * restart, then the send with the deadline in force. Never throws.
 */
async function sendOfferEmailFromSweep(
  notice: WaitlistOfferNotice,
  marker: OwedNoticeMarker,
  context: OwedNoticeRun & { idempotencyKey: string },
): Promise<OwedNoticeOutcome> {
  const log = { bookingId: notice.bookingId, key: marker.id, job: context.job };
  try {
    if (await offerEmailRecorded(marker)) {
      logger.info(log, "The waitlist offer email was already recorded; clearing its owed notice without restarting the window");
      return "settled";
    }
    const restart = await restartWaitlistOfferWindow({ bookingId: marker.subjectId, offeredAt: marker.eventAt, zone: notice.zone });
    if (restart.kind === "moved-on") {
      logger.warn({ ...log, why: restart.why }, "The waitlist offer moved on before its window could restart; nothing sent");
      return "settled";
    }
    if (restart.kind === "no-window") {
      logger.warn(log, "No offer window is left to restart; the next sweep takes the past-cut-off step");
      return "threw";
    }
    if (restart.restarted) {
      logger.info({ ...log, expiresAt: restart.expiresAt.toISOString() }, "Restarted a waitlist offer's window from its first real send (#5433 D2)");
    }
    return sendOfferEmail(notice, restart.expiresAt, context);
  } catch (err) {
    logger.error({ err, ...log }, "Failed to restart a waitlist offer's window; its email stays owed");
    return "threw";
  }
}

/** The position the officers' alert quotes, from the marker's payload; null when it cannot be read. */
function payloadPosition(marker: OwedNoticeMarker): number | null {
  const payload = marker.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const position = (payload as Record<string, unknown>).position;
  return typeof position === "number" && Number.isSafeInteger(position) ? position : null;
}

/** The officers' alert. Settled once an officer has it or nobody is meant to; unreached when nobody got it and nothing replays it. Never throws. */
async function alertOfficersOfOffer(notice: WaitlistOfferNotice, marker: OwedNoticeMarker, { job }: OwedNoticeRun): Promise<OwedNoticeOutcome> {
  const position = payloadPosition(marker);
  if (position === null) {
    logger.error({ key: marker.id, job }, "A waitlist offer's officer alert has no readable queue position; cleared without sending it");
    return "settled";
  }
  try {
    const result = await sendAdminWaitlistOfferAlert({
      memberName: notice.memberName,
      checkIn: notice.checkIn,
      checkOut: notice.checkOut,
      guestCount: notice.guestCount,
      position,
    });
    if (!adminAlertNeedsResend(result)) return "settled";
    logger.warn(
      { bookingId: notice.bookingId, failedBeforeLogged: result.failedBeforeLogged, job },
      "No officer received the waitlist offer alert and nothing will replay it; it stays owed for a day",
    );
    return "unreached";
  } catch (err) {
    logger.error({ err, bookingId: notice.bookingId, job }, "Failed to send admin waitlist offer alert");
    return "threw";
  }
}

/** Past a member's waitlist notice's cut-off: alert the officers, once per notice (owner decision D1's rule, #5433). */
export function alertOfficersWaitlistNoticeUnsent(
  notice: Pick<WaitlistOfferNotice, "bookingId" | "memberName" | "checkIn" | "checkOut">,
  marker: OwedNoticeMarker,
  which: WaitlistNoticeUnsent,
): Promise<OwedNoticeOutcome> {
  return alertOfficersOncePastCutoff(marker, {
    label: `waitlist ${which} email past its cut-off`,
    send: () =>
      sendAdminWaitlistNoticeUnsentAlert({
        notice: which,
        memberName: notice.memberName,
        bookingId: notice.bookingId,
        checkIn: notice.checkIn,
        checkOut: notice.checkOut,
      }),
  });
}

const OFFER_KIND_COMMON = {
  job: "waitlist-offer",
  sweepAfterMs: WAITLIST_NOTICE_SWEEP_AFTER_MS,
  unreachedRetryAfterMs: ALERT_NOBODY_ELIGIBLE_RETRY_MS,
  load: loadWaitlistOfferNotice,
  stillOwed: offerNoticeStillOwed,
};

/** The member's offer email, as the sweep sends it: restarting the window first (D2). */
const MEMBER: OwedNoticeDeliverer<WaitlistOfferNotice> = {
  ...OFFER_KIND_COMMON,
  kind: MEMBER_KIND,
  audience: "member",
  maxAgeMs: WAITLIST_MEMBER_NOTICE_MAX_AGE_MS,
  // Worth sending while a window can still be given (before the check-in date)
  // or the offer's own deadline has not passed, whichever is later.
  sendBy: (notice) =>
    new Date(Math.max(waitlistOfferRestartCap(notice.checkIn, notice.zone).getTime(), notice.expiresAt?.getTime() ?? 0)),
  pastCutoff: (notice, marker) => alertOfficersWaitlistNoticeUnsent(notice, marker, "offer"),
  idempotencyKey: (marker) => waitlistOfferEmailKey(marker.subjectId, marker.eventAt),
  deliver: sendOfferEmailFromSweep,
};

/** The member's offer email straight after the offer commits: the offer's own window, never restarted. */
const MEMBER_RIGHT_AFTER_OFFER: OwedNoticeDeliverer<WaitlistOfferNotice> = {
  ...MEMBER,
  deliver: (
    notice: WaitlistOfferNotice,
    _marker: OwedNoticeMarker,
    context: OwedNoticeRun & { idempotencyKey: string },
  ): Promise<OwedNoticeOutcome> =>
    notice.expiresAt ? sendOfferEmail(notice, notice.expiresAt, context) : Promise.resolve("threw"),
};

const OFFICERS: OwedNoticeDeliverer<WaitlistOfferNotice> = {
  ...OFFER_KIND_COMMON,
  kind: OFFICERS_KIND,
  audience: "officers",
  maxAgeMs: OWED_OFFICER_ALERT_MAX_AGE_MS,
  sendBy: (_notice, marker) => new Date(marker.eventAt.getTime() + OWED_OFFICER_ALERT_MAX_AGE_MS),
  deliver: alertOfficersOfOffer,
};

/** The offer's two kinds, member first, as the registry lists them. */
export const WAITLIST_OFFER_NOTICE_DELIVERERS: readonly OwedNoticeDeliverer<WaitlistOfferNotice>[] = [MEMBER, OFFICERS];

/**
 * After the offer commits: deliver both notices, the member's first, from what
 * the offer pass knew and the descriptor `recordWaitlistOfferNoticesOwed`
 * returned. Each claim is taken on the stamp the transaction wrote, so a sweep
 * that already holds a marker wins and this sends nothing. Never throws.
 */
export async function deliverWaitlistOfferNotices(notice: WaitlistOfferNotice, owed: OwedWaitlistOffer): Promise<void> {
  await deliverOwedNotice(MEMBER_RIGHT_AFTER_OFFER, owedNoticeMarker(memberInput(owed)), notice);
  await deliverOwedNotice(OFFICERS, owedNoticeMarker(officersInput(owed)), notice);
}

/**
 * Of these offers, the ones whose member was never told: no `EmailLog` row for
 * the offer email, and its owed notice still stands or passed its cut-off
 * unsent (the once-ever alert's claim records that). An offer made before
 * #5433, which wrote no marker, counts as told, as every offer did before.
 * Read inside `expireStaleOffers`'s transaction, through its client, after its
 * locks (`INV-LOCK-004`): three reads by primary key.
 */
export async function findNeverToldWaitlistOffers(
  db: Pick<Prisma.TransactionClient, "owedNotice" | "emailLog" | "alertCooldown">,
  offers: readonly { bookingId: string; offeredAt: Date | null }[],
): Promise<Set<string>> {
  const made = offers.flatMap(({ bookingId, offeredAt }) => {
    if (!offeredAt) return [];
    const markerId = owedNoticeId(MEMBER_KIND, bookingId, offeredAt);
    return [{
      bookingId,
      markerId,
      emailLogId: durableEmailLogId(WAITLIST_OFFER_TEMPLATE_NAME, waitlistOfferEmailKey(bookingId, offeredAt)),
      pastCutoffKey: pastCutoffAlertKey({ id: markerId }),
    }];
  });
  if (made.length === 0) return new Set();
  // One after another: they share the transaction's one connection.
  const markers = await db.owedNotice.findMany({ where: { id: { in: made.map((offer) => offer.markerId) } }, select: { id: true } });
  const emails = await db.emailLog.findMany({ where: { id: { in: made.map((offer) => offer.emailLogId) } }, select: { id: true } });
  const pastCutoff = await db.alertCooldown.findMany({
    where: { key: { in: made.map((offer) => offer.pastCutoffKey) } },
    select: { key: true },
  });
  const owed = new Set([...markers.map((row) => row.id), ...pastCutoff.map((row) => row.key)]);
  const recorded = new Set(emails.map((row) => row.id));
  return new Set(
    made
      .filter((offer) => !recorded.has(offer.emailLogId) && (owed.has(offer.markerId) || owed.has(offer.pastCutoffKey)))
      .map((offer) => offer.bookingId),
  );
}
