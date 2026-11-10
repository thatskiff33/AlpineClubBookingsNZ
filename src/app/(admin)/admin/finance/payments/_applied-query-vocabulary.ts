/**
 * The values `/api/admin/payments` will actually apply, mirrored from
 * `adminPaymentsQuerySchema` (#2816).
 *
 * IT IS A LITERAL, NOT AN IMPORT. That schema lives in `admin-payments-service.ts`,
 * which pulls in Prisma and the database client, so it cannot be imported into the
 * payments page's client bundle — the same reason
 * `page-context/registry.ts` mirrors two Prisma enums by hand.
 * `diagnostics-published-view-vocabularies.test.ts` asserts both halves still match
 * the server, so neither can drift.
 *
 * WHY THE PAGE NEEDS THEM. That schema is STRICT and its parse is total: one
 * out-of-vocabulary spelling (`?status=succeeded`) or one malformed date
 * (`?lastUpdatedFrom=13-45-2026`) 400s the WHOLE query, and `fetchData` ignores a
 * non-ok response — so the rows on screen are the previous query's, or none. A
 * value that fails these checks was applied by nothing, and publishing it to AI
 * Diagnostics as an applied filter would report a narrowing that never happened.
 */

export const APPLIED_PAYMENT_STATUS_VALUES = [
  "PENDING",
  "PROCESSING",
  "SUCCEEDED",
  "FAILED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
] as const;

export type AppliedPaymentStatus =
  (typeof APPLIED_PAYMENT_STATUS_VALUES)[number];

/** True when this status is one the payments API accepts (`all` is not a status). */
export function isAppliedPaymentStatus(
  value: string,
): value is AppliedPaymentStatus {
  return (APPLIED_PAYMENT_STATUS_VALUES as readonly string[]).includes(value);
}

/**
 * The date shape the schema's `dateSchema` accepts — the same `YYYY-MM-DD` regex
 * and no more. That schema does no calendar check either, so mirroring the regex
 * mirrors exactly what is genuinely applied.
 */
export const APPLIED_PAYMENTS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isAppliedPaymentsDate(value: string): boolean {
  return APPLIED_PAYMENTS_DATE_PATTERN.test(value);
}

/**
 * The schema's own bound on `search` (`z.string().trim().max(100)`), mirrored
 * because the first cut of this module left it out (review finding, 14 Aug 2026).
 *
 * IT IS A LENGTH THE REQUEST FAILS ON, not a display nicety. `search` is applied on
 * every keystroke here — no debounce, no submit — so a 101st character 400s the
 * whole query, `fetchData` ignores the response, and the rows on screen stay the
 * ones the 100-character search returned. Publishing the 101-character value would
 * report a narrowing the API refused.
 */
export const APPLIED_PAYMENTS_SEARCH_MAX_CHARS = 100;

/** True when the payments API will apply this search rather than refuse the query. */
export function isAppliedPaymentsSearch(value: string): boolean {
  // The schema TRIMS before it measures, and so does the page before it publishes.
  const trimmed = value.trim();
  return (
    trimmed.length > 0 && trimmed.length <= APPLIED_PAYMENTS_SEARCH_MAX_CHARS
  );
}
