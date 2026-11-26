/**
 * #5433 PR 4 (CP-6): A SPLIT GUEST PORTION'S PAYMENT LINK IS OWED UNTIL SENT.
 *
 * When a split booking's guest portion reaches its hold deadline with no card
 * to charge and the member's own place settled without one, the confirm-pending
 * job mints a payment link inside its transaction
 * (`mintSplitGuestPaymentLinkIfAbsent`) and emails the member the raw token
 * after the commit. The token exists only in memory, and an active link is the
 * job's sign that the member was emailed: a stop between the commit and the
 * send left an active link nobody was ever sent, and every later run found it
 * and sent nothing, until the guests were cancelled at the end of the
 * check-in day. So the transaction that mints the link also records the email
 * as owed (`recordSplitGuestPaymentLinkOwed`), as its last write: one
 * `OwedNotice` marker keyed by the payment link's id. The raw token is never
 * stored. Every link the job or this recovery mints is owed this way, so a
 * live link that was never emailed always has a marker, until its cut-off.
 *
 * Right after the commit `deliverSplitGuestPaymentLink` sends the email, keyed
 * by the link's id (so its `EmailLog` row is `email:split-guest-payment-link:<linkId>`),
 * and decides from what the send returned, as before #5433: an email that was
 * not delivered has its link revoked by id, so the job's next extension mints
 * and sends a fresh one. The marker is cleared once the email went or the link
 * was revoked. It stays for the sweep when the revoke failed (a live link
 * nobody has), or when the send threw before its row was written (round 1,
 * item 2: with an event key a failed row insert throws, and before #5433 the
 * unkeyed send went out regardless; now the sweep sends it within its interval
 * instead of the member waiting up to two days for the next extension).
 *
 * The sweep (`drainOwedNotices`) handles what that attempt never finished:
 * - "moved on", cleared without a send: the booking is gone, deleted or no
 *   longer PENDING; the link was used or is gone; or a newer link was minted
 *   for the booking since. A newer link is either the job's or this
 *   recovery's, each owed by a marker of its own, or one the member sent
 *   themselves from the booking page, where they see the outcome;
 * - otherwise the original link's email row is read by the shared told rule
 *   (`owed-notice/member-email.ts`): told or in flight (sent, queued, withheld
 *   by "No emails"), cleared;
 * - otherwise the booking page's own re-issue revokes the link and mints a new
 *   one (`prepareSplitGuestPaymentLinkReissue`), recording the new link's email
 *   as owed in that same transaction (round 1, item 1), and the new link is
 *   then delivered exactly as the job delivers its own. So a stop between the
 *   re-issue's commit and its send leaves the new link's marker, never a live
 *   link with none;
 * - the cut-off (owner decision D10): the link's own expiry (the end of the
 *   check-in day), or seven days after the mint, whichever comes first. Past it,
 *   unless the email reached the member after all, the officers are alerted
 *   once ("Booking email not sent"). A link that was used, or a booking no
 *   longer pending, has moved on and raises no alert.
 * One email per link: each link's email is keyed by that link. A member is
 * sent a second link only after the first was never delivered.
 *
 * An input that cannot key a marker (unreachable with today's ids) is sent as
 * before #5433: once, unkeyed, with main's revoke when it is not delivered.
 *
 * Locks (`INV-LOCK-001`): the marker is one insert on a primary key, under the
 * `lock(1)` and lodge lock the extension already holds, or under the lodge lock
 * the re-issue already holds; no read, provider call or settings query is
 * added to either (`INV-INT-003`). The delivery and the sweep run after the
 * commit on the base client.
 */
import { BookingStatus, type Prisma } from "@prisma/client";

