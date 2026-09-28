/**
 * #3672 (`INV-PAY-108`, owner option B): once an organiser-pays group's
 * settlement is PAID, the organiser has paid the bill they were shown, and
 * nobody else is ever added to it. A member who joins afterwards gets an
 * ordinary member-pays booking — exactly an each-pays-own joiner's — and pays
 * through the normal member payment flow. A joiner who joined while the bill
 * was open but was not on the one the organiser paid is moved to member-pays in
 * the same transaction that marks the settlement paid. So no organiser-settled
 * booking is ever left behind a paid settlement, where nothing could settle it.
 *
 * Both writers hold the global `lock(1)` the whole settlement lifecycle already
 * serialises on (`INV-LOCK-001`): the booking create re-decides a joiner's
 * payer under it, and the paid apply releases the leftovers under it. Whichever
 * commits first, the other sees it. The group-settlement reaper re-applies the
 * release to any paid group still holding a leftover (one left before this rule
 * existed), under the same lock.
 *
 * Neither switches a joiner whose stay has started (check-in on or before the
 * club's today, the `INV-PAY-016` rule): asking them to pay mid-stay is the
 * treasurer's call, so they stay as they are and the treasurer is told once
 * per group.
 */
import {
  BookingStatus,
  GroupBookingPaymentMode,
  GroupBookingStatus,
  PaymentStatus,
  type Prisma,
} from "@prisma/client";
import { CAPTURED_NOT_FULLY_REFUNDED_TRANSACTION_STATUS_LIST } from "@/lib/payment-transaction-status";
import { bookingOwner } from "@/lib/booking-owner";
import { claimAlertCooldown } from "@/lib/alert-cooldown";
import { clubCalendarDateOf, dateOnlyInstantOf } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import {
  sendAdminGroupJoinerStartedStayAlert,
  sendGroupJoinPaySelfEmail,
} from "@/lib/email";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * "The organiser has paid": the settlement holds captured money that was not
 * all handed back — SUCCEEDED or PARTIALLY_REFUNDED, the shared list
 * (`INV-SSOT`). REFUNDED is unpaid: on a live group it is a capture the webhook
 * refunded before it settled anyone, so the organiser still owes.
 */
const ORGANISER_PAID_STATUSES: readonly PaymentStatus[] =
  CAPTURED_NOT_FULLY_REFUNDED_TRANSACTION_STATUS_LIST;

/**
 * The one definition of "the organiser pays for a member joining now": an
 * organiser-pays group whose organiser has not paid. Pure, so the public join
 * page and the join write path give the same answer.
 */
export function organiserPaysForNewJoiner(group: {
  paymentMode: GroupBookingPaymentMode;
  settlement: { status: PaymentStatus } | null;
}): boolean {
  return (
    group.paymentMode === GroupBookingPaymentMode.ORGANISER_PAYS &&
    !(group.settlement && ORGANISER_PAID_STATUSES.includes(group.settlement.status))
  );
}

/**
 * The club's today in the `@db.Date` encoding check-ins are stored in, for the
 * started-stay rule. Read outside every transaction (`INV-LOCK-004`).
 */
export async function clubTodayForStartedStay(now: Date = new Date()): Promise<Date> {
  return dateOnlyInstantOf(
    clubCalendarDateOf(now, await readClubTimeZoneOutsideRequest())
  );
}

/** How a member joining now pays: the mode the join page describes. */
export function paymentModeForNewJoiner(group: {
  paymentMode: GroupBookingPaymentMode;
  settlement: { status: PaymentStatus } | null;
}): GroupBookingPaymentMode {
  return organiserPaysForNewJoiner(group)
    ? GroupBookingPaymentMode.ORGANISER_PAYS
    : GroupBookingPaymentMode.EACH_PAYS_OWN;
}

/**
 * Re-decide, under the caller's `lock(1)`, whether the organiser pays for a
 * joiner being created now. The join path decides before the lock; a
 * settlement paid in between turns the joiner into a member-pays booking here.
 */
export async function organiserPaysForJoinerInTx(
  tx: Prisma.TransactionClient,
  groupBookingId: string
): Promise<boolean> {
  const group = await tx.groupBooking.findUnique({
    where: { id: groupBookingId },
    select: { paymentMode: true, settlement: { select: { status: true } } },
  });
  return group !== null && organiserPaysForNewJoiner(group);
}

