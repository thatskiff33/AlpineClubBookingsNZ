/**
 * Stale organiser-pays group settlement reaper (#1034).
 *
 * Initiating an organiser-pays settlement commits every child booking to
 * CONFIRMED (capacity-holding) before any money is charged. If the organiser
 * abandons the payment (closed tab, declined card never retried), nothing
 * released those beds: the children sat CONFIRMED-but-unpaid until check-in,
 * blocking capacity and the waitlist (PR #801 residual).
 *
 * This cron releases them: a settlement still unpaid (PENDING or FAILED) past
 * its deadline reverts its CONFIRMED unpaid children to PAYMENT_PENDING (their
 * pre-commit, non-capacity-holding state), voids any open Stripe intent so a
 * stale tab cannot capture, notifies the organiser and joiners, records
 * booking events, and triggers waitlist processing for the freed nights.
 *
 * Deadline: `updatedAt + GROUP_SETTLEMENT_REAP_HOURS` (default 48h), clamped
 * to the organiser booking's check-in so beds free before the stay begins,
 * with a two-hour floor so an arrival-day settlement is never reaped while
 * the organiser is mid-payment. A retry resets `updatedAt` (the initiate flow
 * upserts the settlement row), restarting the clock.
 *
 * Idempotent: children are re-read and reverted under the same advisory lock
 * the settle path takes, so a payment that lands just before the reaper wins
 * (SUCCEEDED settlements are skipped inside the lock), and a rerun finds no
 * CONFIRMED children and does nothing.
 *
 * Second phase (#1094): reverted children cannot be paid by the joiner (the
 * organiserSettled flag blocks joiner payment by design), so if the organiser
 * never retries, they would linger in PAYMENT_PENDING forever. Once a FAILED
 * settlement sits unretried through a second full reap window (fresh
 * `updatedAt` from the reap itself, same deadline function), its
 * organiser-settled PAYMENT_PENDING children are cancelled, each exactly
 * once, with a joiner notification. A settlement retry flips the status back
 * to PENDING and resets `updatedAt`, so a retry between reap and expiry
 * always keeps the children alive; both are re-checked on the fresh row
 * inside the advisory lock so a retry racing the cron wins. No capacity or
 * waitlist work is needed — PAYMENT_PENDING holds no beds.
 *
 * Third phase (#1236): resume an organiser-cancel group cleanup that a crash
 * interrupted. A re-invoked cancel 409s upstream (#1160) and never re-enters
 * the cleanup, so this phase re-drives it: an ORGANISER_PAYS group under a
 * CANCELLED organiser booking that still has active organiser-settled children
 * (older than a short grace) is unfinished even though the group fence is
 * already CANCELLED. It re-invokes the same idempotent
 * settleGroupBookingOnOrganiserCancel, whose persisted refund plan reconstructs
 * (never recomputes) the per-child refund mirror. This completes the local
 * booking/capacity/refund-mirror cleanup but does NOT heal the Xero mirror (see
 * resumeInterruptedOrganiserCancels' Xero residual note).
 */
import {
  BookingEventType,
  BookingStatus,
  GroupBookingPaymentMode,
  PaymentStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  RELEASE_ADMIN_CAPACITY_HOLD_UPDATE,
  RELEASE_WHOLE_LODGE_HOLD_UPDATE,
} from "@/lib/booking-status";
import { cancelPaymentIntentIfCancellable } from "@/lib/stripe";
import { settleGroupBookingOnOrganiserCancel } from "@/lib/group-cancel";
import { reconcileBedAllocationsForBookingWithGlobalLockHeld } from "@/lib/bed-allocation-lifecycle";
import { recordBookingEvent } from "@/lib/booking-events";
import { processWaitlistForDates } from "@/lib/waitlist";
import {
  sendGroupSettlementExpiredEmail,
  sendGroupJoinReleasedEmail,
  sendGroupJoinCancelledEmail,
} from "@/lib/email";
import logger from "@/lib/logger";

