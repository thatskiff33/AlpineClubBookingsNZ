/**
 * #5433 (ST, CP-2): A PAID BOOKING'S CONFIRMATION IS OWED UNTIL SENT.
 *
 * A card payment settles a booking PAID in one transaction, and the member's
 * confirmation goes after the commit. A redelivered Stripe webhook, a retried
 * confirm-payment request or the next confirm-pending run finds the booking
 * already paid and never sends it. So the settle records the confirmation as
 * owed IN ITS OWN TRANSACTION, at its fresh PAID claim
 * (`paid-booking-confirmation-owed.ts`): one `OwedNotice` marker keyed by the
 * booking and the moment it was paid. After the commit the caller hands that
 * marker to `deliverPaidBookingConfirmation`, which claims it, sends and
 * clears it; the sweep (`drainOwedNotices`) sends what that attempt never did.
 * The claim, the clear and the sweep are the mechanism's
 * (`owed-notice/deliver.ts`).
 *
 * OWNER DECISION D1 (23 Nov 2026): "Send it automatically. Send the
 * confirmation when it is found, up to the end of the check-in day, built from
 * the booking as it stands. After that, clear it and alert officers once.
 * Stated with it: it can arrive hours late; a booking cancelled in the
 * meantime is not sent." So:
 * - wait: `PAID_CONFIRMATION_SWEEP_AFTER_MS` (30 minutes) after the payment or
 *   the last attempt; an officers' alert that reached nobody waits a day;
 * - the email carries the event key `<bookingId>:<paidAtMs>`, so one payment
 *   has one `EmailLog` row and the member can never be sent it twice;
 * - "moved on": the booking is gone, deleted, or no longer paid (PAID or
 *   COMPLETED): cancelled (with or without a refund) or its payment reversed.
 *   A partial refund that leaves it paid does not stop the email. Checked by
 *   the sweep, and again just before every send from a fresh read of the
 *   booking's status (round 1, item 4). Stated limit: a cancel that commits
 *   between that read and the provider call is still sent the confirmation;
 * - rendered afresh from the booking as it stands (`sendPaidBookingConfirmation`):
 *   the confirmation's body is never kept (`SENSITIVE_EMAIL_LOG_TEMPLATES`),
 *   which is also why the email retry job can never replay one, before or
 *   after this change, so nothing here has to retire a replay;
 * - the cut-off is the end of the check-in day in the club's time zone
 *   (`paidConfirmationSendBy`, through the club-time kernel), or seven days
 *   after the payment, whichever comes first (owner decision D7, 25 Nov 2026);
 *   past it the notice is cleared and the officers are alerted once
 *   (`alertOfficersOncePastCutoff`). The cut-off is the sweep's only: the
 *   attempt right after the payment always sends, even for a payment recorded
 *   after the check-in day, as before #5433.
 *
 * A send that returns is not proof the member was told: the email core returns
 * without throwing for a suppressed address (`BOUNCED`), a fail-closed "No
 * emails" read or an environment fault (`FAILED`, which for this body-less
 * template nothing replays), and an empty or placeholder address (no row at
 * all). So every send is followed by a read of the email's own row
 * (`email/keyed-email-state.ts`, the rule the waitlist offer shares, answered
 * through `owed-notice/member-email.ts`, which every member kind of the
 * confirm-pending job shares): told
 * (sent, or withheld by "No emails" or a non-production copy), settled; held
 * back by the installation's environment gate (an undeclared role, a misplaced
 * capture transport), settled as before this change, because the gate already
 * puts that row in the email-failure review queue; held by the retry job, kept
 * for it; anything else (a provider failure, a bounce or suppressed address, a
 * fail-closed "No emails" read, no address at all, which owner decision D8
 * keeps), the officers are alerted once, through the same claim as the
 * past-cut-off alert. For the fail-closed read the email core also sends its
 * own alert, to a different group; that one is not durable (round 2, F1), so
 * officers may get both, the trade-off the issue already accepts.
 *
 * Who owes it: only the three callers that send the confirmation ask the
 * settle to record it (`owesPaidConfirmation`): the Stripe webhook, the
 * confirm-payment route and the confirm-pending job's saved-card charge. The
 * other card doors send none, or only on an officer's choice, as before. The
 * confirm-pending job's zero-balance confirmation records the same marker at
 * its own PAID claim (#5433 PR 4, CP-1) and is delivered here too, on the same
 * rules (owner decision D11: an owner who cannot be emailed at all raises the
 * officers' alert, as D8 does for a card payment).
 *
 * Locks (`INV-LOCK-001`): nothing here runs inside a transaction or takes an
 * advisory key. The marker joins the settle's transaction under the locks it
 * already holds; everything in this file runs after the commit.
 */
