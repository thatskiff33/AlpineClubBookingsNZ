import { prisma } from "@/lib/prisma";

/**
 * DOES THIS BOOKING'S INVOICE ALREADY EXIST IN XERO — the one home for the
 * question (#3001, MAD epic #2725). `INV-SSOT`.
 *
 * ## Why the operation row cannot answer it
 *
 * The obvious answer is `XeroSyncOperation.xeroObjectId`, and it is wrong in the
 * one case that matters. **`failXeroSyncOperation` never writes that column** —
 * it writes the status, the error code, the redacted message, the response
 * payload and the completion time, and nothing else. Only
 * `completeXeroSyncOperation` writes the object id. So on a first-attempt
 * failure the id is null BY CONSTRUCTION, and reading "did the invoice reach
 * Xero?" off it answers *no* for every failure — including the failures where
 * the answer is yes.
 *
 * That case is not hypothetical. `createXeroInvoiceForBooking` does real work
 * AFTER Xero has accepted the invoice, and three of those steps can throw:
 * stamping the invoice id onto the payment, stamping it onto the primary
 * payment transaction, and settling the applied-credit allocation — which makes
 * a further provider round trip of its own. That module's own comment beside
 * them says a throw there fails the operation. A worker killed mid-invoice is a
 * second entrance to the same state, reached through the stale-RUNNING reset.
 *
 * Answering *no* there is the expensive direction. An officer told the club's
 * accounts hold no invoice, beside a Retry, raises a SECOND invoice for the same
 * booking — and the only duplicate guard on that path is the payment's stored
 * invoice id, which is precisely the write that failed.
 *
 * ## What this reads instead
 *
 * The two records the workflow persists BEFORE it can fail, in the order it
 * writes them:
 *
 *  - `Payment.xeroInvoiceId` — stamped as soon as Xero returns the invoice, and
 *    before the applied-credit settlement and the completion write;
 *  - the active `PRIMARY_INVOICE` object link — written in the completion
 *    transaction, so it also covers a row whose completion landed and whose
 *    later retry failed.
 *
 * These are the same two signals `enqueueXeroBookingInvoiceOperation` already
 * refuses a second mint on, which is the same question asked for the same
 * reason. That is why they live here and both callers ask this module.
 *
 * ## CORROBORATION, NOT CORRELATION
 *
 * Finding the booking's operation still goes through the BOOKING's correlation
 * key (`xero-booking-invoice-key.ts`), never through the payment row — a
 * booking whose payment row does not exist yet would otherwise match nothing and
 * the page would report all-clear over a failed invoice. This module is asked
 * afterwards, about a payment id the operation row itself carries in `localId`,
 * and only to corroborate what the found row already says. A booking with no
 * payment and no operation is still `null` at the query, before anything here
 * runs.
 *
 * ## WHAT IT CANNOT ANSWER
 *
 * A throw inside the payment stamp itself leaves no local record at all, and
 * neither does a worker killed between Xero accepting the invoice and that
 * write. There is nothing in this database to read, so `exists` is `false` and
 * the reading is honest rather than certain. The stale-RUNNING states are
 * reported as an explicitly UNKNOWN invoice state for exactly this reason
 * (`booking-invoice-sync-status.ts`), which is the case a worker death lands in.
 */

export interface BookingInvoiceEvidence {
  /**
   * The club's own records say an invoice for this booking exists in Xero.
   * `false` means no such record was found — which is not the same as proof that
   * Xero has nothing; see the note above.
   */
  exists: boolean;
  /** The Xero invoice number, where one of the two records carries it. */
  invoiceNumber: string | null;
}

type PaymentInvoiceFields = {
  id: string;
  xeroInvoiceId: string | null;
  xeroInvoiceNumber?: string | null;
};

