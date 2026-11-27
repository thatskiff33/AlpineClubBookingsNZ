/**
 * #3953 (`INV-PAY-139`): QUEUE THE RECEIPT of a booking change's card capture
 * that nothing else records, once per capture. Called by the late-success
 * release (`releaseXeroSupplementaryInvoiceForCapturedPaymentIntent`) when it
 * answers `none-queued` - from the Stripe webhook, the confirm route and a
 * treasurer's keep - by the primary invoice's link save for every capture its
 * cash does not cover ({@link queueReceiptsForUnrecordedCaptures}), and by the
 * booking-vs-Xero repair tool for a capture already missed.
 *
 * EXACTLY ONCE, AND ONLY WHERE NOTHING ELSE RECORDS IT. The find-and-create
 * runs under the per-anchor supplementary-invoice lock
 * (`lockSupplementaryInvoiceAnchor`) on the change the capture pays for
 * (`PaymentTransaction.bookingModificationId`), or the booking where the
 * ledger row names none - anchors that lock already serialises, so no new
 * key, and the lock the change's own supplementary invoice is queued under.
 * Under it the capture's recorder is read (`readCaptureRecorder`, review round
 * 1: one recorder per capture): the primary's own payment, a supplementary
 * invoice for the change or naming the capture, or the gap invoice's payment
 * that took it, and the receipt stands down for each. Otherwise a row for
 * this capture in any status but CANCELLED is found and returned, never a
 * second queued beside it.
 *
 * Not for a booking paid by internet banking (that settlement is the
 * treasurer's, never a Stripe receipt), nor for a cancelled booking - save
 * one case (#4324, `INV-PAY-144`): a late capture a treasurer KEPT whose
 * change the primary invoice bills, queued by the keep's one decision
 * (`queueKeptLateCaptureRecord`, `keptLateCapture`) on its own transaction,
 * which holds the approval task's row; under the anchor lock the task is read
 * again and must still owe the receipt (`lateCaptureReceiptOwed`: DISMISSED,
 * or #4381 approved with its card refund closed paid another way, whose close
 * queues it the same way on its own transaction). Every other caller on a cancelled
 * booking - the release from a replayed webhook, say - finds the kept
 * capture's row (`already-queued`) or is refused, so the keep decides it once.
 */
import { PaymentSource, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CAPTURED_TRANSACTION_STATUS_LIST, isCapturedTransactionStatus } from "@/lib/payment-transaction-status";
import { LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";
import { startXeroSyncOperation } from "@/lib/xero-sync";
import { lockSupplementaryInvoiceAnchor } from "@/lib/xero-supplementary-invoice-enqueue";
import { XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE } from "@/lib/additional-capture-receipt-payload";
import { additionalCaptureReceiptKey } from "@/lib/additional-capture-xero-receipt";
import { readCaptureRecorder } from "@/lib/additional-capture-recorder";
import { captureChangeId } from "@/lib/additional-capture-receipt-link";
import { keptCaptureAnchorId, lateCaptureReceiptOwed } from "@/lib/kept-late-capture-change-receipt";
import type { PrimaryInvoiceFeeAtLink } from "@/lib/xero-primary-invoice-fee-at-link";

export type AdditionalCaptureReceiptEnqueueResult =
  | { outcome: "queued"; queueOperationId: string }
  | { outcome: "already-queued"; queueOperationId: string }
  | {
      outcome: "not-eligible";
      reason:
        | "no-capture"
        | "not-a-change-card-capture"
        | "no-primary-invoice"
        | "booking-cancelled"
        | "capture-not-kept"
        | "no-unpaid-change-invoice"
        | "not-a-card-booking"
        | "recorded-by-primary-invoice"
        | "recorded-by-supplementary-invoice"
        | "recorded-by-credit-release-sweep"
        | "recorded-by-kept-late-capture-invoice";
    };

/** The outbox row shape, shared with the repair tool's read of it. */
export const ADDITIONAL_CAPTURE_RECEIPT_OPERATION = {
  direction: "OUTBOUND",
  entityType: "PAYMENT",
  operationType: "CREATE",
  localModel: "PaymentTransaction",
  queueType: XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
} as const;

type NotEligibleReason = Extract<AdditionalCaptureReceiptEnqueueResult, { outcome: "not-eligible" }>["reason"];

/** The capture as the enqueue's gates read it. */
async function readReceiptCapture(db: Prisma.TransactionClient, paymentIntentId: string) {
  return db.paymentTransaction.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
    select: {
      id: true,
      kind: true,
      source: true,
      status: true,
      bookingModificationId: true,
      reason: true,
      payment: {
        select: { id: true, bookingId: true, xeroInvoiceId: true, source: true, booking: { select: { status: true } } },
      },
    },
  });
}

