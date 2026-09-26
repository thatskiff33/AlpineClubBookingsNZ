import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CLUB_CURRENCY_CODE_LENGTH,
  CLUB_CURRENCY_FALLBACK,
  CLUB_FORMAT_SETTINGS_ID,
  CLUB_LOCALE_EXAMPLES,
  CLUB_LOCALE_FALLBACK,
  CLUB_LOCALE_MAX_LENGTH,
  isValidClubCurrencyCode,
  isValidClubLocale,
  listSelectableClubCurrencyCodes,
  normaliseClubCurrencyCode,
  normaliseClubLocale,
  resolveClubFormat,
} from "@/lib/club-format";

/**
 * The club's currency and locale validators and fallback chain (#3563, stage 1
 * of programme #3205; INV-CONFIG-006).
 *
 * The three properties worth asserting, and they are the ones the club-timezone
 * precedent had to learn the hard way rather than the obvious ones:
 *
 *  1. Validation does NOT go through `Intl.supportedValuesOf` membership, so a
 *     well-formed code this runtime's ICU has never heard of is still accepted.
 *     That is deliberate and is asserted, not tolerated.
 *  2. The locale probe PARSES rather than NEGOTIATES. A tag the runtime has no
 *     data for must come back as itself, never as the runtime's default.
 *  3. The fallback chain runs per FIELD, so a half-corrupt row keeps its good
 *     half.
 */

describe("normaliseClubCurrencyCode", () => {
  it("accepts and upper-cases a three-letter code", () => {
    expect(normaliseClubCurrencyCode("nzd")).toBe("NZD");
    expect(normaliseClubCurrencyCode("  chf  ")).toBe("CHF");
    expect(normaliseClubCurrencyCode("AUD")).toBe("AUD");
  });

  it("refuses anything that is not three ASCII letters", () => {
    for (const bad of [
      "",
      "   ",
      "$",
      "NZ",
      "NZDX",
      "N1D",
      "dollars",
      "NZ D",
      "NZ-D",
      null,
      undefined,
    ]) {
      expect(normaliseClubCurrencyCode(bad), String(bad)).toBeNull();
    }
  });

  it("accepts a well-formed code this ICU may not know, ON PURPOSE", () => {
    /*
      The module refuses to validate by `Intl.supportedValuesOf("currency")`
      membership, for the reason `club-time-zone.ts` measured for zones: that
      list is whatever the bundled ICU knows, so membership is not stable across
      engines and ISO 4217 keeps issuing codes. The accepted consequence is that
      an unknown-but-well-formed code passes. If this ever starts returning
      null, somebody has swapped the shape rule for a list and a club can now be
      locked out of its own real currency by somebody else's ICU build.
    */
    expect(normaliseClubCurrencyCode("ZZZ")).toBe("ZZZ");
  });

  it("every code the selector offers is one the validator accepts", () => {
    // The two must never disagree about a value an operator is SHOWN, which is
    // the bug a filtered list and an unfiltered validator produce together.
    const offered = listSelectableClubCurrencyCodes();
    expect(offered.length).toBeGreaterThan(20);
    expect(offered).toContain(CLUB_CURRENCY_FALLBACK);
    const rejected = offered.filter((code) => !isValidClubCurrencyCode(code));
    expect(rejected).toEqual([]);
  });

  it("offers a stable, sorted, duplicate-free list", () => {
    const offered = listSelectableClubCurrencyCodes();
    expect([...offered].sort((a, b) => a.localeCompare(b, "en"))).toEqual(
      offered,
    );
    expect(new Set(offered).size).toBe(offered.length);
  });
});