import { ALERT_NOBODY_ELIGIBLE_RETRY_MS } from "@/lib/alert-cooldown";
import { readBookingAmountOwed } from "@/lib/booking-amount-owed";
import { alertOfficersBookingNoticeUnsent, OWED_BOOKING_NOTICE_SELECT, type OwedBookingNotice } from "@/lib/booking-notice-unsent-alert";
import { bookingOwner } from "@/lib/booking-owner";
import type { ClubFormat } from "@/lib/club-format";
import { clubFormatValues } from "@/lib/club-format-server";
import { sendSplitGuestPaymentLinkEmail } from "@/lib/email";
import { durableEmailLogId } from "@/lib/email/attempt-log";
import { isToldKeyedEmailState } from "@/lib/email/keyed-email-state";
import logger from "@/lib/logger";
import { revokePaymentLinkById } from "@/lib/payment-link";
import {
  deliverOwedNotice,
  type OwedNoticeDeliverer,
  type OwedNoticeImmediateDeliverer,
  type OwedNoticeOutcome,
  type OwedNoticeRun,
} from "@/lib/owed-notice/deliver";
import type { OwedNoticeKind } from "@/lib/owed-notice/kinds";
import {
  OWED_MEMBER_NOTICE_MAX_AGE_MS,
  OWED_MEMBER_NOTICE_SWEEP_AFTER_MS,
  readOwedMemberEmail,
} from "@/lib/owed-notice/member-email";
import { recordOwedNoticesIfKeyable, type OwedNoticeInput, type OwedNoticeMarker } from "@/lib/owed-notice/store";
import {
  prepareSplitGuestPaymentLinkReissue,
  SPLIT_GUEST_PAYMENT_LINK_TEMPLATE,
  type MintedSplitGuestPaymentLink,
} from "@/lib/payment-link-split-guest";
import { prisma } from "@/lib/prisma";

export const SPLIT_GUEST_PAYMENT_LINK_KIND: OwedNoticeKind = "split-guest-payment-link";

/** The payload field that carries the link's booking. */
const BOOKING_ID = "bookingId";

/** A link's email's `EmailLog` id: keyed by the link. */
export function splitGuestPaymentLinkEmailLogId(paymentLinkId: string): string {
  return durableEmailLogId(SPLIT_GUEST_PAYMENT_LINK_TEMPLATE, paymentLinkId);
}

/** Inside the minting transaction: the marker's input. */
function linkNoticeInput(bookingId: string, paymentLinkId: string, mintedAt: Date): OwedNoticeInput {
  return { kind: SPLIT_GUEST_PAYMENT_LINK_KIND, subjectId: paymentLinkId, eventAt: mintedAt, payload: { [BOOKING_ID]: bookingId } };
}

/**
 * Inside the minting transaction (the job's extension, or the recovery's
 * re-issue), as its last write, right after the mint: record the link's email
 * as owed and return the marker for the delivery after the commit
 * (`INV-SSOT-002`). An input that cannot be keyed is an error log, nothing
 * written and null (`recordOwedNoticesIfKeyable`), so the marker can never
 * roll the mint back for a reason of shape.
 */
export async function recordSplitGuestPaymentLinkOwed(
  tx: Pick<Prisma.TransactionClient, "owedNotice">,
  { bookingId, paymentLinkId }: { bookingId: string; paymentLinkId: string },
): Promise<OwedNoticeMarker | null> {
  const markers = await recordOwedNoticesIfKeyable(tx, [linkNoticeInput(bookingId, paymentLinkId, new Date())], {
    message: "A split guest payment link cannot key its owed email; the mint commits and the email is sent unkeyed, as before #5433",
    context: { bookingId, paymentLinkId },
  });
  return markers?.[0] ?? null;
}

/** What the email needs of the booking, as the minting transaction read it. */
type LinkEmailBooking = Pick<OwedBookingNotice, "id" | "memberId" | "member" | "organisation" | "checkIn" | "checkOut" | "guests" | "finalPriceCents" | "lodgeId"> & {
  payment: { changeFeeCents: number | null } | null;
};

/** The attempt right after the mint: the booking, the link with its raw token, and the club's format. */
export interface SplitGuestPaymentLinkSubject {
  booking: LinkEmailBooking;
  link: MintedSplitGuestPaymentLink;
  format: ClubFormat;
}

/** What one send of a link's email came to. */
type LinkSendResult = "delivered" | "revoked" | "revoke-failed" | "threw-before-row";