const GROUP_SETTLEMENT_REAP_HOURS =
  Number(process.env.GROUP_SETTLEMENT_REAP_HOURS) || 48;

/**
 * Grace before the resume phase re-drives an interrupted organiser-cancel
 * cleanup. The organiser Booking's `updatedAt` is not touched by
 * settleGroupBookingOnOrganiserCancel, so `updatedAt < now - grace` cleanly
 * excludes a cleanup that has only just started (default 15 minutes).
 */
const GROUP_CANCEL_RESUME_GRACE_MINUTES =
  Number(process.env.GROUP_CANCEL_RESUME_GRACE_MINUTES) || 15;

/** Floor so an arrival-day settlement is not reaped while mid-payment. */
const MIN_GRACE_MS = 2 * 60 * 60 * 1000;

export interface GroupSettlementReapResult {
  scanned: number;
  reaped: number;
  releasedChildBookings: number;
  /** FAILED settlements whose reverted children were cancelled this run. */
  expiredSettlements: number;
  cancelledChildBookings: number;
  /** Interrupted organiser-cancel cleanups found by the resume phase (#1236). */
  scannedInterruptedCancels: number;
  /** Interrupted organiser-cancel cleanups this run re-drove to completion. */
  resumedInterruptedCancels: number;
}

/** The reap deadline for one settlement (exported for the operator dashboard). */
export function groupSettlementReapDeadline(
  updatedAt: Date,
  checkIn: Date,
  reapHours: number = GROUP_SETTLEMENT_REAP_HOURS
): Date {
  const windowMs = reapHours * 60 * 60 * 1000;
  return new Date(
    Math.max(
      updatedAt.getTime() + MIN_GRACE_MS,
      Math.min(updatedAt.getTime() + windowMs, checkIn.getTime())
    )
  );
}

const REAPABLE_SETTLEMENT_STATUSES = [
  PaymentStatus.PENDING,
  PaymentStatus.FAILED,
] as const;

const ORGANISER_CANCEL_ACTIVE_CHILD_STATUSES = [
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
] as const;

export async function reapStaleGroupSettlements(
  now: Date = new Date()
): Promise<GroupSettlementReapResult> {
  const candidates = await prisma.groupBookingSettlement.findMany({
    where: { status: { in: [...REAPABLE_SETTLEMENT_STATUSES] } },
    select: {
      id: true,
      status: true,
      amountCents: true,
      updatedAt: true,
      stripePaymentIntentId: true,
      groupBookingId: true,
      groupBooking: {
        select: {
          organiserBookingId: true,
          organiserMember: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
          organiserBooking: { select: { checkIn: true, checkOut: true } },
        },
      },
    },
  });

  const result: GroupSettlementReapResult = {
    scanned: candidates.length,
    reaped: 0,
    releasedChildBookings: 0,
    expiredSettlements: 0,
    cancelledChildBookings: 0,
    scannedInterruptedCancels: 0,
    resumedInterruptedCancels: 0,
  };

  for (const settlement of candidates) {
    const deadline = groupSettlementReapDeadline(
      settlement.updatedAt,
      settlement.groupBooking.organiserBooking.checkIn
    );
    if (now < deadline) {
      continue;
    }

    try {
      const released = await releaseSettlementChildren(settlement.id, {
        organiserBookingId: settlement.groupBooking.organiserBookingId,
      });
      if (released === null || released.length === 0) {
        // Settled (or already reaped) in the meantime — nothing to release,
        // nothing to notify. A rerun lands here, keeping the cron idempotent.
        continue;
      }

      result.reaped += 1;
      result.releasedChildBookings += released.length;

      await finishReap({
        settlement,
        released,
      });
    } catch (err) {
      logger.error(
        { err, settlementId: settlement.id, groupBookingId: settlement.groupBookingId },
        "Failed to reap stale group settlement"
      );
    }
  }

  await expireReapedChildren(now, result);

  await resumeInterruptedOrganiserCancels(now, result);

  return result;
}

