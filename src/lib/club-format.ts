/**
 * The club's currency and locale: their shape and validation (stage 1 of
 * programme #3205, #3563). INV-CONFIG-006.
 *
 * ONE CURRENCY AND ONE LOCALE PER INSTALLATION. The currency is the ISO 4217
 * alphabetic code the club charges and displays money in — `NZD`, `AUD`, `CHF`.
 * The locale is the BCP 47 language tag its numbers and dates are formatted
 * with — `en-NZ`, `de-CH`. Both are properties of the CLUB, not of the server
 * and not of whoever is looking.
 *
 * WHY A SHAPE RULE AND NOT `Intl.supportedValuesOf("currency")`. Membership of
 * that list was the obvious validator and is the wrong one, for the reason
 * `club-time-zone.ts` records at length for time zones: the list is whatever the
 * bundled ICU happens to know, so it is not stable across engines or across an
 * ICU upgrade, and ISO 4217 keeps issuing codes. Validating by membership would
 * let an upgrade turn a club's perfectly good stored currency invalid, or refuse
 * a newly issued code the club is actually being paid in. The list is exactly
 * right for OFFERING choices ({@link listSelectableClubCurrencyCodes}) and
 * useless for judging a stored value.
 *
 * So the recipe is the same one: a SHAPE rule, then a runtime usability probe,
 * then the same shape rule again on whatever the runtime canonicalised it to.
 *
 * - Currency: three ASCII letters, probed through `Intl.NumberFormat`, whose
 *   `resolvedOptions().currency` is the uppercased canonical code.
 * - Locale: a BCP 47 tag shape, probed through `Intl.getCanonicalLocales`,
 *   which is the runtime's own BCP 47 parser and throws on a structurally
 *   invalid tag.
 *
 * TWO DIFFERENCES FROM THE TIMEZONE, both deliberate and both worth stating
 * because the timezone is the precedent a reader arrives from.
 *
 * FIRST, THERE IS ONE NORMALISER PER FIELD, NOT TWO. `club-time-zone.ts` needs a
 * separate PRESERVATION normaliser because forty-one legacy `TZ` spellings work
 * today and are refused by the input validator, so judging a running
 * deployment's zone by the operator-input rule would move the club. Neither
 * field here has that class: `CURRENCY` has always been fed to
 * `APP_CURRENCY = currency.toUpperCase()` and thence to `Intl`, and `LOCALE`
 * straight to `Intl`, so anything that works today is already something these
 * rules accept, and anything they refuse is something that was not working
 * either. The boot backfill and the operator form can therefore share one rule,
 * which is one fewer way for a writer and a reader to disagree.
 *
 * SECOND, THE CURRENCY PROBE CANNOT REJECT AN UNKNOWN-BUT-WELL-FORMED CODE, and
 * saying so is better than implying a check this does not make.
 * `Intl.NumberFormat` throws only when the code is not three ASCII letters, so
 * `ZZZ` is accepted and formats as `ZZZ 12.34`. That is the accepted
 * consequence of refusing list membership above, and it is the safe direction to
 * be wrong in: the failure mode is an odd-looking currency prefix on an admin's
 * own screen, immediately visible and immediately fixable, where the failure
 * mode of list membership is a club locked out of its own real currency by
 * somebody else's ICU build.
 *
 * This module is deliberately free of `server-only` and of every Prisma import:
 * the admin panel needs the selector list and the length limits in the BROWSER,
 * and the boot backfill and the API route need the same judgement on the server.
 * A validator that only half the writers can reach is how two of them drift.
 * The environment-reading half lives in `club-format-env.ts`, which IS marked
 * `server-only`, for the reason recorded there.
 */

/**
 * The generic New Zealand defaults — used ONLY where no prior effective
 * configuration exists at all. They are distribution defaults, not an assumption
 * about which club this is (`INV-CONFIG-001`): an install that has been running
 * on another currency keeps it, because the boot backfill copies what that
 * deployment is already effectively using before this constant can be reached.
 * The same argument `CLUB_TIME_ZONE_FALLBACK` makes for `Pacific/Auckland`.
 */
export const CLUB_CURRENCY_FALLBACK = "NZD";

