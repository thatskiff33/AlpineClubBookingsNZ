/**
 * #3643 (`INV-PAY-107`, owner decision 26 Sep 2026, option A): has anybody paid
 * towards an expired internet-banking hold?
 *
 * The hold-expiry job used to release every expired hold as if it were unpaid.
 * The inbound Xero sync only SETTLES a booking whose invoice is fully paid; a
 * part payment leaves nothing but a PAYMENT link (`xero-inbound/invoice.ts`),
 * so a member who had paid $150 of $300 lost their beds and the money went
 * untracked. The job now asks this module first and keeps any hold with money
 * against it.
 *
 * TWO sources, because either alone misses a case:
 *  - the invoice read LIVE from Xero. A transfer that landed just before the
 *    deadline may not have reached the inbound reconcile yet, so the local
 *    record alone would call it unpaid.
 *  - the PAYMENT links the inbound sync already recorded. They are the only
 *    evidence left when Xero cannot be read, and they are what the release
 *    transaction re-checks under its locks (`hasRecordedInvoicePayment`).
 *
 * The live read runs BEFORE the release transaction, never inside it (provider
 * calls stay out of transactions). Anything it cannot establish is
 * `unreadable`, and an unreadable hold is kept: releasing without evidence is
 * the exact harm option A was chosen to stop.
 */
import type { Prisma } from "@prisma/client";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { findBookingSupplementaryInvoiceIds } from "@/lib/xero-clearing-allocations";
import {
  classifyXeroInvoiceCashEvidence,
  quantifyXeroInvoiceCashCents,
} from "@/lib/xero-inbound/invoice-paid-effects";
import {
  BOOKING_INVOICE_PAYMENT_ROLES,
  isRecordedBookingInvoicePayment,
} from "@/lib/xero-inbound/object-links";

export interface HoldInvoiceReading {
  invoiceId: string;
  invoiceNumber: string | null;
  /** Xero shows cash against this invoice (`classifyXeroInvoiceCashEvidence`). */
  hasCash: boolean;
  /**
   * The cash, in cents (payments plus over/prepayments applied). A floor when
   * Xero's amounts did not all quantify, so `hasCash` is the decision.
   */
  paidCents: number;
  amountDueCents: number | null;
}

export type HoldPaymentEvidence =
  /** No issued invoice: nothing can have been paid against one. */
  | { kind: "no-invoice" }
  /** Every invoice read cleanly, no cash on any, and no recorded payment link. */
  | { kind: "unpaid"; invoices: HoldInvoiceReading[] }
  | {
      kind: "paid";
      invoices: HoldInvoiceReading[];
      /** True when only the local PAYMENT link says so (Xero unreadable). */
      fromRecordedLinkOnly: boolean;
      paidCents: number;
      amountDueCents: number | null;
    }
  | { kind: "unreadable"; reason: string };

type LinkReader = Pick<Prisma.TransactionClient, "xeroObjectLink" | "bookingModification">;

/**
 * Whether the inbound sync has recorded any payment against the booking's
 * primary or supplementary invoices. Reads only local rows, so it is safe
 * inside the release transaction, where it is the under-lock re-check
 * (`INV-PAY-107`): a part payment the inbound reconcile recorded between the
 * live read and the lock stops the release.
 */
export async function hasRecordedInvoicePayment(
  { paymentId, bookingId }: { paymentId: string; bookingId: string },
  db: LinkReader = prisma,
): Promise<boolean> {
  const modifications = await db.bookingModification.findMany({
    where: { bookingId },
    select: { id: true },
  });
  const links = await db.xeroObjectLink.findMany({
    where: {
      active: true,
      xeroObjectType: "PAYMENT",
      role: { in: [...BOOKING_INVOICE_PAYMENT_ROLES] },
      OR: [
        { localModel: "Payment", localId: paymentId },
        ...(modifications.length > 0
          ? [
              {
                localModel: "BookingModification",
                localId: { in: modifications.map((row) => row.id) },
              },
            ]
          : []),
      ],
    },
    select: { xeroObjectType: true, role: true, metadata: true },
  });
  return links.some(isRecordedBookingInvoicePayment);
}

function describeReadFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 297)}...` : message;
}

/**
 * Read an expired hold's invoices from Xero and decide whether any money is
 * against them. Never throws: a failure is `unreadable` (or `paid`, when a
 * recorded payment link already proves money arrived).
 */
export async function readHoldPaymentEvidence(hold: {
  id: string;
  bookingId: string;
  xeroInvoiceId: string | null;
  xeroInvoiceNumber: string | null;
}): Promise<HoldPaymentEvidence> {
  let recordedLink: boolean;
  try {
    recordedLink = await hasRecordedInvoicePayment({
      paymentId: hold.id,
      bookingId: hold.bookingId,
    });
  } catch (error) {
    return { kind: "unreadable", reason: describeReadFailure(error) };
  }

  if (!hold.xeroInvoiceId) {
    // No invoice yet means nothing to pay against — but a link would still
    // be money, so it is honoured rather than second-guessed.
    return recordedLink
      ? {
          kind: "paid",
          invoices: [],
          fromRecordedLinkOnly: true,
          paidCents: 0,
          amountDueCents: null,
        }
      : { kind: "no-invoice" };
  }

  let invoices: HoldInvoiceReading[];
  let indeterminate = false;
  try {
    const supplementaryIds = await findBookingSupplementaryInvoiceIds(hold.bookingId);
    const invoiceIds = [...new Set([hold.xeroInvoiceId, ...supplementaryIds])];
    const { xero, tenantId } = await getAuthenticatedXeroClient();
    invoices = [];
    for (const invoiceId of invoiceIds) {
      const response = await callXeroApi(
        () => xero.accountingApi.getInvoice(tenantId, invoiceId),
        {
          operation: "getInvoice",
          resourceType: "INVOICE",
          workflow: "releaseExpiredInternetBankingHolds",
          context: `getInvoice(hold-expiry payment check ${invoiceId})`,
        },
      );
      const invoice = response.body.invoices?.[0];
      if (!invoice) throw new Error(`Xero returned no invoice for ${invoiceId}`);
      const evidence = classifyXeroInvoiceCashEvidence(invoice);
      if (evidence === "indeterminate") indeterminate = true;
      invoices.push({
        invoiceId,
        invoiceNumber:
          invoice.invoiceNumber ??
          (invoiceId === hold.xeroInvoiceId ? hold.xeroInvoiceNumber : null),
        hasCash: evidence === "cash",
        paidCents:
          evidence === "cash" ? quantifyXeroInvoiceCashCents(invoice).knownCents : 0,
        amountDueCents: providerAmountToCents(invoice.amountDue),
      });
    }
  } catch (error) {
    logger.warn(
      { err: error, bookingId: hold.bookingId, paymentId: hold.id },
      "Could not read an expired Internet Banking hold's invoice from Xero; keeping the hold",
    );
    return recordedLink
      ? {
          kind: "paid",
          invoices: [],
          fromRecordedLinkOnly: true,
          paidCents: 0,
          amountDueCents: null,
        }
      : { kind: "unreadable", reason: describeReadFailure(error) };
  }

  const liveCash = invoices.some((invoice) => invoice.hasCash);
  if (liveCash || recordedLink) {
    const dues = invoices.map((invoice) => invoice.amountDueCents);
    return {
      kind: "paid",
      invoices,
      fromRecordedLinkOnly: !liveCash,
      paidCents: invoices.reduce((sum, invoice) => sum + invoice.paidCents, 0),
      amountDueCents: dues.every((due) => due !== null)
        ? dues.reduce<number>((sum, due) => sum + (due ?? 0), 0)
        : null,
    };
  }
  if (indeterminate) {
    return {
      kind: "unreadable",
      reason: "Xero returned the invoice without its payment fields.",
    };
  }
  return { kind: "unpaid", invoices };
}
