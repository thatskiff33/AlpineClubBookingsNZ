import { parseDecimalDollarsToCents } from "@/lib/money-input";
import { formatCents } from "@/lib/utils";

// Money helpers for the AI assistant monthly spend cap. All money is NZD integer
// cents; the editor shows dollars-and-cents. Bounds mirror the settings route's
// zod contract (0..100_000 cents = NZ$0..NZ$1,000). Cap 0 disables all paid
// answers (hard-off).

export const MAX_BUDGET_CENTS = 100_000;

/**
 * Integer cents → a fixed 2dp dollars string for the editor input (e.g. 1000 →
 * "10.00"). Kept as its own name (#3302) because callers reach for
 * "centsToDollars" for an editable input value, not a displayed amount — but
 * the arithmetic itself is `formatCents`'s `{ style: "plain" }`, not a second
 * copy of it.
 */
export function centsToDollars(cents: number): string {
  return formatCents(cents, { style: "plain" });
}

export type ParseBudgetResult =
  | { ok: true; cents: number }
  | { ok: false; error: string };

/**
 * Parse a dollars-and-cents string into integer cents, enforcing the 0..$1,000
 * bound and at most two decimal places. Rejects blanks, non-numbers, negatives,
 * and over-precise input so a fat-finger cannot silently truncate.
 */
export function parseDollarsToCents(input: string): ParseBudgetResult {
  const trimmed = input.trim();
  if (trimmed === "") {
    return { ok: false, error: "Enter a monthly spend cap." };
  }
  // #2685: the canonical exact parser owns the grammar AND the conversion, so
  // this file no longer keeps a private copy of either. It refuses anything the
  // repository refuses everywhere else — a negative, a stray "$", a suffix, more
  // than two decimal places — and never turns one into a silent zero.
  const cents = parseDecimalDollarsToCents(trimmed);
  if (cents === null) {
    return {
      ok: false,
      // The message names every reason the parser actually refuses, not just
      // the decimal places. It also turns down a leading zero ("007.50"), a
      // currency symbol and a thousands separator, and an operator told only
      // about decimal places has no way to see what is wrong with "007.50"
      // (#2685 review).
      error:
        "Enter an amount in dollars and cents, for example 10.00 — no currency symbol, thousands separator, or leading zero.",
    };
  }
  if (cents > MAX_BUDGET_CENTS) {
    return {
      ok: false,
      error: `The monthly cap cannot exceed $${centsToDollars(MAX_BUDGET_CENTS)}.`,
    };
  }
  return { ok: true, cents };
}
