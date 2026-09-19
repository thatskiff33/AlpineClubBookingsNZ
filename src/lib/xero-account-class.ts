/**
 * What KIND of account a Xero account is — the one answer (#2717, `INV-SSOT-001`).
 *
 * Xero describes an account twice. Its `Type` is a fine-grained bookkeeping
 * category with twenty-odd values, four of which are expenses: `EXPENSE`,
 * `OVERHEADS`, `DIRECTCOSTS` and `DEPRECIATN`. Its `Class` is the five-value
 * roll-up — `ASSET`, `EQUITY`, `EXPENSE`, `LIABILITY`, `REVENUE` — and it is
 * the single field that means "this is an expense account".
 *
 * That distinction is not academic here. On the standard New Zealand chart the
 * range a treasurer would put write-offs in is typed `OVERHEADS`, so a picker
 * filtering on `type === "EXPENSE"` renders its empty-state message and a club
 * can never configure the mapping at all — which arrives at "you may not
 * configure this", the neighbour of the option the owner explicitly rejected
 * (#2717, 10 Aug 2026).
 *
 * The finance side of this repository had already answered it the other way:
 * the profit-and-loss view and the ratio explorer both classify a fact row by
 * its account CLASS. This module is that answer, moved to one place so the
 * admin picker and the finance reports cannot drift apart — the fix is the
 * move, not a lint rule (`AGENTS.md` → "Single source of truth").
 *
 * Deliberately pure and leaf: no Prisma, no React, no `xero-node` import, so a
 * client component and a server report can both read it.
 */

/** Xero's five account classes, verbatim (`Account.ClassEnum`). */
export const XERO_ACCOUNT_CLASSES = [
  "ASSET",
  "EQUITY",
  "EXPENSE",
  "LIABILITY",
  "REVENUE",
] as const;

export type XeroAccountClass = (typeof XERO_ACCOUNT_CLASSES)[number];

/**
 * Read a provider-supplied class string as one of the five, or `null`.
 *
 * `null` means "the snapshot does not say" — a chart row Xero returned without
 * a Class, or a cached row written before the field was captured. Callers
 * decide what to do with that; none of them may guess.
 */
export function normalizeXeroAccountClass(
  value: string | null | undefined,
): XeroAccountClass | null {
  const normalized = value?.trim().toUpperCase();
  return (XERO_ACCOUNT_CLASSES as readonly string[]).includes(normalized ?? "")
    ? (normalized as XeroAccountClass)
    : null;
}
