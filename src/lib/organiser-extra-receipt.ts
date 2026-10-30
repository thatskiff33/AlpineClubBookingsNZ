/** A supplementary organiser invoice's actual cash joins the child's paid mirror. */
import type { Invoice } from "xero-node";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { lockPaymentForRefundedTotal } from "@/lib/payment-transactions";
import { resolveOrganiserBilling } from "@/lib/organiser-billing";
import { asRecord } from "@/lib/xero-json";
import { syncBookingLedgerSettlements } from "@/lib/booking-ledger-settlement-sync";
import { CAPTURED_TRANSACTION_STATUS_LIST } from "@/lib/payment-transaction-status";
import { LEDGER_ROWS_NEWEST_FIRST, LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";
import { ORGANISER_SHARE_RECEIPT_REASON, ORGANISER_EXTRA_RECEIPT_REASON, organiserExtraPaidPriceCents, readOrganiserExtraState, type OrganiserExtraInvoice } from "@/lib/organiser-extra-state";

export async function syncOrganiserExtraInvoiceCash(invoice: Invoice): Promise<void> {
  if (!invoice.invoiceID) return;
  const { quantifyXeroInvoiceCashCents } = await import("@/lib/xero-inbound/invoice-paid-effects");
  const cash = quantifyXeroInvoiceCashCents(invoice);
  const cashCents = cash.knownCents;
  if (!cash.complete || cashCents < 0) throw new Error("Organiser extra invoice has no readable cash figure");
  const links = await prisma.xeroObjectLink.findMany({ where: { xeroObjectType: "INVOICE", xeroObjectId: invoice.invoiceID, localModel: "BookingModification", role: "SUPPLEMENTARY_INVOICE", active: true }, select: { localId: true, metadata: true } });
  for (const link of links) {
    if (asRecord(link.metadata)?.organiserBilling !== true) continue;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      const modification = await tx.bookingModification.findUniqueOrThrow({ where: { id: link.localId }, select: { bookingId: true } });
      const paymentId = (await tx.payment.findUniqueOrThrow({ where: { bookingId: modification.bookingId }, select: { id: true } })).id;
      await lockPaymentForRefundedTotal(tx, paymentId);
      const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      const previous = await tx.paymentTransaction.findMany({
        where: { paymentId, xeroInvoiceId: invoice.invoiceID, reason: ORGANISER_EXTRA_RECEIPT_REASON, status: { in: [...CAPTURED_TRANSACTION_STATUS_LIST] } },
        select: { id: true, amountCents: true, refundedAmountCents: true },
        orderBy: [...LEDGER_ROWS_NEWEST_FIRST], // the reversal below walks the newest receipt first
      });
      const previousCashCents = previous.reduce((sum, row) => sum + row.amountCents, 0);
      const delta = cashCents - previousCashCents;
      if (cashCents > 0) {
        const primary = await tx.paymentTransaction.findFirst({ where: { paymentId: payment.id, kind: "PRIMARY", source: "INTERNET_BANKING" }, select: { id: true } });
        if (!primary) {
          const extras = await tx.paymentTransaction.findMany({ where: { paymentId: payment.id, reason: ORGANISER_EXTRA_RECEIPT_REASON, status: { in: [...CAPTURED_TRANSACTION_STATUS_LIST] } }, orderBy: [...LEDGER_ROWS_OLDEST_FIRST], select: { amountCents: true } });
          const originalCents = Math.max(0, payment.amountCents - extras.reduce((sum, row) => sum + row.amountCents, 0));
          const booking = await tx.booking.findUniqueOrThrow({ where: { id: modification.bookingId }, include: { payment: true } });
          const billing = await resolveOrganiserBilling(tx, booking);
          if (!billing) throw new Error("Extra receipt has no organiser settlement");
          await tx.paymentTransaction.create({
            data: {
              paymentId: payment.id, kind: "PRIMARY", source: "INTERNET_BANKING", amountCents: originalCents,
              refundedAmountCents: Math.min(payment.refundedAmountCents, originalCents),
              status: payment.refundedAmountCents >= originalCents ? "REFUNDED" : payment.refundedAmountCents > 0 ? "PARTIALLY_REFUNDED" : "SUCCEEDED",
              xeroInvoiceId: billing.combinedInvoiceId, reason: ORGANISER_SHARE_RECEIPT_REASON,
            },
          });
        }
      }
      const receipt = async (amountCents: number) => tx.paymentTransaction.create({
        data: { paymentId, kind: "ADDITIONAL", source: "INTERNET_BANKING", amountCents, status: "SUCCEEDED", xeroInvoiceId: invoice.invoiceID, xeroInvoiceNumber: invoice.invoiceNumber ?? null, reason: ORGANISER_EXTRA_RECEIPT_REASON },
      });
      if (delta > 0) await receipt(delta);
      // N2: what was refunded from this invoice's cash is the netting's own record, not the
      // receipt rows - a refund lands on the combined share's row first (F2).
      const extra = delta < 0 ? (await readOrganiserExtraState(tx, modification.bookingId)).invoices.find((row) => row.invoiceId === invoice.invoiceID) : undefined;
      if (delta < 0 && reversalTouchesRefundedCash(extra, cashCents)) {
        // N-d: cash the organiser was partly refunded from cannot be unwound
        // here. Record nothing, raise one treasurer task, and let the rest of
        // the inbound event (and every later one) proceed.
        await raiseCashReversedAfterRefundReview(tx, { invoice, modificationId: link.localId, bookingId: modification.bookingId, cashCents });
        return;
      }
      if (delta < 0) {
        // Captures are immutable ledger sources. Reverse affected receipts and
        // re-record a partially reversed row's surviving cash as a new source.
        let reversedCents = -delta;
        for (const row of previous) {
          if (reversedCents <= 0) break;
          await tx.paymentTransaction.update({ where: { id: row.id }, data: { status: "FAILED" } });
          const survivingCents = Math.max(0, row.amountCents - reversedCents);
          reversedCents = Math.max(0, reversedCents - row.amountCents);
          if (survivingCents > 0) await receipt(survivingCents);
        }
      }
      // The original combined-invoice share is a mirror, not a transaction.
      // Re-projecting aggregates from only this receipt would erase that share.
      if (delta !== 0) {
        await tx.payment.update({ where: { id: payment.id }, data: { amountCents: { increment: delta } } });
        await syncBookingLedgerSettlements({ paymentId, store: tx });
      }
    });
  }
}

