import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments } from "./support/strip-comments";

/**
 * #3507 — "format a stay date" has ONE home, and this is what keeps it there.
 *
 * ## What it guards
 *
 * A stored lodge night is a `@db.Date`, encoded as UTC midnight. Decoding it
 * through a zone names the day before for any club west of Greenwich (CT-4,
 * #2870; `INV-DATE-010`). The correct decode-then-format pair —
 * `calendarDateOfSerialisedDbDate` then `formatClubDate` — was spelled out in
 * fifteen production files, each with its own docblock of why the pair must
 * stay a pair.
 * `formatStayDate` / `formatStayDateOrNull` in `src/lib/club-time/format.ts`
 * are now the one statement of it (`INV-SSOT-001`), and every one of those
 * files imports it.
 *
 * The composition cannot be made unrepresentable: `calendarDateOfSerialisedDbDate`
 * stays exported because a comparison or a calendar-date VALUE legitimately
 * needs the decoder without the formatter, and `formatClubDate` stays exported
 * because a `CalendarDate` reached any other way still needs formatting. What
 * CAN be refused is the two of them in the same production file — a file that
 * holds both is composing them, however many lines apart — and a second
 * declaration under the helper's own name, which is how the #3498 reopen card
 * grew its local copy.
 *
 * ## Both decoders, and every local spelling of the name (#3511)
 *
 * #3507 matched only the SERIALISED decoder. The same rule was also written as
 * `formatClubDate(calendarDateOfDateOnlyInstant(x))` in about a dozen
 * server-side files, behind seven client-side `formatStayDay` wrappers and a
 * `formatDateOnly`, and in two shared "payload" helpers
 * (`formatPayloadCalendarDay`, `formatMemberCalendarDay`) with a stricter
 * rejection of a time-bearing string. #3511 converged all of them onto
 * `formatStayDate` / `formatStayDateOrNull` ("converge, keep fallbacks": each
 * surface keeps its own `?? fallback`; only a malformed offset-less timestamp
 * changed, and it now reads by its date prefix). `DECODER_CALL` therefore
 * matches BOTH kernel decoders, and `LOCAL_HELPER_DECLARATION` refuses every
 * name those copies went by. A `Date` that must be proved a stored day first
 * (`requireStoredCalendarDay`) goes INTO `formatStayDate`, whose `Instant` arm
 * takes it.
 *
 * The one file that legitimately holds a decoder and no formatter is any file
 * that decodes for a comparison or a value; the one that holds `formatClubDate`
 * and no decoder is any file formatting a `CalendarDate` reached another way.
 * Only holding BOTH is refused.
 *
 * ## This suite is unreachable by `vitest related`
 *
 * It reads `src/` from disk, so it has no import edge to the files it scans.
 * Run it BY NAME (`pnpm run test:named`), and note that a missing path is a
 * failure here rather than a silent skip (#3120).
 */

const ROOT = path.resolve(__dirname, "../../..");

/** The one home. A second file matching either pattern below is the defect. */
const HOME = "src/lib/club-time/format.ts";

