import {
  ManualRefundTaskKind,
  ManualRefundTaskStatus,
  PaymentRecoveryOperationStatus,
  PaymentSource,
  PaymentTransactionKind,
  type Prisma,
} from "@prisma/client";
import { DEFAULT_BOOKING_DEFAULTS } from "@/config/club-settings-defaults";
import { logAudit } from "@/lib/audit";
import type { CancelledBookingLateCapture } from "@/lib/cancelled-booking-late-capture";
import type { ClubFormat } from "@/lib/club-format";
import { automaticCancelledBookingRefundTaskReasons } from "@/lib/deleted-booking-modification-payment";
import { queueLateCaptureRefundCreditNote } from "@/lib/late-capture-refund-credit-note";
import logger from "@/lib/logger";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import { enqueueLateCaptureApprovalRefundRecovery } from "@/lib/payment-recovery";
import {
  buildLateCaptureApprovalRefundRecoveryIdempotencyKey,
  buildLateCaptureRefundMetadata,
  buildLateCaptureRefundStripeKeyPrefix,
} from "@/lib/payment-recovery-keys";
import {
  isCapturedTransactionStatus,
  refundPaymentTransactions,
  type RefundAllocationSlice,
} from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";

/**
 * #3639 (owner decision 26 Sep 2026, `INV-PAY-102`): a club may have a treasurer
 * approve the refund of a genuine late capture on a cancelled booking — money
 * Stripe took after the cancel — instead of the webhook refunding it
 * automatically. The owner's words: "each club will have different preferences".
 *
 * THE SETTING DECIDES ONLY WHO PRESSES THE BUTTON. The refund an approval makes
 * is the automatic one, byte for byte: the same transaction, the same amount,
 * the same Stripe idempotency prefix and body
 * (`buildLateCaptureRefundStripeKeyPrefix` / `buildLateCaptureRefundMetadata`),
 * so if both ever run for one capture Stripe answers the second with the first.
 * Dismissing the task keeps the money, with a note, and moves nothing.
 *
 * THE TASK IS AN ORDINARY `DELETED_BOOKING_LATE_CAPTURE` ROW WITH A MARKER.
 * `lateCaptureApprovalIntentId` names the capture, makes it unique, and is what
 * routes its completion to a Stripe refund. No new kind label, so the previous
 * app version — which cannot read a label it does not know — lists and counts
 * it during a blue/green overlap as the open late-capture question it knows.
 *
 * ONE TASK PER CAPTURE, AND IT OWNS THE DECISION. Once a task exists for an
 * intent — open, approved or dismissed — every later notice for that intent is
 * acknowledged without a refund, whatever the setting says by then. So a club
 * switching back to automatic cannot refund a capture a treasurer is looking at
 * or has already kept, and a replay while the task is open raises nothing.
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

/** The sentence the finance card prints. Stored, so it names the capture. */
function heldLateCaptureReason(capture: CancelledBookingLateCapture): string {
  const which =
    capture.captureKind === "primary"
      ? `The booking's own payment ${capture.paymentIntentId}`
      : `A payment for a change to the booking (${capture.paymentIntentId})`;
  return `${which} was captured after the booking was cancelled (#3639) and has NOT been refunded: the club has a treasurer approve these refunds. Refund it to the card from this screen, or keep it with a note.`.slice(
    0,
    500,
  );
}

/**
 * Called by BOTH late-capture handlers after #2774's fence and before the
 * automatic refund. `true` means the handler must stop: a task already owns this
 * capture, or the club wants approval and one has just been raised. `false`
 * means refund automatically, exactly as before.
 *
 * Nothing is caught: a read that cannot answer must not pick a side, so the
 * webhook answers 500 and Stripe redelivers — the same rule as the fence.
 *
 * The raise holds `pg_advisory_xact_lock(1)` across its checks and the create,
 * the key the confirm route's #2700 raise already holds for the same table, so
 * the two writers are serialised and neither raises a second question for one
 * capture. No provider call happens inside it.
 */
export async function holdLateCaptureForTreasurerIfRequired(
  capture: CancelledBookingLateCapture,
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
    // The confirm route's #2700 question for a deleted booking is already the
    // human decision this capture needs; a second task would ask for it twice.
    const openQuestion = await tx.manualRefundTask.findFirst({
      where: {
        bookingId: capture.bookingId,
        paymentId: capture.paymentId,
        reason: {
          in: automaticCancelledBookingRefundTaskReasons(capture.paymentIntentId),
        },
        status: ManualRefundTaskStatus.OPEN,
      },
      select: { id: true },
    });
    if (openQuestion) return { taskId: openQuestion.id, created: false };
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
  return true;
}