/** The generic New Zealand locale default. See {@link CLUB_CURRENCY_FALLBACK}. */
export const CLUB_LOCALE_FALLBACK = "en-NZ";

/**
 * The `ClubFormatSettings` singleton row id — the ONE spelling, and it lives in
 * this module rather than beside the reader for the measured reason
 * `CLUB_TIME_SETTINGS_ID` records (#2989 review). Writers that cannot import a
 * `server-only` reader would otherwise each declare their own `"default"`
 * literal, and a drift between them fails SILENTLY: `create` passes `id`
 * explicitly, so the writer creates a second row under the wrong id, the reader
 * still finds nothing at `"default"`, and the club's chosen currency sits
 * orphaned with no error anywhere.
 */
export const CLUB_FORMAT_SETTINGS_ID = "default";

/** Matches `ClubFormatSettings.currencyCode`'s `@db.VarChar(3)`. */
export const CLUB_CURRENCY_CODE_LENGTH = 3;

/** Matches `ClubFormatSettings.locale`'s `@db.VarChar(64)`. */
export const CLUB_LOCALE_MAX_LENGTH = 64;

/** An ISO 4217 alphabetic code: exactly three ASCII letters. */
const CURRENCY_CODE_SHAPE = /^[A-Za-z]{3}$/;

/**
 * A BCP 47 language tag SHAPE — a primary subtag of two or three ASCII letters,
 * then hyphen-separated subtags of one to eight alphanumerics.
 *
 * It is deliberately looser than the full BCP 47 grammar AFTER the primary
 * subtag, because the runtime probe below is the grammar:
 * `Intl.getCanonicalLocales` is the engine's own parser and throws
 * `RangeError` on anything it cannot read. The shape rule exists to refuse the
 * obviously-wrong before the probe sees it, and to bound the length against the
 * column.
 *
 * WHY THE PRIMARY SUBTAG IS PINNED AT TWO OR THREE LETTERS, which is the one
 * place this rule is STRICTER than the parser. RFC 5646 allows `2*3ALPHA`, a
 * reserved `4ALPHA`, and `5*8ALPHA` for a registered language subtag — and
 * `getCanonicalLocales` checks the grammar, not the registry, so it accepts
 * `english` and `deutsch` happily. Those are exactly the mistake an operator
 * types into this field, and accepting one would record a locale that formats
 * nothing the way the club expects while looking deliberate. Every ISO 639
 * language code is two or three letters, so requiring that refuses the mistake
 * without refusing any real language. It also refuses the `x-` private-use and
 * `i-` grandfathered families, which name no language a club formats in.
 */
const BCP47_TAG_SHAPE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;

function hasCurrencyCodeShape(value: string): boolean {
  return value.length === CLUB_CURRENCY_CODE_LENGTH && CURRENCY_CODE_SHAPE.test(value);
}

function hasLocaleShape(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= CLUB_LOCALE_MAX_LENGTH &&
    BCP47_TAG_SHAPE.test(value)
  );
}

/**
 * The canonical spelling of a usable club currency code, or `null`.
 *
 * Trims, judges the SHAPE, asks the runtime to accept it, and judges the
 * canonical code the runtime reports by the same rule. The resolved spelling is
 * what comes back, so `nzd` is stored as `NZD` — one spelling in the database
 * whatever an operator or an environment variable typed.
 */
export function normaliseClubCurrencyCode(
  value: string | null | undefined,
): string | null {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!hasCurrencyCodeShape(candidate)) return null;

  let resolved: string | undefined;
  try {
    /*
      THE LOCALE ARGUMENT IS `undefined` ON PURPOSE, and it is not an evasion of
      the house ban on `Intl.NumberFormat(<literal locale>, { style: "currency" })`
      (INV-CONFIG-001, #3325). That ban exists because a RENDERING formatter must
      take the club's locale rather than one this codebase picked. This
      constructs no rendering formatter: nothing is formatted, no string is
      produced, and the currency under test is a variable. Passing a literal
      locale here would be the very mistake the ban names — asserting a club's
      locale from inside a validator — so the probe states that it has no
      opinion about the locale instead, which is what `undefined` means.
    */
    resolved = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: candidate,
    }).resolvedOptions().currency;
  } catch {
    // RangeError: this runtime will not format money in that code.
    return null;
  }

  if (typeof resolved !== "string") return null;
  return hasCurrencyCodeShape(resolved) ? resolved.toUpperCase() : null;
}

