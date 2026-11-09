import {
  PaymentSource,
  PaymentTransactionKind,
  type Prisma,
} from "@prisma/client";
import type { ClubFormat } from "@/lib/club-format";
import { automaticCancelledBookingRefundTaskReasons } from "@/lib/deleted-booking-modification-payment";
import { finishApprovedLateCaptureRefund } from "@/lib/late-capture-refund-credit-note";
import logger from "@/lib/logger";
import { postRefundObligation, type BookingJournalContext } from "@/lib/member-money/doors";
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
import { captureRefundState } from "@/lib/payment-transaction-status";
import { lateCaptureOwnChargeSlice } from "@/lib/late-capture-own-charge-refund";
import { closeDoorRow, closePrePersistedRefundRow } from "@/lib/pre-persisted-refund-close";
import {
  keepRefusedPrePersistedRefundOwed,
  sliceAfterRecordedRefusals,
} from "@/lib/refused-card-refund-retry";

/**
 * #3639 (owner decision 26 Sep 2026, `INV-PAY-106`): what a treasurer's
 * approval of a held late capture refunds. The hold itself — the setting and
 * the raise of the task — is `late-capture-refund-hold.ts`.
 *
 * THE SETTING DECIDES ONLY WHO PRESSES THE BUTTON. The refund an approval makes
 * is the automatic one, byte for byte: the same transaction, the same amount,
 * the same Stripe idempotency prefix and body
 * (`buildLateCaptureRefundStripeKeyPrefix` / `buildLateCaptureRefundMetadata`),
 * so if both ever run for one capture Stripe answers the second with the first.
 * Only a refusal Stripe recorded moves the key on (#4103). Dismissing the task
 * keeps the money, with a note, and moves nothing.
 */