import { ALERT_NOBODY_ELIGIBLE_RETRY_MS } from "@/lib/alert-cooldown";
import { bookingOwner } from "@/lib/booking-owner";
import { isPaidLikeBookingStatus } from "@/lib/booking-status";
import type { ClubFormat } from "@/lib/club-format";
import { clubFormatValues } from "@/lib/club-format-server";
import { endOfStoredClubDay, type ClubTimeZone } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { sendAdminBookingConfirmationUnsentAlert } from "@/lib/email/admin-alerts-booking-confirmation-unsent";
import { durableEmailLogId } from "@/lib/email/attempt-log";
import { BOOKING_CONFIRMED_TEMPLATE_NAME } from "@/lib/email/booking-confirmed-template";
import logger from "@/lib/logger";
import { deliverOwedNotice, type OwedNoticeDeliverer, type OwedNoticeImmediateDeliverer, type OwedNoticeOutcome, type OwedNoticeRun } from "@/lib/owed-notice/deliver";
import {
  OWED_MEMBER_NOTICE_MAX_AGE_MS,
  OWED_MEMBER_NOTICE_SWEEP_AFTER_MS,
  owedMemberEmailOutcome,
  owedMemberEmailPastCutoff,
  type OwedMemberEmail,
} from "@/lib/owed-notice/member-email";
import { alertOfficersOncePastCutoff } from "@/lib/owed-notice/past-cutoff-once";
import { owedNoticeEventKey, type OwedNoticeMarker } from "@/lib/owed-notice/store";
import {
  loadPaidConfirmationBooking,
  sendPaidBookingConfirmation,
  type PaidConfirmationBooking,
} from "@/lib/paid-booking-confirmation-email";
import { BOOKING_CONFIRMED_KIND } from "@/lib/paid-booking-confirmation-owed";
import { prisma } from "@/lib/prisma";

/** How long after its stamp a sweep takes a confirmation's marker, so the attempt right after the settle goes first. */
export const PAID_CONFIRMATION_SWEEP_AFTER_MS = OWED_MEMBER_NOTICE_SWEEP_AFTER_MS;

/** A confirmation still owed this long after the payment is past its cut-off, whatever the check-in date (owner decision D7). */
export const PAID_CONFIRMATION_MAX_AGE_MS = OWED_MEMBER_NOTICE_MAX_AGE_MS;

/**
 * The confirmation as a send needs it: the booking as it stands, and the club's
 * format, read outside any transaction. The attempt right after the payment
 * has this and nothing more: it applies no cut-off (round 1, item 6).
 */
export interface PaidConfirmationSubject {
  booking: PaidConfirmationBooking;
  format: ClubFormat;
}

/**
 * The sweep's subject: the same, plus the club's time zone its cut-off needs.
 * Only the sweep's deliverer takes it, and only it has a cut-off, so a cut-off
 * without a zone cannot be written (round 2, F4).
 */
export interface PaidConfirmationSweepSubject extends PaidConfirmationSubject {
  zone: ClubTimeZone;
}

/** The confirmation's event key, `<bookingId>:<paidAtMs>`: one `EmailLog` row per payment. */
export function paidConfirmationKey(marker: Pick<OwedNoticeMarker, "subjectId" | "eventAt">): string {
  return owedNoticeEventKey(marker.subjectId, marker.eventAt);
}

/** The confirmation's durable `EmailLog` id. */
export function paidConfirmationEmailLogId(marker: Pick<OwedNoticeMarker, "subjectId" | "eventAt">): string {
  return durableEmailLogId(BOOKING_CONFIRMED_TEMPLATE_NAME, paidConfirmationKey(marker));
}

/** Null when the booking is still owed its confirmation; otherwise why it moved on. */
export function paidConfirmationMovedOn(booking: Pick<PaidConfirmationBooking, "status" | "deletedAt">): string | null {
  if (booking.deletedAt) return "the booking was deleted";
  if (!isPaidLikeBookingStatus(booking.status)) return `the booking is ${booking.status}`;
  return null;
}

