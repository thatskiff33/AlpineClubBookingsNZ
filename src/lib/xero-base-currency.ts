/**
 * Does the connected Xero organisation's base currency differ from the club's
 * currency? The ONE comparison (#3633, `INV-SSOT`), shared by the three places
 * that warn about it: the Xero setup wizard's organisation confirmation, the
 * Club Currency & Locale page and the setup-readiness list.
 *
 * Why it matters: invoices sent to Xero carry no currency of their own, so Xero
 * books them in the organisation's base currency, while card payments are
 * charged in the club's currency (#3567). When the two differ, Stripe charges
 * and Xero invoices are in different currencies. The warning blocks nothing and
 * changes no invoice (the decision on #3633).
 *
 * Client-safe: the wizard compares in the browser. The only import is the
 * currency-code shape rule from `@/lib/club-format`, which already reaches the
 * browser bundle.
 */

import { normaliseClubCurrencyCode } from "@/lib/club-format";

/** The two codes that differ, each in its canonical upper-case spelling. */
export interface XeroBaseCurrencyMismatch {
  xeroBaseCurrency: string;
  clubCurrencyCode: string;
}

/**
 * The two currencies when they differ, or `null` when they match OR when
 * either one is unknown.
 *
 * Unknown means absent, blank or not a currency code at all. An unreadable
 * Xero (not connected, a failed read, a viewer who may not read the
 * organisation) passes `null` and gets no warning: the check says nothing
 * rather than guess. Both sides go through `normaliseClubCurrencyCode`, so
 * `nzd` and `NZD` are the same currency.
 */
export function xeroBaseCurrencyMismatch(
  orgBaseCurrency: string | null | undefined,
  clubCurrencyCode: string | null | undefined,
): XeroBaseCurrencyMismatch | null {
  const xeroBaseCurrency = normaliseClubCurrencyCode(orgBaseCurrency);
  const club = normaliseClubCurrencyCode(clubCurrencyCode);
  if (xeroBaseCurrency === null || club === null) return null;
  if (xeroBaseCurrency === club) return null;
  return { xeroBaseCurrency, clubCurrencyCode: club };
}
