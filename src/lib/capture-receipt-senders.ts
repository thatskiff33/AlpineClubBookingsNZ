/**
 * #4525 (Ledger M13): the capture senders' side of the capture-receipt
 * manifest, for the senders that read what they stored rather than hold it:
 * the primary invoice's Stripe payment (raised, or replayed from the stored
 * response) and a PARTIAL invoice repair. Each names the capture, key, cents and
 * Xero payment id, and hands them to `recordCaptureReceiptManifest`, which
 * never throws. Nothing here sends anything to Xero.
 */
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { recordCaptureReceiptManifest } from "@/lib/member-money/doors";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { asRecord, readString } from "@/lib/xero-json";
import { primaryInvoiceStripePaymentReference } from "@/lib/xero-primary-invoice-fee-gap";
import { buildXeroIdempotencyKey } from "@/lib/xero-sync";

/** The primary invoice's Stripe payment key: one per Payment, whichever run sends it. */
export function primaryInvoicePaymentKey(paymentId: string): string {
  return buildXeroIdempotencyKey("payment", paymentId, "invoice-payment", "v1");
}

type PrimaryPayment = { id: string; stripePaymentIntentId: string | null };

/**
 * The primary invoice's Stripe payment as Xero returned it (`sent`), or as the
 * raising run stored that response. Its cents are Xero's, else the cents the
 * run sent (`sentCents`); its bank code is Xero's, else the one sent. No payment
 * id, no receipt.
 */
export async function recordPrimaryInvoicePaymentReceipt(input: {
  bookingId: string;
  payment: PrimaryPayment;
  invoiceId: string;
  sent: unknown;
  sentCents: number | null;
  reference: string;
  bankCode: string | null;
}): Promise<void> {
  const sent = asRecord(input.sent);
  const providerPaymentId = readString(sent?.paymentID);
  const amountCents = providerAmountToCents(sent?.amount) ?? input.sentCents;
  if (!providerPaymentId || amountCents === null) return;
  await recordCaptureReceiptManifest({
    bookingId: input.bookingId,
    paymentIntentId: input.payment.stripePaymentIntentId,
    applicationKey: primaryInvoicePaymentKey(input.payment.id),
    amountCents,
    providerPaymentId,
    invoiceId: input.invoiceId,
    reference: readString(sent?.reference) ?? input.reference,
    bankCode: readString(asRecord(sent?.account)?.code) ?? input.bankCode,
  });
}

/**
 * The Stripe payment the raising run stored on its operation
 * (`responsePayload.payment`), for a replay to read before it completes the
 * operation over it. Null where it stored none, and on a read failure. The
 * invoice's other payment links (a PARTIAL repair's, which records its own, or
 * the inbound sync's bank payments) are not this payment.
 */
export async function readStoredPrimaryInvoicePayment(syncOperationId: string): Promise<unknown> {
  try {
    const operation = await prisma.xeroSyncOperation.findUnique({ where: { id: syncOperationId }, select: { responsePayload: true } });
    return asRecord(operation?.responsePayload)?.payment ?? null;
  } catch (error) {
    logger.error({ err: error, syncOperationId }, "Could not read the stored primary invoice payment");
    return null;
  }
}

/** The replay's receipt, from the payment `readStoredPrimaryInvoicePayment` read; no stored payment, no receipt. */
export async function recordStoredPrimaryInvoicePaymentReceipt(sent: unknown, payment: PrimaryPayment, bookingId: string, invoiceId: string): Promise<void> {
  await recordPrimaryInvoicePaymentReceipt({
    bookingId, payment, invoiceId, sent, sentCents: null,
    reference: primaryInvoiceStripePaymentReference(payment.stripePaymentIntentId), bankCode: null,
  });
}

/**
 * A PARTIAL invoice repair's receipt, once the payment id is stored (sent now,
 * or an earlier run's link). The capture is the booking payment's for a primary
 * invoice, else the one the stored payload names; when neither names one,
 * nothing is recorded and the repair still closes. The bank code is read from
 * the payment operation the repair stored.
 */
export async function recordRepairCaptureReceipt(
  operation: { localModel: string | null; localId: string | null; requestPayload: unknown; responsePayload?: unknown },
  repair: { invoiceId: string; amountCents: number; idempotencyKey: string; reference: string },
  providerPaymentId: string,
): Promise<void> {
  let capture: { bookingId: string; paymentIntentId: string } | null = null;
  try {
    // Inbound bank payments can close a repair too. Only the payment this
    // outbound operation sent is evidence of a card capture receipt.
    const originalPaymentId = readString(asRecord(asRecord(operation.responsePayload)?.payment)?.paymentID);
    if (originalPaymentId !== providerPaymentId) {
      const sentPayment = await prisma.xeroSyncOperation.findFirst({
        where: { direction: "OUTBOUND", entityType: "PAYMENT", idempotencyKey: repair.idempotencyKey, xeroObjectId: providerPaymentId },
        select: { id: true },
      });
      if (!sentPayment) return;
    }
    capture = await partialRepairCapture(operation);
  } catch (error) {
    logger.error({ err: error, localModel: operation.localModel, localId: operation.localId }, "Could not name the capture a repaired invoice payment records");
  }
  if (!capture) return;
  await recordCaptureReceiptManifest({
    ...capture,
    applicationKey: repair.idempotencyKey,
    amountCents: repair.amountCents,
    providerPaymentId,
    invoiceId: repair.invoiceId,
    reference: repair.reference,
  });
}

async function partialRepairCapture(
  operation: { localModel: string | null; localId: string | null; requestPayload: unknown },
): Promise<{ bookingId: string; paymentIntentId: string } | null> {
  if (operation.localModel === "Payment" && operation.localId) {
    const payment = await prisma.payment.findUnique({
      where: { id: operation.localId },
      select: { bookingId: true, stripePaymentIntentId: true },
    });
    return payment?.stripePaymentIntentId ? { bookingId: payment.bookingId, paymentIntentId: payment.stripePaymentIntentId } : null;
  }
  const payload = asRecord(operation.requestPayload);
  const bookingId = readString(payload?.bookingId);
  const paymentIntentId = readString(payload?.paymentIntentId);
  return bookingId && paymentIntentId ? { bookingId, paymentIntentId } : null;
}
