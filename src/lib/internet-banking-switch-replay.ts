import type { Payment } from "@prisma/client";

import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { isXeroConnected } from "@/lib/xero";
import {
  enqueueXeroAppliedCreditAllocationOperation,
  enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";

/**
 * What the switch to Internet Banking (`/api/payments/switch-to-internet-banking`)
 * does after its commit, and what it answers when the booking is already on
 * Internet Banking (#4019 review, `INV-PAY-143`). Split from the route so the
 * route's first switch and both of its replays (the early unlocked read and the
 * post-lock re-read) share one queueing step and one answer.
 */

/** The live states a switch acts on: one rule for the locked gate and the early replay. */
export function isLiveSwitchState(booking: {
  deletedAt: Date | null;
  organiserSettled: boolean;
  status: string;
}): boolean {
  return (
    !booking.deletedAt &&
    !booking.organiserSettled &&
    (booking.status === "PAYMENT_PENDING" || booking.status === "CONFIRMED")
  );
}

/**
 * The already-switched answer: the reference and hold the first switch
 * persisted, with a released hold (`internetBankingHoldReleasedAt` set) no
 * longer offered - its beds are not held, whatever the columns beside it say.
 * #4365 (adjacent, not this rule) owns whether a booking that is no longer
 * live gets this answer at all.
 */
export function alreadySwitchedBody(
  payment: Pick<
    Payment,
    "reference" | "internetBankingHoldSlots" | "internetBankingHoldUntil" | "internetBankingHoldReleasedAt"
  >,
  reference: string,
): { reference: string; holdBedSlots: boolean; holdUntil: Date | null } {
  const held = payment.internetBankingHoldReleasedAt == null;
  return {
    reference: payment.reference ?? reference,
    holdBedSlots: held ? payment.internetBankingHoldSlots : false,
    holdUntil: held ? payment.internetBankingHoldUntil : null,
  };
}

/**
 * The Xero invoice and applied-credit allocation a switch queues after its
 * commit. Both enqueues are idempotent - an invoice already linked, already
 * queued (PENDING or RUNNING), or resolved by hand in Xero queues nothing - so a
 * replay on a LIVE booking runs this too: a first switch whose enqueue failed
 * after its commit (logged only) is healed by the member's retry. Nothing else
 * would heal it: the automatic `MISSING_PRIMARY_INVOICE` repair reads PAID
 * bookings only. Best-effort, as the first switch's always was: a failure is
 * logged and the switch's answer stands.
 *
 * The outbox enqueue reads no booking status, and every caller runs after its
 * transaction with no lock held (the early replay read its booking with none at
 * all), so a cancellation can commit between the caller's read and this line.
 * The booking's live state is therefore read again here, and a booking no
 * longer live (`isLiveSwitchState`) queues nothing. A cancel landing after this
 * re-read is the same narrow window the first switch's own enqueue always had.
 */
export async function queueSwitchInvoiceAfterCommit(bookingId: string, memberId: string): Promise<void> {
  try {
    const current = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: { status: true, deletedAt: true, organiserSettled: true },
    });
    if (!current || !isLiveSwitchState(current)) return;
    const queued = await enqueueXeroBookingInvoiceOperation(bookingId, {
      createdByMemberId: memberId,
      invoiceEmailDelivery: null,
    });
    // #1620 — enqueue the applied-credit allocation AFTER the invoice op (older
    // createdAt → processed first) so the invoice exists when the allocation
    // runs; if not yet raised the allocation handler throws and the outbox
    // retries. Skips itself when there is no unallocated applied credit.
    const queuedAllocation = await enqueueXeroAppliedCreditAllocationOperation(bookingId, {
      createdByMemberId: memberId,
    });
    if ((queued.queueOperationId || queuedAllocation.queueOperationId) && (await isXeroConnected())) {
      await kickQueuedXeroOutboxOperationsIfConnected({ limit: 2 });
    }
  } catch (err) {
    logger.error({ err, bookingId }, "Failed to queue Xero invoice after switching to Internet Banking");
  }
}