type ReceiptCapture = NonNullable<Awaited<ReturnType<typeof readReceiptCapture>>> & {
  payment: { xeroInvoiceId: string };
};

/** The gates read from the capture alone: a captured change card payment on a booking with its primary invoice id. */
function captureRefusal(
  transaction: Awaited<ReturnType<typeof readReceiptCapture>>,
): { refused: NotEligibleReason } | { capture: ReceiptCapture } {
  if (!transaction) return { refused: "no-capture" };
  if (
    transaction.kind !== "ADDITIONAL" ||
    transaction.source !== "STRIPE" ||
    !isCapturedTransactionStatus(transaction.status)
  ) {
    return { refused: "not-a-change-card-capture" };
  }
  const { xeroInvoiceId } = transaction.payment;
  if (!xeroInvoiceId) return { refused: "no-primary-invoice" };
  return { capture: { ...transaction, payment: { ...transaction.payment, xeroInvoiceId } } };
}

/**
 * The gates read under the capture's anchor, after its row check: on a
 * cancelled booking the receipt is still owed (`lateCaptureReceiptOwed`), and
 * the capture's recorder is its receipt (`readCaptureRecorder`).
 */
async function refusalUnderAnchor(
  tx: Prisma.TransactionClient,
  capture: ReceiptCapture,
  paymentIntentId: string,
  options: { requireUnpaidChangeInvoice?: true; closingPaidAnotherWay?: true },
): Promise<NotEligibleReason | null> {
  const { payment } = capture;
  if (payment.booking.status === "CANCELLED") {
    // #4324, #4381: still owed its receipt (kept, or its refund closed paid
    // another way), read under the lock the receipt's worker reads it under.
    const owed = await lateCaptureReceiptOwed(tx, paymentIntentId, options.closingPaidAnotherWay ? { closingPaidAnotherWay: true } : undefined);
    if (!owed) return "capture-not-kept";
  }
  const recorder = await readCaptureRecorder(
    {
      bookingId: payment.bookingId,
      primaryInvoiceId: payment.xeroInvoiceId,
      paymentIntentId,
      // Round 7: the change its stamp or its review charge's reason names.
      bookingModificationId: captureChangeId(capture),
    },
    tx,
  );
  if (recorder.kind !== "receipt") return `recorded-by-${recorder.kind}`;
  // A release losing another caller's refusal can say already-released.
  // Under this same anchor, require the recorder's live unpaid change target;
  // falling back to the primary would pay an invoice that never billed it.
  if (options.requireUnpaidChangeInvoice && recorder.targets[0]?.kind !== "CHANGE_INVOICE") {
    return "no-unpaid-change-invoice";
  }
  return null;
}

