/**
 * #3643 (`INV-PAY-107`, orchestrator decisions 1 and 2 on the thread, within
 * option A): the normal cancel path knows about a part-paid internet banking
 * invoice.
 *
 * The cancel reads the invoices live, before any transaction, and gets one of:
 *  - `recognise`: a member's booking whose cash Xero sizes exactly. The claim
 *    records that cash as the payment's captured internet banking money —
 *    through the existing ledger writers — so the booking takes the paid path:
 *    the cancellation policy applies to what was paid (as account credit), and
 *    the claim queues a clearing note for what the invoices still owe.
 *  - `manual`: money is recorded against the invoice but the app cannot hand it
 *    back as credit — the booking belongs to an organisation (#3369), or Xero
 *    could not give the amount exactly (a recorded link while Xero is down, a
 *    figure that did not quantify, a supplementary invoice that could not be
 *    read). DECISION 2: an officer may still cancel; the cancel takes the
 *    unpaid path WITHOUT a clearing note (a full one would over-clear), raises
 *    a hand-back task (owner decision 28 Sep 2026), the repair tool lists the
 *    booking for manual review until that task is closed, and the treasurer is
 *    alerted. A member's own cancel is refused, pointing them to the club.
 *  - null: nothing to recognise; the cancel proceeds as before.
 */
