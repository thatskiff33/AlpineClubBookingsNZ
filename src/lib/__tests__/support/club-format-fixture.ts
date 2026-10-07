import {
  CLUB_CURRENCY_FALLBACK,
  CLUB_LOCALE_FALLBACK,
  type ClubFormat,
} from "@/lib/club-format";

/**
 * The club format a test passes when it is NOT the thing under test (#3565).
 *
 * Every rendering takes the club's format as a required argument, so a test
 * that only cares about the amount still has to say which format — and this is
 * the one to say, on exactly the terms `club-time-render.tsx` chooses its zone:
 * these are the values `APP_CURRENCY` / `APP_LOCALE` fall back to, so every
 * existing expected string (`"$45.00"`, `"+$1,204"`) keeps its meaning and the
 * migration to a required argument changed no test's MEANING.
 *
 * Spelled from the fallbacks rather than as literals so this file and the
 * runtime can never disagree about what "the default" is (`INV-SSOT-001`), and
 * exported from one place so no test grows its own `{ currencyCode, locale }`.
 *
 * And, on the same terms, A TEST USING THIS PROVES NOTHING ABOUT FORMAT
 * AUTHORITY: under the defaults the recorded setting and the retired constants
 * agree. A test that means to prove the argument is load-bearing passes
 * {@link CLUB_FORMAT_TEST_OTHER} and asserts an answer only that produces.
 */
export const CLUB_FORMAT_TEST: ClubFormat = {
  currencyCode: CLUB_CURRENCY_FALLBACK,
  locale: CLUB_LOCALE_FALLBACK,
};

/**
 * A format the environment does NOT hold — the house choice for proving that
 * the argument reaches the output (`CHF`, and a locale that groups with an
 * apostrophe and writes the code rather than a `$`).
 */
export const CLUB_FORMAT_TEST_OTHER: ClubFormat = {
  currencyCode: "CHF",
  locale: "de-CH",
};