/** D1's cut-off: the last instant of the check-in day in the club's time zone (the stored date-only night, through the kernel). */
export function paidConfirmationSendBy(checkIn: Date, zone: ClubTimeZone): Date {
  return endOfStoredClubDay(checkIn, zone);
}

/** The booking as it stands, read outside any transaction; null when it is gone. */
async function loadPaidConfirmationSubject(marker: OwedNoticeMarker, format: ClubFormat): Promise<PaidConfirmationSubject | null> {
  const booking = await loadPaidConfirmationBooking(marker.subjectId);
  return booking ? { booking, format } : null;
}

/** The sweep's read: the booking, the club's format and its time zone; null when the booking is gone. */
async function loadPaidConfirmationSweepSubject(marker: OwedNoticeMarker): Promise<PaidConfirmationSweepSubject | null> {
  const subject = await loadPaidConfirmationSubject(marker, await clubFormatValues());
  return subject ? { ...subject, zone: await readClubTimeZoneOutsideRequest() } : null;
}

/**
 * Why the booking no longer owes its confirmation, read afresh just before a
 * send (one read by primary key, outside any transaction): null to send.
 */
async function paidConfirmationMovedOnNow(bookingId: string): Promise<string | null> {
  const current = await prisma.booking.findUnique({ where: { id: bookingId }, select: { status: true, deletedAt: true } });
  return current ? paidConfirmationMovedOn(current) : "the booking is gone";
}

/**
 * Alert the officers, once per payment (the marker's id keys the once-ever
 * claim), that the owner was not told: D1's rule past the cut-off, and a send
 * that did not reach them. Through the once-ever takeover: a claim another
 * attempt holds is read by its sent stamp, and only this kind's wait counts
 * as in flight.
 */
function alertOfficersPaidConfirmationUnsent(subject: PaidConfirmationSubject, marker: OwedNoticeMarker): Promise<OwedNoticeOutcome> {
  const owner = bookingOwner(subject.booking).member;
  return alertOfficersOncePastCutoff(marker, {
    label: "booking confirmation not sent",
    inFlightMs: PAID_CONFIRMATION_SWEEP_AFTER_MS,
    send: () =>
      sendAdminBookingConfirmationUnsentAlert({
        memberName: `${owner.firstName} ${owner.lastName}`.trim(),
        bookingId: subject.booking.id,
        checkIn: subject.booking.checkIn,
        checkOut: subject.booking.checkOut,
      }),
  });
}

/**
 * The confirmation's email as the shared reading takes it
 * (`owed-notice/member-email.ts`): told, settled; held back by the
 * installation's environment gate, settled as before #5433 (it waits in the
 * review queue, where officers already see it); held by the email retry job,
 * kept for it; undeliverable or never recorded, the officers are alerted once.
 * A row withheld because the booking's "No emails" switch could not be read is
 * undeliverable like any other (round 2, F1): the email core's own alert about
 * it is not durable, so this notice's claim is what makes sure officers hear.
 */
function paidConfirmationEmail(subject: PaidConfirmationSubject, marker: OwedNoticeMarker, job: string): OwedMemberEmail {
  return {
    emailLogId: paidConfirmationEmailLogId(marker),
    label: "booking confirmation",
    log: { bookingId: marker.subjectId, key: marker.id, job },
    alertOfficers: () => alertOfficersPaidConfirmationUnsent(subject, marker),
  };
}

/**
 * Send the confirmation with the payment's event key, then read what became
 * of it. A booking that moved on since the payment is not sent (D1): its status
 * is read afresh just before the send, so a cancel between the settle (or the
 * sweep's read) and this attempt clears the notice too. Stated limit: a cancel
 * that commits between that read and the provider call is still sent it.
 * Never throws.
 */
async function deliverOwedPaidConfirmation(
  subject: PaidConfirmationSubject,
  marker: OwedNoticeMarker,
  { idempotencyKey, job }: OwedNoticeRun & { idempotencyKey: string },
): Promise<OwedNoticeOutcome> {
  let movedOn: string | null;
  try {
    movedOn = await paidConfirmationMovedOnNow(marker.subjectId);
  } catch (err) {
    logger.error({ err, bookingId: marker.subjectId, job }, "Failed to read a paid booking's status before sending its confirmation; it stays owed");
    return "threw";
  }
  if (movedOn !== null) {
    logger.warn({ bookingId: marker.subjectId, key: marker.id, why: movedOn, job }, "The paid booking moved on before its confirmation was sent; not sending it");
    return "settled";
  }
  try {
    await sendPaidBookingConfirmation(subject.booking, subject.format, idempotencyKey);
  } catch (err) {
    logger.error({ err, bookingId: marker.subjectId, job }, "Failed to send confirmation email");
    return "threw";
  }
  return owedMemberEmailOutcome(paidConfirmationEmail(subject, marker, job));
}

