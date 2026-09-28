/**
 * #3672 (`INV-PAY-109`, owner option B): once an organiser-pays group's
 * settlement is PAID, the organiser has paid the bill they were shown, and
 * nobody else is ever added to it. A member who joins afterwards gets an
 * ordinary member-pays booking — exactly an each-pays-own joiner's — and pays
 * through the normal member payment flow. A joiner who joined while the bill
 * was open but was not on the one the organiser paid is moved to member-pays in
 * the same transaction that marks the settlement paid, whether or not their
 * stay has started (orchestrator decision 3). So no organiser-settled booking
 * is ever left behind a paid settlement, where nothing could settle it.
 *
 * Who is told differs. A joiner who can pay now (`PAYMENT_PENDING`) and whose
 * stay has not started is emailed to pay, at most once. A joiner whose stay has
 * started is not emailed mid-stay: the treasurer is alerted once per group and
 * collects by hand, through the ordinary admin mark-paid or card paths the
 * switched booking now accepts. Every switch writes a payer-switch booking
 * event inside the switch transaction; it is the durable record, and the
 * treasurer's alert is re-driven from it until it reaches someone.
 *
 * Both writers hold the global `lock(1)` the whole settlement lifecycle already
 * serialises on (`INV-LOCK-001`): the booking create re-decides a joiner's
 * payer under it, and the paid apply switches the leftovers under it. Whichever
 * commits first, the other sees it. The group-settlement reaper re-applies the
 * switch to any paid group still holding a leftover (one left before this rule
 * existed), under the same lock.
 */
import {
  BookingEventType,
  BookingStatus,
  GroupBookingPaymentMode,
  GroupBookingStatus,
  type PaymentStatus,
  type Prisma,
} from "@prisma/client";
import { bookingOwner } from "@/lib/booking-owner";
import {
  ACTIVE_BOOKING_STATUSES,
  isPaidLikeBookingStatus,
} from "@/lib/booking-status";
import { bookingStayHasStarted } from "@/lib/booking-edit-policy";
import { sendAdminAlertOnceEver } from "@/lib/admin-alert-once";
import { clubTodayForStartedStay } from "@/lib/club-today-for-started-stay";
import {
  sendAdminGroupJoinerStartedStayAlert,
  sendGroupJoinPaySelfEmail,
} from "@/lib/email";
import {
  ORGANISER_PAID_SETTLEMENT_STATUSES,
  organiserHasPaidSettlement,
} from "@/lib/group-organiser-paid";
import {
  asGroupJoinerPaysOwnSnapshot,
  GROUP_JOINER_PAYS_OWN_EVENT_KIND,
  GROUP_JOINER_PAYS_OWN_EVENT_REASON,
  type GroupJoinerPaysOwnEventSnapshot,
} from "@/lib/manual-settlement-reversal-event";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

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
    !organiserHasPaidSettlement(group.settlement)
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
 * The statuses a left-behind joiner is switched from: live and not yet paid
 * for, derived from the shared lists (`INV-SSOT`) rather than re-listed —
 * PENDING, PAYMENT_PENDING, CONFIRMED and AWAITING_REVIEW today. The paid apply
 * has just flipped every CONFIRMED child it settled to PAID, so in practice
 * these are joiners the paid bill did not cover.
 */
const LEFT_BEHIND_STATUSES: BookingStatus[] = ACTIVE_BOOKING_STATUSES.filter(
  (status) => !isPaidLikeBookingStatus(status)
);

/** An organiser-settled child no paid bill covers (its parent is added per use). */
const LEFT_BEHIND_CHILD = {
  organiserSettled: true,
  deletedAt: null,
  status: { in: LEFT_BEHIND_STATUSES },
} satisfies Prisma.BookingWhereInput;

export interface JoinerPayerSwitch {
  /** Every joiner switched to paying for themselves. */
  switchedCount: number;
  /** Switched, awaiting payment, stay not started: email each to pay. */
  emailToPay: string[];
  /** Switched, stay started: not emailed; the treasurer is told once per group. */
  startedStay: string[];
}

export const NO_PAYER_SWITCH: JoinerPayerSwitch = {
  switchedCount: 0,
  emailToPay: [],
  startedStay: [],
};

/**
 * Switch every organiser-settled child the paid settlement did not cover to
 * member-pays, and record a payer-switch event for each, in the caller's
 * transaction under `lock(1)`: the paid apply's, after the settlement is marked
 * SUCCEEDED, and the reaper's heal. What is returned — and so who is emailed
 * or named to the treasurer — is exactly the rows the guarded update changed.
 *
 * The event insert is direct rather than through `recordBookingEvent`, which
 * swallows a failure and would leave the transaction aborted: a failed insert
 * rolls the switch back with it, so no switch is ever left without its record.
 */
