/**
 * NZD -> club-currency conversion for AI spend (#3354, `INV-CONFIG-001`).
 *
 * Both AI modules price provider tokens from a table in NEW ZEALAND cents per
 * million tokens (Anthropic's USD list x a fixed, conservative 1.8 NZD/USD).
 * A club configured for another currency (`APP_CURRENCY`) enters, compares and
 * reads its monthly cap in its OWN money, so every NZD-cent estimate is
 * converted through ONE administrator-set rate before it is booked or compared
 * with a cap. This module is the single home for that rate's arithmetic and
 * grammar; `ai-spend-currency-settings.ts` reads the stored rate.
 *
 * CLIENT-SAFE BY DESIGN: no Prisma, no `server-only`. The admin card that
 * edits the rate imports the parser and formatter from here, the same way the
 * spend-cap editors import `parseDecimalDollarsToCents`.
 *
 * THE RATE IS AN INTEGER (`INV-MONEY`): parts per million club units per NZD.
 * `1_000_000` is identity (1 NZD = 1 club unit); `920_000` means 1 NZD = 0.92
 * club units. No float is ever stored, and the conversion below never divides
 * a float — it multiplies two integers and takes an exact integer ceiling.
 */

/** Parts per million: the fixed point of the stored rate. */
export const MICROS_PER_CLUB_UNIT = 1_000_000;

/** The identity rate — 1 NZD = 1 club unit — used for an NZD club and for a non-NZD club that has not set a rate. */
export const IDENTITY_RATE_MICROS = MICROS_PER_CLUB_UNIT;

/** Smallest storable rate: 0.000001 club units per NZD (one micro). */
export const MIN_RATE_MICROS = 1;

/**
 * Largest storable rate: 1,000 club units per NZD. Bounded well inside the
 * INTEGER column (2,147,483,647 micros = 2,147.48) and inside every product an
 * estimate can form with it (see `convertNzdCentsToClubCents`). A rate above
 * this is a fat-finger for any currency this product formats in two decimals.
 */
export const MAX_RATE_MICROS = 1_000 * MICROS_PER_CLUB_UNIT;

/** At most six decimal places — the precision the integer micros can hold. */
const RATE_GRAMMAR = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/;

/**
 * Parse the decimal an administrator typed (for example `"0.92"`) into micros,
 * or `null` when it is not a usable rate. Exact: the integer and fraction digit
 * groups are combined with integer arithmetic, never through a float. Refuses a
 * blank, a sign, a currency symbol, a thousands separator, a leading zero
 * (`"007"`), more than six decimals, NaN/Infinity by construction (the grammar
 * admits only digits), ZERO (a zero rate would price every call at nothing and
 * disarm both caps) and anything above `MAX_RATE_MICROS`.
 */
export function parseClubUnitsPerNzdToMicros(input: string): number | null {
  const match = RATE_GRAMMAR.exec(input.trim());
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(6, "0"));
  if (!Number.isSafeInteger(whole)) return null;
  const micros = whole * MICROS_PER_CLUB_UNIT + fraction;
  if (!Number.isSafeInteger(micros)) return null;
  if (micros < MIN_RATE_MICROS || micros > MAX_RATE_MICROS) return null;
  return micros;
}

/**
 * Whether a stored (or received) micros value is a rate this module will
 * price with: a safe integer inside `[MIN_RATE_MICROS, MAX_RATE_MICROS]`.
 */
export function isValidRateMicros(micros: number): boolean {
  return (
    Number.isSafeInteger(micros) &&
    micros >= MIN_RATE_MICROS &&
    micros <= MAX_RATE_MICROS
  );
}

/**
 * The inverse of the parser, for display and for seeding the editor: micros
 * -> a plain decimal string with at least two and at most six decimals,
 * trailing zeros beyond the second trimmed (`920_000` -> `"0.92"`,
 * `1_000_000` -> `"1.00"`, `1_234_567` -> `"1.234567"`). No currency symbol —
 * a rate is a ratio, not an amount.
 */
export function formatClubUnitsPerNzd(micros: number): string {
  const whole = Math.trunc(micros / MICROS_PER_CLUB_UNIT);
  const fraction = micros - whole * MICROS_PER_CLUB_UNIT;
  const digits = String(fraction).padStart(6, "0").replace(/0+$/, "");
  return `${whole}.${digits.padEnd(2, "0")}`;
}

/**
 * Convert NZD integer cents to club-currency integer cents at `micros`, ROUNDED
 * UP. The over-count direction is deliberate and load-bearing: both metering
 * libraries already over-estimate (conservative FX, `Math.ceil`, fail-expensive
 * unknown model) so a cap trips early rather than late, and a conversion that
 * rounded down would hand some of that margin back. At the identity rate the
 * result equals the input exactly; a positive input never converts to zero,
 * so "a real call is never free in the ledger" survives the conversion.
 *
 * Exact integer arithmetic: the product of two safe integers is computed, then
 * divided with the remainder recovered by subtraction, so no rounding of the
 * quotient can push an exact multiple up or a near-multiple down. Throws on a
 * non-integer, negative or out-of-range input rather than returning a wrong
 * cents figure — every caller sits behind a fail-closed catch that denies the
 * spend.
 */
export function convertNzdCentsToClubCents(nzdCents: number, micros: number): number {
  if (!Number.isSafeInteger(nzdCents) || nzdCents < 0) {
    throw new Error(
      `AI spend conversion: nzdCents must be a non-negative integer, got ${nzdCents}`,
    );
  }
  if (!isValidRateMicros(micros)) {
    throw new Error(`AI spend conversion: rate micros out of range, got ${micros}`);
  }
  const product = nzdCents * micros;
  if (!Number.isSafeInteger(product)) {
    throw new Error(
      `AI spend conversion: ${nzdCents} x ${micros} overflows a safe integer`,
    );
  }
  const quotient = Math.trunc(product / MICROS_PER_CLUB_UNIT);
  // Exact: both terms are safe integers, so the subtraction is exact and the
  // adjustment below corrects any rounding the float division introduced.
  let remainder = product - quotient * MICROS_PER_CLUB_UNIT;
  let floor = quotient;
  while (remainder < 0) {
    floor -= 1;
    remainder += MICROS_PER_CLUB_UNIT;
  }
  while (remainder >= MICROS_PER_CLUB_UNIT) {
    floor += 1;
    remainder -= MICROS_PER_CLUB_UNIT;
  }
  return remainder > 0 ? floor + 1 : floor;
}

/** What every consumer of the rate receives; see `loadAiSpendCurrency`. */
export interface AiSpendCurrency {
  /** The club's configured currency code (`APP_CURRENCY`). */
  clubCurrency: string;
  /** True when the club prices in NZD: no conversion applies and no rate is stored or shown. */
  isNzd: boolean;
  /** The rate in force: identity for an NZD club and for a non-NZD club with no stored rate. */
  clubUnitsPerNzdMicros: number;
  /** When the stored rate was set; `null` when none is stored. */
  rateSetAt: Date | null;
  /** Who set it (a plain member id, audit-only); `null` when unknown or none is stored. */
  rateSetByMemberId: string | null;
  /** False for a non-NZD club with no stored rate — spend is then counted as if 1 NZD = 1 club unit. */
  isConfigured: boolean;
}
