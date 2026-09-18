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
 * fourteen files, each with its own docblock of why the pair must stay a pair.
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
 * ## This suite is unreachable by `vitest related`
 *
 * It reads `src/` from disk, so it has no import edge to the files it scans.
 * Run it BY NAME (`npm run test:named`), and note that a missing path is a
 * failure here rather than a silent skip (#3120).
 */

const ROOT = path.resolve(__dirname, "../../..");

/** The one home. A second file matching either pattern below is the defect. */
const HOME = "src/lib/club-time/format.ts";

const DECODER_CALL = /\bcalendarDateOfSerialisedDbDate(?:OrNull)?\s*\(/;
const FORMATTER_CALL = /\bformatClubDate\s*\(/;
const HELPER_DECLARATION =
  /\b(?:function\s+formatStayDate(?:OrNull)?\s*\(|(?:const|let|var)\s+formatStayDate(?:OrNull)?\s*[=:])/;
const HELPER_IMPORT = /\bformatStayDate(?:OrNull)?\b/;

/** True when `source` (comments already stripped) composes the pair itself. */
export function composesStayDateInline(source: string): boolean {
  return DECODER_CALL.test(source) && FORMATTER_CALL.test(source);
}

/** True when `source` declares its own `formatStayDate`-named helper. */
export function declaresLocalStayDateHelper(source: string): boolean {
  return HELPER_DECLARATION.test(source);
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
      "These files compose `calendarDateOfSerialisedDbDate` with `formatClubDate` " +
        "themselves. Import `formatStayDate` (or `formatStayDateOrNull` in a client " +
        "render) from `@/lib/club-time` instead — the one home for the rule, whose " +
        "docblock carries why (INV-DATE-010; INV-SSOT-001; #3507).",
    ).toEqual([]);
  });

  it("refuses a second helper declared under the kernel's name", () => {
    const offenders = files.filter(
      (rel) => rel !== HOME && declaresLocalStayDateHelper(read(rel)),
    );
    expect(
      offenders,
      "These files declare their own `formatStayDate`. The kernel exports one from " +
        "`@/lib/club-time`; import it rather than shadowing it (INV-SSOT-001; #3507).",
    ).toEqual([]);
  });
});
