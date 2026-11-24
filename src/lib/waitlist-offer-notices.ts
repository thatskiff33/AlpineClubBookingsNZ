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
 * (`sendOfferEmailFromSweep`) first reads the offer email's state
 * (`OfferEmailState`, review B): told, it clears; the email retry cron's, it
 * waits; undeliverable, or to an address no email can reach (none, a
 * placeholder, or SES-suppressed: round 2, item 6), it alerts the officers.
 * Only an email that never reached its row is sent by the sweep, in order:
 * 1. restart the window in its own locked transaction
 *    (`restartWaitlistOfferWindow`): once per offer, and not at all when too
 *    little window would be left (the officers are alerted instead); a lost
 *    claim sends nothing;
 * 2. send, stating the deadline in force.
 * A stop between 1 and 2 leaves the window restarted and the marker claimed;
 * the next sweep finds the restarted deadline and sends with it as it stands,
 * so the member then has the remainder of the restarted window, not a fresh
 * one (stated limit, review C).
 *
 * Either send is followed by a read of the email's row (`sendOfferEmail`),
 * because a send can return without reaching the member (round 2, item 2).
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
import { logAudit } from "@/lib/audit";
import { bookingOwner } from "@/lib/booking-owner";
import type { ClubFormat } from "@/lib/club-format";
import { clubFormatValues } from "@/lib/club-format-server";
import type { ClubTimeZone } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { sendAdminWaitlistOfferAlert, sendWaitlistOfferEmail } from "@/lib/email";
import { adminAlertNeedsResend } from "@/lib/email/admin-alert-send-result";
import { sendAdminWaitlistNoticeUnsentAlert } from "@/lib/email/admin-alerts-waitlist-notice-unsent";
import { emailReachability } from "@/lib/email-reachability";
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
import {
  isOfferEmailRowTold,
  isToldOfferEmailState,
  offerEmailLogId,
  readOfferEmailState,
  retireOfferEmailIfReplayable,
  waitlistOfferEmailKey,
  waitlistOfferMovedOn,
} from "@/lib/waitlist-offer-email-state";
import { WAITLIST_NOTICE_SWEEP_AFTER_MS, waitlistOfferRestartCap } from "@/lib/waitlist-offer-window";
import { restartWaitlistOfferWindow } from "@/lib/waitlist-offer-window-restart";

/** A member's waitlist notice older than this is past its cut-off, whatever its own cut-off says. */
export const WAITLIST_MEMBER_NOTICE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const MEMBER_KIND: OwedNoticeKind = "waitlist-offer-member";
const OFFICERS_KIND: OwedNoticeKind = "waitlist-offer-officers";


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

/** Null to send; otherwise why the offer moved on (`waitlistOfferMovedOn`, the one rule). */
const offerMovedOn = (notice: WaitlistOfferNotice, marker: OwedNoticeMarker): string | null =>
  waitlistOfferMovedOn({ status: notice.status, waitlistOfferedAt: notice.offeredAt }, marker.eventAt);

/**
 * The offer's "moved on" check. When the offer is over, a `FAILED` offer email
 * the retry cron could still replay is retired first, so the member is never
 * sent an offer stating a dead deadline (round 2, item 4).
 */
