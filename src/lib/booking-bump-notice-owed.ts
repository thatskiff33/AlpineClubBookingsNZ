/**
 * #5407 item 13, moved onto the owed-notice mechanism by #5433: THE BUMP
 * NOTICES ARE OWED UNTIL SENT.
 *
 * When the confirm-pending cron bumps a pending booking (its dates filled up),
 * the member is emailed (`booking-bumped`, or `booking-guests-cancelled` for a
 * booking flagged to cancel if its guests could not come) and the officers are
 * alerted (`admin-booking-bumped`). Both are sent after the bump commits, and
 * a rerun finds the booking CANCELLED and never reaches them again. So the
 * cron records them as owed IN THE BUMP'S OWN TRANSACTION
 * (`recordBumpNoticesOwed`): one `OwedNotice` marker per notice, keyed by kind,
 * booking, bump time and variant and stamped with the bump time, which is
 * taken there once and handed back as the descriptor the delivery claims with.
 * After the commit `deliverBumpNotices` claims each marker, sends, and clears
 * it when the notice is settled. The sweep (`drainOwedNotices`, run by the
 * confirm-pending job and the email retry job) sends what is still owed. The
 * claim, the clear and the sweep are the mechanism's (`owed-notice/deliver.ts`);
 * this module supplies the two kinds' deliverers.
 *
 * The two kinds, as before #5433:
 * - the wait: a marker is swept once its stamp (the bump, or the last
 *   attempt) is at least `BUMP_NOTICE_SWEEP_AFTER_MS` (an hour) old; an
 *   officers' alert that reached nobody waits `ALERT_NOBODY_ELIGIBLE_RETRY_MS`
 *   (a day), so a persistent fault writes at most about seven
 *   undeliverable-alert escalation rows before the marker expires;
 * - the maximum age, and the cut-off: `BUMP_NOTICE_MAX_AGE_MS` (seven days);
 *   past it the marker is cleared with an error log and nothing is sent, and
 *   no officer alert is raised;
 * - the member's email carries the event key `<bookingId>:<bumpedAtMs>`
 *   (`bumpNoticeIdempotencyKey`), so one bump has one `EmailLog` row;
 * - the officers' alert is at least once (`booking-bump-alert.ts`).
 *
 * "Moved on": the sweep clears without sending when the booking is gone, no
 * longer cancelled, or has a `CANCELLED`, `MEMBER_PAID` or
 * `NON_MEMBER_CONFIRMED` booking event after the bump (reinstated and then
 * cancelled or confirmed again; a settlement marker, a `CANCELLED` event that
 * cancels nothing, does not count). Most of those events are narrative,
 * written best effort after their own commits (`recordBookingEvent`); only a
 * few decision records commit with what they describe. A narrative event
 * lost the same way still leaves the booking told it was bumped. This narrows
 * the gap; it does not close it.
 *
 * BLUE-GREEN (#5433): a release before #5433 wrote these markers to
 * `AlertCooldown` under the `booking-bump-member-owed:` and
 * `booking-bump-officers-owed:` prefixes, and may run beside this one; markers
 * it wrote before the deploy outlive it. `legacyBumpMarkerSource` keeps
 * sweeping those prefixes with the same stamp-guarded claim
 * (`claimOwedAlert`, which shares its stamp rule with the table's claim) and
 * the same event key. One bump is committed by exactly one release, so its
 * markers are in one table; whichever release reaches a legacy marker first
 * wins it. It goes once two releases have shipped with the table.
 *
 * Locks (`INV-LOCK-001`): the markers are written under the global lock and
 * the lodge lock the bump transaction already holds, one primary-key insert
 * with no read, provider call or settings query (`INV-INT-003`). The claim,
 * the sends and the sweep run after the commit on the base client and take no
 * advisory key.
 */
