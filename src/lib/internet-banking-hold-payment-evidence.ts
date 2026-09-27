/**
 * #3643 (`INV-PAY-107`, owner decision 26 Sep 2026, option A): has anybody paid
 * towards an internet-banking booking's invoice?
 *
 * The hold-expiry job used to release every expired hold as if it were unpaid.
 * The inbound Xero sync only SETTLES a booking whose invoice is fully paid; a
 * part payment leaves nothing but a PAYMENT link (`xero-inbound/invoice.ts`),
 * so a member who had paid $150 of $300 lost their beds and the money went
 * untracked. The job, and the cancel path when an officer cancels such a
 * booking, now ask this module first.
 *
 * TWO sources, with a fixed precedence:
 *  - the invoice read LIVE from Xero wins whenever every invoice was read
 *    cleanly. A transfer that landed just before the deadline may not have
 *    reached the inbound reconcile yet, and a payment the treasurer removed in
 *    bank rec leaves a stale local link that Xero no longer shows.
 *  - the PAYMENT links the inbound sync recorded are used only when Xero
 *    cannot answer, and — for links that appeared after the read started —
 *    by the release transaction's under-lock re-check
 *    (`hasRecordedInvoicePayment` with `since`).
 *
 * The live read runs BEFORE any transaction (provider calls stay out of
 * transactions). Anything it cannot establish is `unreadable`, never `unpaid`.
 */
import type { Prisma } from "@prisma/client";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { findBookingSupplementaryInvoiceIds } from "@/lib/xero-clearing-allocations";
import { getXeroErrorStatusCode } from "@/lib/xero-error-shape";
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
   * Xero's amounts did not all quantify (`cashComplete` false).
   */
  paidCents: number;
  cashComplete: boolean;
  amountDueCents: number | null;
}

interface ReadStamp {
  /** Taken before anything was read: the re-check's cut-off for new links. */
  readStartedAt: Date;
}

export type HoldPaymentEvidence = ReadStamp &
  (
    /** No issued invoice: nothing can have been paid against one. */
    | { kind: "no-invoice" }
    /** Every invoice read cleanly and shows no cash. A local link is ignored. */
    | { kind: "unpaid"; invoices: HoldInvoiceReading[] }
    | {
        kind: "paid";
        /** The invoices that WERE read (a failed supplementary is absent). */
        invoices: HoldInvoiceReading[];
        /** True when only a recorded link says so, because Xero could not answer. */
        fromRecordedLinkOnly: boolean;
        paidCents: number;
        /**
         * Every invoice was read and every figure quantified exactly — the
         * only state in which `paidCents` may be recorded as captured money.
         */
        cashComplete: boolean;
        /** Null unless every invoice was read. */
        amountDueCents: number | null;
        /** Every invoice read, nothing left owing: the inbound sync is behind. */
        paidInFull: boolean;
      }
    | {
        kind: "unreadable";
        reason: string;
        /** Xero answered 404 for an invoice the booking records. */
        notFound: boolean;
      }
  );

type LinkReader = Pick<Prisma.TransactionClient, "xeroObjectLink" | "bookingModification">;

/**
 * Whether the inbound sync has recorded a payment against the booking's primary
 * or supplementary invoices. Reads only local rows, so it is safe inside a
 * transaction. With `since`, only links created at or after that instant count:
 * that is the release transaction's re-check, which must catch a payment the
 * inbound reconcile recorded after the live read, not re-litigate a stale link
 * the clean read already overruled.
 */
