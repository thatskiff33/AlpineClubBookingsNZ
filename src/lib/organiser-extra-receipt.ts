/** A supplementary organiser invoice's actual cash joins the child's paid mirror. */
import type { Invoice } from "xero-node";
import { prisma } from "@/lib/prisma";
import { lockPaymentForRefundedTotal } from "@/lib/payment-transactions";
import { resolveOrganiserBilling } from "@/lib/organiser-billing";
import { asRecord } from "@/lib/xero-json";
import { syncBookingLedgerSettlements } from "@/lib/booking-ledger-settlement-sync";
import { CAPTURED_TRANSACTION_STATUS_LIST } from "@/lib/payment-transaction-status";
import { ORGANISER_SHARE_RECEIPT_REASON, ORGANISER_EXTRA_RECEIPT_REASON } from "@/lib/organiser-extra-state";

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
      const previous = await tx.paymentTransaction.findMany({ where: { paymentId, xeroInvoiceId: invoice.invoiceID, reason: ORGANISER_EXTRA_RECEIPT_REASON, status: { in: [...CAPTURED_TRANSACTION_STATUS_LIST] } }, select: { id: true, amountCents: true, refundedAmountCents: true }, orderBy: [{ createdAt: "desc" }, { insertionSeq: "desc" }] });
      const previousCashCents = previous.reduce((sum, row) => sum + row.amountCents, 0);
      const delta = cashCents - previousCashCents;
      if (cashCents > 0) {
        const primary = await tx.paymentTransaction.findFirst({ where: { paymentId: payment.id, kind: "PRIMARY", source: "INTERNET_BANKING" }, select: { id: true } });
        if (!primary) {
          const extras = await tx.paymentTransaction.findMany({ where: { paymentId: payment.id, reason: ORGANISER_EXTRA_RECEIPT_REASON, status: { in: [...CAPTURED_TRANSACTION_STATUS_LIST] } }, select: { amountCents: true } });
          const originalCents = Math.max(0, payment.amountCents - extras.reduce((sum, row) => sum + row.amountCents, 0));
          const booking = await tx.booking.findUniqueOrThrow({ where: { id: modification.bookingId }, include: { payment: true } });
          const billing = await resolveOrganiserBilling(tx, booking);
          if (!billing) throw new Error("Extra receipt has no organiser settlement");
          await tx.paymentTransaction.create({ data: { paymentId: payment.id, kind: "PRIMARY", source: "INTERNET_BANKING", amountCents: originalCents, refundedAmountCents: Math.min(payment.refundedAmountCents, originalCents), status: payment.refundedAmountCents >= originalCents ? "REFUNDED" : payment.refundedAmountCents > 0 ? "PARTIALLY_REFUNDED" : "SUCCEEDED", xeroInvoiceId: billing.combinedInvoiceId, reason: ORGANISER_SHARE_RECEIPT_REASON } });
        }
      }
      const receipt = async (amountCents: number) => tx.paymentTransaction.create({ data: { paymentId, kind: "ADDITIONAL", source: "INTERNET_BANKING", amountCents, status: "SUCCEEDED", xeroInvoiceId: invoice.invoiceID, xeroInvoiceNumber: invoice.invoiceNumber ?? null, reason: ORGANISER_EXTRA_RECEIPT_REASON } });
      if (delta > 0) await receipt(delta);
      if (delta < 0) {
        // Captures are immutable ledger sources. Reverse affected receipts and
        // re-record a partially reversed row's surviving cash as a new source.
        let reversedCents = -delta;
        for (const row of previous) {
          if (reversedCents <= 0) break;
          if (row.refundedAmountCents > 0) throw new Error("Organiser extra cash was reversed after it was refunded; reconcile this invoice by hand");
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

/** Avoid requiring cash fields on unrelated/subscription invoice payloads. */
export async function reconcileOrganiserExtraInvoiceCash(invoice: Invoice): Promise<void> {
  if (!invoice.invoiceID) return;
  const link = await prisma.xeroObjectLink.findFirst({ where: { xeroObjectType: "INVOICE", xeroObjectId: invoice.invoiceID, localModel: "BookingModification", role: "SUPPLEMENTARY_INVOICE", active: true, metadata: { path: ["organiserBilling"], equals: true } }, select: { id: true } });
  if (link) await syncOrganiserExtraInvoiceCash(invoice);
}
