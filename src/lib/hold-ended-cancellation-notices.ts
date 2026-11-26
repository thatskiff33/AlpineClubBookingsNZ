/**
 * #5433 PR 4 (CP-4, CP-5): THE NOTICES OF A HOLD THAT ENDED IN CANCELLATION
 * ARE OWED UNTIL SENT.
 *
 * At the end of the check-in day the confirm-pending job cancels two kinds of
 * still-unpaid PENDING booking, each with an email to its owner and one final
 * alert to the officers, sent after the cancel commits:
 * - a booking made from an approved booking request (#2012): the requester's
 *   `booking-request-payment-expired`, the officers'
 *   `admin-booking-request-hold-cancelled`;
 * - a split booking's provisional guest portion (#1993): the member's
 *   `split-guest-portion-cancelled`, the officers'
 *   `admin-split-settlement-cancelled`. Both wordings depend on whether the
 *   member's own booking was settled (`parentUnpaid`), which is worked out in
 *   the cancel's transaction and so travels in each marker's payload.
 * A rerun finds the booking CANCELLED and never reaches them again. So the
 * cancel records both as owed IN ITS OWN TRANSACTION
 * (`recordHoldEndedNoticesOwed`), as its last write; after the commit
 * `deliverHoldEndedNotices` claims, sends and clears each, the member's first
 * as before #5433, and the sweep (`drainOwedNotices`) sends what that attempt
 * never did. The claim, the clear and the sweep are the mechanism's
 * (`owed-notice/deliver.ts`).
 *
 * The kinds:
 * - the wait: 30 minutes after the cancel or the last attempt; an officers'
 *   alert that reached nobody waits a day;
 * - the member's email carries the event key `<bookingId>:<cancelledAtMs>`, so
 *   one cancel has one `EmailLog` row and the member can never be sent it
 *   twice; what became of it is read from that row
 *   (`owed-notice/member-email.ts`): not told (it failed for good, bounced, or
 *   the owner has no address that can be emailed), the officers are alerted
 *   once ("Booking email not sent");
 * - "moved on": the booking is gone, deleted, or no longer CANCELLED. Stated
 *   limit: a booking reinstated and cancelled again in between still counts as
 *   cancelled, and is sent this notice;
 * - the cut-off (settled by the lane: cancellation notices until the check-out
 *   date): the member's email until the end of the check-out day in the
 *   club's time zone, or seven days after the cancel (owner decision D7's
 *   limit for a confirmation, applied here), whichever comes first; past it
 *   the officers are alerted once. The officers' alert: seven days, then
 *   cleared with an error log. The cut-off is the sweep's only: the attempt
 *   right after the cancel always sends, as before #5433.
 *
 * Locks (`INV-LOCK-001`): the markers are one insert of two rows on primary
 * keys, under the `lock(1)` and lodge lock the cancel already holds, with no
 * read, provider call or settings query (`INV-INT-003`). Everything else here
 * runs after the commit on the base client and takes no advisory key.
 */
import { BookingStatus, type Prisma } from "@prisma/client";

import { ALERT_NOBODY_ELIGIBLE_RETRY_MS } from "@/lib/alert-cooldown";
import {
  alertOfficersBookingNoticeUnsent,
  OWED_BOOKING_NOTICE_SELECT,
  owedNoticeOwnerName,
  type OwedBookingNotice,
} from "@/lib/booking-notice-unsent-alert";
import { bookingOwner } from "@/lib/booking-owner";
import { formatBookingReference } from "@/lib/booking-reference";
import type { ClubFormat } from "@/lib/club-format";
import { clubFormatValues } from "@/lib/club-format-server";
import { calendarDateOfDateOnlyInstant, endOfClubDayInclusive, type ClubTimeZone } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import {
  sendAdminBookingRequestHoldCancelledEmail,
  sendAdminSplitSettlementCancelledAlert,
  sendBookingRequestPaymentExpiredEmail,
  sendSplitGuestPortionCancelledEmail,
} from "@/lib/email";
import { durableEmailLogId } from "@/lib/email/attempt-log";
import logger from "@/lib/logger";
import {
  deliverOwedNotice,
  OWED_OFFICER_ALERT_MAX_AGE_MS,
  type OwedNoticeDeliverer,
  type OwedNoticeImmediateDeliverer,
  type OwedNoticeOutcome,
  type OwedNoticeRun,
} from "@/lib/owed-notice/deliver";
import type { OwedNoticeKind } from "@/lib/owed-notice/kinds";
import {
  OWED_MEMBER_NOTICE_MAX_AGE_MS,
  OWED_MEMBER_NOTICE_SWEEP_AFTER_MS,
  owedMemberEmailOutcome,
  owedMemberEmailPastCutoff,
  type OwedMemberEmail,
} from "@/lib/owed-notice/member-email";
import { owedOfficerAlertOutcome } from "@/lib/owed-notice/officer-alert";
import {
  owedNoticeEventKey,
  owedNoticeInputProblem,
  owedNoticeMarker,
  recordOwedNotices,
  type OwedNoticeInput,
  type OwedNoticeMarker,
} from "@/lib/owed-notice/store";
import { prisma } from "@/lib/prisma";

