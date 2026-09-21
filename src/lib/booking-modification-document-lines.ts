/**
 * WHICH LINES A XERO DOCUMENT MAY CARRY (#3530 stages 2b and 2c, `INV-MOD-058`).
 *
 * Pure: the gate between what an edit stored (`booking-modification-lines.ts`),
 * what a review closure settled against it (`edit-financial-review-charge-shape.ts`)
 * and the document a builder is about to send. The builders never read the
 * rows directly; they ask here and render what they are given, or today's
 * single line when they are given none.
 */
import {
  parseModificationLines,
  sumModificationLines,
  type ModificationLine,
} from "@/lib/booking-modification-lines";
import type { EditReviewSettledShare } from "@/lib/edit-financial-review-charge-shape";


export type ModificationDocumentLinesFallbackReason =
  /**
   * The row stores no lines (parked, inexact, a credit election, or legacy)
   * and no review share has been settled against it.
   */
  | "NO_STORED_LINES"
  /** The column holds something this version cannot read as a whole. */
  | "UNPARSEABLE"
  /**
   * The lines and shares together do not explain the document's figure: a
   * restated operation (`INV-PAY-070`) billing an amount no settled share
   * accounts for, or a refund note for one of several refund shares settled
   * against one edit - the document knows its amount and its anchor, not
   * which task it bills, and guessing is the thing this rule forbids.
   */
  | "STORED_LINES_DO_NOT_SUM"
  /** #3193's second ask bills one settled review share, never the edit. */
  | "SECOND_ASK"
  /**
   * The credit note returns less than the reduction (`INV-PAY-019`'s tier or
   * a policy retention), so the lines would overstate what went back.
   */
  | "POLICY_RETAINED"
  /** The credit note returns more than the reduction; the lines would understate it. */
  | "REFUND_EXCEEDS_REDUCTION"
  /**
   * Not the selector's own: a read the itemisation needed failed after the
   * row was written. `xero-modification-line-items.ts` records it so the
   * reason union a reader matches on is complete in one place.
   */
  | "NARRATION_UNAVAILABLE";

export type ModificationDocumentLinesSelection = {
  /** What the stored lines sum to, or null when there are none to sum. */
  storedSumCents: number | null;
  /** What the settled review shares sum to, signed; null when there are none. */
  sharesSumCents: number | null;
  /** The figure the document bills, as the caller computed it. */
  billedCents: number;
} & (
  | {
      source: "STORED";
      /** The edit's own lines; empty for a parked edit whose shares explain the document. */
      lines: ModificationLine[];
      /** The review shares, one line each, in completion order. */
      shares: EditReviewSettledShare[];
      reason?: undefined;
    }
  | {
      source: "FALLBACK_SINGLE_LINE";
      reason: ModificationDocumentLinesFallbackReason;
      lines?: undefined;
      shares?: undefined;
    }
);

/**
 * THE GATE BETWEEN THE STORED ROWS AND A XERO DOCUMENT (`INV-MOD-058`,
 * `INV-MONEY-003`). A document is itemised only when the edit's stored lines
 * plus the review shares settled against it explain EXACTLY what it bills;
 * any other case renders today's single line, with the reason recorded on the
 * operation beside the document. The shape mirrors `selectBookingMoneyBuildUp`
 * (`INV-MONEY-030`): one discriminator, one reason, the figures compared.
 *
 * `priceDiffCents` and `changeFeeCents` are the figures the document bills;
 * the lines explain the edit's own delta and each share explains one settled
 * task's figure, so together they explain `priceDiffCents` - the change fee is
 * its own line on every document, unchanged by this. A supplementary invoice
 * bills `priceDiffCents + changeFeeCents`; a credit note bills
 * `refundAmountCents`, which equals `|priceDiffCents + changeFeeCents|` unless
 * policy retained part of it.
 */
export function selectModificationDocumentLines(args: {
  storedPriceLines: unknown;
  /** The COMPLETED review shares anchored on the modification (stage 2c); none before it. */
  shares?: ReadonlyArray<EditReviewSettledShare>;
  priceDiffCents: number;
  changeFeeCents: number;
  billedCents: number;
  document: "SUPPLEMENTARY_INVOICE" | "MODIFICATION_CREDIT_NOTE";
  /** Set for #3193's second ask, which never itemises. */
  secondAsk?: boolean;
}): ModificationDocumentLinesSelection {
  const { storedPriceLines, priceDiffCents, changeFeeCents, billedCents, document } = args;
  const shares = [...(args.shares ?? [])];
  const sharesSumCents =
    shares.length === 0
      ? null
      : shares.reduce((sum, share) => sum + share.sign * share.amountCents, 0);
  const fallback = (
    reason: ModificationDocumentLinesFallbackReason,
    storedSumCents: number | null,
  ): ModificationDocumentLinesSelection => ({
    source: "FALLBACK_SINGLE_LINE",
    reason,
    storedSumCents,
    sharesSumCents,
    billedCents,
  });
  if (args.secondAsk) return fallback("SECOND_ASK", null);
  const hasStored = storedPriceLines !== null && storedPriceLines !== undefined;
  if (!hasStored && shares.length === 0) {
    return fallback("NO_STORED_LINES", null);
  }
  const lines = hasStored ? parseModificationLines(storedPriceLines) : [];
  if (!lines) return fallback("UNPARSEABLE", null);
  const storedSumCents = lines.length === 0 ? null : sumModificationLines(lines);
  if ((storedSumCents ?? 0) + (sharesSumCents ?? 0) !== priceDiffCents) {
    return fallback("STORED_LINES_DO_NOT_SUM", storedSumCents);
  }
  const netCents = priceDiffCents + changeFeeCents;
  const expectedBilledCents = document === "SUPPLEMENTARY_INVOICE" ? netCents : -netCents;
  if (billedCents !== expectedBilledCents) {
    return fallback(
      document === "SUPPLEMENTARY_INVOICE"
        ? "STORED_LINES_DO_NOT_SUM"
        : billedCents < expectedBilledCents
          ? "POLICY_RETAINED"
          : "REFUND_EXCEEDS_REDUCTION",
      storedSumCents,
    );
  }
  return { source: "STORED", lines, shares, storedSumCents, sharesSumCents, billedCents };
}