/**
 * N2: whether a reversal down to `cashAfterCents` takes back paid price this
 * invoice's refunds were already sized on (`releasedPriceCents`, its refund
 * plans, `readOrganiserExtraState`). The fee is paid first (N4), so the price
 * still paid after it is what is left once the fee is covered. A plan that
 * refunded nothing handed no cash back, so its reversal unwinds as usual.
 */
function reversalTouchesRefundedCash(extra: OrganiserExtraInvoice | undefined, cashAfterCents: number): boolean {
  if (!extra || extra.refundedCents <= 0) return false;
  return organiserExtraPaidPriceCents({ ...extra, cashCents: cashAfterCents, releasedPriceCents: 0 }) < extra.releasedPriceCents;
}

/**
 * N-d: the treasurer's task in Xero Operations - a non-replayable FAILED
 * review row, as `raisePrimaryInvoiceReviewTask` raises - when cash on an
 * organiser's extra invoice is reversed after part of it was refunded. One per
 * invoice and cash figure, so a later, different reversal raises its own.
 */
async function raiseCashReversedAfterRefundReview(
  tx: Prisma.TransactionClient,
  input: { invoice: Invoice; modificationId: string; bookingId: string; cashCents: number },
): Promise<void> {
  const correlationKey = `organiser-extra-cash-reversed:${input.invoice.invoiceID}:${input.cashCents}`;
  if (await tx.xeroSyncOperation.findFirst({ where: { correlationKey, entityType: "REVIEW" }, select: { id: true } })) return;
  const now = new Date();
  const reference = input.invoice.invoiceNumber ?? input.invoice.invoiceID;
  await tx.xeroSyncOperation.create({
    data: {
      direction: "INBOUND", entityType: "REVIEW", operationType: "ORGANISER_EXTRA_CASH_REVERSED",
      // N6: anchored on the Booking, as `raisePrimaryInvoiceReviewTask`'s are, so the booking shows it; the change rides in the payload.
      localModel: "Booking", localId: input.bookingId, status: "FAILED", correlationKey, replayable: false,
      lastErrorCode: "ORGANISER_EXTRA_CASH_REVERSED",
      lastErrorMessage:
        `Cash on the group organiser's extra invoice ${reference} for Booking ${input.bookingId.slice(0, 8)} was reversed in Xero ` +
        "after part of it had been refunded to the organiser, so the app has left what it records as paid unchanged. Check the invoice, " +
        "the reversal and the refund in Xero, recover or write off the difference there, then choose Resolve (fixed in Xero).",
      requestPayload: { invoiceId: input.invoice.invoiceID ?? null, bookingId: input.bookingId, modificationId: input.modificationId, cashCents: input.cashCents },
      startedAt: now, completedAt: now,
    },
  });
}

/** Avoid requiring cash fields on unrelated/subscription invoice payloads. */
export async function reconcileOrganiserExtraInvoiceCash(invoice: Invoice): Promise<void> {
  if (!invoice.invoiceID) return;
  const link = await prisma.xeroObjectLink.findFirst({ where: { xeroObjectType: "INVOICE", xeroObjectId: invoice.invoiceID, localModel: "BookingModification", role: "SUPPLEMENTARY_INVOICE", active: true, metadata: { path: ["organiserBilling"], equals: true } }, select: { id: true } });
  if (link) await syncOrganiserExtraInvoiceCash(invoice);
}
