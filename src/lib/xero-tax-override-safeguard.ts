import { Prisma } from "@prisma/client";
import type { LineItem } from "xero-node";
import { buildStructuredAuditLogCreateArgs } from "@/lib/audit";
import logger from "@/lib/logger";
import type { XeroTaxOverrides } from "@/lib/member-money";
import { prisma } from "@/lib/prisma";
import { isPrismaKnownUniqueConstraintError } from "@/lib/prisma-known-errors";
import { lineTaxAmountsMatch, lineTaxMismatches, parseStoredLineTaxMismatches, type XeroLineTaxMismatch } from "@/lib/xero-line-tax-mismatches";
import { invoiceLineItemsTotalCents } from "@/lib/xero-modification-line-items";

/**
 * THE LIVE SAFEGUARD ON THE JOURNAL'S GST (#5208, owner decisions 18 and 20 Nov
 * 2026). A new primary invoice carries each line's tax from the journal
 * (Option A). Xero documents that a sent `TaxAmount` is kept ("This value can
 * be overriden if the calculated TaxAmount is not correct"), but the app does
 * not take that on trust: after every create and every update of a primary
 * invoice it compares the tax Xero returns with the tax it sent, line by line.
 *
 * A difference is recorded as one `XeroTaxOverrideMismatch` row per sync
 * operation, and while any row is uncleared the overrides are PAUSED: new
 * primary invoices go without tax amounts and Xero works the tax out itself.
 * The app never switches to another option silently; the pause shows on the
 * Finance dashboard, the Xero health page and the Xero finance page until a
 * finance officer checks the invoices and resumes.
 *
 * No advisory lock (`INV-LOCK-001`): this is a club-wide finance flag that
 * changes no booking status or settlement money. The insert is unique on the
 * sync operation; the clear is a status-guarded claim.
 */

/** A flagged invoice, as the finance card and the health surfaces show it. */
export interface XeroTaxOverrideMismatchView {
  id: string;
  createdAt: Date;
  bookingId: string;
  providerInvoiceId: string;
  invoiceNumber: string | null;
  documentKind: "CREATE" | "UPDATE";
  lines: XeroLineTaxMismatch[];
}

/**
 * Whether new primary invoices carry the journal's tax. Read OUTSIDE any
 * transaction, once per outbox run as it builds its lines (`INV-LOCK-004`).
 * A read that fails throws, and the invoice is not sent this run.
 */
export async function readXeroTaxOverridePause(): Promise<XeroTaxOverrides> {
  const open = await prisma.xeroTaxOverrideMismatch.findFirst({ where: { clearedAt: null }, select: { id: true } });
  return open ? "PAUSED" : "ON";
}

/** How many flagged invoices hold the pause; zero when the overrides are on. */
export async function countOpenXeroTaxOverrideMismatches(): Promise<number> {
  return prisma.xeroTaxOverrideMismatch.count({ where: { clearedAt: null } });
}

/**
 * The one sentence every surface shows while the pause holds (the Finance
 * dashboard, the Xero health page and the Xero finance page), or null.
 */
export function xeroTaxOverridePauseProblem(openCount: number): string | null {
  if (openCount <= 0) return null;
  const invoices = openCount === 1 ? "1 invoice" : `${openCount} invoices`;
  return `Xero changed the GST on ${invoices} after the app sent it. Until someone in finance checks them and resumes, `
    + "new invoices go to Xero without the club's own GST figures and Xero works the GST out itself.";
}

/** The uncleared mismatches, oldest first: what the pause is made of. */
export async function listOpenXeroTaxOverrideMismatches(): Promise<XeroTaxOverrideMismatchView[]> {
  const rows = await prisma.xeroTaxOverrideMismatch.findMany({
    where: { clearedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, createdAt: true, bookingId: true, providerInvoiceId: true, invoiceNumber: true, documentKind: true, lines: true },
  });
  return rows.map((row) => ({ ...row, lines: parseStoredLineTaxMismatches(row.lines) }));
}

/**
 * Compare what was sent with what Xero returned and, on a difference, record
 * it and pause the overrides. Lines sent without a `taxAmount` are never
 * compared, so a document sent while paused, or an update that copies Xero's
 * own amounts, can only trip the pause if Xero changed what it already held.
 * A create replayed under its idempotency key returns the ORIGINAL invoice, so
 * a reply is not compared when an earlier attempt under the key sent other
 * line tax (`earlierSent`, e.g. sent while paused or by the release before),
 * or when its lines bill other amounts; the manifest records either as its own
 * conflict.
 * Never throws: the sync operation's outcome is not this check's to change.
 */
