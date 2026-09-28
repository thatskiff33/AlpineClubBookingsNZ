import {
  BookingStatus,
  ManualRefundTaskKind,
  ManualRefundTaskStatus,
  PaymentTransactionKind,
} from "@prisma/client";
import { DEFAULT_BOOKING_DEFAULTS } from "@/config/club-settings-defaults";
import { logAudit } from "@/lib/audit";
import {
  automaticCancelledBookingRefundTaskReasons,
  type CancelledBookingLateCaptureKind,
} from "@/lib/deleted-booking-modification-payment";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { sendAdminAlertOnceEver } from "@/lib/admin-alert-once";
import { bookingOwner } from "@/lib/booking-owner";
import { clubFormatValues } from "@/lib/club-format-server";
import { sendAdminLateCaptureHeldAlert } from "@/lib/email";

/**
 * #3639 (owner decision 26 Sep 2026, `INV-PAY-106`): a club may have a treasurer
 * approve the refund of a genuine late capture on a cancelled booking — money
 * Stripe took after the cancel — instead of it being refunded automatically.
 * The owner's words: "each club will have different preferences".
 *
 * THIS MODULE IS THE HOLD: whether a capture is held, and the raise of the task
 * that holds it. It has no refund in it, so the payment-recovery cron can ask it
 * without importing the approval's refund (which imports that cron). What an
 * approval then refunds is `late-capture-refund-approval.ts`.
 *
 * THE TASK IS AN ORDINARY `DELETED_BOOKING_LATE_CAPTURE` ROW WITH A MARKER.
 * `lateCaptureApprovalIntentId` names the capture, makes it unique, and is what
 * routes its completion to a Stripe refund. No new kind label, so the previous
 * app version — which cannot read a label it does not know — lists and counts
 * it during a blue/green overlap as the open late-capture question it knows.
 *
 * ONE TASK PER CAPTURE, AND IT OWNS THE DECISION. Once a task exists for an
 * intent — open, approved or dismissed — every later notice for that intent is
 * acknowledged without a refund, whatever the setting says by then.
 *
 * EVERY AUTOMATIC REFUND OF A LATE CAPTURE ASKS: both webhook late-capture
 * handlers, and the superseded-intent hand-off (webhook and cron) that refunds a
 * change payment a cancel had marked for cancellation but which captured anyway.
 */

/** The club's answer, read outside any transaction (`INV-LOCK-004`). */
export async function readLateCaptureRefundNeedsApproval(): Promise<boolean> {
  const row = await prisma.bookingDefaults.findUnique({
    where: { id: "default" },
    select: { lateCaptureRefundNeedsApproval: true },
  });
  return (
    row?.lateCaptureRefundNeedsApproval ??
    DEFAULT_BOOKING_DEFAULTS.lateCaptureRefundNeedsApproval
  );
}

/** What the hold needs to know about one capture. */
export type HeldLateCapture = {
  bookingId: string;
  paymentId: string;
  paymentIntentId: string;
  amountCents: number;
  captureKind: CancelledBookingLateCaptureKind;
};

/**
 * The sentence the finance card prints. STORED, and read by BOTH app versions
 * during a blue/green overlap: the previous one shows it beside a **Mark paid
 * back** button that records a hand-back and moves no money, so the sentence
 * must say plainly not to use that unless the club returned the money itself.
 */
export function heldLateCaptureReason(capture: HeldLateCapture): string {
  const which =
    capture.captureKind === "primary"
      ? `The booking's own payment ${capture.paymentIntentId}`
      : `A payment for a change to the booking (${capture.paymentIntentId})`;
  return `${which} went through after the booking was cancelled and has NOT been refunded: it is held for a treasurer to approve. Refund it to the card through Stripe, or keep it with a note (keeping it records it in Xero as a paid invoice). Do not mark it paid back unless the club has already returned the money itself.`.slice(
    0,
    500,
  );
}

/**
 * `true` means the caller must not refund: a task already owns this capture, or
 * the club wants approval and one is now raised. `false` means refund
 * automatically, exactly as before.
 *
 * Nothing is caught: a read that cannot answer must not pick a side, so the
 * caller fails and is retried — the webhook answers 500, the cron retries.
 *
 * The raise holds `pg_advisory_xact_lock(1)` across its checks and its write,
 * the key the confirm route's #2700 raise already holds for the same table, so
 * the two writers are serialised. No provider call happens inside it. When the
 * #2700 route's OPEN question already exists for the capture, the marker is put
 * ON that row rather than raising a second one: it then completes as a card
 * refund, and a dismissal of it still owns the capture.
 */
