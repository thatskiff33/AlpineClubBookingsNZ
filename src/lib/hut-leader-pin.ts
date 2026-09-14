/**
 * The kiosk PIN's SHAPE — its length, the filter that enforces it, and the two
 * expressions derived from that length — in one module both sides of the
 * client/server boundary can hold (#2981).
 *
 * ## Why one module, and why not `lodge-pin-session.ts`
 *
 * "Six digits" was retyped in nine places: three PIN forms (`maxLength`,
 * `pattern`, a `length !== 6` submit guard, and an inline
 * `.replace(/\D/g, "").slice(0, 6)` in each), two zod schemas as `/^\d{6}$/`,
 * and the generator's `randomInt(0, 1_000_000)` + `padStart(6, "0")`. A club
 * that changed the PIN length would have had to find every one of them, and a
 * form whose filter and whose `pattern` disagree accepts input the server then
 * refuses — so this is `INV-SSOT`'s "cannot change a fact in one place" exactly.
 *
 * It is NOT in `@/lib/lodge-pin-session`, which is where the generator lives,
 * for the reason `lodge-pin-session-timing.ts` already records for the session
 * clocks (#3228): that module reads the database and the auth secret, so it is
 * unreachable from a browser bundle, and all three PIN forms are `"use client"`.
 * `INV-OPS-013` (`client-server-boundary-census.test.ts`) enforces that, so the
 * split is a boundary requirement rather than a preference. This module imports
 * nothing, which is what keeps it holdable from both sides.
 */

/** Digits in a kiosk PIN. Everything below is derived from it. */
export const HUT_LEADER_PIN_LENGTH = 6;

/**
 * The wire/storage form, for a zod schema or any other exact check.
 * `new RegExp` rather than a literal so the length above is the only place the
 * number appears.
 */
export const HUT_LEADER_PIN_PATTERN = new RegExp(
  `^\\d{${HUT_LEADER_PIN_LENGTH}}$`,
);

/**
 * The same rule as an HTML `pattern` attribute value. Browsers anchor `pattern`
 * implicitly, so it carries no `^`/`$` of its own.
 */
export const HUT_LEADER_PIN_HTML_PATTERN = `\\d{${HUT_LEADER_PIN_LENGTH}}`;

/**
 * The input filter every PIN field applies: digits only, no longer than a PIN.
 *
 * Idempotent, and it only ever DELETES characters — which is what lets
 * `SecretInput` repair the caret after running it.
 */
export function sanitiseHutLeaderPin(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, HUT_LEADER_PIN_LENGTH);
}

/** Whether a typed value is a complete PIN, for a submit guard. */
export function isCompleteHutLeaderPin(value: string): boolean {
  return value.length === HUT_LEADER_PIN_LENGTH;
}
