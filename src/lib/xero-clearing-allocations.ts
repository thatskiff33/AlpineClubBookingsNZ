/**
 * Where an invoice-clearing credit note is allocated (`INV-PAY-017`, #3535).
 *
 * The note is sized over the booking's whole invoicing — the primary invoice
 * plus, for a booking edited upward, the booking change's supplementary
 * invoice, which also carries the change fee (`unpaidInvoiceClearingAmountCents`).
 * Allocating all of it to the primary invoice asked Xero to allocate more than
 * that invoice owes, so Xero refused and the note floated with both invoices
 * open. The note is therefore allocated across the booking's open invoices,
 * the primary first and then each supplementary invoice in the order it was
 * raised, each up to what Xero says it still owes.
 *
 * When those invoices together owe LESS than the note — part of the booking
 * was paid, or an invoice the note is sized for was never raised — nothing is
 * allocated and no note is created: the builder fails the operation with the
 * shortfall, visibly, rather than leaving a note that says the booking was not
 * paid floating against money that was (a part-paid invoice is #3643's).
 *
 * The plan is recorded on the operation (`allocations`), so a PARTIAL note's
 * repair re-allocates exactly what was planned instead of re-deriving it from
 * invoices the first attempt already changed.
 */
import type { XeroClient } from "xero-node";
import { prisma } from "@/lib/prisma";
import { callXeroApi } from "@/lib/xero-api-client";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { asRecord, readNumber, readString } from "@/lib/xero-json";
import { formatCents } from "@/lib/utils";
import type { ClubFormat } from "@/lib/club-format";

export interface ClearingAllocationTarget {
  invoiceId: string;
  amountCents: number;
}

export class ClearingAllocationShortfallError extends Error {
  constructor(noteCents: number, owedCents: number, format: ClubFormat) {
    super(
      `The booking's open Xero invoices owe ${formatCents(owedCents, format)}, less than this ${formatCents(noteCents, format)} invoice-clearing credit note; nothing was created. Part of the booking may have been paid, or an invoice the note is sized for was never raised - review it by hand.`
    );
    this.name = "ClearingAllocationShortfallError";
  }
}

/**
 * Pure: allocate `noteCents` across `invoices` in order, each up to its amount
 * due. Throws when they owe less than the note in total.
 */
export function planClearingAllocations(input: {
  noteCents: number;
  invoices: Array<{ invoiceId: string; amountDueCents: number }>;
  /** The club's format (#3565), for the shortfall message's amounts. */
  format: ClubFormat;
}): ClearingAllocationTarget[] {
  const targets: ClearingAllocationTarget[] = [];
  let remaining = input.noteCents;
  for (const invoice of input.invoices) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Math.max(0, invoice.amountDueCents));
    if (take > 0) {
      targets.push({ invoiceId: invoice.invoiceId, amountCents: take });
      remaining -= take;
    }
  }
  if (remaining > 0) {
    throw new ClearingAllocationShortfallError(
      input.noteCents,
      input.noteCents - remaining,
      input.format
    );
  }
  return targets;
}

/**
 * The booking changes' own supplementary invoices, oldest first. A review
 * task's second ask (anchored on the task, #3193) bills money outside the
 * booking's stored price, so the clearing note is not sized for it.
 */
export async function findBookingSupplementaryInvoiceIds(
  bookingId: string
): Promise<string[]> {
  const modifications = await prisma.bookingModification.findMany({
    where: { bookingId },
    select: { id: true },
  });
  if (modifications.length === 0) return [];
  const links = await prisma.xeroObjectLink.findMany({
    where: {
      localModel: "BookingModification",
      localId: { in: modifications.map((modification) => modification.id) },
      xeroObjectType: "INVOICE",
      role: "SUPPLEMENTARY_INVOICE",
      active: true,
    },
    select: { xeroObjectId: true },
    orderBy: { createdAt: "asc" },
  });
  return [...new Set(links.map((link) => link.xeroObjectId))];
}

/** Each invoice's live amount due, in the order given; 0 unless AUTHORISED. */
export async function readInvoiceAmountsDue(
  xero: XeroClient,
  tenantId: string,
  invoiceIds: string[]
): Promise<Array<{ invoiceId: string; amountDueCents: number }>> {
  const out: Array<{ invoiceId: string; amountDueCents: number }> = [];
  for (const invoiceId of invoiceIds) {
    const response = await callXeroApi(
      () => xero.accountingApi.getInvoice(tenantId, invoiceId),
      {
        operation: "getInvoice",
        resourceType: "INVOICE",
        workflow: "createXeroCreditNoteForModification",
        context: `getInvoice(clearing allocation ${invoiceId})`,
      }
    );
    const invoice = response.body.invoices?.[0];
    const authorised = String(invoice?.status ?? "") === "AUTHORISED";
    out.push({
      invoiceId,
      amountDueCents: authorised ? providerAmountToCents(invoice?.amountDue) ?? 0 : 0,
    });
  }
  return out;
}

/** The plan a clearing note's operation recorded, or null when it recorded none. */
export function readRecordedClearingAllocations(
  requestPayload: unknown
): ClearingAllocationTarget[] | null {
  const raw = asRecord(requestPayload)?.allocations;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const targets: ClearingAllocationTarget[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    const invoiceId = readString(record?.invoiceId);
    const amountCents = readNumber(record?.amountCents);
    if (!invoiceId || amountCents === null || amountCents <= 0) return null;
    targets.push({ invoiceId, amountCents });
  }
  return targets;
}
