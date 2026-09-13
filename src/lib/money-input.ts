/**
 * The canonical boundary for money a PERSON typed (INV-MONEY-001, INV-MONEY-003).
 *
 * Everything a member or an admin types into a dollars box comes through here.
 * The parse is exact: the dollar and cent digit groups are read as integers and
 * combined with integer arithmetic, so the amount never passes through a binary
 * float and no decimal fraction is ever approximated. A string that is not a
 * well-formed amount returns `null` — it never becomes `0`, and callers must
 * turn that `null` into a validation error the person can see (#2685).
 *
 * Already-numeric amounts from an accounting provider are a DIFFERENT boundary:
 * the decimal source text no longer exists by the time they arrive, so they go
 * through `@/lib/money-provider-amount` instead. Do not send them here.
 */

/**
 * What a dollars box must be, for the parser above to ever see what was typed.
 *
 * A money box is `type="text"` with a decimal keypad, NOT `type="number"`
 * (owner decision, 14 Aug 2026). This is not a style preference — it is what
 * makes the validation in this module reachable at all.
 *
 * HTML's value-sanitization algorithm strips a `type="number"` control's value
 * to the empty string the moment it does not parse as a floating-point number.
 * `"50abc"`, `"$45.00"`, `"1,000.00"`, `"1,200"`, `"50e"` and `"50."` all arrive
 * at an `onChange` handler as `""` — indistinguishable from the box having been
 * deliberately cleared. Every handler in this repository reads `""` as "no
 * value", so a mistyped nightly rate saved as $0.00, a flat whole-lodge rate
 * reverted to per-guest pricing, and an error already on screen was wiped by the
 * next keystroke, with the save button re-enabled. The parser never ran, because
 * the browser had already thrown the evidence away.
 *
 * With `type="text"` the typed text survives, the parser sees it, and the
 * `null` it returns becomes the visible error the owner's 9 Aug decision asked
 * for. `inputMode="decimal"` still brings up a decimal keypad on a phone.
 *
 * The considered alternative was reading `validity.badInput` on the number
 * input. It was rejected: jsdom reports `badInput` as `false` unconditionally,
 * so it cannot be unit-tested at all, and the payments amount filter had
 * already shipped the text+`inputMode` pattern by hand.
 *
 * SPREAD THIS, including on a filter. A hand-written `inputMode="decimal"` with
 * no `type` at all was a fifth spelling of the same box and outlived #2932's
 * first pass on four of them, the payments filter among them; they spread the
 * constant now (#2932 review). There is no entry-versus-search distinction to
 * draw: these are two presentational attributes, and an omitted `type` was
 * already `text` by the HTML default, so the constant states what the markup
 * meant rather than changing it.
 *
 * ACCEPTED COST: no spinner arrows, and a decimal rather than numeric keypad.
 */
export const MONEY_INPUT_PROPS = {
  type: "text",
  inputMode: "decimal",
} as const;

/** Parse a non-negative decimal NZD input exactly, without binary float math. */
export function parseDecimalDollarsToCents(value: string): number | null {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const dollars = Number(match[1]);
  const cents = Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(dollars)) return null;
  const total = dollars * 100 + cents;
  return Number.isSafeInteger(total) && total <= 2_147_483_647 ? total : null;
}

/**
 * Parse a decimal NZD input that may carry a leading sign, exactly.
 *
 * Only for the places where the domain genuinely allows a negative amount — a
 * member credit adjustment can be a debit. The magnitude is handed to
 * `parseDecimalDollarsToCents`, so grammar, cent precision and range are the
 * canonical rules and this adds nothing but the sign. It is deliberately NOT the
 * default: a price, fee or refund box that accepts a minus sign is a bug.
 */
export function parseSignedDecimalDollarsToCents(value: string): number | null {
  const trimmed = value.trim();
  const negative = trimmed.startsWith("-");
  const magnitude =
    negative || trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
  const cents = parseDecimalDollarsToCents(magnitude);
  if (cents === null) return null;
  // `-0` is not a distinct amount; keep zero canonical so callers can compare it.
  return negative && cents !== 0 ? -cents : cents;
}
