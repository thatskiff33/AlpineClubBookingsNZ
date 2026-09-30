import { parseDecimalDollarsToCents } from "@/lib/money-input";

/**
 * The canonical boundary for money that arrives from an accounting provider
 * (INV-MONEY-001, INV-MONEY-003, INV-MONEY-006).
 *
 * Xero hands us decimal dollars that have ALREADY been parsed into JavaScript
 * numbers by the SDK's `JSON.parse`. The original decimal text is gone by then,
 * so the exact text parser in `@/lib/money-input` cannot be used and must not be
 * pretended into place — the only honest control is a single reviewed rounding
 * boundary with an explicit contract (#2685, owner decision 9 Aug 2026).
 *
 * ## Contract
 *
 * - **Input:** anything. A value is convertible only if it is a `number` and
 *   `Number.isFinite`. Everything else — `null`, `undefined`, a string, `NaN`,
 *   `Infinity` — returns `null`. The boundary is fail-closed: a caller that
 *   needs a figure must handle the `null`, never substitute a zero.
 * - **Rounding:** `Math.round(value * 100)` — which is half-UP (toward positive
 *   infinity, so `-1234.5` becomes `-1234`, not `-1235`), applied at whatever
 *   value the binary double actually lands on rather than at the decimal the
 *   provider printed. This is deliberately the exact
 *   arithmetic every call site this replaced already performed, character for
 *   character, so no Xero reconciliation, credit allocation or invoice total
 *   moves by a cent when the call sites are routed through here. It is the rule
 *   the existing provider tests pin, and changing it is a money-behaviour
 *   decision for the repository owner, not a refactor.
 * - **Sign:** preserved. A negative provider amount converts to negative cents.
 *   Callers that require a non-negative figure clamp or reject it themselves,
 *   because "clamp to zero" and "refuse" are different domain answers and this
 *   boundary must not pick one for them.
 * - **Output:** an integer number of cents (`Math.round` guarantees the integer;
 *   provider amounts are far inside the safe-integer range).
 *
 * ## What this is NOT for
 *
 * Money a person typed. That still has its decimal text, so it goes through
 * `parseDecimalDollarsToCents` in `@/lib/money-input`, which never touches a
 * float at all.
 */

/**
 * A finite provider amount in decimal dollars → integer cents, or `null`.
 *
 * @see the module docblock for the full rounding, sign and validity contract.
 */
export function providerAmountToCents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return Math.round(value * 100);
}

/**
 * A finite provider amount in decimal major units → integer TEN-THOUSANDTHS of
 * the major unit, or `null` (#3724).
 *
 * Hundredths are the wrong grain for a Xero figure in a currency that does not
 * count in them. A Kuwaiti dinar invoice for KWD 1.234 is 123 hundredths, which
 * drops the fils; KWD 0.004 is zero hundredths, which reads as "nothing owing".
 * Ten-thousandths is the finest minor unit ISO 4217 defines (CLF and UYW count
 * to four places), so every currency's own precision survives it exactly.
 *
 * NOT a replacement for `providerAmountToCents`, whose rounding is frozen and
 * which every reconciliation and ledger reads. This is for a caller that must
 * ask "is anything owing at all" of a provider balance, or show that balance in
 * its own currency's precision — never for a figure that is stored, posted or
 * sent back to a provider.
 *
 * Same input, sign and fail-closed contract as `providerAmountToCents`. The
 * rounding at the fourth place also absorbs a double's representation residue,
 * so a balance derived as `0.4 - 0.1 - 0.3` (5.5e-17) reads as zero rather than
 * as a sliver still owing.
 */
export function providerAmountToTenThousandths(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return Math.round(value * 10_000);
}

/**
 * As `providerAmountToCents`, but `null` when the provider amount carries
 * precision finer than a cent.
 *
 * Used where accepting a rounded figure would silently invent a cent that the
 * provider never allocated — the credit-note deallocation reconciliation reads
 * an allocation back from Xero and must refuse a sub-cent amount rather than
 * round it into agreement.
 *
 * The tolerance is on the scaled value rather than the input because that is
 * where the double's own representation error lives: an exact 2dp decimal such
 * as `12.34` lands within ~1e-12 of `1234` once scaled, while a genuine
 * three-decimal-place amount such as `12.345` lands half a cent away.
 */