async function offerNoticeStillOwed(notice: WaitlistOfferNotice, marker: OwedNoticeMarker): Promise<true | string> {
  const movedOn = offerMovedOn(notice, marker);
  if (movedOn === null) return true;
  await retireOfferEmailIfReplayable(marker.subjectId, marker.eventAt, movedOn);
  return movedOn;
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

/** The marker's offer email state: its subject is the booking and its event the offer. */
const offerEmailStateOf = (marker: OwedNoticeMarker) => readOfferEmailState(marker.subjectId, marker.eventAt);

/**
 * The member's offer email, stating `expiresAt`, with the offer's event key;
 * then what became of it (round 2, item 2). A send that returns has not
 * necessarily reached the member: the email core returns without throwing for
 * a suppressed address (`BOUNCED`), for a fail-closed "No emails" read or an
 * environment fault (`FAILED`, keeping its body, so the retry cron's), and for
 * an empty or placeholder address (no row at all). So the row decides: told, settled; the
 * retry cron's, kept for it; undeliverable, or nothing recorded, the officers
 * are alerted once through the shared claim. Never throws.
 */
async function sendOfferEmail(
  notice: WaitlistOfferNotice,
  marker: OwedNoticeMarker,
  expiresAt: Date,
  context: OwedNoticeRun & { idempotencyKey: string },
): Promise<OwedNoticeOutcome> {
  const { idempotencyKey, job } = context;
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
  } catch (err) {
    logger.error({ err, bookingId: notice.bookingId, job }, "Failed to send waitlist offer email");
    return "threw";
  }
  try {
    const state = await offerEmailStateOf(marker);
    if (isToldOfferEmailState(state)) return "settled";
    if (state === "retrying") {
      logger.info({ bookingId: notice.bookingId, job }, "The email retry cron holds this waitlist offer email; the owed notice waits for it");
      return "threw";
    }
    logger.warn(
      { bookingId: notice.bookingId, job, state },
      "The waitlist offer email did not reach the member; alerting the officers instead",
    );
    return alertOfficersWaitlistNoticeUnsent(notice, marker, "offer");
  } catch (err) {
    logger.error({ err, bookingId: notice.bookingId, job }, "Failed to read the waitlist offer email's state after its send");
    return "threw";
  }
}

/**
 * Whether the member's address can be emailed at all (`emailReachability`,
 * round 2 item 6, round 3 item 4), read outside any transaction. An unreadable
 * suppression list is "not now": the notice is offered again a wait later.
 */
async function memberReachability(notice: WaitlistOfferNotice): Promise<"reachable" | "unreachable" | "unknown"> {
  const reach = await emailReachability(notice.email, (err) =>
    logger.error({ err, bookingId: notice.bookingId }, "Could not read the email suppression list; the waitlist offer email stays owed"),
  );
  return reach === "reachable" || reach === "unknown" ? reach : "unreachable";
}

/**
 * #5433 review I: the restart is a change to the offer an officer may look
 * for, so it leaves an audit row with both deadlines (`waitlist.offer_sent`
 * keeps the one the offer was made with). Written once the restart has
 * committed and before the email it is for is sent.
 */
function auditWindowRestart(notice: WaitlistOfferNotice, previousExpiresAt: Date, expiresAt: Date): void {
  logAudit({
    action: "waitlist.offer_window_restarted",
    memberId: null,
    targetId: notice.bookingId,
    subjectMemberId: notice.recipientMemberId,
    entityType: "Booking",
    entityId: notice.bookingId,
    category: "booking",
    outcome: "success",
    summary: "Waitlist offer window restarted",
    details:
      "The offer email had not been sent, so the offer's window was restarted for the email now being sent, which states the new deadline (#5433 D2)",
    metadata: { previousExpiresAt: previousExpiresAt.toISOString(), expiresAt: expiresAt.toISOString() },
  });
}

/**
 * The sweep's send (D2), by the offer email's state: told, nothing to do; the
 * retry cron's, wait for it; undeliverable, or the address cannot be emailed,
 * tell the officers; never sent, restart the window (once per offer) and send
 * with the deadline in force, or tell the officers when too little window is
 * left. Never throws.
 */