export async function recordXeroTaxOverrideMismatch(input: {
  xeroSyncOperationId: string;
  bookingId: string;
  providerInvoiceId: string;
  invoiceNumber: string | null;
  documentKind: "CREATE" | "UPDATE";
  sent: ReadonlyArray<LineItem>;
  returned: ReadonlyArray<LineItem>;
  /** The lines each earlier attempt under the same idempotency key stored. */
  earlierSent?: ReadonlyArray<ReadonlyArray<LineItem>>;
}): Promise<void> {
  if ((input.earlierSent ?? []).some((earlier) => !lineTaxAmountsMatch(earlier, input.sent))) {
    logger.info({ bookingId: input.bookingId, xeroSyncOperationId: input.xeroSyncOperationId }, "An earlier attempt sent other line tax, so Xero's reply may be its invoice; GST not compared");
    return;
  }
  if (!billsTheSameLines(input.sent, input.returned)) return;
  const lines = lineTaxMismatches(input.sent, input.returned);
  if (lines.length === 0) return;
  const { xeroSyncOperationId, bookingId, providerInvoiceId, invoiceNumber, documentKind } = input;
  try {
    await prisma.$transaction(async (tx) => {
      const row = await tx.xeroTaxOverrideMismatch.create({
        data: { xeroSyncOperationId, bookingId, providerInvoiceId, invoiceNumber, documentKind, lines: lines as unknown as Prisma.InputJsonArray },
        select: { id: true },
      });
      await tx.auditLog.create(
        buildStructuredAuditLogCreateArgs({
          action: "XERO_TAX_OVERRIDES_PAUSED",
          entity: { type: "XeroTaxOverrideMismatch", id: row.id },
          category: "xero",
          severity: "important",
          outcome: "failure",
          summary: `Xero changed the GST on invoice ${invoiceNumber ?? providerInvoiceId}; GST overrides are paused`,
          metadata: { bookingId, providerInvoiceId, xeroSyncOperationId, documentKind, lines },
        }),
      );
    });
    logger.warn({ bookingId, providerInvoiceId, xeroSyncOperationId, lines }, "Xero changed the GST the app sent on an invoice; GST overrides are paused until finance resumes them");
  } catch (error) {
    if (isPrismaKnownUniqueConstraintError(error)) {
      logger.info({ bookingId, providerInvoiceId, xeroSyncOperationId }, "This operation's GST mismatch was already recorded");
      return;
    }
    logger.error({ err: error, bookingId, providerInvoiceId, xeroSyncOperationId, lines }, "Could not record a GST mismatch Xero returned; the GST overrides were NOT paused");
  }
}

/** Whether Xero's reply carries the lines sent, each billing the same cents. */
function billsTheSameLines(sent: ReadonlyArray<LineItem>, returned: ReadonlyArray<LineItem>): boolean {
  return sent.length === returned.length
    && sent.every((line, index) => invoiceLineItemsTotalCents([line]) === invoiceLineItemsTotalCents([returned[index]!]));
}

/**
 * Clear the named mismatches, once a finance officer has checked them. Only
 * rows still open and in the list are claimed; a lost claim (another officer
 * cleared them first) writes no audit row. Overrides resume on the next outbox
 * run once no row is open; nothing is re-sent.
 */
export async function clearXeroTaxOverridePause(memberId: string, ids: readonly string[], note: string): Promise<{ cleared: number }> {
  if (ids.length === 0) return { cleared: 0 };
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.xeroTaxOverrideMismatch.updateMany({
      where: { id: { in: [...ids] }, clearedAt: null },
      data: { clearedAt: new Date(), clearedByMemberId: memberId, clearNote: note },
    });
    if (count > 0) {
      await tx.auditLog.create(
        buildStructuredAuditLogCreateArgs({
          action: "XERO_TAX_OVERRIDE_PAUSE_CLEARED",
          actor: { memberId },
          entity: { type: "XeroTaxOverrideMismatch", id: null },
          category: "admin",
          severity: "important",
          outcome: "success",
          summary: `GST overrides resumed: ${count} flagged invoice${count === 1 ? "" : "s"} checked`,
          metadata: { ids: [...ids], cleared: count, note },
        }),
      );
    }
    return { cleared: count };
  });
}