import {
  ManualRefundTaskKind,
  type Payment,
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
  type Prisma,
} from "@prisma/client";
import { bookingOwner } from "@/lib/booking-owner";
import {
  hasRecordedInvoicePayment,
  readHoldPaymentEvidence,
  type HoldPaymentEvidence,
} from "@/lib/internet-banking-hold-payment-evidence";
import {
  enqueueXeroModificationCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import { isXeroConnected } from "@/lib/xero";
import logger from "@/lib/logger";
import type { ClubFormat } from "@/lib/club-format";
import { alertExpiredHold, type ExpiredHoldView } from "@/lib/internet-banking-hold-kept";
import {
  lockPaymentForRefundedTotal,
  reconcilePaymentAggregates,
  recordInternetBankingPaymentTransaction,
} from "@/lib/payment-transactions";
import { PART_PAYMENT_RECOGNISED_REASON } from "@/lib/part-payment-recognition-reason";
import { MANUAL_REFUND_TASK_REASON_MAX } from "@/lib/manual-subscription-payment";

export { PART_PAYMENT_RECOGNISED_REASON };

type PaidEvidence = Extract<HoldPaymentEvidence, { kind: "paid" }>;

export interface PartPaymentAtCancel {
  kind: "recognise";
  /** The cash Xero shows across the booking's invoices, exactly. */
  paidCents: number;
  /** What the invoices still owe: the clearing note's size. */
  amountDueCents: number;
  /** When the read started: the claim refuses a payment recorded after it. */
  readStartedAt: Date;
}

export interface ManualPartPaymentAtCancel {
  kind: "manual";
  why: "organisation" | "unsizable";
  evidence: PaidEvidence;
}

export type CancelPartPayment = PartPaymentAtCancel | ManualPartPaymentAtCancel | null;

/** A member's own cancel of a `manual` booking: the club settles it by hand. */
export const PART_PAYMENT_MANUAL_MEMBER_REFUSAL =
  "A payment has been recorded against this booking's invoice that the club needs to settle by hand, so it cannot be cancelled online. Please contact the club to cancel it.";

/** Thrown inside the claim when the payment changed since the read (maps to 409). */
export class PartPaymentChangedError extends Error {
  constructor() {
    super("The booking's payment changed while it was being cancelled; try again.");
    this.name = "PartPaymentChangedError";
  }
}

type PaymentForRead = Pick<
  Payment,
  "id" | "bookingId" | "source" | "status" | "xeroInvoiceId" | "xeroInvoiceNumber" | "manuallyMarkedPaidAt"
>;

/**
 * The preview's short cache (D8): opening the dialog repeatedly costs one Xero
 * read per booking per minute, not one per open. Never used by the cancel,
 * which always reads fresh.
 */
const PREVIEW_CACHE_MS = 60_000;
const previewCache = new Map<string, { at: number; value: CancelPartPayment }>();

async function decide(booking: {
  memberId: string | null;
  payment: PaymentForRead | null;
}): Promise<CancelPartPayment> {
  const payment = booking.payment;
  if (
    !payment ||
    payment.source !== PaymentSource.INTERNET_BANKING ||
    payment.status !== PaymentStatus.PENDING ||
    !payment.xeroInvoiceId ||
    payment.manuallyMarkedPaidAt
  ) {
    return null;
  }
  const evidence = await readHoldPaymentEvidence(payment);
  if (evidence.kind !== "paid") return null;
  // An organisation has no member account to credit (#3369): the paid path
  // would refuse its credit refund, so it is handled by hand instead.
  if (!bookingOwner(booking).memberId) {
    return { kind: "manual", why: "organisation", evidence };
  }
  if (!evidence.cashComplete || evidence.amountDueCents === null || evidence.paidCents <= 0) {
    return { kind: "manual", why: "unsizable", evidence };
  }
  return {
    kind: "recognise",
    paidCents: evidence.paidCents,
    amountDueCents: evidence.amountDueCents,
    readStartedAt: evidence.readStartedAt,
  };
}

/** Outside any transaction. The cancel calls it without a cache. */
export async function readPartPaymentAtCancel(
  booking: { memberId: string | null; payment: PaymentForRead | null },
  options: { cached?: boolean; now?: number } = {},
): Promise<CancelPartPayment> {
  const key = booking.payment?.id;
  if (!options.cached || !key) return decide(booking);
  const now = options.now ?? Date.now();
  const hit = previewCache.get(key);
  if (hit && now - hit.at < PREVIEW_CACHE_MS) return hit.value;
  const value = await decide(booking);
  previewCache.set(key, { at: now, value });
  return value;
}

/** Test seam: forget the preview cache. */
export function clearPartPaymentPreviewCacheForTests(): void {
  previewCache.clear();
}

/**
 * Inside the cancel claim, under `pg_advisory_xact_lock(1)`: record the cash
 * as captured, exactly once, and queue the clearing note for the unpaid rest in
 * the same transaction (D2, as the hold release does), so no crash point can
 * leave the invoice open with nothing queued. Throws `PartPaymentChangedError`
 * when anything moved since the read, which rolls the claim back:
 *  - a payment recorded since the read started (D1, the hold path's rule) —
 *    the recorded figure would be short and the later cash absorbed silently;
 *  - the payment no longer PENDING, or already holding captured money;
 *  - a ledger shape the conversion cannot keep single (D6): more than one
 *    internet banking PRIMARY row.
 *
 * The one internet banking PRIMARY row, PENDING or FAILED, becomes the receipt
 * rather than having another written beside it: a later PAID event for the
 * invoice flips every non-refunded PRIMARY row to SUCCEEDED, so a second row at
 * face value would double the capture.
 */
export async function recordPartPaymentInClaim(
  tx: Prisma.TransactionClient,
  bookingId: string,
  paymentId: string,
  partPayment: PartPaymentAtCancel,
  createdByMemberId: string,
) {
  if (
    await hasRecordedInvoicePayment(
      { paymentId, bookingId, since: partPayment.readStartedAt },
      tx,
    )
  ) {
    throw new PartPaymentChangedError();
  }
  // #3640's order for the refunded total: the Payment row before any
  // transaction row. The receipt write below touches a transaction row and
  // then the aggregate, ahead of the claim's own lock of the same row.
  await lockPaymentForRefundedTotal(tx, paymentId);
  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    include: { transactions: true },
  });
  if (
    !payment ||
    payment.source !== PaymentSource.INTERNET_BANKING ||
    payment.status !== PaymentStatus.PENDING ||
    payment.manuallyMarkedPaidAt
  ) {
    throw new PartPaymentChangedError();
  }
  const captured = payment.transactions.some((row) =>
    [PaymentStatus.SUCCEEDED, PaymentStatus.REFUNDED, PaymentStatus.PARTIALLY_REFUNDED].includes(
      row.status as "SUCCEEDED" | "REFUNDED" | "PARTIALLY_REFUNDED",
    ),
  );
  if (captured) throw new PartPaymentChangedError();
  const ibPrimary = payment.transactions.filter(
    (row) =>
      row.kind === PaymentTransactionKind.PRIMARY &&
      row.source === PaymentSource.INTERNET_BANKING,
  );
  if (ibPrimary.length > 1) throw new PartPaymentChangedError();

  const [receiptRow] = ibPrimary;
  const recorded = receiptRow
    ? await (async () => {
        await tx.paymentTransaction.update({
          where: { id: receiptRow.id },
          data: {
            amountCents: partPayment.paidCents,
            status: PaymentStatus.SUCCEEDED,
            reason: PART_PAYMENT_RECOGNISED_REASON,
            xeroInvoiceId: payment.xeroInvoiceId,
            xeroInvoiceNumber: payment.xeroInvoiceNumber,
          },
        });
        return reconcilePaymentAggregates({ paymentId, store: tx });
      })()
    : await recordInternetBankingPaymentTransaction({
        paymentId,
        amountCents: partPayment.paidCents,
        status: PaymentStatus.SUCCEEDED,
        xeroInvoiceId: payment.xeroInvoiceId,
        xeroInvoiceNumber: payment.xeroInvoiceNumber,
        reference: payment.reference,
        reason: PART_PAYMENT_RECOGNISED_REASON,
        store: tx,
      });
  if (!recorded) throw new PartPaymentChangedError();

  // #3535's booking-anchored clearing note for what the invoices still owe,
  // sized from Xero's own amount due at the read. The builder re-reads the
  // invoices and creates nothing if they owe less by then; a refused or missing
  // note is the repair tool's to report (`INV-PAY-107`).
  let clearingOperationId: string | null = null;
  if (partPayment.amountDueCents > 0) {
    const queued = await enqueueXeroModificationCreditNoteOperation(
      {
        bookingId,
        refundAmountCents: partPayment.amountDueCents,
        clearsUnpaidInvoice: true,
        // The booking WAS partly paid: the note says it clears the unpaid
        // balance, never "booking not paid" (#3643).
        clearsUnpaidBalance: true,
      },
      { createdByMemberId, store: tx },
    );
    clearingOperationId = queued.queueOperationId;
  }
  return { payment: recorded, clearingOperationId };
}