/** Past the cut-off: alert the officers once, unless the confirmation did reach the owner after all, or waits in the review queue. */
function paidConfirmationPastCutoff(subject: PaidConfirmationSubject, marker: OwedNoticeMarker, run: OwedNoticeRun): Promise<OwedNoticeOutcome> {
  return owedMemberEmailPastCutoff(paidConfirmationEmail(subject, marker, run.job));
}

/** What both deliveries share: the send and its outcome, which need no time zone. */
const PAID_CONFIRMATION_DELIVERY: OwedNoticeImmediateDeliverer<PaidConfirmationSubject> = {
  kind: BOOKING_CONFIRMED_KIND,
  job: "card-payment-confirmation",
  audience: "member",
  sweepAfterMs: PAID_CONFIRMATION_SWEEP_AFTER_MS,
  unreachedRetryAfterMs: ALERT_NOBODY_ELIGIBLE_RETRY_MS,
  idempotencyKey: paidConfirmationKey,
  deliver: deliverOwedPaidConfirmation,
};

/** The sweep's deliverer: its subject always carries the zone its cut-off reads. */
const PAID_CONFIRMATION: OwedNoticeDeliverer<PaidConfirmationSweepSubject> = {
  ...PAID_CONFIRMATION_DELIVERY,
  maxAgeMs: PAID_CONFIRMATION_MAX_AGE_MS,
  load: loadPaidConfirmationSweepSubject,
  stillOwed: async ({ booking }) => paidConfirmationMovedOn(booking) ?? true,
  sendBy: ({ booking, zone }) => paidConfirmationSendBy(booking.checkIn, zone),
  pastCutoff: paidConfirmationPastCutoff,
};

/** The confirmation's kind, as the registry lists it. */
export const PAID_CONFIRMATION_NOTICE_DELIVERERS: readonly OwedNoticeDeliverer<PaidConfirmationSweepSubject>[] = [PAID_CONFIRMATION];

/**
 * A confirmation that could not be recorded as owed (a booking id that cannot
 * key a marker; unreachable with today's ids): sent once as before #5433,
 * unkeyed, with nothing left for a later run and no officers' alert. Used by
 * the confirm-pending job's zero-balance claim (#5433 PR 4, round 1, item 5).
 * Never throws.
 */
export async function sendUnrecordedPaidBookingConfirmation(bookingId: string, format: ClubFormat, job: string): Promise<void> {
  try {
    const booking = await loadPaidConfirmationBooking(bookingId);
    if (booking) await sendPaidBookingConfirmation(booking, format, undefined);
  } catch (err) {
    logger.error({ err, bookingId, job }, "Failed to send confirmation email");
  }
}

/**
 * After the settle commits: deliver the confirmation from the marker it
 * returned (`MarkBookingPaymentSucceededResult.paidConfirmation`), with the
 * club format the caller resolved before its transaction. The claim is taken
 * on the stamp the settle wrote, so a sweep that already holds the marker wins
 * and this sends nothing. `job` names the caller in the logs. Never throws: a
 * failure is logged and the marker, still standing, is the sweep's.
 */
export async function deliverPaidBookingConfirmation(marker: OwedNoticeMarker, format: ClubFormat, job: string): Promise<void> {
  let subject: PaidConfirmationSubject | null;
  try {
    subject = await loadPaidConfirmationSubject(marker, format);
  } catch (err) {
    logger.error({ err, bookingId: marker.subjectId, job }, "Failed to read a paid booking for its confirmation; a later run sends it");
    return;
  }
  if (!subject) {
    logger.warn({ bookingId: marker.subjectId, job }, "A paid booking was gone before its confirmation was sent; a later run clears its owed notice");
    return;
  }
  await deliverOwedNotice({ ...PAID_CONFIRMATION_DELIVERY, job }, marker, subject);
}