export async function hasRecordedInvoicePayment(
  {
    paymentId,
    bookingId,
    since,
  }: { paymentId: string; bookingId: string; since?: Date },
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
      ...(since ? { createdAt: { gte: since } } : {}),
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

function sumDue(invoices: HoldInvoiceReading[]): number | null {
  let total = 0;
  for (const invoice of invoices) {
    if (invoice.amountDueCents === null) return null;
    total += invoice.amountDueCents;
  }
  return total;
}

/**
 * Read a booking's invoices from Xero and decide whether any money is against
 * them. Never throws.
 */
export async function readHoldPaymentEvidence(hold: {
  id: string;
  bookingId: string;
  xeroInvoiceId: string | null;
  xeroInvoiceNumber: string | null;
}): Promise<HoldPaymentEvidence> {
  const readStartedAt = new Date();
  const linkOnlyPaid = (): HoldPaymentEvidence => ({
    kind: "paid",
    readStartedAt,
    invoices: [],
    fromRecordedLinkOnly: true,
    paidCents: 0,
    cashComplete: false,
    amountDueCents: null,
    paidInFull: false,
  });

  let recordedLink: boolean;
  try {
    recordedLink = await hasRecordedInvoicePayment({
      paymentId: hold.id,
      bookingId: hold.bookingId,
    });
  } catch (error) {
    return {
      kind: "unreadable",
      readStartedAt,
      reason: describeReadFailure(error),
      notFound: false,
    };
  }

  if (!hold.xeroInvoiceId) {
    // No invoice yet means nothing to pay against — but a link would still
    // be money, so it is honoured rather than second-guessed.
    return recordedLink ? linkOnlyPaid() : { kind: "no-invoice", readStartedAt };
  }

  const readings: HoldInvoiceReading[] = [];
  const failures: unknown[] = [];
  let indeterminate = false;
  let expected = 1;
  try {
    const supplementaryIds = await findBookingSupplementaryInvoiceIds(hold.bookingId);
    const invoiceIds = [...new Set([hold.xeroInvoiceId, ...supplementaryIds])];
    expected = invoiceIds.length;
    const { xero, tenantId } = await getAuthenticatedXeroClient();
    // Each invoice on its own: one failed supplementary read must not throw
    // away cash already seen on the primary.
    for (const invoiceId of invoiceIds) {
      try {
        const response = await callXeroApi(
          () => xero.accountingApi.getInvoice(tenantId, invoiceId),
          {
            operation: "getInvoice",
            resourceType: "INVOICE",
            workflow: "internetBankingHoldPaymentCheck",
            context: `getInvoice(hold payment check ${invoiceId})`,
          },
        );
        const invoice = response.body.invoices?.[0];
        if (!invoice) {
          failures.push(
            Object.assign(new Error(`Xero returned no invoice for ${invoiceId}`), {
              statusCode: 404,
            }),
          );
          continue;
        }
        const evidence = classifyXeroInvoiceCashEvidence(invoice);
        if (evidence === "indeterminate") indeterminate = true;
        const cash = evidence === "cash" ? quantifyXeroInvoiceCashCents(invoice) : null;
        readings.push({
          invoiceId,
          invoiceNumber:
            invoice.invoiceNumber ??
            (invoiceId === hold.xeroInvoiceId ? hold.xeroInvoiceNumber : null),
          hasCash: evidence === "cash",
          paidCents: cash?.knownCents ?? 0,
          cashComplete: cash ? cash.complete : evidence === "none",
          amountDueCents: providerAmountToCents(invoice.amountDue),
        });
      } catch (error) {
        failures.push(error);
      }
    }
  } catch (error) {
    failures.push(error);
  }

  const allRead = readings.length === expected && failures.length === 0;
  if (readings.some((reading) => reading.hasCash)) {
    const amountDueCents = allRead ? sumDue(readings) : null;
    return {
      kind: "paid",
      readStartedAt,
      invoices: readings,
      fromRecordedLinkOnly: false,
      paidCents: readings.reduce((sum, reading) => sum + reading.paidCents, 0),
      cashComplete:
        allRead && !indeterminate && readings.every((reading) => reading.cashComplete),
      amountDueCents,
      paidInFull: amountDueCents === 0,
    };
  }

  if (failures.length > 0 || indeterminate) {
    if (failures.length > 0) {
      logger.warn(
        { err: failures[0], bookingId: hold.bookingId, paymentId: hold.id },
        "Could not read an internet banking booking's invoice from Xero",
      );
    }
    if (recordedLink) return linkOnlyPaid();
    const notFound = failures.some((error) => {
      const status =
        getXeroErrorStatusCode(error) ??
        (error as { statusCode?: unknown } | null)?.statusCode;
      return status === 404;
    });
    return {
      kind: "unreadable",
      readStartedAt,
      reason:
        failures.length > 0
          ? describeReadFailure(failures[0])
          : "Xero returned the invoice without its payment fields.",
      notFound,
    };
  }

  // Every invoice read cleanly and shows no cash: Xero wins over a local link.
  return { kind: "unpaid", readStartedAt, invoices: readings };
}