export async function releaseUnpaidJoinersToMemberPaysInTx(
  tx: Prisma.TransactionClient,
  group: { groupBookingId: string; organiserBookingId: string },
  clubTodayDateOnly: Date
): Promise<JoinerPayerSwitch> {
  const switched = await tx.booking.updateManyAndReturn({
    where: { parentBookingId: group.organiserBookingId, ...LEFT_BEHIND_CHILD },
    data: { organiserSettled: false },
    select: { id: true, status: true, checkIn: true },
  });
  if (switched.length === 0) return NO_PAYER_SWITCH;
  const rows = switched.map((booking) => ({
    ...booking,
    stayStarted: bookingStayHasStarted(booking.checkIn, clubTodayDateOnly),
  }));
  await tx.bookingEvent.createMany({
    data: rows.map((booking) => {
      const snapshot: GroupJoinerPaysOwnEventSnapshot = {
        kind: GROUP_JOINER_PAYS_OWN_EVENT_KIND,
        groupBookingId: group.groupBookingId,
        organiserBookingId: group.organiserBookingId,
        bookingStatus: booking.status,
        stayStarted: booking.stayStarted,
      };
      return {
        bookingId: booking.id,
        // A marker that cancels nothing (`SETTLEMENT_MARKERS`).
        type: BookingEventType.CANCELLED,
        actorMemberId: null,
        amountCents: null,
        reason: GROUP_JOINER_PAYS_OWN_EVENT_REASON,
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
      };
    }),
  });
  return {
    switchedCount: rows.length,
    emailToPay: rows
      .filter((b) => !b.stayStarted && b.status === BookingStatus.PAYMENT_PENDING)
      .map((b) => b.id),
    startedStay: rows.filter((b) => b.stayStarted).map((b) => b.id),
  };
}

/** The treasurer's alert key for one group: one claim, ever, per group. */
function startedStayAlertKey(groupBookingId: string): string {
  return `group-joiner-started-stay:${groupBookingId}`;
}

/**
 * Tell the treasurer ONCE per group that joiners its paid bill did not cover
 * were switched to paying for themselves mid-stay, without an email. The
 * claim's keep, one-day hold or give-back follows the send's result
 * (`sendAdminAlertOnceEver`); a held or given-back claim is retried by the
 * group-settlement cycle (`alertStartedStayPayerSwitches`). Never throws;
 * returns whether the claim was kept.
 */
export async function alertStartedStayJoinersOnce(
  group: {
    groupBookingId: string;
    organiserBookingId: string;
    organiser: { firstName: string; lastName: string };
    checkIn: Date;
  },
  bookingIds: string[]
): Promise<boolean> {
  return sendAdminAlertOnceEver({
    key: startedStayAlertKey(group.groupBookingId),
    label: "mid-stay group joiner alert",
    context: { groupBookingId: group.groupBookingId },
    send: async () => {
      const joiners = await prisma.booking.findMany({
        where: { id: { in: bookingIds } },
        select: {
          id: true,
          memberId: true,
          member: { select: { email: true, firstName: true, lastName: true } },
          // #3369: the owner may be an Organisation; bookingOwner() reads both.
          organisation: { select: { name: true, email: true } },
        },
      });
      logger.warn(
        { groupBookingId: group.groupBookingId, bookingIds },
        "Paid group joiners switched to paying for themselves mid-stay; alerting the treasurer"
      );
      return sendAdminGroupJoinerStartedStayAlert({
        organiserName: `${group.organiser.firstName} ${group.organiser.lastName}`.trim(),
        organiserBookingId: group.organiserBookingId,
        checkIn: group.checkIn,
        joiners: joiners.map((b) => {
          const member = bookingOwner(b).member;
          return { name: `${member.firstName} ${member.lastName ?? ""}`.trim(), bookingId: b.id };
        }),
      });
    },
  });
}

/**
 * After the switch commits: email each joiner who can pay now that their
 * booking is theirs to pay. The booking link every booking-scoped message
 * carries opens the pay step. At most once: a failure is logged and never
 * retried, and never undoes the settlement or the switch; the payer-switch
 * event is the record. Never throws.
 */
export async function notifyJoinersReleasedToMemberPays(
  groupBookingId: string,
  organiser: { firstName: string; lastName: string },
  bookingIds: string[]
): Promise<void> {
  const organiserName = `${organiser.firstName} ${organiser.lastName}`.trim();
  try {
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
  } catch (err) {
    logger.error(
      { err, groupBookingId, bookingIds },
      "Failed to load switched group joiners to tell them to pay; the switch stands"
    );
  }
}

