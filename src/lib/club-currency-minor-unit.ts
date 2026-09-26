/**
 * Whether a currency counts in hundredths — the ONE home of that rule (owner
 * decision D3 on #3567; INV-CONFIG-006, INV-MONEY).
 *
 * EVERY AMOUNT IN THIS PRODUCT IS AN INTEGER COUNT OF HUNDREDTHS. `formatCents`
 * writes `cents / 100`, every fee field takes a decimal with two places, and
 * Stripe's `amount` is sent as that same integer. Stripe reads `amount` in the
 * currency's SMALLEST unit, so the product and the card agree only for a
 * currency whose smallest unit is one hundredth. For the yen the smallest unit
 * is the yen itself: a fee shown as ¥84.50 would be charged ¥8,450, a hundred
 * times over. For the Kuwaiti dinar it is the fils, a thousandth: charged a
 * tenth. So a currency without two decimal places is refused — when the club's
 * currency is SAVED (`/api/admin/club-format`), and again when a card is
 * CHARGED (`stripe.ts`), which catches a value that reached the row another
 * way (the first-boot seed copies `CURRENCY` as it finds it). Supporting such
 * currencies properly would touch every amount field and formatter, and was
 * declined as its own programme.
 *
 * WHY A FIXED LIST AND NOT `Intl`'s `maximumFractionDigits`. The runtime's
 * answer is not the same answer everywhere, which is the failure the currency
 * validator in `club-format.ts` already refuses to build on: measured on Node 24,
 * V8 reports ZERO digits for HUF, IDR and COP, whose ISO 4217 minor unit is 2 and
 * which Stripe charges as two-decimal. A rule taken from the engine would refuse
 * a Hungarian club on the server and offer it the currency in a browser whose
 * engine says 2. The list below is fixed, so the save route, the charge guard and
 * the panel's option list give one answer on every engine.
 *
 * WHAT IS ON IT. The union of two published lists, because a currency on either
 * one breaks the hundredths assumption:
 * - ISO 4217's currencies whose minor unit is not 2 (0, 3 or 4 digits), plus
 *   the codes it lists with no minor unit at all (precious metals, the SDR, the
 *   testing codes);
 * - Stripe's zero-decimal and three-decimal currencies, which add MGA (ISO says
 *   2; Stripe charges it in whole ariary);
 * - withdrawn ISO 4217 codes (List Three) whose minor unit was not 2 — the
 *   peseta, the lira, the Turkish lira before 2005 and the rest. No payment
 *   provider charges in them, but some engines still OFFER them in
 *   `Intl.supportedValuesOf("currency")`, so they are refused here rather than
 *   left selectable.
 * A code absent from both — a real two-decimal currency, or an unknown but
 * well-formed one — is taken to count in hundredths; Stripe refuses a currency
 * it does not support on its own.
 *
 * Isomorphic: no environment read, no `server-only`, so the browser panel can
 * leave these out of the options it offers.
 */

const CURRENCIES_WITHOUT_TWO_DECIMAL_PLACES: ReadonlySet<string> = new Set([
  // ISO 4217 minor unit 0. Stripe charges most of these as zero-decimal; ISK
  // and UGX it keeps in a two-decimal representation for backward
  // compatibility but only accepts amounts divisible by 100 — so either way a
  // price kept in hundredths is not what the card would be charged.
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF",
  "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF",
  // Stripe zero-decimal, though ISO 4217 lists a minor unit of 2.
  "MGA",
  // ISO 4217 minor unit 3 (Stripe three-decimal where it supports them).
  "BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND",
  // ISO 4217 minor unit 4.
  "CLF", "UYW",
  // ISO 4217 "N.A.": no minor unit — metals, the SDR, bond units, testing codes.
  "XAG", "XAU", "XBA", "XBB", "XBC", "XBD", "XDR", "XPD", "XPT", "XSU",
  "XTS", "XUA", "XXX",
  // Withdrawn codes (ISO 4217 List Three) whose minor unit was not 2.
  "ADP", "BEF", "BYR", "ESP", "GRD", "ITL", "LUF", "MGF", "MRO", "PTE",
  "STD", "TMM", "TRL", "ZWD",
]);

/**
 * A currency code as every money-side comparison reads it: trimmed and upper
 * case. The ONE normaliser for that (#3567 review), shared by the refusal below
 * and the Stripe charge currency, so the guard and the wire can never read two
 * spellings of one code differently.
 */
export function canonicalCurrencyCode(currencyCode: string): string {
  return currencyCode.trim().toUpperCase();
}

/**
 * True when `currencyCode` counts in hundredths, as every amount here does.
 * Case-insensitive and trimmed, so a raw `CURRENCY` seed and a stored code get
 * the same answer.
 */
export function currencyHasTwoDecimalPlaces(currencyCode: string): boolean {
  return !CURRENCIES_WITHOUT_TWO_DECIMAL_PLACES.has(canonicalCurrencyCode(currencyCode));
}

/**
 * The refusal an operator or a log reader sees, one spelling for the save route
 * and the charge guard.
 */
/** How a stored row with a BLANK currency is named on the format (#3567). */
export const NO_STORED_CURRENCY = "(blank)";

export function twoDecimalPlacesRequiredMessage(currencyCode: string): string {
  if (currencyCode === NO_STORED_CURRENCY) {
    return (
      "The club has no currency recorded, so a card cannot be charged. " +
      "Choose a currency with two decimal places, such as NZD, AUD or CHF."
    );
  }
  return (
    `${currencyCode} does not count in hundredths, and this site records every ` +
    "amount in hundredths (cents), so a card would be charged the wrong amount. " +
    "Choose a currency with two decimal places, such as NZD, AUD or CHF."
  );
}