import { BookingEventType, BookingStatus, Prisma } from "@prisma/client";
import {
  ALERT_NOBODY_ELIGIBLE_RETRY_MS,
  claimOwedAlert,
  deferAlertCooldown,
  listOwedAlertKeys,
  settleOwedAlert,
} from "@/lib/alert-cooldown";
import { alertOfficersOfBump } from "@/lib/booking-bump-alert";
import { bookingOwner } from "@/lib/booking-owner";
import { sendBookingBumpedEmail, sendBookingGuestsCancelledEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { NOT_A_SETTLEMENT_MARKER_WHERE } from "@/lib/manual-settlement-reversal-event";
import {
  deliverOwedNotice,
  OWED_OFFICER_ALERT_MAX_AGE_MS,
  type OwedNoticeDeliverer,
  type OwedNoticeOutcome,
  type OwedNoticeRef,
  type OwedNoticeSource,
} from "@/lib/owed-notice/deliver";
import type { OwedNoticeKind } from "@/lib/owed-notice/kinds";
import { owedNoticeId, owedNoticeMarker, recordOwedNotices, type OwedNoticeMarker } from "@/lib/owed-notice/store";
import { prisma } from "@/lib/prisma";

/**
 * How long a marker waits after its last attempt before the sweep tries it:
 * the attempt right after the commit goes first, and a send that threw is not
 * retried every few minutes. An officers' alert that reached nobody waits
 * `ALERT_NOBODY_ELIGIBLE_RETRY_MS` (a day) instead.
 */
export const BUMP_NOTICE_SWEEP_AFTER_MS = 60 * 60 * 1000;

/**
 * A marker older than this is cleared with an error log and nothing is sent:
 * the officers' alerts' seven days (#5433, settled by the lane), which the
 * bump's member email shares, as it has since #5407.
 */
export const BUMP_NOTICE_MAX_AGE_MS = OWED_OFFICER_ALERT_MAX_AGE_MS;

export type BumpNoticeKind = "member" | "officers";

const KINDS: readonly BumpNoticeKind[] = ["member", "officers"];

/** The `OwedNotice.kind` of each notice. */
const KIND: Record<BumpNoticeKind, OwedNoticeKind> = {
  member: "booking-bump-member",
  officers: "booking-bump-officers",
};

/** The variant in the id: g, the guests-cancelled notice; b, the bumped one. */
const FLAGGED_VARIANT = "g";
const BUMPED_VARIANT = "b";

const variantOf = (flagged: boolean) => (flagged ? FLAGGED_VARIANT : BUMPED_VARIANT);

/**
 * One notice's marker id. The bump time is in it because a cancelled booking
 * can be reinstated and bumped again, and that bump owes its own notices.
 */
export function bumpNoticeId(kind: BumpNoticeKind, bookingId: string, bumpedAt: Date, flagged: boolean): string {
  return owedNoticeId(KIND[kind], bookingId, bumpedAt, variantOf(flagged));
}

/** The member email's event key: one EmailLog row per bump, the format #5407 shipped. */
export function bumpNoticeIdempotencyKey(bookingId: string, bumpedAt: Date): string {
  return `${bookingId}:${bumpedAt.getTime()}`;
}

/** One bump's owed notices: the booking, the variant, and the instant that keys and stamps the markers. */
export interface OwedBumpNotice {
  bookingId: string;
  bumpedAt: Date;
  flagged: boolean;
}

function bumpMarkerInput(kind: BumpNoticeKind, owed: OwedBumpNotice) {
  return { kind: KIND[kind], subjectId: owed.bookingId, eventAt: owed.bumpedAt, variant: variantOf(owed.flagged) };
}

/**
 * Inside the bump's transaction, under its global and lodge locks: record both
 * notices as owed, stamped with the bump time, and return the descriptor the
 * delivery claims with, so the stamp and the claim's bound are one value
 * (`INV-SSOT-002`). One insert that skips a marker already there, never a
 * caught unique-key error, which would abort a PostgreSQL transaction.
 */
export async function recordBumpNoticesOwed(
  tx: Pick<Prisma.TransactionClient, "owedNotice">,
  { bookingId, flagged, bumpedAt = new Date() }: { bookingId: string; flagged: boolean; bumpedAt?: Date },
): Promise<OwedBumpNotice> {
  const owed = { bookingId, bumpedAt, flagged };
  await recordOwedNotices(
    tx,
    KINDS.map((kind) => bumpMarkerInput(kind, owed)),
  );
  return owed;
}

/** What the notices need, read again by the sweep. */
export const BUMP_NOTICE_BOOKING_SELECT = Prisma.validator<Prisma.BookingSelect>()({
  id: true,
  status: true,
  lodgeId: true,
  checkIn: true,
  checkOut: true,
  memberId: true,
  member: { select: { id: true, email: true, firstName: true, lastName: true, canLogin: true } },
  organisation: { select: { name: true, email: true } },
  guests: { select: { id: true } },
});

export type BumpNoticeBooking = Prisma.BookingGetPayload<{ select: typeof BUMP_NOTICE_BOOKING_SELECT }>;

/**
 * The member's email, with the bump's event key. Settled when the send
 * returned (sent, already recorded, withheld or skipped); threw when it threw,
 * logged.
 */
async function sendBumpedMemberNotice(
  booking: BumpNoticeBooking,
  flagged: boolean,
  { idempotencyKey, job }: { idempotencyKey: string; job: string },
): Promise<OwedNoticeOutcome> {
  const owner = bookingOwner(booking);
  const context = { bookingId: booking.id, recipientMemberId: owner.memberId, idempotencyKey };
  try {
    if (flagged) {
      await sendBookingGuestsCancelledEmail(
        context,
        owner.member.email,
        owner.member.firstName,
        booking.checkIn,
        booking.checkOut,
        booking.lodgeId,
      );
    } else {
      await sendBookingBumpedEmail(
        context,
        owner.member.email,
        owner.member.firstName,
        booking.checkIn,
        booking.checkOut,
        booking.guests.length,
        booking.lodgeId,
        // #2430: the only send site of this template, and it reaches two
        // recipient classes. A club member (their own pending booking, or a
        // split guest child) can sign in and rebook; the non-login
        // NON_MEMBER/SCHOOL contact who owns a booking converted from a public
        // booking request (#707), or any non-login contact an admin booked for,
        // cannot, so the notice points them at the club contact page instead
        // of the members-only booking flow.
        // #3369: an organisation never signs in, so the notice points a school
        // at the club contact page, the same branch the non-login school
        // contact already took.
        owner.member.canLogin ?? false,
      );
    }
    return "settled";
  } catch (err) {
    logger.error({ err, bookingId: booking.id, job }, "Failed to send bumped email");
    return "threw";
  }
}

/**
 * Booking events that mean the booking moved on after this bump: reinstated
 * and then cancelled again, or confirmed again. The bump itself writes
 * `BUMPED` only, and no event type records a reinstatement on its own. A
 * settlement marker is a `CANCELLED` event that cancels nothing, and can be
 * written on a booking already cancelled, so it is left out.
 */
const MOVED_ON_SINCE_BUMP: BookingEventType[] = [
  BookingEventType.CANCELLED,
  BookingEventType.MEMBER_PAID,
  BookingEventType.NON_MEMBER_CONFIRMED,
];

/** True to send; otherwise why the booking must not be told it was bumped. Read outside any transaction. */
async function bumpNoticeStillOwed(booking: BumpNoticeBooking, marker: OwedNoticeMarker): Promise<true | string> {
  if (booking.status !== BookingStatus.CANCELLED) return "no longer cancelled";
  const later = await prisma.bookingEvent.findFirst({
    where: {
      bookingId: marker.subjectId,
      type: { in: MOVED_ON_SINCE_BUMP },
      occurredAt: { gt: marker.eventAt },
      ...NOT_A_SETTLEMENT_MARKER_WHERE,
    },
    select: { type: true },
  });
  return later ? `recorded ${later.type} since the bump` : true;
}

const isFlagged = (marker: OwedNoticeMarker) => marker.variant === FLAGGED_VARIANT;

/** What both bump kinds share: the read, the moved-on check, the wait and the cut-off. */
const BUMP_KIND_COMMON = {
  job: "confirmPendingBookings",
  sweepAfterMs: BUMP_NOTICE_SWEEP_AFTER_MS,
  unreachedRetryAfterMs: ALERT_NOBODY_ELIGIBLE_RETRY_MS,
  maxAgeMs: BUMP_NOTICE_MAX_AGE_MS,
  load: (marker: OwedNoticeMarker) =>
    prisma.booking.findUnique({ where: { id: marker.subjectId }, select: BUMP_NOTICE_BOOKING_SELECT }),
  stillOwed: bumpNoticeStillOwed,
  sendBy: (_booking: BumpNoticeBooking, marker: OwedNoticeMarker) => new Date(marker.eventAt.getTime() + BUMP_NOTICE_MAX_AGE_MS),
};

const BUMP_DELIVERER: Record<BumpNoticeKind, OwedNoticeDeliverer<BumpNoticeBooking>> = {
  member: {
    ...BUMP_KIND_COMMON,
    kind: KIND.member,
    audience: "member",
    idempotencyKey: (marker) => bumpNoticeIdempotencyKey(marker.subjectId, marker.eventAt),
    deliver: (booking, marker, context) => sendBumpedMemberNotice(booking, isFlagged(marker), context),
  },
  officers: {
    ...BUMP_KIND_COMMON,
    kind: KIND.officers,
    audience: "officers",
    deliver: (booking, marker, { job }) => alertOfficersOfBump(booking, isFlagged(marker), job),
  },
};

/** The two bump kinds, member first, as the registry lists them. */
export const BUMP_NOTICE_DELIVERERS: readonly OwedNoticeDeliverer<BumpNoticeBooking>[] = KINDS.map(
  (kind) => BUMP_DELIVERER[kind],
);

/**
 * After the bump commits: deliver one of its notices. The claim is taken on
 * the marker as the transaction stamped it (`owed.bumpedAt`), so a sweep that
 * already claimed it wins and this sends nothing. Never throws.
 */
export async function deliverBumpNotice(
  kind: BumpNoticeKind,
  booking: BumpNoticeBooking,
  owed: OwedBumpNotice,
): Promise<void> {
  await deliverOwedNotice(BUMP_DELIVERER[kind], owedNoticeMarker(bumpMarkerInput(kind, owed)), booking);
}

/**
 * After the bump commits: deliver both notices, the member's first, from the
 * descriptor `recordBumpNoticesOwed` returned inside the transaction.
 */
export async function deliverBumpNotices(booking: BumpNoticeBooking, owed: OwedBumpNotice): Promise<void> {
  for (const kind of KINDS) await deliverBumpNotice(kind, booking, owed);
}

// ---------------------------------------------------------------------------
// The bump markers a release before #5433 wrote to `AlertCooldown`.
// ---------------------------------------------------------------------------

/** The `AlertCooldown` prefix each kind's markers carried before #5433. */
const LEGACY_PREFIX: Readonly<Partial<Record<OwedNoticeKind, string>>> = {
  [KIND.member]: "booking-bump-member-owed:",
  [KIND.officers]: "booking-bump-officers-owed:",
};

/** A legacy marker's `AlertCooldown` key: `<prefix><bookingId>:<bumpedAtMs>:<g|b>`. */
export function legacyBumpNoticeKey(kind: BumpNoticeKind, bookingId: string, bumpedAt: Date, flagged: boolean): string {
  return `${LEGACY_PREFIX[KIND[kind]]}${bookingId}:${bumpedAt.getTime()}:${variantOf(flagged)}`;
}

/** A legacy key read as the marker it stands for, or null when it cannot be read. */
function parseLegacyBumpNoticeKey(kind: OwedNoticeKind, key: string): OwedNoticeMarker | null {
  const [bookingId, bumpedAtMs, variant, ...rest] = key.slice(LEGACY_PREFIX[kind]!.length).split(":");
  const bumpedAt = new Date(Number(bumpedAtMs));
  if (!bookingId || rest.length > 0 || Number.isNaN(bumpedAt.getTime())) return null;
  if (variant !== FLAGGED_VARIANT && variant !== BUMPED_VARIANT) return null;
  return owedNoticeMarker({ kind, subjectId: bookingId, eventAt: bumpedAt, variant });
}

function legacyRef(kind: OwedNoticeKind, key: string): OwedNoticeRef {
  return {
    key,
    marker: parseLegacyBumpNoticeKey(kind, key),
    claim: (stampedNoLaterThan, now) => claimOwedAlert({ key, stampedNoLaterThan, now }),
    settle: (claimedAt) => settleOwedAlert({ key, claimedAt }),
    defer: (claimedAt, waitMs, retryAfterMs) => deferAlertCooldown({ key, claimedAt, windowMs: waitMs, retryAfterMs }),
  };
}

/** The legacy `AlertCooldown` bump markers, for the two bump kinds only. */
export const legacyBumpMarkerSource: OwedNoticeSource = {
  name: "AlertCooldown (bump markers before #5433)",
  async listDue(deliverer, { dueBefore }) {
    const prefix = LEGACY_PREFIX[deliverer.kind];
    if (!prefix) return [];
    // The drain's own bound, as given (`INV-SSOT-002`): stamped no later than `dueBefore`.
    const keys = await listOwedAlertKeys({ prefix, now: dueBefore, retryAfterMs: 0 });
    return keys.map((key) => legacyRef(deliverer.kind, key));
  },
};