/**
 * Statuses an organiser-settled child can be left in once its group's
 * settlement is paid: not paid and still live. The paid apply has just flipped
 * every CONFIRMED child to PAID, so in practice these are joiners the paid bill
 * did not cover (still PAYMENT_PENDING, or held for review).
 */
const LEFT_BEHIND_EXCLUDED_STATUSES = [
  BookingStatus.PAID,
  BookingStatus.CANCELLED,
  BookingStatus.BUMPED,
  BookingStatus.COMPLETED,
] as const;

/** An organiser-settled child no paid bill covers (its parent is added per use). */
const LEFT_BEHIND_CHILD = {
  organiserSettled: true,
  deletedAt: null,
  status: { notIn: [...LEFT_BEHIND_EXCLUDED_STATUSES] },
} satisfies Prisma.BookingWhereInput;

export interface LeftBehindRelease {
  /** Moved to member-pays: tell each to pay. */
  released: string[];
  /** Left as they are because their stay has started: tell the treasurer. */
  skippedStarted: string[];
}

/**
 * Move every organiser-settled child the paid settlement did not cover to
 * member-pays, except one whose stay has started (check-in on or before
 * `clubTodayDateOnly`, from `clubTodayForStartedStay`). Called in the paid
 * apply's transaction, under `lock(1)`, after the settlement is marked
 * SUCCEEDED, and by the reaper's heal under the same lock.
 */
export async function releaseUnpaidJoinersToMemberPaysInTx(
  tx: Prisma.TransactionClient,
  organiserBookingId: string,
  clubTodayDateOnly: Date
): Promise<LeftBehindRelease> {
  const where = {
    parentBookingId: organiserBookingId,
    ...LEFT_BEHIND_CHILD,
  } satisfies Prisma.BookingWhereInput;
  const leftBehind = await tx.booking.findMany({
    where,
    select: { id: true, checkIn: true },
  });
  const started = (b: { checkIn: Date }) =>
    b.checkIn.getTime() <= clubTodayDateOnly.getTime();
  const released = leftBehind.filter((b) => !started(b)).map((b) => b.id);
  const skippedStarted = leftBehind.filter(started).map((b) => b.id);
  if (released.length > 0) {
    await tx.booking.updateMany({
      where: { ...where, id: { in: released } },
      data: { organiserSettled: false },
    });
  }
  return { released, skippedStarted };
}

/**
 * "Once" for the started-stay alert: the claim window outlives any stay, so
 * one `AlertCooldown` row per group means the treasurer is told a single time.
 */
const STARTED_STAY_ALERT_WINDOW_MS = 36_500 * 86_400_000;

/**
 * Tell the treasurer ONCE per group that joiners its paid bill did not cover
 * were left as they are because the stay has started. Claim first, send after,
 * outside any transaction; best-effort, so a failed send never stops the run.
 */
export async function alertStartedLeftBehindJoinersOnce(
  group: {
    groupBookingId: string;
    organiserBookingId: string;
    organiser: { firstName: string; lastName: string };
    checkIn: Date;
  },
  bookingIds: string[]
): Promise<void> {
  try {
    const claimed = await claimAlertCooldown({
      key: `group-joiner-started-stay:${group.groupBookingId}`,
      windowMs: STARTED_STAY_ALERT_WINDOW_MS,
    });
    if (!claimed) return;
    const joiners = await prisma.booking.findMany({
      where: { id: { in: bookingIds } },
      select: {
        memberId: true,
        member: { select: { email: true, firstName: true, lastName: true } },
        // #3369: the owner may be an Organisation; bookingOwner() reads both.
        organisation: { select: { name: true, email: true } },
      },
    });
    logger.warn(
      { groupBookingId: group.groupBookingId, bookingIds },
      "Paid group joiners not covered by the bill, left for the treasurer because the stay has started"
    );
    await sendAdminGroupJoinerStartedStayAlert({
      organiserName: `${group.organiser.firstName} ${group.organiser.lastName}`.trim(),
      organiserBookingId: group.organiserBookingId,
      checkIn: group.checkIn,
      joinerNames: joiners
        .map((b) => {
          const member = bookingOwner(b).member;
          return `${member.firstName} ${member.lastName ?? ""}`.trim();
        })
        .join(", "),
    });
  } catch (err) {
    logger.error(
      { err, groupBookingId: group.groupBookingId },
      "Failed to alert on paid group joiners whose stay has started"
    );
  }
}

