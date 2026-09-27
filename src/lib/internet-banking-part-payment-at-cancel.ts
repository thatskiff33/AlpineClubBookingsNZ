/**
 * #3643 (`INV-PAY-107`, orchestrator decision on the thread, within option A):
 * the normal cancel path knows about a part-paid internet banking invoice.
 *
 * Option A keeps a part-paid hold and says the officer "cancels and decides the
 * refund or credit there". Before this, that path could not: the payment was
 * still PENDING, so the cancel took the never-captured branch — no refund, and
 * a full-size clearing note the builder then refused as a shortfall, leaving
 * the part payment untracked. Now the cancel reads the invoices live (before
 * any transaction), and when Xero shows cash it can size exactly, the claim
 * transaction records that cash as the payment's captured internet banking
 * money — through the existing ledger writers — so the booking takes the paid
 * path: the cancellation policy applies to what was paid (internet banking
 * refunds as account credit), and the clearing note is sized to what the
 * invoices still owe.
 *
 * Cash Xero shows but that cannot be sized exactly (a recorded link with Xero
 * unreadable, a figure that did not quantify, a supplementary invoice that
 * could not be read) refuses the cancel rather than clearing the invoice as if
 * nobody had paid.
 */
import {
  type Payment,
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
  type Prisma,
} from "@prisma/client";
import { readHoldPaymentEvidence } from "@/lib/internet-banking-hold-payment-evidence";
import logger from "@/lib/logger";
import { isXeroConnected } from "@/lib/xero";
import {
  enqueueXeroModificationCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import {
  reconcilePaymentAggregates,
  recordInternetBankingPaymentTransaction,
} from "@/lib/payment-transactions";

export interface PartPaymentAtCancel {
  /** The cash Xero shows across the booking's invoices, exactly. */
  paidCents: number;
  /** What the invoices still owe: the clearing note's size. */
  amountDueCents: number;
}

export const PART_PAYMENT_UNSIZABLE_REFUSAL =
  "Xero shows a payment against this booking's invoice, but its amount could not be read exactly, so the booking was not cancelled. Try again when Xero can be read, or check the invoice in Xero.";

/** The reason stamped on the ledger row the recognition writes. */
export const PART_PAYMENT_RECOGNISED_REASON = "xero_part_payment_recognised_at_cancel";

/**
 * Outside any transaction. `null` means "nothing to recognise" (not an
 * internet banking payment awaiting money, no invoice, nothing paid, or Xero
 * unreadable with no payment recorded — the cancel proceeds as before).
 */
export async function readPartPaymentAtCancel(booking: {
  memberId: string | null;
  payment: Pick<
    Payment,
    "id" | "bookingId" | "source" | "status" | "xeroInvoiceId" | "xeroInvoiceNumber" | "manuallyMarkedPaidAt"
  > | null;
}): Promise<PartPaymentAtCancel | "unsizable" | null> {
  const payment = booking.payment;
  if (
    !payment ||
    payment.source !== PaymentSource.INTERNET_BANKING ||
    payment.status !== PaymentStatus.PENDING ||
    !payment.xeroInvoiceId ||
    payment.manuallyMarkedPaidAt ||
    // An organisation has no member account to credit (#3369); its paid path
    // refuses a credit refund, so recognition would turn a working cancel
    // into a failing one. It keeps the pre-#3643 behaviour.
    !booking.memberId
  ) {
    return null;
  }
  const evidence = await readHoldPaymentEvidence(payment);
  if (evidence.kind !== "paid") return null;
  if (!evidence.cashComplete || evidence.amountDueCents === null || evidence.paidCents <= 0) {
    return "unsizable";
  }
  return { paidCents: evidence.paidCents, amountDueCents: evidence.amountDueCents };
}

/**
 * Inside the cancel claim, under `pg_advisory_xact_lock(1)`: record the cash
 * as captured, exactly once. Returns the refreshed payment, or null when the
 * payment changed since the read (no longer PENDING, already has captured
 * money, or an unexpected ledger shape) — the caller then refuses the claim.
 *
 * Idempotent by its guard: it only writes onto a PENDING payment with no
 * captured row, and the write makes it SUCCEEDED with one. The pending
 * PRIMARY row is turned into the receipt rather than left beside it, so a later
 * PAID event for the invoice (the clearing note plus this cash) cannot flip a
 * second full-amount row to SUCCEEDED and double the capture.
 */
export async function recordPartPaymentInClaim(
  tx: Prisma.TransactionClient,
  paymentId: string,
  partPayment: PartPaymentAtCancel,
) {
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
    return null;
  }
  const captured = payment.transactions.some((row) =>
    [PaymentStatus.SUCCEEDED, PaymentStatus.REFUNDED, PaymentStatus.PARTIALLY_REFUNDED].includes(
      row.status as "SUCCEEDED" | "REFUNDED" | "PARTIALLY_REFUNDED",
    ),
  );
  if (captured) return null;
  const pendingPrimary = payment.transactions.filter(
    (row) =>
      row.kind === PaymentTransactionKind.PRIMARY &&
      row.source === PaymentSource.INTERNET_BANKING &&
      row.status === PaymentStatus.PENDING,
  );
  if (pendingPrimary.length > 1) return null;

  const [receiptRow] = pendingPrimary;
  if (receiptRow) {
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
  }
  return recordInternetBankingPaymentTransaction({
    paymentId,
    amountCents: partPayment.paidCents,
    status: PaymentStatus.SUCCEEDED,
    xeroInvoiceId: payment.xeroInvoiceId,
    xeroInvoiceNumber: payment.xeroInvoiceNumber,
    reference: payment.reference,
    reason: PART_PAYMENT_RECOGNISED_REASON,
    store: tx,
  });
}

/**
 * After the cancel claim commits: clear what the invoices still owe with
 * #3535's booking-anchored clearing note, sized from Xero's own amount due at
 * the read. The builder re-reads the invoices and creates nothing if they owe
 * less by then. Never throws — the cancellation already stands.
 */
export async function queueClearingNoteForUnpaidRest(
  bookingId: string,
  partPayment: PartPaymentAtCancel,
  createdByMemberId: string,
): Promise<void> {
  if (partPayment.amountDueCents <= 0) return;
  try {
    const queued = await enqueueXeroModificationCreditNoteOperation(
      { bookingId, refundAmountCents: partPayment.amountDueCents, clearsUnpaidInvoice: true },
      { createdByMemberId },
    );
    if (queued.queueOperationId && (await isXeroConnected())) {
      void kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 }).catch((err) =>
        logger.error({ err, bookingId }, "Failed to kick Xero invoice-clearing credit note outbox worker"),
      );
    }
  } catch (err) {
    logger.error(
      { err, bookingId, amountDueCents: partPayment.amountDueCents },
      "Failed to queue Xero invoice-clearing credit note for the unpaid rest of a part-paid booking",
    );
  }
}