type BookingInvoiceEvidenceDb = {
  payment: { findUnique(args: unknown): Promise<unknown> };
  xeroObjectLink: {
    findFirst(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown>;
  };
};

export interface BookingInvoiceEvidenceDependencies {
  db: BookingInvoiceEvidenceDb;
}

const defaultDependencies: BookingInvoiceEvidenceDependencies = {
  db: prisma as unknown as BookingInvoiceEvidenceDb,
};

/**
 * The active `PRIMARY_INVOICE` link for one payment, or `null`.
 *
 * Split out because `enqueueXeroBookingInvoiceOperation` asks exactly this,
 * separately from the payment field, and in an order its own fences depend on.
 */
export async function findActivePrimaryInvoiceLink(
  paymentId: string,
  input?: { deps?: Partial<BookingInvoiceEvidenceDependencies> },
): Promise<{ xeroObjectId: string; xeroObjectNumber: string | null } | null> {
  const deps = { ...defaultDependencies, ...input?.deps };

  return (await deps.db.xeroObjectLink.findFirst({
    where: {
      localModel: "Payment",
      localId: paymentId,
      xeroObjectType: "INVOICE",
      role: "PRIMARY_INVOICE",
      active: true,
    },
    select: { xeroObjectId: true, xeroObjectNumber: true },
  })) as { xeroObjectId: string; xeroObjectNumber: string | null } | null;
}

/**
 * The evidence for a payment already loaded by the caller.
 *
 * The link is only asked for when the payment field is empty, because the field
 * alone already settles it and the second read would change no answer.
 */
export async function readBookingInvoiceEvidence(
  payment: PaymentInvoiceFields,
  input?: { deps?: Partial<BookingInvoiceEvidenceDependencies> },
): Promise<BookingInvoiceEvidence> {
  if (payment.xeroInvoiceId) {
    return { exists: true, invoiceNumber: payment.xeroInvoiceNumber ?? null };
  }

  const link = await findActivePrimaryInvoiceLink(payment.id, input);

  return {
    exists: Boolean(link),
    invoiceNumber: link?.xeroObjectNumber ?? null,
  };
}

/**
 * The same evidence for MANY payments the caller has already loaded — the shape
 * the club-wide "paid bookings missing invoices" list has (#3467).
 *
 * It is the set form of {@link readBookingInvoiceEvidence}, not a third rule:
 * the payment field settles a payment on its own, and the active
 * `PRIMARY_INVOICE` link is asked for — in ONE query — only for the payments
 * the field leaves open. A list of several hundred paid bookings therefore
 * costs one round trip rather than one per booking, which is the only reason
 * this exists beside the per-payment reader.
 *
 * Every payment handed in gets an entry, so a caller can never mistake "not
 * looked up" for "no evidence".
 */
export async function readBookingInvoiceEvidenceForPayments(
  payments: readonly PaymentInvoiceFields[],
  input?: { deps?: Partial<BookingInvoiceEvidenceDependencies> },
): Promise<Map<string, BookingInvoiceEvidence>> {
  const deps = { ...defaultDependencies, ...input?.deps };
  const evidence = new Map<string, BookingInvoiceEvidence>();
  const unsettled: string[] = [];

  for (const payment of payments) {
    if (payment.xeroInvoiceId) {
      evidence.set(payment.id, {
        exists: true,
        invoiceNumber: payment.xeroInvoiceNumber ?? null,
      });
    } else {
      evidence.set(payment.id, { exists: false, invoiceNumber: null });
      unsettled.push(payment.id);
    }
  }

  if (unsettled.length === 0) return evidence;

  const links = (await deps.db.xeroObjectLink.findMany({
    where: {
      localModel: "Payment",
      localId: { in: unsettled },
      xeroObjectType: "INVOICE",
      role: "PRIMARY_INVOICE",
      active: true,
    },
    select: { localId: true, xeroObjectNumber: true },
  })) as Array<{ localId: string; xeroObjectNumber: string | null }>;

  for (const link of links) {
    evidence.set(link.localId, {
      exists: true,
      invoiceNumber: link.xeroObjectNumber ?? null,
    });
  }

  return evidence;
}

/**
 * The evidence for a payment the caller holds only the id of — the shape
 * `booking-invoice-sync-status.ts` has, because the operation row stores the
 * payment id in `localId`.
 *
 * A payment id that no longer resolves is "no evidence" rather than an error:
 * the projection's job is to describe a booking, not to fail on one.
 */
export async function readBookingInvoiceEvidenceForPayment(
  paymentId: string,
  input?: { deps?: Partial<BookingInvoiceEvidenceDependencies> },
): Promise<BookingInvoiceEvidence> {
  const deps = { ...defaultDependencies, ...input?.deps };

  const payment = (await deps.db.payment.findUnique({
    where: { id: paymentId },
    select: { id: true, xeroInvoiceId: true, xeroInvoiceNumber: true },
  })) as PaymentInvoiceFields | null;

  if (!payment) {
    const link = await findActivePrimaryInvoiceLink(paymentId, input);
    return {
      exists: Boolean(link),
      invoiceNumber: link?.xeroObjectNumber ?? null,
    };
  }

  return readBookingInvoiceEvidence(payment, input);
}
