/**
 * #3672 (`INV-PAY-XXX`, owner option B): once an organiser-pays group's
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
 * commits first, the other sees it.
 */
import {
  BookingStatus,
  GroupBookingPaymentMode,
  PaymentStatus,
  type Prisma,
} from "@prisma/client";

/**
 * The one definition of "the organiser pays for a member joining now": an
 * organiser-pays group whose settlement has not been paid. Pure, so the public
 * join page and the join write path give the same answer.
 */
export function organiserPaysForNewJoiner(group: {
  paymentMode: GroupBookingPaymentMode;
  settlement: { status: PaymentStatus } | null;
}): boolean {
  return (
    group.paymentMode === GroupBookingPaymentMode.ORGANISER_PAYS &&
    group.settlement?.status !== PaymentStatus.SUCCEEDED
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
    organiserSettled: true,
    deletedAt: null,
    status: { notIn: [...LEFT_BEHIND_EXCLUDED_STATUSES] },
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