/**
 * Resume phase (#1236): re-drive an organiser-cancel group cleanup that a crash
 * interrupted. Since #1160 the cancel path claims the organiser booking to
 * CANCELLED atomically and calls settleGroupBookingOnOrganiserCancel only on the
 * winning cancel; a re-invoked cancel 409s and never re-enters cleanup, so a
 * crash mid-cleanup leaves ORGANISER_PAYS joiner children holding beds / PAID
 * under a CANCELLED organiser booking with nothing to re-drive them.
 *
 * GroupBooking.CANCELLED is now the FIRST, durable settlement fence (#1881), so
 * interrupted work is detected by remaining active organiser-settled children
 * under a CANCELLED organiser booking, regardless of the already-fenced group
 * status. The organiser Booking's `updatedAt` is untouched by the cleanup, so
 * `updatedAt < now - grace` excludes a cleanup that has only just started. Each
 * match re-invokes the same idempotent cleanup — the persisted
 * refund plan makes it reconstruct (never recompute) the per-child refund mirror
 * and the SUCCEEDED guard fires the Stripe refund at most once across re-drives.
 *
 * Credit-note durability (#1257/#1377): a re-drive cannot see a child whose
 * booking already committed CANCELLED (the ACTIVE_CHILD_STATUSES filter
 * excludes it), but this is no longer a gap. settleGroupBookingOnOrganiserCancel
 * now enqueues each child's Xero refund credit note in the SAME transaction as
 * the child cancel + refund mirror, so a CANCELLED child always carries its
 * queued credit-note operation — the crash window is closed for every source,
 * including Internet-Banking children the #1354 daily reconcile self-heal
 * cannot recover. That daily self-heal remains a Stripe-only backstop.
 */
async function resumeInterruptedOrganiserCancels(
  now: Date,
  result: GroupSettlementReapResult
): Promise<void> {
  const graceMs = GROUP_CANCEL_RESUME_GRACE_MINUTES * 60 * 1000;
  const cutoff = new Date(now.getTime() - graceMs);

  const interrupted = await prisma.groupBooking.findMany({
    where: {
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      organiserBooking: {
        status: BookingStatus.CANCELLED,
        deletedAt: null,
        updatedAt: { lt: cutoff },
        linkedBookings: {
          some: {
            organiserSettled: true,
            deletedAt: null,
            status: { in: [...ORGANISER_CANCEL_ACTIVE_CHILD_STATUSES] },
          },
        },
      },
    },
    select: { organiserBookingId: true, organiserMemberId: true },
  });

  result.scannedInterruptedCancels += interrupted.length;

  for (const group of interrupted) {
    try {
      // Actor = organiserMemberId (a real Member FK); ipAddress is the cron tag.
      await settleGroupBookingOnOrganiserCancel(
        group.organiserBookingId,
        group.organiserMemberId,
        "cron:group-cancel-resume"
      );
      result.resumedInterruptedCancels += 1;
    } catch (err) {
      logger.error(
        { err, organiserBookingId: group.organiserBookingId },
        "Failed to resume interrupted organiser-cancel group cleanup"
      );
    }
  }
}

/**
 * Second phase (#1094): cancel PAYMENT_PENDING organiser-settled children of
 * FAILED settlements that sat unretried through another full reap window.
 * Scanned fresh after phase one so a settlement reaped in this run (whose
 * `updatedAt` the reap just refreshed) is never expired in the same run.
 */
