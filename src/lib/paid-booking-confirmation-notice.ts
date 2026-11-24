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
 *   COMPLETED): cancelled, refunded or reversed. Checked by the sweep and
 *   again just before every send, so neither sends for such a booking;
 * - rendered afresh from the booking as it stands (`sendPaidBookingConfirmation`):
 *   the confirmation's body is never kept (`SENSITIVE_EMAIL_LOG_TEMPLATES`),
 *   which is also why the email retry job can never replay one, before or
 *   after this change, so nothing here has to retire a replay;
 * - the cut-off is the end of the check-in day in the club's time zone
 *   (`paidConfirmationSendBy`, through the club-time kernel), or seven days
 *   after the payment, whichever comes first; past it the notice is cleared
 *   and the officers are alerted once (`alertOfficersOncePastCutoff`).
 *
 * A send that returns is not proof the member was told: the email core returns
 * without throwing for a suppressed address (`BOUNCED`), a fail-closed "No
 * emails" read or an environment fault (`FAILED`, which for this body-less
 * template nothing replays), and an empty or placeholder address (no row at
 * all). So every send is followed by a read of the email's own row
 * (`email/keyed-email-state.ts`, the rule the waitlist offer shares): told
 * (sent, or withheld by "No emails" or a non-production copy), settled; held
 * by the retry job, kept for it; anything else, the officers are alerted once,
 * through the same claim as the past-cut-off alert.
 *
 * Who owes it: only the three callers that send the confirmation ask the
 * settle to record it (`owesPaidConfirmation`): the Stripe webhook, the
 * confirm-payment route and the confirm-pending job's saved-card charge. The
 * other card doors send none, or only on an officer's choice, as before.
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
import { calendarDateOfDateOnlyInstant, endOfClubDayInclusive, type ClubTimeZone } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { sendAdminBookingConfirmationUnsentAlert } from "@/lib/email/admin-alerts-booking-confirmation-unsent";
import { durableEmailLogId } from "@/lib/email/attempt-log";
import { BOOKING_CONFIRMED_TEMPLATE_NAME } from "@/lib/email/booking-confirmed-template";
import { isToldKeyedEmailState, readKeyedEmailState } from "@/lib/email/keyed-email-state";
import logger from "@/lib/logger";
import { deliverOwedNotice, type OwedNoticeDeliverer, type OwedNoticeOutcome, type OwedNoticeRun } from "@/lib/owed-notice/deliver";
import { alertOfficersOncePastCutoff } from "@/lib/owed-notice/past-cutoff-once";
import { owedNoticeEventKey, type OwedNoticeMarker } from "@/lib/owed-notice/store";
import {
  loadPaidConfirmationBooking,
  sendPaidBookingConfirmation,
  type PaidConfirmationBooking,
} from "@/lib/paid-booking-confirmation-email";
import { BOOKING_CONFIRMED_KIND } from "@/lib/paid-booking-confirmation-owed";

/** How long after its stamp a sweep takes a confirmation's marker, so the attempt right after the settle goes first. */
export const PAID_CONFIRMATION_SWEEP_AFTER_MS = 30 * 60 * 1000;

/** A confirmation still owed this long after the payment is past its cut-off, whatever the check-in date. */
export const PAID_CONFIRMATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The confirmation as a send needs it: the booking as it stands, and the club's settings read outside any transaction. */
export interface PaidConfirmationSubject {
  booking: PaidConfirmationBooking;
  format: ClubFormat;
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
  return endOfClubDayInclusive(calendarDateOfDateOnlyInstant(checkIn), zone);
}