describe("normaliseClubLocale", () => {
  it("accepts and canonicalises a BCP 47 tag", () => {
    expect(normaliseClubLocale("en-NZ")).toBe("en-NZ");
    expect(normaliseClubLocale("  EN-nz ")).toBe("en-NZ");
    expect(normaliseClubLocale("de-ch")).toBe("de-CH");
    expect(normaliseClubLocale("en")).toBe("en");
  });

  it("refuses a tag that is not structurally a language tag", () => {
    for (const bad of [
      "",
      "   ",
      "en_NZ",
      // `getCanonicalLocales` accepts this — RFC 5646 allows a 5-to-8-letter
      // primary subtag for a REGISTERED language, and the parser checks the
      // grammar rather than the registry. It is also the mistake an operator
      // actually types, so the shape rule pins the primary subtag at the two
      // or three letters every ISO 639 code has.
      "English",
      "deutsch",
      // The private-use and grandfathered families, which name no language a
      // club formats in and which the same pin refuses.
      "x-club",
      "i-klingon",
      "en-",
      "-NZ",
      "en NZ",
      "en/NZ",
      "en-NZ-",
      "a".repeat(CLUB_LOCALE_MAX_LENGTH + 1),
      null,
      undefined,
    ]) {
      expect(normaliseClubLocale(bad), String(bad)).toBeNull();
    }
  });

  it("PARSES rather than negotiates: an unsupported tag comes back as itself", () => {
    /*
      THE ASSERTION THIS FILE EXISTS FOR. The obvious probe — building an
      `Intl.DateTimeFormat` and reading `resolvedOptions().locale` — never
      throws for a well-formed tag; it negotiates and reports the locale it fell
      back to. Under that probe a runtime with no data for a tag would store its
      OWN default instead, so a club asking for `mi-NZ` on a slim ICU build
      would silently be recorded as `en-US`. `Intl.getCanonicalLocales` is the
      parser rather than the negotiator, which is why it is what the module
      uses. `qaa` is an ISO 639-2 code reserved for private use, so no runtime
      has data for it and it is the sharpest available probe of the difference.
      It is three letters, so the primary-subtag pin admits it.
    */
    const negotiated = new Intl.NumberFormat("qaa-x-club").resolvedOptions()
      .locale;
    expect(normaliseClubLocale("qaa-x-club")).toBe("qaa-x-club");
    // Non-vacuity: the negotiating probe really would have answered differently.
    expect(negotiated).not.toBe("qaa-x-club");
  });
});

describe("resolveClubFormat", () => {
  const environment = { currencyCode: "AUD", locale: "en-AU" };

  it("prefers a valid persisted value over the environment, per field", () => {
    expect(
      resolveClubFormat({ currencyCode: "CHF", locale: "de-CH" }, environment),
    ).toEqual({ currencyCode: "CHF", locale: "de-CH" });
  });

  it("reads the environment only while nothing is persisted", () => {
    expect(resolveClubFormat(null, environment)).toEqual({
      currencyCode: "AUD",
      locale: "en-AU",
    });
  });

  it("falls back to the shipped defaults when neither answers", () => {
    expect(resolveClubFormat(null, null)).toEqual({
      currencyCode: CLUB_CURRENCY_FALLBACK,
      locale: CLUB_LOCALE_FALLBACK,
    });
    expect(
      resolveClubFormat(
        { currencyCode: "nope", locale: "also nope" },
        { currencyCode: "", locale: null },
      ),
    ).toEqual({
      currencyCode: CLUB_CURRENCY_FALLBACK,
      locale: CLUB_LOCALE_FALLBACK,
      // #3567 re-review: a STORED currency that cannot be used refuses charges.
      unusableStoredCurrency: "NOPE",
    });
  });

  it("displays a fallback for a stored JPY but names it, so charges are refused (#3567 re-review, D3)", () => {
    // Display keeps rendering — in the environment seed, then NZD — while the
    // stored code travels on the format for stripeChargeCurrency to refuse.
    expect(resolveClubFormat({ currencyCode: "JPY", locale: "ja-JP" }, environment)).toEqual({
      currencyCode: "AUD",
      locale: "ja-JP",
      unusableStoredCurrency: "JPY",
    });
    expect(resolveClubFormat({ currencyCode: "jpy", locale: "ja-JP" }, null)).toEqual({
      currencyCode: CLUB_CURRENCY_FALLBACK,
      locale: "ja-JP",
      unusableStoredCurrency: "JPY",
    });
    // The environment seed alone never refuses charges: no row, nothing stored.
    expect(resolveClubFormat(null, { currencyCode: "JPY", locale: "ja-JP" })).toEqual({
      currencyCode: CLUB_CURRENCY_FALLBACK,
      locale: "ja-JP",
    });
  });

  it("keeps the good half of a half-corrupt row", () => {
    // A row-level fallback would discard a currency the club really did choose
    // because its locale had rotted — a hand-edit or an ICU that dropped a tag.
    expect(
      resolveClubFormat({ currencyCode: "CHF", locale: "!!" }, environment),
    ).toEqual({ currencyCode: "CHF", locale: "en-AU" });
    expect(
      resolveClubFormat({ currencyCode: "!!", locale: "de-CH" }, environment),
    ).toEqual({ currencyCode: "AUD", locale: "de-CH", unusableStoredCurrency: "!!" });
  });

  it("canonicalises whichever leg answers", () => {
    expect(
      resolveClubFormat(null, { currencyCode: "chf", locale: "DE-ch" }),
    ).toEqual({ currencyCode: "CHF", locale: "de-CH" });
  });
});