/** Which hold ended: a request booking's (#2012), or a split booking's guest portion (#1993). */
export type HoldEnded = "request" | "split-guest";

type Audience = "member" | "officers";

const AUDIENCES: readonly Audience[] = ["member", "officers"];

const KIND: Record<HoldEnded, Record<Audience, OwedNoticeKind>> = {
  request: { member: "request-hold-cancelled-member", officers: "request-hold-cancelled-officers" },
  "split-guest": { member: "split-guest-cancelled-member", officers: "split-guest-cancelled-officers" },
};

/** The member email's template, for its `EmailLog` id. */
const MEMBER_TEMPLATE: Record<HoldEnded, string> = {
  request: "booking-request-payment-expired",
  "split-guest": "split-guest-portion-cancelled",
};

/** The payload field that carries `parentUnpaid` (1 or 0) for a split guest portion. */
const PARENT_UNPAID = "parentUnpaid";

/** One cancel's owed notices: which hold, the booking, the instant that keys and stamps them, and the split wording fact. */
export interface OwedHoldEndedNotices {
  ended: HoldEnded;
  bookingId: string;
  cancelledAt: Date;
  /** The split guest portion's: whether the member's own booking was not settled. Null for a request booking. */
  parentUnpaid: boolean | null;
}

function holdEndedInput(audience: Audience, owed: OwedHoldEndedNotices): OwedNoticeInput {
  return {
    kind: KIND[owed.ended][audience],
    subjectId: owed.bookingId,
    eventAt: owed.cancelledAt,
    payload: owed.parentUnpaid === null ? null : { [PARENT_UNPAID]: owed.parentUnpaid ? 1 : 0 },
  };
}

/**
 * Inside the cancel's transaction, as its last write, under the locks it
 * already holds: record both notices as owed, and return the descriptor the
 * delivery claims with (`INV-SSOT-002`). Whether they can be written is asked
 * first (`owedNoticeInputProblem`), without a write: an input that cannot key
 * a marker is an error log, nothing is recorded and null comes back, so the
 * marker can never roll the cancel back for a reason of shape (a database
 * failure of the insert still rolls it back, like any write in it).
 */
export async function recordHoldEndedNoticesOwed(
  tx: Pick<Prisma.TransactionClient, "owedNotice">,
  { ended, bookingId, parentUnpaid = null }: { ended: HoldEnded; bookingId: string; parentUnpaid?: boolean | null },
): Promise<OwedHoldEndedNotices | null> {
  const owed: OwedHoldEndedNotices = { ended, bookingId, cancelledAt: new Date(), parentUnpaid };
  const inputs = AUDIENCES.map((audience) => holdEndedInput(audience, owed));
  const problem = inputs.map(owedNoticeInputProblem).find((found) => found !== null);
  if (problem) {
    logger.error({ bookingId, problem }, "A cancelled hold cannot key its owed notices; the cancel commits and nothing is recorded as owed");
    return null;
  }
  await recordOwedNotices(tx, inputs);
  return owed;
}

/** The booking as a send needs it, and the club's format, read outside any transaction. */
interface HoldEndedSubject {
  booking: OwedBookingNotice;
  format: ClubFormat;
}

/** The sweep's subject: the same, plus the club's time zone the member's cut-off needs. */
interface HoldEndedSweepSubject extends HoldEndedSubject {
  zone: ClubTimeZone;
}

/** Which hold a marker's kind is for. */
function endedOf(marker: OwedNoticeMarker): HoldEnded {
  return marker.kind === KIND.request.member || marker.kind === KIND.request.officers ? "request" : "split-guest";
}

/**
 * The split wording fact, from the payload. A marker whose payload cannot be
 * read is taken as unsettled: only a settled parent is promised that the
 * member's own booking still stands, as before #5433.
 */