/**
 * The email with the raw token, keyed by the link when it is owed, then main's
 * own rule: an email that was not delivered has its link revoked by id (so a
 * concurrent on-demand re-mint's newer link survives), and the job's next
 * extension re-mints and re-sends. The returned status decides, as before
 * #5433; only a send that threw is checked against the keyed row, which tells
 * a failure before the row from one after it. Never throws.
 */
async function sendLinkEmail({ booking, link, format }: SplitGuestPaymentLinkSubject, idempotencyKey: string | undefined, job: string): Promise<LinkSendResult> {
  const owner = bookingOwner(booking);
  let delivered = false;
  let threw = false;
  try {
    const emailOutcome = await sendSplitGuestPaymentLinkEmail({
      bookingContext: { bookingId: booking.id, recipientMemberId: owner.memberId },
      email: owner.member.email,
      firstName: owner.member.firstName,
      token: link.token,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      guestCount: booking.guests.length,
      priceCents: booking.finalPriceCents,
      amountDueCents: (await readBookingAmountOwed(booking)).dueCents,
      bookingId: booking.id,
      // `expiresAt` comes back FROM the mint, so the email states the row's
      // own instant rather than deriving the boundary a second time.
      expiresAt: link.expiresAt,
      lodgeId: booking.lodgeId ?? null,
      idempotencyKey,
    }, format);
    delivered = emailOutcome.status === "sent";
    // #2258: the switch can be flipped between the pre-mint gate and this
    // send. The token is revoked below either way, but a DELIBERATE withhold
    // must not be reported as a retryable delivery failure. The else-branch
    // names NO cause: it said "(suppressed recipient)", false for an
    // environment withhold (#3035).
    const withheld = emailOutcome.status === "withheld_for_booking" && emailOutcome.reason === "booking_no_emails";
    if (!delivered) {
      logger.warn(
        { bookingId: booking.id, emailStatus: emailOutcome.status, job },
        withheld
          ? "Split-booking guest payment link email withheld by the booking's email gate; revoking the link"
          : "Split-booking guest payment link email not delivered; revoking the link so the next settlement run re-mints. emailStatus says why",
      );
    }
  } catch (emailErr) {
    threw = true;
    logger.error(
      { err: emailErr, bookingId: booking.id, job },
      "Failed to send split-booking guest payment link email; revoking the link so the next settlement run re-mints",
    );
  }
  if (delivered) return "delivered";
  let revoked = true;
  try {
    await revokePaymentLinkById(link.paymentLinkId);
  } catch (revokeErr) {
    revoked = false;
    logger.error(
      { err: revokeErr, bookingId: booking.id, paymentLinkId: link.paymentLinkId, job },
      "Failed to revoke undelivered split guest payment link; a stale active link may block re-minting until it expires",
    );
  }
  if (threw && idempotencyKey !== undefined && (await linkEmailNeverRecorded(link.paymentLinkId, booking.id, job))) return "threw-before-row";
  return revoked ? "revoked" : "revoke-failed";
}

/** True when the link's keyed email has no row (or its row cannot be read, which the sweep then settles). Never throws. */
async function linkEmailNeverRecorded(paymentLinkId: string, bookingId: string, job: string): Promise<boolean> {
  try {
    return (await readOwedMemberEmail(splitGuestPaymentLinkEmailLogId(paymentLinkId))).state === "not-sent";
  } catch (err) {
    logger.error({ err, bookingId, paymentLinkId, job }, "Failed to read a split guest payment link's email row after its send threw; it stays owed");
    return true;
  }
}

/** The send, answered for the mechanism: cleared once the email went or the link was revoked; kept otherwise. Never throws. */
async function deliverMintedSplitGuestPaymentLink(
  subject: SplitGuestPaymentLinkSubject,
  _marker: OwedNoticeMarker,
  { idempotencyKey, job }: OwedNoticeRun & { idempotencyKey: string },
): Promise<OwedNoticeOutcome> {
  const sent = await sendLinkEmail(subject, idempotencyKey, job);
  return sent === "delivered" || sent === "revoked" ? "settled" : "threw";
}