async function expireReapedChildren(
  now: Date,
  result: GroupSettlementReapResult
): Promise<void> {
  const failedSettlements = await prisma.groupBookingSettlement.findMany({
    where: { status: PaymentStatus.FAILED },
    select: {
      id: true,
      status: true,
      updatedAt: true,
      groupBookingId: true,
      groupBooking: {
        select: {
          organiserBookingId: true,
          organiserMember: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
          organiserBooking: { select: { checkIn: true, checkOut: true } },
        },
      },
    },
  });

  for (const settlement of failedSettlements) {
    const deadline = groupSettlementReapDeadline(
      settlement.updatedAt,
      settlement.groupBooking.organiserBooking.checkIn
    );
    if (now < deadline) {
      continue;
    }

    try {
      const cancelled = await cancelReapedChildren(settlement.id, {
        organiserBookingId: settlement.groupBooking.organiserBookingId,
        checkIn: settlement.groupBooking.organiserBooking.checkIn,
        now,
      });
      if (cancelled === null || cancelled.length === 0) {
        // Retried, settled, or already expired in the meantime — nothing to
        // cancel, nothing to notify. A rerun lands here, keeping the cron
        // idempotent.
        continue;
      }

      result.expiredSettlements += 1;
      result.cancelledChildBookings += cancelled.length;

      await finishExpiry({ settlement, cancelled });
    } catch (err) {
      logger.error(
        { err, settlementId: settlement.id, groupBookingId: settlement.groupBookingId },
        "Failed to expire reaped group settlement children"
      );
    }
  }
}

type ReleasedChild = {
  id: string;
  checkIn: Date;
  checkOut: Date;
  // The child's own lodge: the freed beds are at this lodge, so its waitlist
  // queue (not the default lodge's) is the one to re-process (multi-lodge).
  lodgeId: string;
  memberId: string;
  memberEmail: string;
  memberFirstName: string;
};

/**
 * Revert the settlement's CONFIRMED unpaid children to PAYMENT_PENDING under
 * the same advisory lock the settle path takes. Returns null when the
 * settlement succeeded in the meantime (payment race — the payment wins).
 */
async function releaseSettlementChildren(
  settlementId: string,
  { organiserBookingId }: { organiserBookingId: string }
): Promise<ReleasedChild[] | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

    const current = await tx.groupBookingSettlement.findUnique({
      where: { id: settlementId },
      select: { status: true },
    });
    if (
      !current ||
      !(REAPABLE_SETTLEMENT_STATUSES as readonly PaymentStatus[]).includes(
        current.status
      )
    ) {
      return null;
    }

    const children = await tx.booking.findMany({
      where: {
        parentBookingId: organiserBookingId,
        organiserSettled: true,
        deletedAt: null,
        status: BookingStatus.CONFIRMED,
      },
      select: {
        id: true,
        checkIn: true,
        checkOut: true,
        lodgeId: true,
        member: { select: { id: true, email: true, firstName: true } },
      },
    });

    const claimedChildren: typeof children = [];
    for (const child of children) {
      // Status-guarded revert (#1881): CONFIRMED -> PAYMENT_PENDING only. Under
      // the shared lock(1) a concurrent settle (which now also takes lock(1))
      // cannot interleave; the guard makes the no-clobber guarantee structural.
      const reverted = await tx.booking.updateMany({
        where: { id: child.id, status: BookingStatus.CONFIRMED },
        data: { status: BookingStatus.PAYMENT_PENDING },
      });
      if (reverted.count === 0) continue;
      claimedChildren.push(child);
      // PAYMENT_PENDING does not hold capacity: drop the bed allocations.
      await reconcileBedAllocationsForBookingWithGlobalLockHeld({
        bookingId: child.id,
        db: tx,
        previousRange: { checkIn: child.checkIn, checkOut: child.checkOut },
      });
    }

    // Write FAILED (bumping `updatedAt`) only when this pass did real work —
    // released children, or recorded the PENDING→FAILED abandonment. The
    // update restarts the clock the expiry phase (#1094) measures its second
    // window from, so re-writing it on every no-op pass over an already
    // FAILED settlement would keep reverted children in PAYMENT_PENDING
    // forever.
    if (claimedChildren.length > 0 || current.status !== PaymentStatus.FAILED) {
      // Status-guarded FAILED claim (#1881): never overwrite a settlement a
      // concurrent settle already moved to SUCCEEDED/REFUNDED under lock(1).
      await tx.groupBookingSettlement.updateMany({
        where: {
          id: settlementId,
          status: {
            notIn: [
              PaymentStatus.SUCCEEDED,
              PaymentStatus.REFUNDED,
              PaymentStatus.PARTIALLY_REFUNDED,
            ],
          },
        },
        data: { status: PaymentStatus.FAILED },
      });
    }

    return claimedChildren.map((child) => ({
      id: child.id,
      checkIn: child.checkIn,
      checkOut: child.checkOut,
      lodgeId: child.lodgeId,
      memberId: child.member.id,
      memberEmail: child.member.email,
      memberFirstName: child.member.firstName,
    }));
  });
}