/** After the claim commits: a best-effort kick of the queued clearing note. */
export async function kickClearingNoteForUnpaidRest(
  bookingId: string,
  clearingOperationId: string | null,
): Promise<void> {
  if (!clearingOperationId) return;
  try {
    if (await isXeroConnected()) {
      await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
    }
  } catch (err) {
    logger.error({ err, bookingId }, "Failed to kick Xero invoice-clearing credit note outbox worker");
  }
}

/**
 * The owner's 28 Sep 2026 decision on DECISION 2: the cancel raises a task in
 * the hand-back queue, inside the unpaid claim under `pg_advisory_xact_lock(1)`,
 * so the cancel and its task commit together. Closing the task is what quiets
 * the repair tool's manual-review finding for the booking (`INV-PAY-107`).
 *
 * The task is a `CANCELLED_BOOKING_HAND_BACK` marked by
 * `partPaymentReviewPaymentId`, with no amount and no `paymentId`: the app does
 * not know the amount, and a `paymentId` would suppress the organisation
 * late-cash arm's own sized hand-back, which dedupes on (booking, payment,
 * kind). One per payment, in any status: the lookup here under the lock, and
 * the unique marker behind it. Returns whether a task was raised.
 */
export async function raisePartPaymentReviewTask(
  tx: Prisma.TransactionClient,
  bookingId: string,
  paymentId: string,
  manual: ManualPartPaymentAtCancel,
): Promise<boolean> {
  const existing = await tx.manualRefundTask.findFirst({
    where: { partPaymentReviewPaymentId: paymentId },
    select: { id: true },
  });
  if (existing) return false;
  const why =
    manual.why === "organisation"
      ? "The booking belongs to an organisation, which has no member account to hold it as credit."
      : "Xero could not give the amount paid exactly.";
  await tx.manualRefundTask.create({
    data: {
      bookingId,
      partPaymentReviewPaymentId: paymentId,
      kind: ManualRefundTaskKind.CANCELLED_BOOKING_HAND_BACK,
      reason: `Booking ${bookingId} was cancelled as unpaid, but Xero records a payment against its invoice. ${why} Nothing has been refunded, credited or cleared here: settle the payment in Xero (refund it or apply it), clear what the invoice still owes, then dismiss this item with a note saying what you did. Do not mark it paid back.`.slice(
        0,
        MANUAL_REFUND_TASK_REASON_MAX,
      ),
    },
  });
  return true;
}

/**
 * DECISION 2: an officer cancelled a booking with money the app cannot credit.
 * The treasurer is told once, through the hold alert's own claim-guarded
 * channel; the claim raised a hand-back task (above) for the repair tool.
 */
export async function alertManualPartPaymentCancel(
  booking: ExpiredHoldView["booking"] & {
    id: string;
    payment: {
      id: string;
      xeroInvoiceId: string | null;
      xeroInvoiceNumber: string | null;
      internetBankingHoldUntil: Date | null;
    } | null;
  },
  manual: ManualPartPaymentAtCancel,
  format: ClubFormat,
): Promise<void> {
  if (!booking.payment) return;
  await alertExpiredHold(
    {
      id: booking.payment.id,
      bookingId: booking.id,
      xeroInvoiceId: booking.payment.xeroInvoiceId,
      xeroInvoiceNumber: booking.payment.xeroInvoiceNumber,
      internetBankingHoldUntil: booking.payment.internetBankingHoldUntil,
      booking,
    },
    manual.evidence,
    "cancelled-payment-recorded",
    format,
  ).catch((err) =>
    logger.error({ err, bookingId: booking.id }, "Failed to alert the treasurer about a cancel with a payment to settle by hand"),
  );
}
