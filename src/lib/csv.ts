/**
 * Escape a single value for RFC 4180 CSV output.
 *
 * Wraps the value in double-quotes when it contains a comma, a double-quote, a
 * newline, or a carriage return, doubling any embedded quotes. Also guards
 * against CSV/formula injection: values whose first character could be
 * interpreted as a formula by a spreadsheet (`=`, `+`, `-`, `@`, tab, or CR)
 * are prefixed with a single quote before the RFC-4180 quoting logic runs.
 *
 * This is a pure string helper with no server-only dependencies, so it is safe
 * to import from both client components (browser-side CSV exports) and server
 * route handlers. It is the single source of truth for CSV cell escaping — new
 * call sites must delegate here rather than re-implementing the guard.
 */
/** The leading characters a spreadsheet may read as the start of a formula. */
const CSV_FORMULA_LEAD_CHARACTERS = new Set(["=", "+", "-", "@", "\t", "\r"]);

export function escapeCsvCell(value: string): string {
  if (CSV_FORMULA_LEAD_CHARACTERS.has(value.charAt(0))) {
    value = "'" + value;
  }
  if (
    value.includes('"') ||
    value.includes(",") ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

/**
 * The exact inverse of {@link escapeCsvCell}'s formula guard, for a value read
 * back from a file this application exported: ONE leading `'` is removed only
 * when a formula-lead character follows it, so `'- no nuts` imports as
 * `- no nuts` while a value that merely starts with an apostrophe is kept.
 *
 * Applied to the dietary/allergy column (#2941), whose export and import are
 * meant to round-trip byte for byte. Other imported columns keep their existing
 * behaviour; widening this to them is a separate decision, not a tidy-up.
 */
export function unescapeCsvFormulaGuard(value: string): string {
  return value.charAt(0) === "'" && CSV_FORMULA_LEAD_CHARACTERS.has(value.charAt(1))
    ? value.slice(1)
    : value;
}
