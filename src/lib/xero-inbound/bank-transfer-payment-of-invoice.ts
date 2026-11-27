/**
 * THE ONE BANK-TRANSFER PAYMENT OF AN INVOICE (#5289 C, `INV-PAY-126`,
 * `INV-SSOT`): the rule the inbound settle matches a paid invoice's payment by,
 * and the only rule every writer of a bank-transfer refunded total from Xero
 * uses to find the payment an invoice names.
 *
 * - The settle (`syncInternetBankingPaymentsForPaidInvoice`): an Internet
 *   Banking payment whose own `xeroInvoiceId` is the invoice, or which an
 *   active `Payment` `PRIMARY_INVOICE` link names; it decides only when exactly
 *   one matches.
 * - The note sync's allocation write and removal, and the outbound completion
 *   of an edit's note allocation, lock and decide that same one payment, a
 *   payment named only by its link included.
 *
 * Which invoice's allocations a payment's total counts is one invoice per
 * payment (`decisionInvoiceIdsOf`): the payment's own invoice, or, for a bank
 * transfer, the one its only active link names while none is stamped. The kept settle passes the
 * invoice it settles instead.
 *
 * Reads only, on the caller's client; it takes no lock.
 */
import { PaymentSource, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { asRecord, readString } from "@/lib/xero-json";
import { NOT_CARD_REFUND_REVERSAL_INVOICE_LINK } from "@/lib/xero-card-refund-reversal-outbox";
import { NOTE_ALLOCATION_ROLE, ROLELESS_ALLOCATION_ROLE } from "@/lib/xero-clearing-allocations";

type Db = Pick<Prisma.TransactionClient, "payment" | "xeroObjectLink">;

/** The settle's link: a payment's active primary-invoice link. */
const PRIMARY_INVOICE_LINK_WHERE = {
  localModel: "Payment",
  xeroObjectType: "INVOICE",
  role: "PRIMARY_INVOICE",
  active: true,
  ...NOT_CARD_REFUND_REVERSAL_INVOICE_LINK,
} as const satisfies Prisma.XeroObjectLinkWhereInput;

/**
 * The settle's payment filter for one invoice: a bank transfer whose own
 * invoice id it is, or one of `linkedPaymentIds` (its active primary-invoice
 * links). The settle reads the links from the invoice sync; every other caller
 * reads them through `bankTransferPaymentIdsOfInvoices`.
 */
export function bankTransferPaymentsOfInvoiceWhere(invoiceId: string, linkedPaymentIds: readonly string[]): Prisma.PaymentWhereInput {
  return {
    source: PaymentSource.INTERNET_BANKING,
    OR: [{ xeroInvoiceId: invoiceId }, ...(linkedPaymentIds.length > 0 ? [{ id: { in: [...linkedPaymentIds] } }] : [])],
  };
}

/** Each invoice's linked payment ids (`PRIMARY_INVOICE_LINK_WHERE`). */
async function linkedPaymentIdsByInvoiceId(invoiceIds: readonly string[], db: Db): Promise<Map<string, string[]>> {
  const links = await db.xeroObjectLink.findMany({
    where: { ...PRIMARY_INVOICE_LINK_WHERE, xeroObjectId: { in: [...invoiceIds] } },
    select: { localId: true, xeroObjectId: true },
  });
  const byInvoiceId = new Map<string, string[]>();
  for (const link of links) byInvoiceId.set(link.xeroObjectId, [...(byInvoiceId.get(link.xeroObjectId) ?? []), link.localId]);
  return byInvoiceId;
}

/**
 * For each invoice, the one bank-transfer payment the settle would match
 * (`bankTransferPaymentsOfInvoiceWhere`); an invoice matching none or several
 * is left out, as the settle decides no total for it.
 */
export async function bankTransferPaymentIdsOfInvoices(invoiceIds: readonly string[], db: Db = prisma): Promise<Map<string, string>> {
  const unique = [...new Set(invoiceIds)];
  const byInvoiceId = new Map<string, string>();
  if (unique.length === 0) return byInvoiceId;
  const linked = await linkedPaymentIdsByInvoiceId(unique, db);
  const payments = await db.payment.findMany({
    where: {
      source: PaymentSource.INTERNET_BANKING,
      OR: [{ xeroInvoiceId: { in: unique } }, { id: { in: [...new Set([...linked.values()].flat())] } }],
    },
    select: { id: true, xeroInvoiceId: true },
  });
  for (const invoiceId of unique) {
    const linkedIds = new Set(linked.get(invoiceId) ?? []);
    // "Exactly one" said as a first with no rest (#2800).
    const [only, ...more] = payments.filter((payment) => payment.xeroInvoiceId === invoiceId || linkedIds.has(payment.id));
    if (only && more.length === 0) byInvoiceId.set(invoiceId, only.id);
  }
  return byInvoiceId;
}

/**
 * The invoice whose allocations a payment's refunded total counts
 * (`decideLinkedRefundedTotalCents`): its own invoice id, whatever its source
 * (#4444), or, for a bank transfer while none is stamped, the invoice its only
 * active primary-invoice link names (the settle's rule). One invoice per
 * payment, so an older invoice it was once linked to is never added. Absent
 * when no single invoice names it.
 */
export async function decisionInvoiceIdsOf(
  payments: ReadonlyArray<{ id: string; source: PaymentSource; xeroInvoiceId: string | null }>,
  db: Db = prisma,
): Promise<Map<string, string>> {
  const decided = new Map<string, string>();
  const unstamped: string[] = [];
  for (const payment of payments) {
    if (payment.xeroInvoiceId) decided.set(payment.id, payment.xeroInvoiceId);
    else if (payment.source === PaymentSource.INTERNET_BANKING) unstamped.push(payment.id);
  }
  if (unstamped.length === 0) return decided;
  const links = await db.xeroObjectLink.findMany({
    where: { ...PRIMARY_INVOICE_LINK_WHERE, localId: { in: unstamped } },
    select: { localId: true, xeroObjectId: true },
  });
  for (const paymentId of unstamped) {
    const [only, ...more] = new Set(links.filter((link) => link.localId === paymentId).map((link) => link.xeroObjectId));
    if (only && more.length === 0) decided.set(paymentId, only);
  }
  return decided;
}

/** A note's allocation link as stored, and the payment its invoice names. */
export type NoteAllocationOfPayment<L> = { link: L; invoiceId: string; paymentId: string | null };

const NOTE_ALLOCATION_LINK_SELECT = {
  localModel: true,
  localId: true,
  xeroObjectType: true,
  xeroObjectId: true,
  xeroObjectNumber: true,
  xeroObjectUrl: true,
  role: true,
  metadata: true,
} as const satisfies Prisma.XeroObjectLinkSelect;

export type StoredNoteAllocationLink = Prisma.XeroObjectLinkGetPayload<{ select: typeof NOTE_ALLOCATION_LINK_SELECT }>;

/**
 * #5289 A (owner decision D1): a credit note's still-active allocation links
 * (its own role and the role-less one), each with the invoice it records and
 * the one bank-transfer payment that invoice names
 * (`bankTransferPaymentIdsOfInvoices`), or null. In one fixed order, so a pass
 * that stops part-way has handled a known prefix, and read by `active: true`,
 * so a retry finds only what is left. The removal of a cancelled reading's
 * allocations reads it; #5251 reuses it.
 */
export async function bankTransferPaymentsOfNoteAllocations(
  creditNoteId: string,
  db: Db = prisma,
): Promise<Array<NoteAllocationOfPayment<StoredNoteAllocationLink>>> {
  const links = await db.xeroObjectLink.findMany({
    where: {
      xeroObjectType: "ALLOCATION",
      active: true,
      role: { in: [NOTE_ALLOCATION_ROLE, ROLELESS_ALLOCATION_ROLE] },
      metadata: { path: ["creditNoteId"], equals: creditNoteId },
    },
    orderBy: [{ xeroObjectId: "asc" }, { localModel: "asc" }, { localId: "asc" }, { role: "asc" }],
    select: NOTE_ALLOCATION_LINK_SELECT,
  });
  const withInvoice = links.flatMap((link) => {
    const metadata = asRecord(link.metadata);
    const invoiceId = readString(metadata?.invoiceId);
    return invoiceId && readString(metadata?.creditNoteId) === creditNoteId ? [{ link, invoiceId }] : [];
  });
  const paymentIds = await bankTransferPaymentIdsOfInvoices(withInvoice.map((entry) => entry.invoiceId), db);
  return withInvoice.map((entry) => ({ ...entry, paymentId: paymentIds.get(entry.invoiceId) ?? null }));
}
