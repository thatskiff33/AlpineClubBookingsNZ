/**
 * What the Club Currency & Locale setting reaches, in plain English — the ONE
 * home of that copy (#3566 review, `INV-SSOT`).
 *
 * The admin page's blurb, the confirmation panel's consequences list and the
 * page's contextual help all tell an operator what saving changes. Each used to
 * carry its own sentence, and after #3566 all three still said dates followed
 * the server's `LOCALE`. Rendering them from here means the next stage that
 * changes what the setting reaches changes one string. The operator guide
 * (`docs/guides/club-format.md`) is the long form and says the same.
 *
 * Client-safe: plain strings, no imports.
 */

/**
 * Everything the setting reaches, and — without counting them, so the copy
 * cannot go stale as the list changes — the few labels that stay in English.
 * The guide's "What does not follow it" list is the authority on those.
 */
export const CLUB_FORMAT_REACH =
  "Everything the site writes follows this setting as soon as you save: every amount, every date and time on screen (the lobby display's clock and the health dashboard's \"Last refresh\" line included), the currency AI spend is counted in, and alphabetical order. Emails follow too — the server that takes the save refreshes its copy at once. A few labels stay in English whatever is set, such as the date labels along the bottom of the report charts (\"Apr 16\"), some day and month names chosen from fixed lists, and relative times like \"3 hours ago\" — the Club Currency & Locale guide lists them.";

/** A currency change clears the AI spend conversion rate. */
export const CLUB_FORMAT_AI_RATE_CLEARED =
  "Changing the CURRENCY clears the AI spend conversion rate, because it was set for the old currency: enter the rate for the new one on the AI settings page afterwards. Changing only the number and date format leaves it alone.";

/** What the server's CURRENCY and LOCALE still do: nothing, once recorded. */
export const CLUB_FORMAT_SERVER_SETTINGS =
  "CURRENCY and LOCALE on the server seeded this setting once, on the first start after upgrading, and no longer change anything — not what a club sees and not what cards are charged in. Editing them will not change it back.";

/** Nothing recorded is rewritten. */
export const CLUB_FORMAT_NOTHING_REWRITTEN =
  "No amount is converted, recorded or not. A payment of 8450 cents stays 8450 cents in the currency it was paid in, and every price keeps its number — after a change the same number is shown, and charged, in the new currency.";

/**
 * Card payments follow the setting (#3567, owner decision D1), and what a
 * change does to a payment already under way.
 */
export const CLUB_FORMAT_CARD_PAYMENTS =
  "Card payments are charged in this currency. Saving a different one changes what new card charges are made in straight away. A card payment already started stays in the currency it was started in unless the member reopens it, when it is replaced by one in the new currency. A saved card charged later is charged in the new currency. A payment-recovery retry is refused by the payment provider for the first 24 hours after the change and is then made in the new currency. A refund of a payment taken before the change goes back in that payment's original currency, though this site shows its amount in the new one. Currencies without two decimal places, such as JPY or KWD, cannot be chosen, because every amount here is kept in hundredths.";

/**
 * Xero's base currency must match (#3567, owner decision D8). Invoices sent to
 * Xero carry no currency of their own, so Xero books them in the organisation's
 * base currency; the check that compares the two is #3633.
 */
export const CLUB_FORMAT_PROVIDER_CURRENCIES =
  "The club's Stripe account and its Xero organisation's base currency must both be this currency. Xero books every invoice this site sends in its base currency, and Stripe converts a charge in any other currency before paying it out, at a fee. Change them to match before saving here, not after.";

/**
 * The acknowledgement a CURRENCY change needs on top of the ordinary one
 * (owner decision D2). The route refuses a currency change without it.
 */
export function clubFormatCurrencyChangeAcknowledgement(currencyCode: string): string {
  return `I have checked that the club's Stripe account and its Xero base currency are both ${currencyCode}, and I understand card payments are charged in ${currencyCode} from the moment I save.`;
}