export async function holdLateCaptureForTreasurerIfRequired(
  capture: HeldLateCapture,
): Promise<boolean> {
  const marker = { lateCaptureApprovalIntentId: capture.paymentIntentId };
  const owned = await prisma.manualRefundTask.findUnique({
    where: marker,
    select: { id: true, status: true },
  });
  if (owned) {
    logger.info(
      {
        bookingId: capture.bookingId,
        paymentIntentId: capture.paymentIntentId,
        manualRefundTaskId: owned.id,
        taskStatus: owned.status,
      },
      "Late capture on a cancelled booking already has a treasurer-approval task; no automatic refund (#3639)",
    );
    // #3635: a still-open task re-announces, so an alert whose send failed
    // or reached nobody is retried by the next notice; a kept claim makes this
    // a no-op.
    if (owned.status === ManualRefundTaskStatus.OPEN) {
      await announceHeldLateCapture(capture);
    }
    return true;
  }
  if (!(await readLateCaptureRefundNeedsApproval())) return false;

  const raised = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const again = await tx.manualRefundTask.findUnique({
      where: marker,
      select: { id: true },
    });
    if (again) return { taskId: again.id, created: false };
    const openQuestion = await tx.manualRefundTask.findFirst({
      where: {
        bookingId: capture.bookingId,
        paymentId: capture.paymentId,
        reason: {
          in: automaticCancelledBookingRefundTaskReasons(capture.paymentIntentId),
        },
        status: ManualRefundTaskStatus.OPEN,
        lateCaptureApprovalIntentId: null,
      },
      select: { id: true },
    });
    if (openQuestion) {
      // The kind is set in the same write: a #2700 row raised before the kind
      // existed carries NULL, and the marker's CHECK allows only this kind
      // (delta D5).
      await tx.manualRefundTask.update({
        where: { id: openQuestion.id },
        data: { ...marker, kind: ManualRefundTaskKind.DELETED_BOOKING_LATE_CAPTURE },
      });
      return { taskId: openQuestion.id, created: false };
    }
    const task = await tx.manualRefundTask.create({
      data: {
        bookingId: capture.bookingId,
        paymentId: capture.paymentId,
        amountCents: capture.amountCents,
        raisedAmountCents: capture.amountCents,
        kind: ManualRefundTaskKind.DELETED_BOOKING_LATE_CAPTURE,
        lateCaptureApprovalIntentId: capture.paymentIntentId,
        reason: heldLateCaptureReason(capture),
        status: ManualRefundTaskStatus.OPEN,
      },
      select: { id: true },
    });
    return { taskId: task.id, created: true };
  });

  logAudit({
    action: "booking.payment.late_capture_refund_held",
    category: "payment",
    severity: "important",
    outcome: "blocked",
    entityType: "Booking",
    entityId: capture.bookingId,
    targetId: capture.bookingId,
    details: JSON.stringify({
      paymentIntentId: capture.paymentIntentId,
      capturedAmountCents: capture.amountCents,
      captureKind: capture.captureKind,
      manualRefundTaskId: raised.taskId,
      taskRaised: raised.created,
      refundSent: false,
    }),
  });
  await announceHeldLateCapture(capture);
  return true;
}

/**
 * #3639 (delta D7): the finance alert for a held capture, ONCE per payment
 * intent, through the one once-ever rule (`sendAdminAlertOnceEver`, #3635 /
 * #3672): the claim is kept once a copy was sent or queued for the retry cron,
 * so a Stripe redelivery, a cron retry or a second instance never re-sends;
 * held a day when nobody can receive it; given back when the send throws. The
 * retry is driven by the next notice for the intent, which announces again
 * from the task-already-exists branch while the task is OPEN. Never throws:
 * the task is the record, and a failed mail must not fail the webhook or the
 * cron over a nudge.
 */
async function announceHeldLateCapture(capture: HeldLateCapture): Promise<void> {
  const context = {
    bookingId: capture.bookingId,
    paymentIntentId: capture.paymentIntentId,
  };
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: capture.bookingId },
      select: {
        checkIn: true,
        checkOut: true,
        member: { select: { firstName: true, lastName: true } },
        organisation: { select: { name: true, email: true } },
      },
    });
    if (!booking) return;
    const owner = bookingOwner(booking).member;
    await sendAdminAlertOnceEver({
      key: `late-capture-held:${capture.paymentIntentId}`,
      label: "held late-capture alert",
      context,
      send: async () =>
        sendAdminLateCaptureHeldAlert(
          {
            memberName: `${owner.firstName} ${owner.lastName}`,
            checkIn: booking.checkIn,
            checkOut: booking.checkOut,
            amountCents: capture.amountCents,
            bookingId: capture.bookingId,
          },
          await clubFormatValues(),
        ),
    });
  } catch (err) {
    logger.error(
      { err, ...context },
      "Failed to send the held late-capture alert; the task on the payments board still records it",
    );
  }
}

/**
 * The superseded-intent hand-off's question (#3639 review F1). A cancel marks an
 * outstanding change payment for cancellation; if it captures anyway, the
 * webhook's superseded hook and the recovery cron hand it to a refund BEFORE
 * either late-capture handler runs. On a CANCELLED booking that is a late
 * capture like any other, so it follows the club's setting too. On a live
 * booking (an ask superseded by a newer one) it is not, and this answers false.
 */
export async function holdSupersededLateCaptureIfRequired(operation: {
  bookingId: string;
  paymentId: string;
  paymentIntentId: string;
  paymentTransactionId: string;
  amountCents: number;
}): Promise<boolean> {
  const [booking, transaction] = await Promise.all([
    prisma.booking.findUnique({
      where: { id: operation.bookingId },
      select: { status: true },
    }),
    prisma.paymentTransaction.findUnique({
      where: { id: operation.paymentTransactionId },
      select: { kind: true },
    }),
  ]);
  if (booking?.status !== BookingStatus.CANCELLED) return false;
  return holdLateCaptureForTreasurerIfRequired({
    bookingId: operation.bookingId,
    paymentId: operation.paymentId,
    paymentIntentId: operation.paymentIntentId,
    amountCents: operation.amountCents,
    captureKind:
      transaction?.kind === PaymentTransactionKind.PRIMARY ? "primary" : "modification",
  });
}