function parentUnpaidOf(marker: OwedNoticeMarker): boolean {
  const payload = marker.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload) && payload[PARENT_UNPAID] === 0) return false;
  return true;
}

/** The member's email, from the booking as it stands, with the cancel's event key. Throws when the send does. */
async function sendHoldEndedMemberEmail(booking: OwedBookingNotice, marker: OwedNoticeMarker, idempotencyKey: string): Promise<void> {
  const owner = bookingOwner(booking);
  if (endedOf(marker) === "request") {
    await sendBookingRequestPaymentExpiredEmail({
      bookingContext: { bookingId: booking.id, recipientMemberId: owner.memberId },
      email: owner.member.email,
      firstName: owner.member.firstName,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      lodgeId: booking.lodgeId,
      idempotencyKey,
    });
    return;
  }
  await sendSplitGuestPortionCancelledEmail({
    bookingId: booking.id,
    recipientMemberId: owner.memberId,
    email: owner.member.email,
    firstName: owner.member.firstName,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    // parentUnpaid conflates unpaid/cancelled/bumped parents, so only
    // promise "your own booking remains confirmed" when the parent is
    // genuinely settled (parentUnpaid === false).
    parentConfirmed: !parentUnpaidOf(marker),
    parentBookingReference: booking.parentBookingId && formatBookingReference(booking.parentBookingId),
    lodgeId: booking.lodgeId,
    idempotencyKey,
  });
}

/** The member's email as the shared reading takes it, and the alert it raises. */
function holdEndedMemberEmail(booking: OwedBookingNotice, marker: OwedNoticeMarker, idempotencyKey: string, job: string): OwedMemberEmail {
  const ended = endedOf(marker);
  return {
    emailLogId: durableEmailLogId(MEMBER_TEMPLATE[ended], idempotencyKey),
    label: ended === "request" ? "requester's booking-released email" : "member's guest-portion-cancelled email",
    log: { bookingId: marker.subjectId, key: marker.id, job },
    alertOfficers: () => alertOfficersBookingNoticeUnsent(marker, ended === "request" ? "request-hold-cancelled" : "split-guest-cancelled", booking),
  };
}

/** Send the member's email, then read what became of it. Never throws. */
async function deliverHoldEndedMember(
  { booking }: HoldEndedSubject,
  marker: OwedNoticeMarker,
  { idempotencyKey, job }: OwedNoticeRun & { idempotencyKey: string },
): Promise<OwedNoticeOutcome> {
  try {
    await sendHoldEndedMemberEmail(booking, marker, idempotencyKey);
  } catch (err) {
    logger.error(
      { err, bookingId: booking.id, job },
      endedOf(marker) === "request"
        ? "Failed to send requester payment-expired email for auto-cancelled request booking (#2012)"
        : "Failed to send member cancellation email for auto-cancelled split child (#1993)",
    );
    return "threw";
  }
  return owedMemberEmailOutcome(holdEndedMemberEmail(booking, marker, idempotencyKey, job));
}

/** The officers' one final notice, from the booking as it stands. Never throws. */
function deliverHoldEndedOfficers({ booking, format }: HoldEndedSubject, marker: OwedNoticeMarker, { job }: OwedNoticeRun): Promise<OwedNoticeOutcome> {
  const details = {
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    guestCount: booking.guests.length,
    totalCents: booking.finalPriceCents,
  };
  const log = { bookingId: booking.id, job };
  return endedOf(marker) === "request"
    ? owedOfficerAlertOutcome("final admin notice for an auto-cancelled request booking (#2012)", log, () =>
        sendAdminBookingRequestHoldCancelledEmail({ requesterName: owedNoticeOwnerName(booking), ...details }, format),
      )
    : owedOfficerAlertOutcome("final admin notice for an auto-cancelled split child (#1993)", log, () =>
        sendAdminSplitSettlementCancelledAlert({ memberName: owedNoticeOwnerName(booking), ...details, parentUnpaid: parentUnpaidOf(marker) }, format),
      );
}

/** Null when the cancel's notices are still owed; otherwise why the booking moved on. */
export function holdEndedMovedOn(booking: Pick<OwedBookingNotice, "status" | "deletedAt">): string | null {
  if (booking.deletedAt) return "the booking was deleted";
  if (booking.status !== BookingStatus.CANCELLED) return `the booking is ${booking.status}`;
  return null;
}

/** The member's cut-off: the last instant of the check-out day in the club's time zone (the stored date-only night, through the kernel). */
export function holdEndedMemberSendBy(checkOut: Date, zone: ClubTimeZone): Date {
  return endOfClubDayInclusive(calendarDateOfDateOnlyInstant(checkOut), zone);
}