const LINK_DELIVERY: OwedNoticeImmediateDeliverer<SplitGuestPaymentLinkSubject> = {
  kind: SPLIT_GUEST_PAYMENT_LINK_KIND,
  job: "confirmPendingBookings",
  audience: "member",
  sweepAfterMs: OWED_MEMBER_NOTICE_SWEEP_AFTER_MS,
  unreachedRetryAfterMs: ALERT_NOBODY_ELIGIBLE_RETRY_MS,
  idempotencyKey: (marker) => marker.subjectId,
  deliver: deliverMintedSplitGuestPaymentLink,
};

/**
 * After a mint commits: send the link's email from the marker its transaction
 * returned, with the raw token the mint handed back. The claim is taken on the
 * stamp the transaction wrote, so a sweep that already holds the marker wins
 * and this sends nothing (and the token dies with this run; the sweep
 * re-mints). With no marker (an input that could not be keyed), the email is
 * sent as before #5433, unkeyed. Never throws.
 */
export async function deliverSplitGuestPaymentLink(marker: OwedNoticeMarker | null, subject: SplitGuestPaymentLinkSubject, job: string): Promise<void> {
  if (marker) {
    await deliverOwedNotice({ ...LINK_DELIVERY, job }, marker, subject);
    return;
  }
  await sendLinkEmail(subject, undefined, job);
}

// ---------------------------------------------------------------------------
// The sweep.
// ---------------------------------------------------------------------------

/** The link and its booking as they stand now, read outside any transaction. */
interface SplitGuestPaymentLinkSweepSubject {
  link: { id: string; bookingId: string; usedAt: Date | null; createdAt: Date; expiresAt: Date };
  booking: OwedBookingNotice;
  newerLinkMinted: boolean;
  format: ClubFormat;
}

/** The booking the marker names: its payload, which the mint wrote. */
function bookingIdOf(marker: OwedNoticeMarker): string | null {
  const payload = marker.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload[BOOKING_ID];
  return typeof value === "string" ? value : null;
}

async function loadSplitGuestPaymentLinkSweepSubject(marker: OwedNoticeMarker): Promise<SplitGuestPaymentLinkSweepSubject | null> {
  const bookingId = bookingIdOf(marker);
  if (!bookingId) return null;
  const link = await prisma.paymentLink.findUnique({
    where: { id: marker.subjectId },
    select: { id: true, bookingId: true, usedAt: true, createdAt: true, expiresAt: true },
  });
  if (!link || link.bookingId !== bookingId) return null;
  const booking = await prisma.booking.findUnique({ where: { id: bookingId }, select: OWED_BOOKING_NOTICE_SELECT });
  if (!booking) return null;
  const newer = await prisma.paymentLink.findFirst({
    where: { bookingId, createdAt: { gt: link.createdAt } },
    select: { id: true },
  });
  return { link, booking, newerLinkMinted: newer !== null, format: await clubFormatValues() };
}

/**
 * Null when the link's email is still owed; otherwise why it moved on. The
 * link's expiry is not here: it is the notice's cut-off (`sendBy`), past which
 * the officers are alerted once unless the member was told.
 */
export function splitGuestPaymentLinkMovedOn(subject: Pick<SplitGuestPaymentLinkSweepSubject, "link" | "booking" | "newerLinkMinted">): string | null {
  const { link, booking } = subject;
  if (booking.deletedAt) return "the booking was deleted";
  if (booking.status !== BookingStatus.PENDING) return `the booking is ${booking.status}`;
  if (link.usedAt) return "the link was used";
  if (subject.newerLinkMinted) return "a newer payment link was minted for the booking, owed in its own right";
  return null;
}

/** Whether the link's own keyed email says the member was told, or is in flight. */
async function linkEmailTold(paymentLinkId: string): Promise<boolean> {
  return isToldKeyedEmailState((await readOwedMemberEmail(splitGuestPaymentLinkEmailLogId(paymentLinkId))).state);
}