/** How a completed approval sends the money back. A `EditReviewSettlementRoute` arm. */
export type LateCaptureRefundRoute = {
  kind: "late-capture-refund";
  paymentId: string;
  paymentIntentId: string;
  captureKind: "primary" | "modification";
  /** Always null: there is no booking edit behind this money. */
  bookingModificationId: null;
  /** Pinned to the capture's own transaction, as the automatic refund is. */
  allocation: RefundAllocationSlice[];
};

export const LATE_CAPTURE_APPROVAL_UNREADABLE_MESSAGE =
  "This item no longer matches a captured card payment on the booking, so it cannot be refunded from here. Check the payment in Stripe, then dismiss the item with a note saying what you found.";
export const LATE_CAPTURE_APPROVAL_ALREADY_REFUNDED_MESSAGE =
  "Part or all of this payment has already been refunded outside this item, so refunding it again from here is refused. Check the payment in Stripe, then dismiss the item with a note saying what you found.";

/**
 * Decide, BEFORE the completion's claim, exactly what an approval refunds — so a
 * refusal leaves the task OPEN. The amount is the task's own (a legacy-style
 * amount, never amended at completion) and it must still fit in what the capture
 * has left: a refund an officer already made in the Stripe dashboard is synced
 * onto the transaction by `charge.refunded`, and this is where it stops a second.
 */
export async function planLateCaptureApprovalRefund({
  task,
  amountCents,
  store,
}: {
  task: { paymentId: string | null; lateCaptureApprovalIntentId: string | null };
  amountCents: number;
  store: Prisma.TransactionClient;
}): Promise<LateCaptureRefundRoute> {
  const paymentIntentId = task.lateCaptureApprovalIntentId;
  const transaction =
    paymentIntentId && task.paymentId
      ? await store.paymentTransaction.findUnique({
          where: { stripePaymentIntentId: paymentIntentId },
          select: {
            id: true,
            paymentId: true,
            kind: true,
            source: true,
            status: true,
            amountCents: true,
            refundedAmountCents: true,
          },
        })
      : null;
  if (
    !paymentIntentId ||
    !transaction ||
    transaction.paymentId !== task.paymentId ||
    transaction.source !== PaymentSource.STRIPE ||
    !isCapturedTransactionStatus(transaction.status)
  ) {
    throw new ManualBookingPaymentError(LATE_CAPTURE_APPROVAL_UNREADABLE_MESSAGE, 409);
  }
  if (transaction.amountCents - transaction.refundedAmountCents < amountCents) {
    throw new ManualBookingPaymentError(
      LATE_CAPTURE_APPROVAL_ALREADY_REFUNDED_MESSAGE,
      409,
    );
  }
  return {
    kind: "late-capture-refund",
    paymentId: transaction.paymentId,
    paymentIntentId,
    captureKind:
      transaction.kind === PaymentTransactionKind.PRIMARY ? "primary" : "modification",
    bookingModificationId: null,
    allocation: [{ paymentTransactionId: transaction.id, amountCents }],
  };
}

/**
 * #3639: the same question for the confirm route's #2700 task, which completes
 * as a hand-back (a ledger mirror of money the club returned itself). If the
 * capture has already been refunded — in the Stripe dashboard, or by the webhook
 * before the booking was deleted — that hand-back would count one refund twice,
 * so it is refused before the claim and the task stays OPEN to be dismissed.
 * The capture is the one whose frozen reason sentence this task carries
 * (`automaticCancelledBookingRefundTaskReasons` is that key), which is exact.
 */
export async function assertLateCaptureHandBackStillOwed({
  task,
  amountCents,
  store,
}: {
  task: { paymentId: string | null; reason: string };
  amountCents: number;
  store: Prisma.TransactionClient;
}): Promise<void> {
  const captures = task.paymentId
    ? await store.paymentTransaction.findMany({
        where: { paymentId: task.paymentId, stripePaymentIntentId: { not: null } },
        select: { stripePaymentIntentId: true, amountCents: true, refundedAmountCents: true },
      })
    : [];
  const capture = captures.find(
    (row) =>
      row.stripePaymentIntentId !== null &&
      automaticCancelledBookingRefundTaskReasons(row.stripePaymentIntentId).includes(
        task.reason,
      ),
  );
  if (!capture) {
    throw new ManualBookingPaymentError(LATE_CAPTURE_APPROVAL_UNREADABLE_MESSAGE, 409);
  }
  if (capture.amountCents - capture.refundedAmountCents < amountCents) {
    throw new ManualBookingPaymentError(LATE_CAPTURE_APPROVAL_ALREADY_REFUNDED_MESSAGE, 409);
  }
}