/** The booking and the club's time zone, read outside any transaction; null when the booking is gone. */
async function loadPaidConfirmationSubject(marker: OwedNoticeMarker, format: ClubFormat): Promise<PaidConfirmationSubject | null> {
  const booking = await loadPaidConfirmationBooking(marker.subjectId);
  if (!booking) return null;
  return { booking, format, zone: await readClubTimeZoneOutsideRequest() };
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
 * What became of the confirmation's email, read from its row: told, settled;
 * held by the email retry job, kept for it; undeliverable or never recorded,
 * the officers are alerted once. Never throws.
 */
async function paidConfirmationOutcome(subject: PaidConfirmationSubject, marker: OwedNoticeMarker, job: string): Promise<OwedNoticeOutcome> {
  const log = { bookingId: marker.subjectId, key: marker.id, job };
  try {
    const state = await readKeyedEmailState(paidConfirmationEmailLogId(marker));
    if (isToldKeyedEmailState(state)) return "settled";
    if (state === "retrying") {
      logger.info(log, "The email retry cron holds this booking confirmation; the owed notice waits for it");
      return "threw";
    }
    logger.warn({ ...log, state }, "The booking confirmation did not reach the owner; alerting the officers instead");
  } catch (err) {
    logger.error({ err, ...log }, "Failed to read the booking confirmation's state after its send");
    return "threw";
  }
  return alertOfficersPaidConfirmationUnsent(subject, marker);
}

/**
 * Send the confirmation with the payment's event key, then read what became
 * of it. A booking that moved on since the payment is not sent (D1): a cancel
 * between the settle and this attempt clears the notice too. Never throws.
 */
async function deliverOwedPaidConfirmation(
  subject: PaidConfirmationSubject,
  marker: OwedNoticeMarker,
  { idempotencyKey, job }: OwedNoticeRun & { idempotencyKey: string },
): Promise<OwedNoticeOutcome> {
  const movedOn = paidConfirmationMovedOn(subject.booking);
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
  return paidConfirmationOutcome(subject, marker, job);
}

/** Past the cut-off: alert the officers once, unless the confirmation did reach the owner after all. */
async function paidConfirmationPastCutoff(subject: PaidConfirmationSubject, marker: OwedNoticeMarker, run: OwedNoticeRun): Promise<OwedNoticeOutcome> {
  try {
    if (isToldKeyedEmailState(await readKeyedEmailState(paidConfirmationEmailLogId(marker)))) return "settled";
  } catch (err) {
    logger.error({ err, key: marker.id, job: run.job }, "Failed to read the booking confirmation's state past its cut-off");
    return "threw";
  }
  logger.error({ bookingId: marker.subjectId, key: marker.id, job: run.job }, "A paid booking's confirmation passed its cut-off unsent; alerting the officers once");
  return alertOfficersPaidConfirmationUnsent(subject, marker);
}

const PAID_CONFIRMATION: OwedNoticeDeliverer<PaidConfirmationSubject> = {
  kind: BOOKING_CONFIRMED_KIND,
  job: "card-payment-confirmation",
  audience: "member",
  sweepAfterMs: PAID_CONFIRMATION_SWEEP_AFTER_MS,
  unreachedRetryAfterMs: ALERT_NOBODY_ELIGIBLE_RETRY_MS,
  maxAgeMs: PAID_CONFIRMATION_MAX_AGE_MS,
  load: async (marker) => loadPaidConfirmationSubject(marker, await clubFormatValues()),
  stillOwed: async ({ booking }) => paidConfirmationMovedOn(booking) ?? true,
  sendBy: ({ booking, zone }) => paidConfirmationSendBy(booking.checkIn, zone),
  pastCutoff: paidConfirmationPastCutoff,
  idempotencyKey: paidConfirmationKey,
  deliver: deliverOwedPaidConfirmation,
};

/** The confirmation's kind, as the registry lists it. */
export const PAID_CONFIRMATION_NOTICE_DELIVERERS: readonly OwedNoticeDeliverer<PaidConfirmationSubject>[] = [PAID_CONFIRMATION];

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
  await deliverOwedNotice({ ...PAID_CONFIRMATION, job }, marker, subject);
}