/**
 * The treasurer's mid-stay alert, re-driven from the payer-switch events: every
 * group with a switched joiner whose stay had started, who is still unpaid and
 * whose stay has not ended (check-out on or after the club's today, so the scan
 * stays bounded to live stays) gets `alertStartedStayJoinersOnce`. A group
 * already alerted loses the claim and sends nothing; one whose earlier send
 * threw, or reached nobody a day ago, can claim again and is retried here.
 * Lock-free: it only reads and emails. Returns how many groups' claims it kept.
 */
export async function alertStartedStayPayerSwitches(
  clubTodayDateOnly: Date
): Promise<number> {
  const events = await prisma.bookingEvent.findMany({
    where: {
      type: BookingEventType.CANCELLED,
      AND: [
        { snapshot: { path: ["kind"], equals: GROUP_JOINER_PAYS_OWN_EVENT_KIND } },
        { snapshot: { path: ["stayStarted"], equals: true } },
      ],
      booking: {
        deletedAt: null,
        organiserSettled: false,
        status: { in: LEFT_BEHIND_STATUSES },
        checkOut: { gte: clubTodayDateOnly },
      },
    },
    select: { bookingId: true, snapshot: true },
  });
  const byGroup = new Map<string, string[]>();
  for (const event of events) {
    const snapshot = asGroupJoinerPaysOwnSnapshot(event.snapshot);
    if (!snapshot) continue;
    const ids = byGroup.get(snapshot.groupBookingId) ?? [];
    if (!ids.includes(event.bookingId)) ids.push(event.bookingId);
    byGroup.set(snapshot.groupBookingId, ids);
  }
  if (byGroup.size === 0) return 0;
  const groups = await prisma.groupBooking.findMany({
    where: { id: { in: [...byGroup.keys()] } },
    select: {
      id: true,
      organiserBookingId: true,
      organiserMember: { select: { firstName: true, lastName: true } },
      organiserBooking: { select: { checkIn: true } },
    },
  });
  let alerted = 0;
  for (const group of groups) {
    const sent = await alertStartedStayJoinersOnce(
      {
        groupBookingId: group.id,
        organiserBookingId: group.organiserBookingId,
        organiser: group.organiserMember,
        checkIn: group.organiserBooking.checkIn,
      },
      byGroup.get(group.id) ?? []
    );
    if (sent) alerted += 1;
  }
  return alerted;
}

/**
 * The reaper's self-heal: every live organiser-pays group whose organiser has
 * paid but still has a left-behind organiser-settled child gets the same
 * switch, one group per transaction under `lock(1)` with the group re-read
 * inside it, then the same email. A switched child is no longer
 * organiser-settled, so it is never selected again. A cancelled group (or
 * organiser booking) is left to the organiser-cancel cleanup, which owns its
 * organiser-settled children. Then the treasurer's mid-stay alerts are sent or
 * retried. Returns how many joiners it switched and how many groups it alerted.
 */
export async function releaseJoinersLeftBehindPaidSettlements(
  now: Date = new Date()
): Promise<{ released: number; startedStayAlerts: number }> {
  const clubTodayDateOnly = await clubTodayForStartedStay(now);
  const groups = await prisma.groupBooking.findMany({
    where: {
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      status: { not: GroupBookingStatus.CANCELLED },
      settlement: { is: { status: { in: [...ORGANISER_PAID_SETTLEMENT_STATUSES] } } },
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
  let released = 0;
  for (const group of groups) {
    let outcome: JoinerPayerSwitch;
    try {
      outcome = await prisma.$transaction(async (tx) => {
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
          !organiserHasPaidSettlement(current.settlement) ||
          current.organiserBooking.deletedAt !== null ||
          current.organiserBooking.status === BookingStatus.CANCELLED
        ) {
          return NO_PAYER_SWITCH;
        }
        return releaseUnpaidJoinersToMemberPaysInTx(
          tx,
          { groupBookingId: group.id, organiserBookingId: group.organiserBookingId },
          clubTodayDateOnly
        );
      });
    } catch (err) {
      logger.error(
        { err, groupBookingId: group.id },
        "Failed to move a paid group's left-behind joiners to member-pays"
      );
      continue;
    }
    if (outcome.switchedCount === 0) continue;
    released += outcome.switchedCount;
    logger.info(
      { groupBookingId: group.id, switchedCount: outcome.switchedCount },
      "Moved joiners a paid group settlement did not cover to member-pays (#3672)"
    );
    if (outcome.emailToPay.length > 0) {
      await notifyJoinersReleasedToMemberPays(group.id, group.organiserMember, outcome.emailToPay);
    }
  }
  const startedStayAlerts = await alertStartedStayPayerSwitches(clubTodayDateOnly).catch((err) => {
    logger.error({ err }, "Failed to send or retry the mid-stay group joiner alerts");
    return 0;
  });
  return { released, startedStayAlerts };
}