/** How a completed approval sends the money back. A `EditReviewSettlementRoute` arm. */
export type LateCaptureRefundRoute = {
  kind: "late-capture-refund";
  paymentId: string;
  paymentIntentId: string;
  captureKind: "primary" | "modification";
  /** Always null: there is no booking edit behind this money. */
  bookingModificationId: null;
  /** Pinned to the capture's own transaction, as the automatic refund is (`lateCaptureOwnChargeSlice`, #4131). */
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
  if (captureRefundState(transaction).heldCents < amountCents) {
    throw new ManualBookingPaymentError(
      LATE_CAPTURE_APPROVAL_ALREADY_REFUNDED_MESSAGE,
      409,
    );
  }
  // #4103 (`INV-PAY-130`): the webhook's refund of this slice that Stripe refused
  // is cached under its key for 24 hours, so the approval asks on the key
  // generation its recorded refusals count to - a request Stripe has never seen.
  const recorded = await store.paymentRefund.findMany({
    where: { paymentId: transaction.paymentId },
    select: { paymentTransactionId: true, amountCents: true, status: true },
  });
  return {
    kind: "late-capture-refund",
    paymentId: transaction.paymentId,
    paymentIntentId,
    captureKind:
      transaction.kind === PaymentTransactionKind.PRIMARY ? "primary" : "modification",
    bookingModificationId: null,
    // #4131: the capture's own charge, the one slice every late-capture door sends (held >= amount above).
    allocation: [sliceAfterRecordedRefusals(lateCaptureOwnChargeSlice(transaction, amountCents).slice, recorded)],
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
        select: {
          stripePaymentIntentId: true,
          status: true,
          amountCents: true,
          refundedAmountCents: true,
        },
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
  if (captureRefundState(capture).heldCents < amountCents) {
    throw new ManualBookingPaymentError(LATE_CAPTURE_APPROVAL_ALREADY_REFUNDED_MESSAGE, 409);
  }
}

/** Inside the completion's claim: the refund debt, before any Stripe call. */
export async function persistLateCaptureApprovalRefundDebt({
  bookingId,
  route,
  amountCents,
  store,
  journal,
  actingMemberId,
}: {
  bookingId: string;
  route: LateCaptureRefundRoute;
  amountCents: number;
  store: Prisma.TransactionClient;
  /** #4516 (M4c): the completion's journal context, resolved before its transaction. */
  journal: BookingJournalContext;
  actingMemberId: string;
}) {
  await enqueueLateCaptureApprovalRefundRecovery({
    bookingId,
    paymentId: route.paymentId,
    paymentIntentId: route.paymentIntentId,
    amountCents,
    allocationPlan: route.allocation,
    store,
  });
  // #4516 (M4c): R05 for the capture's return, beside its debt. This claim holds no `lock(1)` until M4d, so the
  // debtor is read without the booking row (a Payment-row writer never takes one, `INV-LOCK-002`).
  await postRefundObligation(store, journal, { bookingId, scope: "capture-return", id: route.paymentIntentId, amountCents,
    origin: "OFFICER", actorMemberId: actingMemberId, debtorRead: "plain" });
}

/**
 * Best-effort happy-path close of the debt above, as the edit-review one is: a
 * lost close leaves a PENDING operation whose replay Stripe answers with the
 * original refund under the same keys.
 *
 * #4126: it closes only the row as this approval left it
 * (`closePrePersistedRefundRow`, `untouchedOnly`) - PENDING, never attempted,
 * on the plan it just sent. A row the runner has claimed or tried belongs to
 * the runner: it replays these same keys, Stripe answers with this refund, and
 * its own close writes the record once. A re-plan of this row moves a slice
 * only after Stripe refused it (`keepRefusedPrePersistedRefundOwed`), so it
 * cannot follow an approval whose every slice was made; a close that loses on
 * a row still untouched is an anomaly (`reportLostPrePersistedClose`).
 */
async function markLateCaptureApprovalRefundRecoverySucceeded(idempotencyKey: string, sentPlan: ReadonlyArray<RefundAllocationSlice>) {
  return closePrePersistedRefundRow({ idempotencyKey, sentPlan, untouchedOnly: true });
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
      obligation: { scope: "capture-return", id: route.paymentIntentId }, // #4516: the R05 the completion posted
    });
    // #4103 (`INV-PAY-130`): a refusal (failed/canceled) is not a refund: the
    // row stays open, re-planned on fresh keys, and nothing is recorded or noted.
    const refused = await keepRefusedPrePersistedRefundOwed({
      bookingId,
      idempotencyKey: buildLateCaptureApprovalRefundRecoveryIdempotencyKey(route.paymentIntentId),
      attempt: result,
      format,
    });
    if (refused) throw refused;
    refundId = result.refunds[0]?.refundId ?? null;
  } catch (err) {
    // #4103: a slice refused before a later one threw is re-planned now.
    await keepRefusedPrePersistedRefundOwed({
      bookingId,
      idempotencyKey: buildLateCaptureApprovalRefundRecoveryIdempotencyKey(route.paymentIntentId),
      plan: route.allocation,
      attempt: { error: err },
      format,
    });
    logger.error(
      { err, bookingId, taskId, paymentIntentId: route.paymentIntentId },
      "Stripe refund failed after a treasurer approved a late-capture refund - the persisted recovery operation will replay it",
    );
    return null;
  }
  // The record is written by whichever of this and the cron replay moves the
  // debt to SUCCEEDED - exactly once (delta D6). A lost close here leaves it
  // PENDING, and the replay, answered by Stripe with this refund, writes it.
  // A close that threw is logged and is no anomaly: the row is left to the
  // runner's replay. Only a close that ran and matched nothing is read back.
  const closed = await closeDoorRow(
    {
      door: "late-capture-approval",
      idempotencyKey: buildLateCaptureApprovalRefundRecoveryIdempotencyKey(route.paymentIntentId),
      bookingId,
      paymentIntentId: route.paymentIntentId,
      amountCents,
      refundId,
      format,
      context: { taskId },
    },
    async (idempotencyKey) => (await markLateCaptureApprovalRefundRecoverySucceeded(idempotencyKey, route.allocation)).count === 1,
  );
  if (closed) {
    await finishApprovedLateCaptureRefund({
      bookingId,
      paymentId: route.paymentId,
      paymentIntentId: route.paymentIntentId,
      amountCents,
      refundId,
      captureKind: route.captureKind,
      approvedByMemberId: actingMemberId,
      manualRefundTaskId: taskId,
    });
  }
  return refundId;
}