/**
 * The canonical spelling of a usable club locale, or `null`.
 *
 * WHY THE PROBE IS `getCanonicalLocales` AND NOT `new Intl.DateTimeFormat(tag)
 * .resolvedOptions().locale`, which is the obvious mirror of the timezone's
 * probe and is WRONG here. `Intl.DateTimeFormat` never throws for a
 * well-formed tag it does not support; it NEGOTIATES, and reports the locale it
 * fell back to. So `qqq-ZZ` would come back as the runtime's default — `en-US`
 * on most builds — and this function would silently store a locale nobody asked
 * for, while a club whose tag ICU merely lacks data for (`mi-NZ` on a slim ICU)
 * would find its choice quietly rewritten to English. `getCanonicalLocales` is
 * the parser rather than the negotiator: it throws on a structurally invalid
 * tag and otherwise returns the tag canonicalised (`EN-nz` → `en-NZ`) without
 * any opinion about what data is installed. Formatting with an unsupported tag
 * then falls back at RENDER time, which is a display question and not a storage
 * one.
 */
export function normaliseClubLocale(
  value: string | null | undefined,
): string | null {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!hasLocaleShape(candidate)) return null;

  let canonical: string | undefined;
  try {
    [canonical] = Intl.getCanonicalLocales(candidate);
  } catch {
    // RangeError: not a structurally valid BCP 47 tag.
    return null;
  }
  if (typeof canonical !== "string" || !hasLocaleShape(canonical)) return null;

  try {
    // The usability half of the recipe: a tag can be structurally valid and
    // still be refused by a constructor (an unsupported extension, for
    // instance). Nothing is formatted — the probe exists to make the runtime
    // accept or reject the tag.
    new Intl.NumberFormat(canonical).resolvedOptions();
    /*
      THE ZONE IS PINNED TO `UTC`, AND IT HAS TO BE — #3564 CORRECTED THIS.

      Stage 1 wrote `timeZone: undefined` here and argued it was the honest
      spelling: this probe asks whether the runtime will accept the TAG and has
      no opinion about zones, no date is produced, and the result is discarded.
      That reasoning held while this module only ever ran on the server. Stage 2
      (#3564) mounts `ClubFormatProvider` in the browser, which re-validates
      what it is handed, which runs this function in every page's render — and
      an `Intl.DateTimeFormat` built with no `timeZone` resolves to the VIEWER's
      clock, which `INV-DATE-015` bans outright because
      `resolvedOptions().timeZone` is exactly how a page learns that zone.
      Measured: it turned `club-time-zone-panel.test.tsx`'s runtime watch red
      with two unzoned constructions.

      `UTC` asserts nothing about the club. It is the fixed zone the kernel's
      own calendar-day formatters pin for the same reason — it always exists, on
      every runtime — so the probe still answers only the question it is asking,
      and answers it without building the one object this application is not
      allowed to build. Every real date rendering still goes through
      `@/lib/club-time`, which owns the only formatter factory in the tree.
    */
    new Intl.DateTimeFormat(canonical, {
      timeZone: "UTC",
    }).resolvedOptions();
  } catch {
    return null;
  }

  return canonical;
}

/** True when `value` is a usable club currency code. */
export function isValidClubCurrencyCode(value: string | null | undefined): boolean {
  return normaliseClubCurrencyCode(value) !== null;
}

/** True when `value` is a usable club locale. */
export function isValidClubLocale(value: string | null | undefined): boolean {
  return normaliseClubLocale(value) !== null;
}

/** The club's two format settings, both resolved and both always present. */
export interface ClubFormat {
  /** ISO 4217, upper case — `NZD`. */
  currencyCode: string;
  /** BCP 47, canonical — `en-NZ`. */
  locale: string;
}