/**
 * Cancel the settlement's reverted PAYMENT_PENDING children under the same
 * advisory lock the settle path takes. Returns null when the settlement was
 * retried (PENDING again), paid (SUCCEEDED), or its expiry clock restarted in
 * the meantime — the retry always wins.
 */
async function cancelReapedChildren(
  settlementId: string,
  {
    organiserBookingId,
    checkIn,
    now,
  }: { organiserBookingId: string; checkIn: Date; now: Date }
): Promise<ReleasedChild[] | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

    const current = await tx.groupBookingSettlement.findUnique({
      where: { id: settlementId },
      select: { status: true, updatedAt: true },
    });
    if (!current || current.status !== PaymentStatus.FAILED) {
      return null;
    }
    // Re-check the expiry deadline on the fresh row: a failed retry between
    // the scan and this lock restarted the clock.
    if (now < groupSettlementReapDeadline(current.updatedAt, checkIn)) {
      return null;
    }

    const children = await tx.booking.findMany({
      where: {
        parentBookingId: organiserBookingId,
        organiserSettled: true,
        deletedAt: null,
        status: BookingStatus.PAYMENT_PENDING,
      },
      select: {
        id: true,
        checkIn: true,
        checkOut: true,
        lodgeId: true,
        member: { select: { id: true, email: true, firstName: true } },
      },
    });

    const claimedChildren: typeof children = [];
    for (const child of children) {
      // Status-guarded cancel (#1881): PAYMENT_PENDING -> CANCELLED only, so a
      // concurrent settle retry that moved a child on cannot be clobbered.
      const cancelled = await tx.booking.updateMany({
        where: { id: child.id, status: BookingStatus.PAYMENT_PENDING },
        data: {
          status: BookingStatus.CANCELLED,
          ...RELEASE_ADMIN_CAPACITY_HOLD_UPDATE,
          // Best-effort field clearing (#177): this bulk reaper transition has
          // no per-booking audit context, so it mirrors the capacity-hold
          // sibling — clear the stale hold, no released audit.
          ...RELEASE_WHOLE_LODGE_HOLD_UPDATE,
        },
      });
      if (cancelled.count === 0) continue;
      claimedChildren.push(child);
    }

    return claimedChildren.map((child) => ({
      id: child.id,
      checkIn: child.checkIn,
      checkOut: child.checkOut,
      lodgeId: child.lodgeId,
      memberId: child.member.id,
      memberEmail: child.member.email,
      memberFirstName: child.member.firstName,
    }));
  });
}

