import type { LineItem } from "xero-node";
import { providerAmountToCents } from "@/lib/money-provider-amount";

/** One line whose tax Xero holds differently from the tax the app sent (#5208). */
export interface XeroLineTaxMismatch {
  /** The line's position in the request, which Xero keeps in its reply. */
  index: number;
  sentCents: number;
  /** Null when Xero's line carries no readable tax amount, or there is no such line. */
  xeroCents: number | null;
}

/**
 * The lines whose tax Xero did not keep (#5208, owner decision 18 Nov 2026).
 * Pure. Lines pair by position, and only a line whose request carried a
 * `taxAmount` is compared: a line sent without one carries Xero's own figure,
 * which is never a mismatch. Both sides convert through `providerAmountToCents`.
 */
export function lineTaxMismatches(sent: ReadonlyArray<LineItem>, returned: ReadonlyArray<LineItem>): XeroLineTaxMismatch[] {
  const mismatches: XeroLineTaxMismatch[] = [];
  sent.forEach((line, index) => {
    const sentCents = providerAmountToCents(line.taxAmount);
    if (sentCents === null) return;
    const xeroCents = providerAmountToCents(returned[index]?.taxAmount);
    if (xeroCents !== sentCents) mismatches.push({ index, sentCents, xeroCents });
  });
  return mismatches;
}
