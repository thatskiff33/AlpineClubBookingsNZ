/**
 * #5407 item 13: THE BUMP NOTICES ARE OWED UNTIL SENT.
 *
 * When the confirm-pending cron bumps a pending booking (its dates filled up),
 * the member is emailed (`booking-bumped`, or `booking-guests-cancelled` for a
 * booking flagged to cancel if its guests could not come) and the officers are
 * alerted (`admin-booking-bumped`). Both are sent after the bump commits, and
 * a rerun finds the booking CANCELLED and never reaches them again. So a job
 * stopped between the commit and the send, or a send that threw before its
 * EmailLog row existed, used to lose both notices for good.
 *
 * The cron now records them as owed IN THE BUMP'S OWN TRANSACTION
 * (`recordBumpNoticesOwed`): one `AlertCooldown` marker per notice, keyed by
 * booking, bump time and variant and stamped with the bump time, which is
 * taken there once and handed back as the descriptor the delivery claims with.
 * After the commit `deliverBumpNotices` claims each marker, sends, and clears
 * it when the notice is settled; a send that throws, or an officers' alert
 * nobody received that nothing will replay, leaves it. Each run of the same
 * cron also sweeps what is still owed (`drainOwedBumpNotices`): it claims a
 * marker whose stamp (the bump, or the last attempt) is at least
 * `BUMP_NOTICE_SWEEP_AFTER_MS` old, re-reads the booking, and sends, or clears
 * without sending when the booking is gone, no longer cancelled, or cancelled
 * or confirmed again since the bump, or when the marker is past its maximum
 * age.
 *
 * Every send is behind a claim: an `updateMany` on the marker guarded by its
 * stamp (`claimOwedAlert`). Of two runs reaching one marker at the same time
 * exactly one wins and the other sends nothing.
 *
 * What it guarantees:
 * - The member: at most one EmailLog row per bump. The email carries an event
 *   key (`email:<template>:<bookingId>:<bumpedAtMs>`), so a second send finds
 *   the row and sends nothing; a provider failure leaves that row FAILED for
 *   the email retry cron.
 * - The officers: at least once. Their alert has no event key (it is one row
 *   per officer), so a crash after the send and before the marker is cleared
 *   repeats it on a later run. Very rare, and the trade-off already accepted
 *   for other alerts (`caller-retried-alert.ts`, `duplicate-capture-guard.ts`).
 *
 * Stated limits:
 * - A crash during the provider call itself leaves the member's row QUEUED,
 *   which nothing replays (the window every inline send has).
 * - A recovered notice arrives on a later run, at least
 *   `BUMP_NOTICE_SWEEP_AFTER_MS` after the bump or the interrupted attempt.
 * - A send still running `BUMP_NOTICE_SWEEP_AFTER_MS` after its claim, or a
 *   large clock difference between two app instances, lets a sweep claim the
 *   marker again. The member is still sent one email (same event key); the
 *   officers may get their alert twice.
 * - A booking reinstated and then cancelled or confirmed again is caught by
 *   the booking event that records it (`CANCELLED`, `MEMBER_PAID` or
 *   `NON_MEMBER_CONFIRMED` after the bump). Those events are written best
 *   effort after their own commits, so one lost the same way still leaves the
 *   booking told it was bumped. This narrows the gap; it does not close it.
 *
 * Locks (`INV-LOCK-001`): the markers are written under the global lock and
 * the lodge lock the bump transaction already holds, two primary-key upserts
 * with no read, provider call or settings query (`INV-INT-003`). The claim,
 * the sends and the sweep run after the commit on the base client and take no
 * advisory key.
 */