/** Inside the completion's claim: the refund debt, before any Stripe call. */
export async function persistLateCaptureApprovalRefundDebt({
  bookingId,
  route,
  amountCents,
  store,
}: {
  bookingId: string;
  route: LateCaptureRefundRoute;
  amountCents: number;
  store: Prisma.TransactionClient;
}) {
  await enqueueLateCaptureApprovalRefundRecovery({
    bookingId,
    paymentId: route.paymentId,
    paymentIntentId: route.paymentIntentId,
    amountCents,
    allocationPlan: route.allocation,
    store,
  });
}

/**
 * Best-effort happy-path close of the debt above, as the edit-review one is: a
 * lost close leaves a PENDING operation whose replay Stripe answers with the
 * original refund under the same keys.
 */
async function markLateCaptureApprovalRefundRecoverySucceeded(paymentIntentId: string) {
  return prisma.paymentRecoveryOperation.updateMany({
    where: {
      idempotencyKey: buildLateCaptureApprovalRefundRecoveryIdempotencyKey(paymentIntentId),
      status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
    },
    data: {
      status: PaymentRecoveryOperationStatus.SUCCEEDED,
      nextRetryAt: null,
      lastError: null,
      processingStartedAt: null,
      succeededAt: new Date(),
    },
  });
}

/**
 * After the completion commits: the refund itself, then the record and the Xero
 * correction the automatic path writes. A failed refund is logged and left to
 * the recovery cron, which replays the persisted debt under the same keys and
 * queues the Xero correction itself; the treasurer is told it will retry.
 *
 * NO `REFUNDED` BOOKING EVENT, matching the automatic refund of the same money:
 * the member-facing narrative reads a cancelled booking's settlement off that
 * event type, and a late capture is not the cancellation's settlement.
 */
export async function executeLateCaptureApprovalRefund({
  bookingId,
  taskId,
  actingMemberId,
  route,
  amountCents,
  format,
}: {
  bookingId: string;
  taskId: string;
  actingMemberId: string;
  route: LateCaptureRefundRoute;
  amountCents: number;
  format: ClubFormat;
}): Promise<string | null> {
  let refundId: string | null;
  try {
    const result = await refundPaymentTransactions({
      format,
      paymentId: route.paymentId,
      amountCents,
      allocation: route.allocation,
      metadata: buildLateCaptureRefundMetadata(bookingId),
      idempotencyKeyPrefix: buildLateCaptureRefundStripeKeyPrefix(
        bookingId,
        route.paymentIntentId,
      ),
    });
    refundId = result.refunds[0]?.refundId ?? null;
  } catch (err) {
    logger.error(
      { err, bookingId, taskId, paymentIntentId: route.paymentIntentId },
      "Stripe refund failed after a treasurer approved a late-capture refund - the persisted recovery operation will replay it",
    );
    return null;
  }
  await markLateCaptureApprovalRefundRecoverySucceeded(route.paymentIntentId).catch(
    (err) =>
      logger.error(
        { err, bookingId, taskId },
        "Failed to close the late-capture approval refund recovery operation after an inline refund succeeded",
      ),
  );

  logAudit({
    action: "booking.payment.refunded_after_cancellation",
    category: "payment",
    memberId: actingMemberId,
    entityType: "Booking",
    entityId: bookingId,
    targetId: bookingId,
    details: JSON.stringify({
      paymentIntentId: route.paymentIntentId,
      refundId,
      amountCents,
      kind: route.captureKind === "primary" ? "primary" : "modification_additional",
      approvedByMemberId: actingMemberId,
      manualRefundTaskId: taskId,
    }),
  });

  const payment = await prisma.payment.findUnique({
    where: { id: route.paymentId },
    select: { xeroInvoiceId: true },
  });
  await queueLateCaptureRefundCreditNote({
    paymentId: route.paymentId,
    paymentXeroInvoiceId: payment?.xeroInvoiceId ?? null,
    paymentIntentId: route.paymentIntentId,
    amountCents,
  });
  return refundId;
}