export async function enqueueAdditionalCaptureReceiptOperation(
  paymentIntentId: string,
  options?: {
    createdByMemberId?: string | null;
    /**
     * #4324: the caller's transaction - the keep's decision, or (#4381) a
     * paid-another-way close, holding the approval task's row - in place of
     * one of this call's own.
     */
    store?: Prisma.TransactionClient;
    /**
     * #4324: a late capture on a cancelled booking that still owes its receipt
     * (`queueKeptLateCaptureRecord`, and #4381 a paid-another-way close's
     * `queuePaidAnotherWayXero`).
     */
    keptLateCapture?: boolean;
    /** Follow a change-invoice release only while its unpaid invoice still bills this capture. */
    requireUnpaidChangeInvoice?: true;
  },
): Promise<AdditionalCaptureReceiptEnqueueResult> {
  const db = options?.store ?? prisma;
  const read = captureRefusal(await readReceiptCapture(db, paymentIntentId));
  if ("refused" in read) return { outcome: "not-eligible", reason: read.refused };
  const transaction = read.capture;
  const { payment } = transaction;
  const key = additionalCaptureReceiptKey(paymentIntentId);
  const cancelled = payment.booking.status === "CANCELLED";
  if (cancelled && !options?.keptLateCapture) {
    // #4324: a replayed release after the keep queued the receipt answers it.
    const queued = await db.xeroSyncOperation.findFirst({
      where: { correlationKey: key, status: { not: "CANCELLED" } },
      select: { id: true },
    });
    return queued
      ? { outcome: "already-queued", queueOperationId: queued.id }
      : { outcome: "not-eligible", reason: "booking-cancelled" };
  }
  if (payment.source !== PaymentSource.STRIPE) return { outcome: "not-eligible", reason: "not-a-card-booking" };

  const decide = async (tx: Prisma.TransactionClient): Promise<AdditionalCaptureReceiptEnqueueResult> => {
    await lockSupplementaryInvoiceAnchor(tx, keptCaptureAnchorId(transaction, payment.bookingId));
    const existing = await tx.xeroSyncOperation.findFirst({
      where: { correlationKey: key, status: { not: "CANCELLED" } },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (existing) return { outcome: "already-queued" as const, queueOperationId: existing.id };
    const refused = await refusalUnderAnchor(tx, transaction, paymentIntentId, options ?? {});
    if (refused) return { outcome: "not-eligible", reason: refused };
    const operation = await startXeroSyncOperation({
      ...ADDITIONAL_CAPTURE_RECEIPT_OPERATION,
      localId: transaction.id,
      status: "PENDING",
      idempotencyKey: key,
      correlationKey: key,
      requestPayload: {
        queueType: XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
        bookingId: payment.bookingId,
        paymentId: payment.id,
        paymentTransactionId: transaction.id,
        paymentIntentId,
      },
      createdByMemberId: options?.createdByMemberId ?? null,
      store: tx,
    });
    return { outcome: "queued" as const, queueOperationId: operation.id };
  };
  return options?.store ? decide(options.store) : prisma.$transaction(decide);
}

/**
 * #4381 (`INV-SSOT`): WOULD A PAID-ANOTHER-WAY CLOSE'S RECEIPT BE QUEUED? The
 * enqueue's own gates for a late capture on a cancelled booking, without its
 * row check or its write, for the close's plan
 * (`paidAnotherWayXeroPlan`), which runs before the close's record exists -
 * so the close being planned counts as the one `lateCaptureReceiptOwed` finds
 * once it commits. Takes no lock: the close's plan already holds the task row
 * and the capture's anchor, and the dialog's read holds neither and is decided
 * again by the close. The close's queue then calls the enqueue itself, which
 * asks the same gates under the same locks.
 */
export async function paidAnotherWayCaptureReceiptRefusal(
  db: Prisma.TransactionClient,
  paymentIntentId: string,
): Promise<NotEligibleReason | null> {
  const read = captureRefusal(await readReceiptCapture(db, paymentIntentId));
  if ("refused" in read) return read.refused;
  if (read.capture.payment.source !== PaymentSource.STRIPE) return "not-a-card-booking";
  return refusalUnderAnchor(db, read.capture, paymentIntentId, { closingPaidAnotherWay: true });
}

/**
 * #3953 review round 1 (E): once the primary invoice's link is saved, every
 * captured change on the booking that the invoice's recorded cash does not
 * cover gets its receipt row - a capture that landed between the create's read
 * and its link included, whose release ran before there was an invoice. Run
 * by the link's gap check before it measures anything, so the gap invoice never
 * pays itself from those captures. Idempotent: each enqueue finds its row. A
 * record from before the counted list existed queues nothing; the release and
 * the repair tool answer those.
 */
export async function queueReceiptsForUnrecordedCaptures(
  bookingId: string,
  atLink: Pick<PrimaryInvoiceFeeAtLink, "paymentIntentIdsRecordedAtLink">,
): Promise<string[]> {
  if (!atLink.paymentIntentIdsRecordedAtLink) return [];
  const recorded = new Set(atLink.paymentIntentIdsRecordedAtLink);
  const captures = await prisma.paymentTransaction.findMany({
    where: {
      payment: { bookingId },
      kind: "ADDITIONAL",
      source: "STRIPE",
      status: { in: [...CAPTURED_TRANSACTION_STATUS_LIST] },
      stripePaymentIntentId: { not: null },
    },
    orderBy: [...LEDGER_ROWS_OLDEST_FIRST],
    select: { stripePaymentIntentId: true },
  });
  const queued: string[] = [];
  for (const { stripePaymentIntentId } of captures) {
    if (!stripePaymentIntentId || recorded.has(stripePaymentIntentId)) continue;
    const result = await enqueueAdditionalCaptureReceiptOperation(stripePaymentIntentId);
    if (result.outcome === "queued") queued.push(result.queueOperationId);
  }
  return queued;
}