describe("the constants the schema and the form both depend on", () => {
  it("pins the singleton id, because four spellings of it fail silently", () => {
    // `create` passes `id` explicitly, so a writer using a different literal
    // creates a SECOND row, the reader still finds nothing at "default", and
    // the club's setting sits orphaned with no error anywhere.
    expect(CLUB_FORMAT_SETTINGS_ID).toBe("default");
  });

  it("pins the column widths the validators bound against", () => {
    // These must match ClubFormatSettings' @db.VarChar(3) / @db.VarChar(64). A
    // validator that accepts more than the column holds turns a bad input into
    // a 500 at the database instead of a plain-English refusal at the form.
    expect(CLUB_CURRENCY_CODE_LENGTH).toBe(3);
    expect(CLUB_LOCALE_MAX_LENGTH).toBe(64);
  });

  it("pins them against the SCHEMA, not just against a literal (#3563 review)", () => {
    /*
      The assertion above says the CONSTANTS are 3 and 64. It does not say the
      COLUMNS are, so narrowing `locale` to VarChar(32) in a later lane would
      keep every test here green while a 40-character tag passed validation and
      failed at the database with P2000 - which is not a contention code, so the
      route rethrows and the admin gets a 500 where the validator exists to give
      a sentence. Reading the schema is what makes the two changeable in one
      place, which is the whole of INV-SSOT.
    */
    const schema = readFileSync(
      path.join(process.cwd(), "prisma/schema.prisma"),
      "utf8",
    );
    const model = /model ClubFormatSettings \{([^]*?)\n\}/.exec(schema);
    expect(
      model,
      "ClubFormatSettings is missing from schema.prisma",
    ).not.toBeNull();
    const body = model![1];
    expect(body).toMatch(
      new RegExp(
        String.raw`currencyCode\s+String\s+@db\.VarChar\(${CLUB_CURRENCY_CODE_LENGTH}\)`,
      ),
    );
    expect(body).toMatch(
      new RegExp(
        String.raw`locale\s+String\s+@db\.VarChar\(${CLUB_LOCALE_MAX_LENGTH}\)`,
      ),
    );
  });
  it("ships shipped defaults that its own validators accept", () => {
    expect(isValidClubCurrencyCode(CLUB_CURRENCY_FALLBACK)).toBe(true);
    expect(isValidClubLocale(CLUB_LOCALE_FALLBACK)).toBe(true);
  });

  it("offers only examples the validator accepts", () => {
    // The form prints these as worked examples. One the validator refuses would
    // teach an operator a spelling that cannot be saved.
    const refused = CLUB_LOCALE_EXAMPLES.filter(
      (tag) => normaliseClubLocale(tag) !== tag,
    );
    expect(refused).toEqual([]);
  });
});