export function exactProviderAmountToCents(value: unknown): number | null {
  const cents = providerAmountToCents(value);
  if (cents === null) {
    return null;
  }

  return Math.abs((value as number) * 100 - cents) < 0.0001 ? cents : null;
}

/**
 * A Xero *report* cell's amount text → integer cents.
 *
 * Report cells are the one provider surface that still arrives as text, and
 * their grammar is wider than a typed amount: thousands separators, and a
 * negative written either as a leading `-` or in accountants' brackets, so
 * `"(1,234.50)"` is -123450.
 *
 * The affixes are stripped here and the magnitude is handed to the canonical
 * exact parser, so an ordinary two-decimal figure — which is every cell a
 * two-decimal-place Xero organisation produces — never goes near a float.
 *
 * KNOWN, DELIBERATE LIMIT: a cell whose magnitude falls outside that grammar
 * (an organisation reporting to four decimal places, scientific notation, an
 * amount above the int32 cent range) falls back to the historical
 * `Math.round(Number.parseFloat(text) * 100)`. That fallback is preserved
 * verbatim, and lives inside this reviewed module rather than being scattered
 * across the finance snapshots, precisely because tightening it would silently
 * change a published accounting figure — a money-behaviour decision for the
 * owner, not something to slip into a refactor (#2685). The fallback is the only
 * float money arithmetic left in the repository outside a test.
 */
export function parseProviderReportAmountToCents(
  value: string | null | undefined,
): number | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const isBracketNegative =
    trimmed.startsWith("(") && trimmed.endsWith(")") && trimmed.length > 2;
  const normalized = (isBracketNegative ? trimmed.slice(1, -1) : trimmed).replace(
    /,/g,
    "",
  );

  const exactCents = parseExactReportMagnitude(normalized);
  if (exactCents !== null) {
    return isBracketNegative && exactCents !== 0 ? -exactCents : exactCents;
  }

  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.round((isBracketNegative ? parsed * -1 : parsed) * 100);
}

/**
 * The signed magnitude of a report cell, exactly, or `null` when it is not in
 * the canonical grammar and the caller must fall back.
 */
function parseExactReportMagnitude(normalized: string): number | null {
  const signed = normalized.trim();
  const negative = signed.startsWith("-");
  const hasSign = negative || signed.startsWith("+");
  const magnitude = hasSign ? signed.slice(1) : signed;

  // A SIGN ONLY COUNTS WHEN IT IS JOINED TO THE DIGITS.
  //
  // `Number.parseFloat` — the fallback below, and the six legacy snapshot
  // parsers this module replaced — reads `"- 5"` as `NaN`, so every one of them
  // returned `null` for it. `parseDecimalDollarsToCents` trims its own input,
  // so handing it `" 5"` would read `"- 5"` as -500 and quietly widen what
  // counts as an amount. That is not free: `readRowAmountCents` picks the
  // RIGHT-MOST cell of a report row that parses as an amount, so a cell that
  // newly parses can change which cell is read. Worse, bracketed the sign came
  // out INVERTED — `"(- 5)"` became +500, because the bracket then negates a
  // magnitude that had already been made negative (#2685 review).
  //
  // Refusing the space here keeps the fallback's answer, which is what the
  // "byte-identical" claim in this module and in the changelog depends on.
  // `money-provider-amount.test.ts` runs these cells through both parsers.
  if (hasSign && /^\s/.test(magnitude)) {
    return null;
  }

  // The canonical parser owns the grammar, precision and range rules; this
  // function only carries back the affixes it stripped.
  const cents = parseDecimalDollarsToCents(magnitude);
  if (cents === null) {
    return null;
  }

  return negative && cents !== 0 ? -cents : cents;
}