/**
 * Either leg of the fallback chain as its source can actually supply it: a
 * database row, an environment reading, or nothing at all. Every field is
 * optional AND nullable because both of those states occur — an absent row
 * supplies neither key, and an unusable environment variable supplies the key
 * with `null` — and collapsing them would make one of the two callers cast.
 */
export interface ClubFormatCandidate {
  currencyCode?: string | null;
  locale?: string | null;
}

/**
 * Resolve the club's currency and locale from the persisted values, with the
 * environment as a SEED-ONLY fallback and the shipped defaults as the last
 * resort.
 *
 * THE PRECEDENCE IS THE WHOLE POINT (INV-CONFIG-006, owner decision D3 on
 * #3205). A valid persisted value wins outright: once the club has configured
 * its currency, `CURRENCY` and `NEXT_PUBLIC_CURRENCY` are not a second opinion,
 * and editing the container's environment cannot move the club's money. The
 * environment is read ONLY while nothing is persisted — the window between
 * `prisma migrate deploy` and the first boot of the upgraded release, which is
 * exactly the window in which an existing deployment's current effective values
 * must be preserved unchanged.
 *
 * THE TWO FIELDS RESOLVE INDEPENDENTLY, which is not fussiness. The columns are
 * both NOT NULL so a row always carries both, but a row can still reach a reader
 * with one unusable value — a hand-edit, a bad restore, an ICU that stopped
 * accepting a tag. Falling back per field keeps the good half of such a row,
 * where falling back per row would discard a currency the club really did
 * choose because its locale had rotted.
 *
 * A persisted value that does not validate is treated as absent rather than
 * trusted, for the reason `resolveClubTimeZone` states: the only ways to get one
 * there are database surgery and an ICU change, and in both cases falling
 * through to the environment and then to the documented default keeps the app
 * answering.
 *
 * Pure, so the precedence itself is unit-testable without a database.
 */
export function resolveClubFormat(
  persisted: ClubFormatCandidate | null | undefined,
  environment: ClubFormatCandidate | null | undefined,
): ClubFormat {
  return {
    currencyCode:
      normaliseClubCurrencyCode(persisted?.currencyCode) ??
      normaliseClubCurrencyCode(environment?.currencyCode) ??
      CLUB_CURRENCY_FALLBACK,
    locale:
      normaliseClubLocale(persisted?.locale) ??
      normaliseClubLocale(environment?.locale) ??
      CLUB_LOCALE_FALLBACK,
  };
}

/**
 * Every currency code this runtime can offer, for a selector's options.
 *
 * `Intl.supportedValuesOf` is the right source HERE and the wrong one for
 * validation (module doc). Filtered through the same shape rule so the two can
 * never disagree about a value the operator is shown, sorted so the list reads
 * the same on every runtime, and unioned with `CLUB_CURRENCY_FALLBACK` so the
 * documented default is always offerable even on a runtime whose list omits it.
 */
export function listSelectableClubCurrencyCodes(): string[] {
  const offered = new Set<string>([CLUB_CURRENCY_FALLBACK]);
  try {
    for (const code of Intl.supportedValuesOf("currency")) {
      if (hasCurrencyCodeShape(code)) offered.add(code.toUpperCase());
    }
  } catch {
    // A runtime without supportedValuesOf still offers the documented default.
  }
  return [...offered].sort((left, right) => left.localeCompare(right, "en"));
}

/**
 * The locale has NO equivalent list, and that is a fact about the platform
 * rather than an omission here: `Intl.supportedValuesOf` has no `"locale"` key
 * and ECMA-402 exposes no way to enumerate the tags a runtime knows —
 * `supportedLocalesOf` filters candidates you already hold. So the admin surface
 * takes a validated free-text tag with worked examples rather than a select,
 * and this constant is what those examples are.
 *
 * They are examples for a form, not a supported-locale list, and nothing may
 * treat them as one: a club whose tag is absent here types it and it is
 * accepted, exactly as `normaliseClubLocale` describes.
 */
export const CLUB_LOCALE_EXAMPLES: readonly string[] = [
  "en-NZ",
  "en-AU",
  "en-GB",
  "en-US",
  "en-CA",
  "fr-CA",
  "de-CH",
  "fr-CH",
  "it-CH",
  "de-AT",
  "nb-NO",
  "ja-JP",
];
