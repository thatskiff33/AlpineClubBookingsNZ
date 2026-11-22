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
 * booking, bump time and variant. After the commit `deliverBumpNotice` claims
 * each marker, sends, and clears it when the send returns; a send that throws
 * leaves it. Each run of the same cron then sweeps what is still owed
 * (`drainOwedBumpNotices`): it claims a due marker, re-reads the booking, and
 * sends, or clears without sending when the booking is gone or no longer
 * cancelled, or when the marker is past its maximum age.
 *
 * Every send is behind a claim: a status-and-stamp guarded `updateMany` on the
 * marker (`claimOwedAlert`). Of two runs reaching one marker exactly one wins
 * and the other sends nothing, so overlapping runs never both send.
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
 * Stated limits: a crash during the provider call itself leaves the member's
 * row QUEUED, which nothing replays (the window every inline send has); a
 * recovered notice arrives on a later run, at least `BUMP_NOTICE_SWEEP_AFTER_MS`
 * after the interrupted attempt; and a booking reinstated and then cancelled
 * again for another reason before the sweep is still told it was bumped.
 *
 * Locks (`INV-LOCK-001`): the markers are written under the global lock and
 * the lodge lock the bump transaction already holds, two primary-key upserts
 * with no read, provider call or settings query (`INV-INT-003`). The claim,
 * the sends and the sweep run after the commit on the base client and take no
 * advisory key.
 */
import { BookingStatus, type Prisma } from "@prisma/client";
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

interface OwedBumpNotice {
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
 * notices as owed, stamped at the bump time. A plain upsert, never
 * `markAlertOwed`: that one catches a unique-key error, and a caught error
 * still aborts a PostgreSQL transaction. `update: {}` leaves an existing
 * marker as it is.
 */
export async function recordBumpNoticesOwed(
  tx: Pick<Prisma.TransactionClient, "alertCooldown">,
  { bookingId, bumpedAt, flagged }: OwedBumpNotice,
): Promise<void> {
  for (const kind of KINDS) {
    const key = bumpNoticeOwedKey(kind, bookingId, bumpedAt, flagged);
    await tx.alertCooldown.upsert({ where: { key }, create: { key, lastAlertedAt: bumpedAt }, update: {} });
  }
}

/** What the notices need, read again by the sweep. */
export const BUMP_NOTICE_BOOKING_SELECT = {
  id: true,
  status: true,
  lodgeId: true,
  checkIn: true,
  checkOut: true,
  memberId: true,
  member: { select: { id: true, email: true, firstName: true, lastName: true, canLogin: true } },
  organisation: { select: { name: true, email: true } },
  guests: { select: { id: true } },
} satisfies Prisma.BookingSelect;

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
 * Under a won claim: send one notice, and clear its marker if the send
 * returned. A send that threw leaves the marker under this claim's stamp, so
 * the sweep offers it again `BUMP_NOTICE_SWEEP_AFTER_MS` later.
 */
async function sendAndSettle(
  kind: BumpNoticeKind,
  key: string,
  claimedAt: Date,
  booking: BumpNoticeBooking,
  owed: OwedBumpNotice,
): Promise<"delivered" | "threw"> {
  const returned =
    kind === "member" ? await sendBumpedMemberNotice(booking, owed) : await alertOfficersOfBump(booking, owed.flagged);
  if (!returned) return "threw";
  await settleOwedAlert({ key, claimedAt });
  return "delivered";
}

/**
 * After the bump commits: deliver one of its notices. The claim is taken on
 * the marker as the transaction stamped it (`bumpedAt`), so a sweep that
 * already claimed it wins and this sends nothing. Never throws: a failure is
 * logged and the marker, if it still stands, is the sweep's.
 */
export async function deliverBumpNotice(
  kind: BumpNoticeKind,
  booking: BumpNoticeBooking,
  flagged: boolean,
  bumpedAt: Date,
): Promise<void> {
  const owed = { bookingId: booking.id, bumpedAt, flagged };
  const key = bumpNoticeOwedKey(kind, booking.id, bumpedAt, flagged);
  try {
    const claimedAt = await claimOwedAlert({ key, stampedNoLaterThan: bumpedAt });
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

export interface OwedBumpNoticeSweepResult {
  /** Due markers offered to this run. */
  checked: number;
  /** Notices whose send returned, and whose marker was cleared. */
  delivered: number;
  /** Cleared without a send: the booking is gone or no longer cancelled. */
  cleared: number;
  /** Cleared without a send, with an error log: past the maximum age, or unreadable. */
  expired: number;
}

type SweepOutcome = "delivered" | "threw" | "cleared" | "expired" | "claim-lost";

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
  if (!booking || booking.status !== BookingStatus.CANCELLED) {
    logger.warn(
      { key, bookingId: owed.bookingId, status: booking?.status ?? null, job: "confirmPendingBookings" },
      "An owed bump notice's booking is gone or no longer cancelled; cleared without sending it",
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