const DECODER_CALL =
  /\b(?:calendarDateOfSerialisedDbDate(?:OrNull)?|calendarDateOfDateOnlyInstant)\s*\(/;
const FORMATTER_CALL = /\bformatClubDate\s*\(/;
/**
 * Every name a local copy of the stay-date helper has gone by: the kernel's own
 * name, the seven client `formatStayDay` wrappers, `formatDateOnly`, and the two
 * shared payload helpers #3511 retired.
 */
const LOCAL_HELPER_NAMES =
  "formatStayDate(?:OrNull)?|formatStayDay|formatDateOnly|formatPayloadCalendarDay|formatMemberCalendarDay|calendarDayFromPayload";
const LOCAL_HELPER_DECLARATION = new RegExp(
  `\\b(?:function\\s+(?:${LOCAL_HELPER_NAMES})\\s*\\(|(?:const|let|var)\\s+(?:${LOCAL_HELPER_NAMES})\\s*[=:])`,
);
/**
 * `src/lib/date-only.ts` exports its own, unrelated `formatDateOnly` — the legacy
 * compatibility adapter `date-only-encoding-guard.test.ts` tracks until CT-6
 * retires it. The name is refused everywhere else.
 */
const LEGACY_ADAPTER = "src/lib/date-only.ts";
const HELPER_IMPORT = /\bformatStayDate(?:OrNull)?\b/;

/** True when `source` (comments already stripped) composes the pair itself. */
export function composesStayDateInline(source: string): boolean {
  return DECODER_CALL.test(source) && FORMATTER_CALL.test(source);
}

/** True when `source` declares its own `formatStayDate`-named helper. */
export function declaresLocalStayDateHelper(source: string): boolean {
  return LOCAL_HELPER_DECLARATION.test(source);
}

function isProductionSource(rel: string): boolean {
  return (
    /\.tsx?$/.test(rel) &&
    !/\.(test|spec)\.tsx?$/.test(rel) &&
    !/(^|\/)__tests__\//.test(rel) &&
    !/\.d\.ts$/.test(rel)
  );
}

function trackedProductionFiles(): string[] {
  // `git ls-files` reads the index, so a file this branch added is counted and
  // a generated or ignored file is not — the same instrument the other
  // disk-scanning censuses in this directory use.
  const tracked = execSync("git ls-files src", { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return tracked.filter(isProductionSource);
}

function read(rel: string): string {
  return stripComments(fs.readFileSync(path.join(ROOT, rel), "utf8"));
}

describe("the scanner recognises what it refuses", () => {
  it("counts the nested composition", () => {
    expect(
      composesStayDateInline("return formatClubDate(calendarDateOfSerialisedDbDate(v));"),
    ).toBe(true);
  });

  it("counts the two-step OrNull composition, however far apart the lines are", () => {
    const source = [
      "const day = calendarDateOfSerialisedDbDateOrNull(value);",
      "const other = 1;",
      'return day ? formatClubDate(day) : "—";',
    ].join("\n");
    expect(composesStayDateInline(source)).toBe(true);
  });

  it("does not count the decoder alone — a comparison or a calendar-date value", () => {
    expect(
      composesStayDateInline(
        "compareCalendarDates(calendarDateOfSerialisedDbDate(a), calendarDateOfSerialisedDbDate(b))",
      ),
    ).toBe(false);
  });

  it("does not count the formatter alone over a CalendarDate reached another way", () => {
    expect(composesStayDateInline("formatClubDate(night.date)")).toBe(false);
  });

  it("does not count a different shape over the decoder", () => {
    expect(
      composesStayDateInline("formatClubWeekdayDate(calendarDateOfSerialisedDbDate(v))"),
    ).toBe(false);
  });

  it("is not fooled by prose once comments are stripped", () => {
    const source = stripComments(
      "// callers used to write formatClubDate(calendarDateOfSerialisedDbDate(v))\nexport const x = 1;",
    );
    expect(composesStayDateInline(source)).toBe(false);
  });

  it("counts the Date-form composition too (#3511)", () => {
    expect(
      composesStayDateInline("return formatClubDate(calendarDateOfDateOnlyInstant(value), format);"),
    ).toBe(true);
    const guarded = [
      "const day = calendarDateOfDateOnlyInstant(requireStoredCalendarDay(v, opts));",
      "return formatClubDate(day, format);",
    ].join("\n");
    expect(composesStayDateInline(guarded)).toBe(true);
    expect(composesStayDateInline("countClubNights(a, calendarDateOfDateOnlyInstant(b))")).toBe(false);
  });

  it("counts a local helper under any name a copy went by (#3511)", () => {
    for (const source of [
      "function formatStayDay(value: string, format: ClubDateFormat) {",
      "export function formatStayDay(value: string) {",
      "function formatDateOnly(value: string, format: ClubDateFormat): string {",
      "export function formatPayloadCalendarDay(value, format, fallback) {",
      "export const formatMemberCalendarDay = (value: string) => value;",
      "function calendarDayFromPayload(value: string) {",
    ]) {
      expect(declaresLocalStayDateHelper(source), source).toBe(true);
    }
    expect(declaresLocalStayDateHelper("{formatStayDay(booking.checkIn)}")).toBe(false);
  });

  it("counts a local helper declared under the kernel's name", () => {
    expect(declaresLocalStayDateHelper("function formatStayDate(value: string) {")).toBe(true);
    expect(declaresLocalStayDateHelper("const formatStayDateOrNull = (v) => v;")).toBe(true);
    expect(declaresLocalStayDateHelper("function formatStayDates(rows) {")).toBe(false);
    expect(declaresLocalStayDateHelper("{formatStayDate(booking.checkIn)}")).toBe(false);
  });
});

describe("the home really is the home (#3507)", () => {
  it("exists, and composes the pair", () => {
    expect(fs.existsSync(path.join(ROOT, HOME))).toBe(true);
    const source = read(HOME);
    expect(composesStayDateInline(source)).toBe(true);
    expect(declaresLocalStayDateHelper(source)).toBe(true);
  });

  it("is imported by the surfaces that used to spell the pair out", () => {
    const importers = trackedProductionFiles().filter(
      (rel) => rel !== HOME && HELPER_IMPORT.test(read(rel)),
    );
    // Fifteen production files were converted in #3507 plus the barrel. A
    // count near zero means the scan read the wrong tree, not that the helper
    // fell out of use.
    expect(importers.length).toBeGreaterThanOrEqual(10);
  });
});

describe("INV-SSOT-001: no production file outside the home composes a stay date itself", () => {
  const files = trackedProductionFiles();

  it("found the tree to scan, so an empty census is not a silent pass", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(HOME);
  });

  it("refuses the decode-then-format pair anywhere but the home", () => {
    const offenders = files.filter((rel) => rel !== HOME && composesStayDateInline(read(rel)));
    expect(
      offenders,
      "These files compose a stay-date decoder (`calendarDateOfSerialisedDbDate` or " +
        "`calendarDateOfDateOnlyInstant`) with `formatClubDate` themselves. Import `formatStayDate` (or `formatStayDateOrNull` in a client " +
        "render) from `@/lib/club-time` instead — the one home for the rule, whose " +
        "docblock carries why (INV-DATE-010; INV-SSOT-001; #3507; #3511).",
    ).toEqual([]);
  });

  it("refuses a second helper declared under the kernel's name", () => {
    const offenders = files.filter(
      (rel) => rel !== HOME && rel !== LEGACY_ADAPTER && declaresLocalStayDateHelper(read(rel)),
    );
    expect(
      offenders,
      "These files declare their own stay-date helper (`formatStayDate`, `formatStayDay`, " +
        "`formatDateOnly`, `formatPayloadCalendarDay`, ...). The kernel exports " +
        "`formatStayDate` / `formatStayDateOrNull` from `@/lib/club-time`; import them and " +
        "keep the surface's fallback as `?? fallback` (INV-SSOT-001; #3507; #3511).",
    ).toEqual([]);
  });
});
