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

/** Everything the setting reaches, and the one thing it does not. */
export const CLUB_FORMAT_REACH =
  "Everything the site writes follows this setting as soon as you save: every amount, every date and time on screen (the lobby display's clock and the health dashboard's \"Last refresh\" line included), the currency AI spend is counted in, and alphabetical order. Emails follow too — the server that takes the save refreshes its copy at once. The one exception is the date labels along the bottom of the report charts (\"Apr 16\"), which are always in English.";

/** A currency change clears the AI spend conversion rate. */
export const CLUB_FORMAT_AI_RATE_CLEARED =
  "Changing the CURRENCY clears the AI spend conversion rate, because it was set for the old currency: enter the rate for the new one on the AI settings page afterwards. Changing only the number and date format leaves it alone.";

/** What the server's CURRENCY and LOCALE still do. */
export const CLUB_FORMAT_SERVER_SETTINGS =
  "CURRENCY and LOCALE on the server seeded this setting once and no longer change anything a club sees; editing them will not change it back. The one thing still taken from the server's CURRENCY is the currency card payments are charged in.";

/** Nothing recorded is rewritten. */
export const CLUB_FORMAT_NOTHING_REWRITTEN =
  "No amount already recorded is rewritten or re-converted. A payment of 8450 cents is still 8450 cents; only the way an amount is written follows this setting, never what it is worth.";

/** Card payments are a separate, server-side decision. */
export const CLUB_FORMAT_CARD_PAYMENTS =
  "Card payments are still charged in the currency the deployment is configured with. Moving the club to a different currency is a conversation with the payment provider and the club's accountant before it is a setting here.";
