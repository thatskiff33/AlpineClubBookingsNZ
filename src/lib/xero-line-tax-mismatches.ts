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

/** Whether two requests carry the same tax on every line: the same lines, each with the same `taxAmount` cents or none. */
export function lineTaxAmountsMatch(a: ReadonlyArray<LineItem>, b: ReadonlyArray<LineItem>): boolean {
  return a.length === b.length && a.every((line, index) => providerAmountToCents(line.taxAmount) === providerAmountToCents(b[index]!.taxAmount));
}

const isWholeCents = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

/** The mismatches a stored `XeroTaxOverrideMismatch.lines` column holds; an entry of any other shape is dropped. */
export function parseStoredLineTaxMismatches(value: unknown): XeroLineTaxMismatch[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { index, sentCents, xeroCents } = entry as Record<string, unknown>;
    if (!isWholeCents(index) || !isWholeCents(sentCents) || (xeroCents !== null && !isWholeCents(xeroCents))) return [];
    return [{ index, sentCents, xeroCents }];
  });
}
