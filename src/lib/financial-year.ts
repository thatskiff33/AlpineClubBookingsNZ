/**
 * Membership financial-year configuration.
 *
 * The club's financial year-end month drives how a calendar date maps to a
 * membership "season year" and how the Xero subscription-invoice window is
 * built. The effective value is resolved on the server (override, else the
 * connected Xero organisation, else the March default) and cached here as a
 * plain module-level number.
 *
 * This module deliberately has NO server imports (no Prisma, no Xero). It is
 * imported transitively by `utils.ts`, which is also pulled into client
 * bundles, so the synchronous getter below must stay dependency-free. The
 * async resolution lives in `financial-year-server.ts`.
 */

/** Default financial year-end month: March (NZ convention, 31 March year-end). */
export const DEFAULT_FINANCIAL_YEAR_END_MONTH = 3;

// 1-12. Seeded from the DB / Xero by refreshFinancialYearConfig() on the server.
let cachedYearEndMonth = DEFAULT_FINANCIAL_YEAR_END_MONTH;

// test seam
/** Clamp an arbitrary value to a valid month (1-12), falling back to March. */
export function normalizeYearEndMonth(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_FINANCIAL_YEAR_END_MONTH;
  }
  const rounded = Math.round(value);
  if (rounded < 1 || rounded > 12) return DEFAULT_FINANCIAL_YEAR_END_MONTH;
  return rounded;
}

// test seam
/**
 * Synchronous read of the effective financial year-end month (1-12). Returns
 * the March default until the server seeds the cache. Used by the
 * (synchronous) season helpers so their signatures and ~40 call sites are
 * unchanged.
 */
export function getFinancialYearEndMonth(): number {
  return cachedYearEndMonth;
}

/** Update the module cache. Called by the server resolver only. */
export function setFinancialYearEndMonth(month: number): void {
  cachedYearEndMonth = normalizeYearEndMonth(month);
}

/**
 * The 1-based calendar month in which the membership season starts (the month
 * after the year-end month). For a March year-end this is April (4); for a
 * December year-end it is January (1).
 */
export function getSeasonStartMonth(): number {
  return (getFinancialYearEndMonth() % 12) + 1;
}

/** Pure season derivation for callers that already hold an authoritative month. */
export function getSeasonYearForYearEndMonth(
  date: Date,
  yearEndMonth: number,
): number {
  const startMonth = (normalizeYearEndMonth(yearEndMonth) % 12) + 1;
  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  return month >= startMonth ? year : year - 1;
}

// test seam
/** Test-only override. Pair with a reset to DEFAULT in a beforeEach. */
export function __setFinancialYearEndMonthForTesting(month: number): void {
  cachedYearEndMonth = normalizeYearEndMonth(month);
}