/** Post-commit side effects of the expiry phase: record events and notify. */
async function finishExpiry({
  settlement,
  cancelled,
}: {
  settlement: {
    id: string;
    groupBookingId: string;
    groupBooking: {
      organiserMember: { id: string; email: string; firstName: string; lastName: string };
    };
  };
  cancelled: ReleasedChild[];
}) {
  const organiser = settlement.groupBooking.organiserMember;
  const organiserName = `${organiser.firstName} ${organiser.lastName}`.trim();

  for (const child of cancelled) {
    await recordBookingEvent({
      bookingId: child.id,
      type: BookingEventType.CANCELLED,
      reason:
        "The group organiser's combined payment was never completed; this pending place has been cancelled.",
    });

    try {
      await sendGroupJoinCancelledEmail({
        bookingContext: { bookingId: child.id, recipientMemberId: child.memberId },
        email: child.memberEmail,
        firstName: child.memberFirstName,
        organiserName,
        checkIn: child.checkIn,
        checkOut: child.checkOut,
      });
    } catch (err) {
      logger.error(
        { err, bookingId: child.id },
        "Failed to send group join cancelled email to joiner"
      );
    }
  }

  logger.info(
    {
      groupBookingId: settlement.groupBookingId,
      settlementId: settlement.id,
      cancelledCount: cancelled.length,
    },
    "Expired reaped group settlement children"
  );
}

/** Post-commit side effects: void the intent, record events, notify, waitlist. */
async function finishReap({
  settlement,
  released,
}: {
  settlement: {
    id: string;
    amountCents: number;
    stripePaymentIntentId: string | null;
    groupBookingId: string;
    groupBooking: {
      // #2258: the organiser's own booking id gates the settlement emails.
      organiserBookingId: string;
      organiserMember: { id: string; email: string; firstName: string; lastName: string };
      organiserBooking: { checkIn: Date; checkOut: Date };
    };
  };
  released: ReleasedChild[];
}) {
  // Void the abandoned intent so a retained client_secret cannot capture. A
  // failed cancel is logged only: if the stale intent later captures, the
  // webhook safety net refunds it and alerts admins (#1021).
  if (settlement.stripePaymentIntentId) {
    try {
      await cancelPaymentIntentIfCancellable(settlement.stripePaymentIntentId);
    } catch (err) {
      logger.error(
        {
          err,
          settlementId: settlement.id,
          paymentIntentId: settlement.stripePaymentIntentId,
        },
        "Failed to cancel reaped group settlement intent; the webhook safety net covers a late capture"
      );
    }
  }

  for (const child of released) {
    await recordBookingEvent({
      bookingId: child.id,
      type: BookingEventType.BUMPED,
      reason:
        "The group organiser's combined payment was not completed in time; the held spot was released.",
    });
    processWaitlistForDates({
      checkIn: child.checkIn,
      checkOut: child.checkOut,
      // Re-process the freed lodge's own queue, not the default lodge's.
      lodgeId: child.lodgeId,
    }).catch((err) =>
      logger.error(
        { err, bookingId: child.id },
        "Failed to process waitlist after group settlement reap"
      )
    );
  }

  const organiser = settlement.groupBooking.organiserMember;
  const organiserBooking = settlement.groupBooking.organiserBooking;
  const organiserName = `${organiser.firstName} ${organiser.lastName}`.trim();

  try {
    await sendGroupSettlementExpiredEmail({
      bookingContext: {
        bookingId: settlement.groupBooking.organiserBookingId,
        recipientMemberId: organiser.id,
      },
      email: organiser.email,
      firstName: organiser.firstName,
      checkIn: organiserBooking.checkIn,
      checkOut: organiserBooking.checkOut,
      joinerCount: released.length,
      totalCents: settlement.amountCents,
    });
  } catch (err) {
    logger.error(
      { err, groupBookingId: settlement.groupBookingId },
      "Failed to send settlement-expired email to organiser"
    );
  }

  for (const child of released) {
    try {
      await sendGroupJoinReleasedEmail({
        bookingContext: { bookingId: child.id, recipientMemberId: child.memberId },
        email: child.memberEmail,
        firstName: child.memberFirstName,
        organiserName,
        checkIn: child.checkIn,
        checkOut: child.checkOut,
      });
    } catch (err) {
      logger.error(
        { err, bookingId: child.id },
        "Failed to send settlement-expired email to joiner"
      );
    }
  }

  logger.info(
    {
      groupBookingId: settlement.groupBookingId,
      settlementId: settlement.id,
      releasedCount: released.length,
    },
    "Reaped stale group settlement"
  );
}