async function loadHoldEndedSweepSubject(marker: OwedNoticeMarker): Promise<HoldEndedSweepSubject | null> {
  const booking = await prisma.booking.findUnique({ where: { id: marker.subjectId }, select: OWED_BOOKING_NOTICE_SELECT });
  if (!booking) return null;
  return { booking, format: await clubFormatValues(), zone: await readClubTimeZoneOutsideRequest() };
}

/** The member's email's event key: one `EmailLog` row per cancel. */
const holdEndedMemberKey = (marker: OwedNoticeMarker) => owedNoticeEventKey(marker.subjectId, marker.eventAt);

/** What the member kinds share, for the delivery after the commit and the sweep alike. */
const MEMBER_DELIVERY = {
  job: "confirmPendingBookings",
  audience: "member" as const,
  sweepAfterMs: OWED_MEMBER_NOTICE_SWEEP_AFTER_MS,
  unreachedRetryAfterMs: ALERT_NOBODY_ELIGIBLE_RETRY_MS,
  idempotencyKey: holdEndedMemberKey,
  deliver: deliverHoldEndedMember,
};

/** What the officer kinds share. */
const OFFICERS_DELIVERY = {
  job: "confirmPendingBookings",
  audience: "officers" as const,
  sweepAfterMs: OWED_MEMBER_NOTICE_SWEEP_AFTER_MS,
  unreachedRetryAfterMs: ALERT_NOBODY_ELIGIBLE_RETRY_MS,
  deliver: deliverHoldEndedOfficers,
};

const SWEEP_COMMON = {
  load: loadHoldEndedSweepSubject,
  stillOwed: async ({ booking }: HoldEndedSweepSubject) => holdEndedMovedOn(booking) ?? true,
};

function memberSweepDeliverer(ended: HoldEnded): OwedNoticeDeliverer<HoldEndedSweepSubject> {
  return {
    ...MEMBER_DELIVERY,
    ...SWEEP_COMMON,
    kind: KIND[ended].member,
    maxAgeMs: OWED_MEMBER_NOTICE_MAX_AGE_MS,
    sendBy: ({ booking, zone }) => holdEndedMemberSendBy(booking.checkOut, zone),
    pastCutoff: ({ booking }, marker, run) => owedMemberEmailPastCutoff(holdEndedMemberEmail(booking, marker, holdEndedMemberKey(marker), run.job)),
  };
}

function officersSweepDeliverer(ended: HoldEnded): OwedNoticeDeliverer<HoldEndedSweepSubject> {
  return {
    ...OFFICERS_DELIVERY,
    ...SWEEP_COMMON,
    kind: KIND[ended].officers,
    maxAgeMs: OWED_OFFICER_ALERT_MAX_AGE_MS,
    sendBy: (_subject, marker) => new Date(marker.eventAt.getTime() + OWED_OFFICER_ALERT_MAX_AGE_MS),
  };
}

/** The four kinds, each hold's member notice first, as the registry lists them. */
export const HOLD_ENDED_NOTICE_DELIVERERS: readonly OwedNoticeDeliverer<HoldEndedSweepSubject>[] = (["request", "split-guest"] as const).flatMap(
  (ended) => [memberSweepDeliverer(ended), officersSweepDeliverer(ended)],
);

/** The delivery after the commit for one audience's marker. */
function immediateDeliverer(audience: Audience, kind: OwedNoticeKind, job: string): OwedNoticeImmediateDeliverer<HoldEndedSubject> {
  return audience === "member" ? { ...MEMBER_DELIVERY, kind, job } : { ...OFFICERS_DELIVERY, kind, job };
}

/**
 * After the cancel commits: deliver both notices, the member's first, from the
 * descriptor `recordHoldEndedNoticesOwed` returned inside the transaction, with
 * the booking as the transaction read it and the club format the caller
 * resolved before it. Each claim is taken on the stamp the transaction wrote,
 * so a sweep that already holds a marker wins and this sends nothing. Never
 * throws.
 */
export async function deliverHoldEndedNotices(booking: OwedBookingNotice, owed: OwedHoldEndedNotices, format: ClubFormat, job: string): Promise<void> {
  for (const audience of AUDIENCES) {
    const input = holdEndedInput(audience, owed);
    await deliverOwedNotice(immediateDeliverer(audience, input.kind, job), owedNoticeMarker(input), { booking, format });
  }
}