/**
 * After the paid apply commits: email each joiner it moved to member-pays that
 * their booking is now theirs to pay. The booking link every booking-scoped
 * message carries opens the pay step. Failures are logged and never undo the
 * settlement or the move.
 */
export async function notifyJoinersReleasedToMemberPays(
  groupBookingId: string,
  organiser: { firstName: string; lastName: string },
  bookingIds: string[]
): Promise<void> {
  const organiserName = `${organiser.firstName} ${organiser.lastName}`.trim();
  const released = await prisma.booking.findMany({
    where: { id: { in: bookingIds } },
    select: {
      id: true,
      memberId: true,
      checkIn: true,
      checkOut: true,
      member: { select: { email: true, firstName: true } },
      // #3369: the owner may be an Organisation; bookingOwner() reads both.
      organisation: { select: { name: true, email: true } },
    },
  });
  for (const booking of released) {
    const owner = bookingOwner(booking);
    try {
      await sendGroupJoinPaySelfEmail({
        bookingContext: { bookingId: booking.id, recipientMemberId: owner.memberId },
        email: owner.member.email,
        firstName: owner.member.firstName,
        organiserName,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
      });
    } catch (emailErr) {
      logger.error(
        { err: emailErr, groupBookingId, bookingId: booking.id },
        "Failed to tell a group joiner to pay for their own place"
      );
    }
  }
}

/**
 * The reaper's self-heal: every live organiser-pays group whose settlement is
 * SUCCEEDED but still has a left-behind organiser-settled child gets the same
 * release, one group per transaction under `lock(1)` with the group re-read
 * inside it, then the same email. A released child is no longer
 * organiser-settled, so it is never selected again and each joiner is emailed
 * at most once. A cancelled group (or organiser booking) is left to the
 * organiser-cancel cleanup, which owns its organiser-settled children. A
 * joiner whose stay has started is left as they are and the treasurer told
 * once per group. Returns how many joiners it moved and how many it skipped.
 */
export async function releaseJoinersLeftBehindPaidSettlements(
  now: Date = new Date()
): Promise<{ released: number; skippedStarted: number }> {
  const clubTodayDateOnly = await clubTodayForStartedStay(now);
  const groups = await prisma.groupBooking.findMany({
    where: {
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      status: { not: GroupBookingStatus.CANCELLED },
      settlement: { is: { status: PaymentStatus.SUCCEEDED } },
      organiserBooking: {
        deletedAt: null,
        status: { not: BookingStatus.CANCELLED },
        linkedBookings: { some: LEFT_BEHIND_CHILD },
      },
    },
    select: {
      id: true,
      organiserBookingId: true,
      organiserMember: { select: { firstName: true, lastName: true } },
      organiserBooking: { select: { checkIn: true } },
    },
  });
  const totals = { released: 0, skippedStarted: 0 };
  for (const group of groups) {
    try {
      const outcome = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        const current = await tx.groupBooking.findUnique({
          where: { id: group.id },
          select: {
            status: true,
            settlement: { select: { status: true } },
            organiserBooking: { select: { status: true, deletedAt: true } },
          },
        });
        if (
          !current ||
          current.status === GroupBookingStatus.CANCELLED ||
          current.settlement?.status !== PaymentStatus.SUCCEEDED ||
          current.organiserBooking.deletedAt !== null ||
          current.organiserBooking.status === BookingStatus.CANCELLED
        ) {
          return { released: [], skippedStarted: [] };
        }
        return releaseUnpaidJoinersToMemberPaysInTx(
          tx,
          group.organiserBookingId,
          clubTodayDateOnly
        );
      });
      const { released, skippedStarted } = outcome;
      if (released.length > 0) {
        totals.released += released.length;
        logger.info(
          { groupBookingId: group.id, releasedCount: released.length },
          "Moved joiners a paid group settlement did not cover to member-pays (#3672)"
        );
        await notifyJoinersReleasedToMemberPays(group.id, group.organiserMember, released);
      }
      if (skippedStarted.length > 0) {
        totals.skippedStarted += skippedStarted.length;
        await alertStartedLeftBehindJoinersOnce(
          {
            groupBookingId: group.id,
            organiserBookingId: group.organiserBookingId,
            organiser: group.organiserMember,
            checkIn: group.organiserBooking.checkIn,
          },
          skippedStarted
        );
      }
    } catch (err) {
      logger.error(
        { err, groupBookingId: group.id },
        "Failed to move a paid group's left-behind joiners to member-pays"
      );
    }
  }
  return totals;
}
