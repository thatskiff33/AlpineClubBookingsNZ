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
import { readPrimaryInvoiceFeeAtLink } from "@/lib/xero-primary-invoice-gap-anchors";
import { buildXeroIdempotencyKey } from "@/lib/xero-sync";

/** The primary invoice's Stripe payment key: one per Payment, whichever run sends it. */
export function primaryInvoicePaymentKey(paymentId: string): string {
  return buildXeroIdempotencyKey("payment", paymentId, "invoice-payment", "v1");
}

type PrimaryPayment = { id: string; stripePaymentIntentId: string | null };

/**
 * The one card capture the primary invoice's Stripe cash came from. The link's
 * save recorded which captures that cash covers (`intentsRecordedByPrimaryCash`,
 * the split each capture's own receipt stands down by): where it names exactly
 * one, that is the capture, whatever intent the Payment points at now. Where it
 * names several, no one capture holds the payment: `capture` is null, so a
 * receipt is never coverage on a capture that funded only part of it. A link
 * saved without that record cannot tell, and names the Payment's own intent.
 * Null altogether when the record could not be read.
 */
async function primaryInvoiceCashCapture(
  bookingId: string,
  invoiceId: string,
  paymentIntentId: string | null,
): Promise<{ capture: string | null } | null> {
  try {
    const atLink = (await readPrimaryInvoiceFeeAtLink(bookingId, invoiceId))?.atLink;
    const partial = atLink?.partiallyRecordedCaptureAtLink;
    const named = [...(atLink?.paymentIntentIdsRecordedAtLink ?? []), ...(partial ? [partial.paymentIntentId] : [])];
    if (named.length === 0) return { capture: paymentIntentId };
    return { capture: named.length === 1 ? named[0]! : null };
  } catch (error) {
    logger.error({ err: error, bookingId, invoiceId }, "Could not read which captures the primary invoice's Stripe cash covers; no capture receipt is recorded");
    return null;
  }
}

/**
 * The primary invoice's Stripe payment as Xero returned it (`sent`), or as the
 * raising run stored that response. Its cents are Xero's, else the cents the
 * run sent (`sentCents`); its bank code is Xero's, else the one sent. No payment
 * id, no receipt. Cash from several captures names none, and is a conflict.
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
  const cash = await primaryInvoiceCashCapture(input.bookingId, input.invoiceId, input.payment.stripePaymentIntentId);
  if (!cash) return;
  await recordCaptureReceiptManifest({
    bookingId: input.bookingId,
    paymentIntentId: cash.capture,
    paymentKey: primaryInvoicePaymentKey(input.payment.id),
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
 * operation. Null where it stored none; undefined on a read failure so the
 * completion can preserve evidence it could not read. The
 * invoice's other payment links (a PARTIAL repair's, which records its own, or
 * the inbound sync's bank payments) are not this payment.
 */
export async function readStoredPrimaryInvoicePayment(syncOperationId: string): Promise<unknown> {
  try {
    const operation = await prisma.xeroSyncOperation.findUnique({ where: { id: syncOperationId }, select: { responsePayload: true } });
    return asRecord(operation?.responsePayload)?.payment ?? null;
  } catch (error) {
    logger.error({ err: error, syncOperationId }, "Could not read the stored primary invoice payment");
    return undefined;
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
 * or an earlier run's link). The capture is the one the primary invoice's cash
 * came from (`primaryInvoiceCashCapture`), else the one the stored payload
 * names; when neither names one, nothing is recorded and the repair still
 * closes. The bank code is read from the payment operation the repair stored.
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
    capture = await partialRepairCapture(operation, repair.invoiceId);
  } catch (error) {
    logger.error({ err: error, localModel: operation.localModel, localId: operation.localId }, "Could not name the capture a repaired invoice payment records");
  }
  if (!capture) return;
  await recordCaptureReceiptManifest({
    ...capture,
    paymentKey: repair.idempotencyKey,
    amountCents: repair.amountCents,
    providerPaymentId,
    invoiceId: repair.invoiceId,
    reference: repair.reference,
  });
}

async function partialRepairCapture(
  operation: { localModel: string | null; localId: string | null; requestPayload: unknown },
  invoiceId: string,
): Promise<{ bookingId: string; paymentIntentId: string } | null> {
  if (operation.localModel === "Payment" && operation.localId) {
    const payment = await prisma.payment.findUnique({
      where: { id: operation.localId },
      select: { bookingId: true, stripePaymentIntentId: true },
    });
    const paymentIntentId = payment && (await primaryInvoiceCashCapture(payment.bookingId, invoiceId, payment.stripePaymentIntentId))?.capture;
    return payment && paymentIntentId ? { bookingId: payment.bookingId, paymentIntentId } : null;
  }
  const payload = asRecord(operation.requestPayload);
  const bookingId = readString(payload?.bookingId);
  const paymentIntentId = readString(payload?.paymentIntentId);
  return bookingId && paymentIntentId ? { bookingId, paymentIntentId } : null;
}