import { BookingEventType, BookingStatus, Prisma } from "@prisma/client";
import { claimOwedAlert, listOwedAlertKeys, settleOwedAlert } from "@/lib/alert-cooldown";
import { alertOfficersOfBump } from "@/lib/booking-bump-alert";
import { bookingOwner } from "@/lib/booking-owner";
import { sendBookingBumpedEmail, sendBookingGuestsCancelledEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/** The namespaces of the owed markers, one per notice. */
export const BUMP_MEMBER_NOTICE_OWED_PREFIX = "booking-bump-member-owed:";
export const BUMP_OFFICER_ALERT_OWED_PREFIX = "booking-bump-officers-owed:";

/**
 * How long a marker waits after its last attempt before the sweep tries it:
 * the attempt right after the commit goes first, and a send that threw is not
 * retried every few minutes.
 */
export const BUMP_NOTICE_SWEEP_AFTER_MS = 60 * 60 * 1000;

/** A marker older than this is cleared with an error log and nothing is sent. */
export const BUMP_NOTICE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type BumpNoticeKind = "member" | "officers";

const KINDS: readonly BumpNoticeKind[] = ["member", "officers"];

const PREFIX: Record<BumpNoticeKind, string> = {
  member: BUMP_MEMBER_NOTICE_OWED_PREFIX,
  officers: BUMP_OFFICER_ALERT_OWED_PREFIX,
};

/** The variant in the key: g, the guests-cancelled notice; b, the bumped one. */
const FLAGGED_VARIANT = "g";
const BUMPED_VARIANT = "b";

/**
 * One notice's owed marker. The bump time is in the key because a cancelled
 * booking can be reinstated and bumped again, and that bump owes its own
 * notices.
 */
export function bumpNoticeOwedKey(
  kind: BumpNoticeKind,
  bookingId: string,
  bumpedAt: Date,
  flagged: boolean,
): string {
  return `${PREFIX[kind]}${bookingId}:${bumpedAt.getTime()}:${flagged ? FLAGGED_VARIANT : BUMPED_VARIANT}`;
}

/** The member email's event key: one EmailLog row per bump. */
export function bumpNoticeIdempotencyKey(bookingId: string, bumpedAt: Date): string {
  return `${bookingId}:${bumpedAt.getTime()}`;
}

/** One bump's owed notices: the booking, the variant, and the instant that keys and stamps the markers. */
export interface OwedBumpNotice {
  bookingId: string;
  bumpedAt: Date;
  flagged: boolean;
}

function parseBumpNoticeOwedKey(kind: BumpNoticeKind, key: string): OwedBumpNotice | null {
  const [bookingId, bumpedAtMs, variant, ...rest] = key.slice(PREFIX[kind].length).split(":");
  const bumpedAt = new Date(Number(bumpedAtMs));
  if (!bookingId || rest.length > 0 || Number.isNaN(bumpedAt.getTime())) return null;
  if (variant !== FLAGGED_VARIANT && variant !== BUMPED_VARIANT) return null;
  return { bookingId, bumpedAt, flagged: variant === FLAGGED_VARIANT };
}

/**
 * Inside the bump's transaction, under its global and lodge locks: record both
 * notices as owed, stamped with the bump time, and return the descriptor the
 * delivery claims with, so the stamp and the claim's bound are one value
 * (`INV-SSOT-002`). A plain upsert, never `markAlertOwed`: that one catches a
 * unique-key error, and a caught error still aborts a PostgreSQL transaction.
 * `update: {}` leaves an existing marker as it is.
 */
export async function recordBumpNoticesOwed(
  tx: Pick<Prisma.TransactionClient, "alertCooldown">,
  { bookingId, flagged, bumpedAt = new Date() }: { bookingId: string; flagged: boolean; bumpedAt?: Date },
): Promise<OwedBumpNotice> {
  for (const kind of KINDS) {
    const key = bumpNoticeOwedKey(kind, bookingId, bumpedAt, flagged);
    await tx.alertCooldown.upsert({ where: { key }, create: { key, lastAlertedAt: bumpedAt }, update: {} });
  }
  return { bookingId, bumpedAt, flagged };
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
 * The member's email, with the bump's event key. True when the send returned
 * (sent, already recorded, withheld or skipped); false when it threw, logged.
 */
async function sendBumpedMemberNotice(booking: BumpNoticeBooking, owed: OwedBumpNotice): Promise<boolean> {
  const owner = bookingOwner(booking);
  const context = {
    bookingId: booking.id,
    recipientMemberId: owner.memberId,
    idempotencyKey: bumpNoticeIdempotencyKey(booking.id, owed.bumpedAt),
  };
  try {
    if (owed.flagged) {
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
    return true;
  } catch (err) {
    logger.error({ err, bookingId: booking.id, job: "confirmPendingBookings" }, "Failed to send bumped email");
    return false;
  }
}

/**
 * Under a won claim: send one notice, and clear its marker if it is settled.
 * A send that threw, or an officers' alert nobody received that nothing will
 * replay, leaves the marker under this claim's stamp, so the sweep offers it
 * again `BUMP_NOTICE_SWEEP_AFTER_MS` later.
 */
async function sendAndSettle(
  kind: BumpNoticeKind,
  key: string,
  claimedAt: Date,
  booking: BumpNoticeBooking,
  owed: OwedBumpNotice,
): Promise<"delivered" | "kept"> {
  const settled =
    kind === "member" ? await sendBumpedMemberNotice(booking, owed) : await alertOfficersOfBump(booking, owed.flagged);
  if (!settled) return "kept";
  await settleOwedAlert({ key, claimedAt });
  return "delivered";
}

/**
 * After the bump commits: deliver one of its notices. The claim is taken on
 * the marker as the transaction stamped it (`owed.bumpedAt`), so a sweep that
 * already claimed it wins and this sends nothing. Never throws: a failure is
 * logged and the marker, if it still stands, is the sweep's.
 */
export async function deliverBumpNotice(
  kind: BumpNoticeKind,
  booking: BumpNoticeBooking,
  owed: OwedBumpNotice,
): Promise<void> {
  const key = bumpNoticeOwedKey(kind, owed.bookingId, owed.bumpedAt, owed.flagged);
  try {
    const claimedAt = await claimOwedAlert({ key, stampedNoLaterThan: owed.bumpedAt });
    if (!claimedAt) {
      logger.info({ key, job: "confirmPendingBookings" }, "Another run holds this bump notice; not sending it here");
      return;
    }
    await sendAndSettle(kind, key, claimedAt, booking, owed);
  } catch (err) {
    logger.error(
      { err, key, job: "confirmPendingBookings" },
      "Failed to claim or clear a bump notice's owed marker; a later run sends what is still owed",
    );
  }
}

/**
 * After the bump commits: deliver both notices, the member's first, from the
 * descriptor `recordBumpNoticesOwed` returned inside the transaction.
 */
export async function deliverBumpNotices(booking: BumpNoticeBooking, owed: OwedBumpNotice): Promise<void> {
  for (const kind of KINDS) await deliverBumpNotice(kind, booking, owed);
}

export interface OwedBumpNoticeSweepResult {
  /** Due markers offered to this run. */
  checked: number;
  /** Notices whose send returned, and whose marker was cleared. */
  delivered: number;
  /** Cleared without a send: the booking is gone, no longer cancelled, or cancelled or confirmed again since the bump. */
  cleared: number;
  /** Cleared without a send, with an error log: past the maximum age, or unreadable. */
  expired: number;
}

type SweepOutcome = "delivered" | "kept" | "cleared" | "expired" | "claim-lost";

/**
 * Booking events that mean the booking moved on after this bump: reinstated
 * and then cancelled again, or confirmed again. The bump itself writes
 * `BUMPED` only, and no event type records a reinstatement on its own.
 */
const MOVED_ON_SINCE_BUMP: BookingEventType[] = [
  BookingEventType.CANCELLED,
  BookingEventType.MEMBER_PAID,
  BookingEventType.NON_MEMBER_CONFIRMED,
];

/** Why the sweep must not tell this booking it was bumped, or null to send. Read outside any transaction. */
async function bumpNoticeNoLongerTrue(booking: { status: BookingStatus } | null, owed: OwedBumpNotice): Promise<string | null> {
  if (!booking) return "gone";
  if (booking.status !== BookingStatus.CANCELLED) return "no longer cancelled";
  const later = await prisma.bookingEvent.findFirst({
    where: { bookingId: owed.bookingId, type: { in: MOVED_ON_SINCE_BUMP }, occurredAt: { gt: owed.bumpedAt } },
    select: { type: true },
  });
  return later ? `recorded ${later.type} since the bump` : null;
}

async function sweepOne(kind: BumpNoticeKind, key: string, dueBefore: Date, now: Date): Promise<SweepOutcome> {
  const claimedAt = await claimOwedAlert({ key, stampedNoLaterThan: dueBefore, now });
  if (!claimedAt) return "claim-lost";
  const owed = parseBumpNoticeOwedKey(kind, key);
  if (!owed || now.getTime() - owed.bumpedAt.getTime() > BUMP_NOTICE_MAX_AGE_MS) {
    logger.error(
      { key, job: "confirmPendingBookings" },
      "A bump notice was still owed past its maximum age, or its marker could not be read; cleared without sending it",
    );
    await settleOwedAlert({ key, claimedAt });
    return "expired";
  }
  const booking = await prisma.booking.findUnique({ where: { id: owed.bookingId }, select: BUMP_NOTICE_BOOKING_SELECT });
  const why = await bumpNoticeNoLongerTrue(booking, owed);
  if (why || !booking) {
    logger.warn(
      { key, bookingId: owed.bookingId, status: booking?.status ?? null, why, job: "confirmPendingBookings" },
      "An owed bump notice's booking is gone, no longer cancelled, or cancelled or confirmed again since the bump; cleared without sending it",
    );
    await settleOwedAlert({ key, claimedAt });
    return "cleared";
  }
  return sendAndSettle(kind, key, claimedAt, booking, owed);
}

/**
 * Each confirm-pending run: send the bump notices still owed. Offers markers
 * last attempted at least `BUMP_NOTICE_SWEEP_AFTER_MS` ago and claims each one
 * on that bound before anything else. Never throws, for one marker or for the
 * read of the list.
 */
export async function drainOwedBumpNotices(now: Date = new Date()): Promise<OwedBumpNoticeSweepResult> {
  const result: OwedBumpNoticeSweepResult = { checked: 0, delivered: 0, cleared: 0, expired: 0 };
  const dueBefore = new Date(now.getTime() - BUMP_NOTICE_SWEEP_AFTER_MS);
  for (const kind of KINDS) {
    let keys: string[];
    try {
      keys = await listOwedAlertKeys({ prefix: PREFIX[kind], now, retryAfterMs: BUMP_NOTICE_SWEEP_AFTER_MS });
    } catch (err) {
      logger.error({ err, kind, job: "confirmPendingBookings" }, "Failed to read the owed bump notices");
      continue;
    }
    for (const key of keys) {
      result.checked += 1;
      try {
        const outcome = await sweepOne(kind, key, dueBefore, now);
        if (outcome === "delivered" || outcome === "cleared" || outcome === "expired") result[outcome] += 1;
      } catch (err) {
        logger.error({ err, key, job: "confirmPendingBookings" }, "Failed to deliver an owed bump notice; it stays owed");
      }
    }
  }
  return result;
}