/**
 * Recover the email: told on the original link's row, cleared; otherwise
 * revoke and re-mint through the booking page's own re-issue, owing the new
 * link's email in that transaction, and deliver it as the job delivers its
 * own. Never throws.
 */
async function recoverSplitGuestPaymentLink(
  { link, format }: SplitGuestPaymentLinkSweepSubject,
  marker: OwedNoticeMarker,
  { job }: OwedNoticeRun & { idempotencyKey: string },
): Promise<OwedNoticeOutcome> {
  const log = { bookingId: link.bookingId, paymentLinkId: link.id, key: marker.id, job };
  try {
    if (await linkEmailTold(link.id)) {
      logger.info(log, "The split guest payment link's email was sent, or is in flight; its owed notice is cleared");
      return "settled";
    }
  } catch (err) {
    logger.error({ err, ...log }, "Failed to read a split guest payment link's email state; it stays owed");
    return "threw";
  }
  try {
    const reissued = await prepareSplitGuestPaymentLinkReissue(link.bookingId, (tx, minted) =>
      recordSplitGuestPaymentLinkOwed(tx, { bookingId: link.bookingId, paymentLinkId: minted.paymentLinkId }),
    );
    if (reissued.kind !== "minted") {
      logger.info({ ...log, outcome: reissued.kind }, "An owed split guest payment link was not re-issued; its owed notice is cleared");
      return "settled";
    }
    logger.info({ ...log, newPaymentLinkId: reissued.minted.paymentLinkId }, "Re-issued an owed split guest payment link; the new link's email is owed in its own right");
    await deliverSplitGuestPaymentLink(reissued.owed, { booking: reissued.booking, link: reissued.minted, format }, job);
    return "settled";
  } catch (err) {
    logger.error({ err, ...log }, "Failed to re-issue an owed split guest payment link; it stays owed");
    return "threw";
  }
}

/**
 * Past the cut-off (owner decision D10: the link's expiry at the end of the
 * check-in day, or seven days after the mint): alert the officers once, unless
 * the email did reach the member after all. Never throws.
 */
async function splitGuestPaymentLinkPastCutoff(
  { link, booking }: SplitGuestPaymentLinkSweepSubject,
  marker: OwedNoticeMarker,
  { job }: OwedNoticeRun,
): Promise<OwedNoticeOutcome> {
  const log = { bookingId: link.bookingId, paymentLinkId: link.id, key: marker.id, job };
  try {
    if (await linkEmailTold(link.id)) return "settled";
  } catch (err) {
    logger.error({ err, ...log }, "Failed to read a split guest payment link's email state past its cut-off");
    return "threw";
  }
  logger.error(log, "A split guest payment link's email passed its cut-off unsent; alerting the officers once");
  return alertOfficersBookingNoticeUnsent(marker, "split-guest-payment-link", booking);
}

const SPLIT_GUEST_PAYMENT_LINK: OwedNoticeDeliverer<SplitGuestPaymentLinkSweepSubject> = {
  kind: SPLIT_GUEST_PAYMENT_LINK_KIND,
  job: "confirmPendingBookings",
  audience: "member",
  sweepAfterMs: OWED_MEMBER_NOTICE_SWEEP_AFTER_MS,
  unreachedRetryAfterMs: ALERT_NOBODY_ELIGIBLE_RETRY_MS,
  maxAgeMs: OWED_MEMBER_NOTICE_MAX_AGE_MS,
  idempotencyKey: (marker) => marker.subjectId,
  load: loadSplitGuestPaymentLinkSweepSubject,
  stillOwed: async (subject) => splitGuestPaymentLinkMovedOn(subject) ?? true,
  sendBy: ({ link }) => link.expiresAt,
  deliver: recoverSplitGuestPaymentLink,
  pastCutoff: splitGuestPaymentLinkPastCutoff,
};

/** The link kind, as the registry lists it. */
export const SPLIT_GUEST_PAYMENT_LINK_NOTICE_DELIVERERS: readonly OwedNoticeDeliverer<SplitGuestPaymentLinkSweepSubject>[] = [SPLIT_GUEST_PAYMENT_LINK];
