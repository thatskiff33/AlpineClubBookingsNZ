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
 */
import {
  BookingStatus,
  GroupBookingPaymentMode,
  GroupBookingStatus,
  PaymentStatus,
  type Prisma,
} from "@prisma/client";
import { isCapturedTransactionStatus } from "@/lib/payment-transaction-status";
import { bookingOwner } from "@/lib/booking-owner";
import { sendGroupJoinPaySelfEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * The one definition of "the organiser pays for a member joining now": an
 * organiser-pays group whose settlement has not captured the organiser's
 * money. A settlement paid and later refunded (in part or whole) still counts
 * as paid: the captured predicate is the shared one (`INV-SSOT`). Pure, so the
 * public join page and the join write path give the same answer.
 */
export function organiserPaysForNewJoiner(group: {
  paymentMode: GroupBookingPaymentMode;
  settlement: { status: PaymentStatus } | null;
}): boolean {
  return (
    group.paymentMode === GroupBookingPaymentMode.ORGANISER_PAYS &&
    !(group.settlement && isCapturedTransactionStatus(group.settlement.status))
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

/**
 * Move every organiser-settled child the paid settlement did not cover to
 * member-pays. Called in the paid apply's transaction, under `lock(1)`, after
 * the settlement is marked SUCCEEDED. Returns the moved booking ids so the
 * caller can tell each joiner to pay for their own place.
 */
export async function releaseUnpaidJoinersToMemberPaysInTx(
  tx: Prisma.TransactionClient,
  organiserBookingId: string
): Promise<string[]> {
  const where = {
    parentBookingId: organiserBookingId,
    ...LEFT_BEHIND_CHILD,
  } satisfies Prisma.BookingWhereInput;
  const leftBehind = await tx.booking.findMany({ where, select: { id: true } });
  if (leftBehind.length === 0) {
    return [];
  }
  await tx.booking.updateMany({
    where: { ...where, id: { in: leftBehind.map((b) => b.id) } },
    data: { organiserSettled: false },
  });
  return leftBehind.map((b) => b.id);
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
 * organiser-cancel cleanup, which owns its organiser-settled children.
 * Returns how many joiners it moved.
 */
export async function releaseJoinersLeftBehindPaidSettlements(): Promise<number> {
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
    },
  });
  let moved = 0;
  for (const group of groups) {
    try {
      const released = await prisma.$transaction(async (tx) => {
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
          return [];
        }
        return releaseUnpaidJoinersToMemberPaysInTx(tx, group.organiserBookingId);
      });
      if (released.length > 0) {
        moved += released.length;
        logger.info(
          { groupBookingId: group.id, releasedCount: released.length },
          "Moved joiners a paid group settlement did not cover to member-pays (#3672)"
        );
        await notifyJoinersReleasedToMemberPays(group.id, group.organiserMember, released);
      }
    } catch (err) {
      logger.error(
        { err, groupBookingId: group.id },
        "Failed to move a paid group's left-behind joiners to member-pays"
      );
    }
  }
  return moved;
}