async function sendOfferEmailFromSweep(
  notice: WaitlistOfferNotice,
  marker: OwedNoticeMarker,
  context: OwedNoticeRun & { idempotencyKey: string },
): Promise<OwedNoticeOutcome> {
  const log = { bookingId: notice.bookingId, key: marker.id, job: context.job };
  try {
    const state = await offerEmailStateOf(marker);
    if (isToldOfferEmailState(state)) {
      logger.info(log, "The waitlist offer email was already recorded; clearing its owed notice without restarting the window");
      return "settled";
    }
    if (state === "retrying") {
      logger.info(log, "The email retry cron holds this waitlist offer email; the owed notice waits for it");
      return "threw";
    }
    const reach = state === "undeliverable" ? "unreachable" : await memberReachability(notice);
    if (reach === "unknown") return "threw";
    if (reach === "unreachable") {
      logger.warn({ ...log, state }, "The waitlist offer email cannot reach the member; alerting the officers instead");
      return alertOfficersWaitlistNoticeUnsent(notice, marker, "offer");
    }
    const restart = await restartWaitlistOfferWindow({
      bookingId: marker.subjectId,
      offeredAt: marker.eventAt,
      zone: notice.zone,
      now: context.now,
    });
    if (restart.kind === "moved-on") {
      logger.warn({ ...log, why: restart.why }, "The waitlist offer moved on before its window could restart; nothing sent");
      await retireOfferEmailIfReplayable(marker.subjectId, marker.eventAt, restart.why);
      return "settled";
    }
    if (restart.kind === "no-window") {
      logger.warn(log, "Too little of the offer's window is left to tell the member; alerting the officers instead");
      return alertOfficersWaitlistNoticeUnsent(notice, marker, "offer");
    }
    if (restart.restarted) {
      logger.info({ ...log, expiresAt: restart.expiresAt.toISOString() }, "Restarted a waitlist offer's window from its first real send (#5433 D2)");
      auditWindowRestart(notice, restart.previousExpiresAt, restart.expiresAt);
    }
    return sendOfferEmail(notice, marker, restart.expiresAt, context);
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

/** Whether the offer email's own owed notice still stands. */
async function offerEmailStillOwed(marker: OwedNoticeMarker): Promise<boolean> {
  const id = waitlistOfferMemberMarker(marker.subjectId, marker.eventAt).id;
  return (await prisma.owedNotice.findUnique({ where: { id }, select: { id: true } })) !== null;
}

/**
 * The officers' routine offer alert, which states what became of the offer
 * email (sent, withheld, or not delivered) and the deadline in force (round 2,
 * item 7). It waits only while that is not yet known: the email is the retry
 * cron's, or never sent and still owed (review L). Then it always goes, as it
 * did before #5433, including when the email cannot reach the member or its
 * notice ended with no row (an owner with no address, say): the officers then
 * also get the "not sent" alert, which says what to do. Settled once an
 * officer has it or nobody is meant to; unreached when nobody got it and
 * nothing replays it. Never throws.
 */
async function alertOfficersOfOffer(notice: WaitlistOfferNotice, marker: OwedNoticeMarker, { job }: OwedNoticeRun): Promise<OwedNoticeOutcome> {
  const position = payloadPosition(marker);
  if (position === null) {
    logger.error({ key: marker.id, job }, "A waitlist offer's officer alert has no readable queue position; cleared without sending it");
    return "settled";
  }
  try {
    const state = await offerEmailStateOf(marker);
    if (state === "retrying") return "threw";
    if (state === "not-sent" && (await offerEmailStillOwed(marker))) return "threw";
    const result = await sendAdminWaitlistOfferAlert({
      memberName: notice.memberName,
      checkIn: notice.checkIn,
      checkOut: notice.checkOut,
      guestCount: notice.guestCount,
      position,
      expiresAt: notice.expiresAt,
      offerEmail: isToldOfferEmailState(state) ? state : "not-delivered",
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

/**
 * Alert the officers that a member was not told (#5433: D1's rule for a member
 * notice past its cut-off, a send that did not reach the member, and D5's
 * never-told lapse), once per claim key: the offer email's marker for every
 * alert about one offer, so they go once between them. Through the once-ever
 * takeover (`alertOfficersOncePastCutoff`): a claim another attempt holds is
 * read by its sent stamp, and only the waitlist wait counts as in flight.
 */
export function alertOfficersWaitlistNoticeUnsent(
  notice: Pick<WaitlistOfferNotice, "bookingId" | "memberName" | "checkIn" | "checkOut">,
  marker: OwedNoticeMarker,
  which: WaitlistNoticeUnsent,
): Promise<OwedNoticeOutcome> {
  return alertOfficersOncePastCutoff(marker, {
    label: `waitlist ${which} email not sent`,
    inFlightMs: WAITLIST_NOTICE_SWEEP_AFTER_MS,
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

/**
 * Past the offer email's cut-off: alert the officers once, unless the email
 * did reach the member after all (review G).
 */
async function offerEmailPastCutoff(notice: WaitlistOfferNotice, marker: OwedNoticeMarker, run: OwedNoticeRun): Promise<OwedNoticeOutcome> {
  try {
    if (isToldOfferEmailState(await offerEmailStateOf(marker))) return "settled";
  } catch (err) {
    logger.error({ err, key: marker.id, job: run.job }, "Failed to read the waitlist offer email's state past its cut-off");
    return "threw";
  }
  return alertOfficersWaitlistNoticeUnsent(notice, marker, "offer");
}

const OFFER_KIND_COMMON = {
  job: "waitlist-offer",
  sweepAfterMs: WAITLIST_NOTICE_SWEEP_AFTER_MS,
  unreachedRetryAfterMs: ALERT_NOBODY_ELIGIBLE_RETRY_MS,
  load: loadWaitlistOfferNotice,
};

/** The member's offer email, as the sweep sends it: restarting the window first (D2). */
const MEMBER: OwedNoticeDeliverer<WaitlistOfferNotice> = {
  ...OFFER_KIND_COMMON,
  kind: MEMBER_KIND,
  audience: "member",
  maxAgeMs: WAITLIST_MEMBER_NOTICE_MAX_AGE_MS,
  stillOwed: offerNoticeStillOwed,
  // Worth sending while a window can still be given (before the check-in date)
  // or the offer's own deadline has not passed, whichever is later.
  sendBy: (notice) =>
    new Date(Math.max(waitlistOfferRestartCap(notice.checkIn, notice.zone).getTime(), notice.expiresAt?.getTime() ?? 0)),
  pastCutoff: offerEmailPastCutoff,
  idempotencyKey: (marker) => waitlistOfferEmailKey(marker.subjectId, marker.eventAt),
  deliver: sendOfferEmailFromSweep,
};

/** The member's offer email straight after the offer commits: the offer's own window, never restarted. */
const MEMBER_RIGHT_AFTER_OFFER: OwedNoticeDeliverer<WaitlistOfferNotice> = {
  ...MEMBER,
  deliver: (
    notice: WaitlistOfferNotice,
    marker: OwedNoticeMarker,
    context: OwedNoticeRun & { idempotencyKey: string },
  ): Promise<OwedNoticeOutcome> =>
    notice.expiresAt ? sendOfferEmail(notice, marker, notice.expiresAt, context) : Promise.resolve("threw"),
};

const OFFICERS: OwedNoticeDeliverer<WaitlistOfferNotice> = {
  ...OFFER_KIND_COMMON,
  kind: OFFICERS_KIND,
  audience: "officers",
  maxAgeMs: OWED_OFFICER_ALERT_MAX_AGE_MS,
  stillOwed: async (notice, marker) => offerMovedOn(notice, marker) ?? true,
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
 * Of these offers, the ones whose member was never told (round 2, item 2):
 * - an offer email row that is not told (`isOfferEmailRowTold`): never told,
 *   whatever else remains. The keyed row exists only for an offer this
 *   release made, so this needs no further evidence; a bounce that arrived
 *   after `SENT` counts here too;
 * - no row: never told when its owed notice still stands or passed its
 *   cut-off unsent (the once-ever alert's claim records that). An offer made
 *   before #5433, which wrote neither, counts as told, as every offer did.
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
    return [{ bookingId, markerId, emailLogId: offerEmailLogId(bookingId, offeredAt), pastCutoffKey: pastCutoffAlertKey({ id: markerId }) }];
  });
  if (made.length === 0) return new Set();
  // One after another: they share the transaction's one connection.
  const markers = await db.owedNotice.findMany({ where: { id: { in: made.map((offer) => offer.markerId) } }, select: { id: true } });
  const emails = await db.emailLog.findMany({
    where: { id: { in: made.map((offer) => offer.emailLogId) } },
    select: { id: true, status: true, attempts: true, lastAttemptAt: true },
  });
  const pastCutoff = await db.alertCooldown.findMany({
    where: { key: { in: made.map((offer) => offer.pastCutoffKey) } },
    select: { key: true },
  });
  const owed = new Set([...markers.map((row) => row.id), ...pastCutoff.map((row) => row.key)]);
  const rows = new Map(emails.map((row) => [row.id, row]));
  return new Set(
    made
      .filter((offer) => {
        const row = rows.get(offer.emailLogId);
        return row ? !isOfferEmailRowTold(row) : owed.has(offer.markerId) || owed.has(offer.pastCutoffKey);
      })
      .map((offer) => offer.bookingId),
  );
}
