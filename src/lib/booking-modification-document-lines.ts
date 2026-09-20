/**
 * WHICH LINES A XERO DOCUMENT MAY CARRY (#3530 stage 2b, `INV-MOD-058`).
 *
 * Pure: the gate between the lines an edit stored (`booking-modification-lines.ts`)
 * and the document a builder is about to send. The builders never read the
 * column directly; they ask here and render what they are given, or today's
 * single line when they are given none.
 */
import {
  parseModificationLines,
  sumModificationLines,
  type ModificationLine,
} from "@/lib/booking-modification-lines";


export type ModificationDocumentLinesFallbackReason =
  /** The row stores no lines: parked, inexact, a credit election, or legacy. */
  | "NO_STORED_LINES"
  /** The column holds something this version cannot read as a whole. */
  | "UNPARSEABLE"
  /**
   * The lines no longer explain the row's figure - a restated operation
   * (`INV-PAY-070`) bills a raised amount the lines were never about.
   */
  | "STORED_LINES_DO_NOT_SUM"
  /** #3193's second ask bills one settled review share, never the edit. */
  | "SECOND_ASK"
  /**
   * The credit note returns less than the reduction (`INV-PAY-019`'s tier or
   * a policy retention), so the lines would overstate what went back.
   */
  | "POLICY_RETAINED";

export type ModificationDocumentLinesSelection = {
  /** What the stored lines sum to, or null when there are none to sum. */
  storedSumCents: number | null;
  /** The figure the document bills, as the caller computed it. */
  billedCents: number;
} & (
  | { source: "STORED"; lines: ModificationLine[]; reason?: undefined }
  | { source: "FALLBACK_SINGLE_LINE"; reason: ModificationDocumentLinesFallbackReason; lines?: undefined }
);

/**
 * THE GATE BETWEEN THE STORED LINES AND A XERO DOCUMENT (`INV-MOD-058`,
 * `INV-MONEY-003`). A document is itemised only when the stored lines explain
 * EXACTLY what it bills; any other case renders today's single line, with the
 * reason recorded on the operation beside the document. The shape mirrors
 * `selectBookingMoneyBuildUp` (`INV-MONEY-030`): one discriminator, one
 * reason, the figures both sides were compared on.
 *
 * `priceDiffCents` and `changeFeeCents` are the modification row's own; the
 * lines are stored as the explanation of `priceDiffCents` alone - the change
 * fee is its own line on every document, unchanged by this. A supplementary
 * invoice bills `priceDiffCents + changeFeeCents` (as its caller computed it);
 * a credit note bills `refundAmountCents`, which equals
 * `|priceDiffCents + changeFeeCents|` unless policy retained part of it.
 */
export function selectModificationDocumentLines(args: {
  storedPriceLines: unknown;
  priceDiffCents: number;
  changeFeeCents: number;
  billedCents: number;
  document: "SUPPLEMENTARY_INVOICE" | "MODIFICATION_CREDIT_NOTE";
  /** Set for #3193's second ask, which never itemises. */
  secondAsk?: boolean;
}): ModificationDocumentLinesSelection {
  const { storedPriceLines, priceDiffCents, changeFeeCents, billedCents, document } = args;
  const fallback = (
    reason: ModificationDocumentLinesFallbackReason,
    storedSumCents: number | null,
  ): ModificationDocumentLinesSelection => ({
    source: "FALLBACK_SINGLE_LINE",
    reason,
    storedSumCents,
    billedCents,
  });
  if (args.secondAsk) return fallback("SECOND_ASK", null);
  if (storedPriceLines === null || storedPriceLines === undefined) {
    return fallback("NO_STORED_LINES", null);
  }
  const lines = parseModificationLines(storedPriceLines);
  if (!lines) return fallback("UNPARSEABLE", null);
  const storedSumCents = sumModificationLines(lines);
  if (storedSumCents !== priceDiffCents) {
    return fallback("STORED_LINES_DO_NOT_SUM", storedSumCents);
  }
  const netCents = priceDiffCents + changeFeeCents;
  const expectedBilledCents = document === "SUPPLEMENTARY_INVOICE" ? netCents : -netCents;
  if (billedCents !== expectedBilledCents) {
    return fallback(
      document === "SUPPLEMENTARY_INVOICE" ? "STORED_LINES_DO_NOT_SUM" : "POLICY_RETAINED",
      storedSumCents,
    );
  }
  return { source: "STORED", lines, storedSumCents, billedCents };
}
