import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stripCommentsAndStrings } from "./support/strip-comments";

/**
 * A file's CODE, with comments and string contents gone.
 *
 * This repository documents a defect at the site it removed it from, so the
 * files that are MOST correct are the ones whose comments quote the banned
 * shape — `e2e/helpers/stay-dates.ts` explains at the top of the file that it
 * used to call `new Date()`. A raw-text scanner fails hardest where the code is
 * cleanest. Strings go with them: a failure message quoting `new Date()` is
 * prose, not a call.
 *
 * The canonical stripper, never a local copy — `INV-SSOT-004`, enforced by the
 * `ssot/no-local-comment-stripper` lint rule, which caught the local copy this
 * file was first written with. A copy that misreads `.replace(/\//g, "_")` as a
 * line comment deletes the rest of that line, and a census whose stripper
 * under-reports goes FALSELY GREEN.
 */
const codeOnly = (file: string): string =>
  stripCommentsAndStrings(source(file));


/**
 * The browser suite must ask the CLUB what day it is, never the machine running
 * it (#3221).
 *
 * The application derives its civil date through `club-time` from the persisted
 * `ClubTimeSettings.timeZone`, and the E2E stack seeds that from
 * `TZ=Pacific/Auckland` (`docker-compose.yml`). The Playwright process runs on
 * the CI runner, whose zone is UTC. For roughly the last twelve hours of every
 * UTC day those two disagree about the date — and on the last day of a month
 * they disagree about the MONTH.
 *
 * `main` went red on exactly that at 2026-08-31T14:30Z (02:30 on 1 September in
 * New Zealand) and was green on the identical commit that morning. It was the
 * fifth clock-rollover incident in this repository (#2426, #2401, #2443, #2479
 * were the unit-test four that bought the frozen clock). The unit suite has been
 * structurally protected since; the browser suite had nothing, which is what this
 * file is.
 *
 * THIS FILE IS THE STRUCTURAL HALF of that rule: the E2E date space has exactly
 * one argument-less `new Date()`, it names the zone it means, and no second way
 * to ask has come back. A source census, because there is no runtime hook that
 * could catch a hand-rolled `new Date()` in a Playwright spec.
 *
 * The BEHAVIOURAL half — what the dates actually come out as when the clock sits
 * in the window that broke `main` — is `e2e-club-day-boundary.test.ts`, which
 * re-imports the date space at that instant under two host zones. Deliberately
 * not restated here (`INV-SSOT`): that one is about what the dates ARE, this one
 * is about where they may be computed.
 *
 * This is a DISK-SCANNING census: it reads `e2e/**` from the filesystem and has
 * no import edge to the files it scans, so `vitest related` can never select it
 * from a diff. Run it by name when a change touches `e2e/`.
 */

const repoRoot = process.cwd();

const source = (file: string): string =>
  fs.readFileSync(path.join(repoRoot, file), "utf8");

/**
 * Every `.ts` file under `e2e/`, repo-relative and slash-separated.
 *
 * Derived from the directory rather than listed, so a spec added tomorrow is
 * covered without anybody remembering to extend a list — the failure mode that
 * makes a census worth less than the confidence it creates.
 */
function e2eSourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.join(repoRoot, dir), {
      withFileTypes: true,
    })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith(".ts")) found.push(rel);
    }
  };
  walk("e2e");
  return found.sort();
}

/**
 * The only places under `e2e/` allowed to read the wall clock, and why.
 *
 * Each one writes an INSTANT to a database row — "when this was marked
 * complete", "when this waitlist offer was made". None of them derives a
 * calendar date, which is the thing that can be a different day at the club than
 * on the runner. Counted, so adding one is a deliberate act with a reason
 * attached rather than a quiet drift.
 */
const CLOCK_READ_ALLOWLIST: ReadonlyArray<{ file: string; count: number }> = [
  // `SiteSetupState.completedAt` — an audit timestamp, never read as a date.
  { file: "e2e/helpers/setup-state.ts", count: 1 },
  // Two `WaitlistEntry.waitlistOfferedAt` instants on seeded cross-lodge offers.
  { file: "e2e/setup/seed-second-lodge.ts", count: 2 },
];

describe("no second way to ask what day it is (#3221)", () => {
  const files = e2eSourceFiles();

  it("finds the e2e sources it is meant to be scanning", () => {
    // A census that silently scanned nothing would be a green light for the very
    // drift it exists to stop, so the sweep proves it found the tree first.
    expect(files.length).toBeGreaterThan(30);
    expect(files).toContain("e2e/helpers/stay-dates.ts");
    expect(files).toContain("e2e/admin-retroactive-booking.spec.ts");
  });

  it("reads the wall clock only where the allowlist says, and only that often", () => {
    const allowed = new Map(
      CLOCK_READ_ALLOWLIST.map((entry) => [entry.file, entry.count]),
    );
    for (const file of files) {
      const hits = (
        codeOnly(file).match(/new Date\(\s*\)/g) ?? []
      ).length;
      expect(
        hits,
        `${file} reads the wall clock ${hits} time(s). Every calendar date in ` +
          `the browser suite must come from the CLUB's day — ` +
          `\`relDateOnly\` / \`E2E_TODAY_NZ\` in prisma/e2e-fixtures.ts. If this ` +
          `really is an INSTANT written to a row rather than a date, add it to ` +
          `CLOCK_READ_ALLOWLIST in this file with the reason (#3221).`,
      ).toBe(allowed.get(file) ?? 0);
    }
  });

  it("keeps the allowlist honest — every entry still exists and still reads", () => {
    // An allowlist that outlives what it excused is how a ban rots into
    // decoration. If a site is refactored away, this fails and the entry goes.
    for (const { file, count } of CLOCK_READ_ALLOWLIST) {
      expect(files, `${file} is allowlisted but is not an e2e source`).toContain(
        file,
      );
      const hits = (
        codeOnly(file).match(/new Date\(\s*\)/g) ?? []
      ).length;
      expect(
        hits,
        `${file} is allowlisted for ${count} clock read(s) but has ${hits}`,
      ).toBe(count);
    }
  });

  it("never reads a date out of a Date in the runner's own zone", () => {
    // `getFullYear`/`getMonth`/`getDate`/`getDay` project an instant onto the
    // HOST's calendar. A lodge night is a club calendar day encoded at UTC
    // midnight, so it is read with the `getUTC*` forms — which is what every
    // remaining site here uses. This is the second half of the same defect: the
    // first is reading the wrong clock, this is reading the right clock in the
    // wrong zone (`INV-DATE-019`).
    const localParts = /\.get(FullYear|Month|Date|Day)\s*\(/;
    for (const file of files) {
      expect(
        codeOnly(file),
        `${file} projects a Date onto the runner's calendar. Use the getUTC* ` +
          `form over a date-only value, or shiftDateOnly / relDateOnly from ` +
          `prisma/e2e-fixtures.ts (#3221).`,
      ).not.toMatch(localParts);
    }
  });

  it("keeps date-only arithmetic in one place", () => {
    // Five copies of "YYYY-MM-DD plus N days" lived under e2e/ before #3221, one
    // of them built on a LOCAL-time Date, which is how the wrong-zone read
    // survived a decade of review. `shiftDateOnly` is the one home (INV-SSOT).
    const handRolled = /setUTCDate\s*\(/;
    for (const file of files) {
      expect(
        codeOnly(file),
        `${file} rolls its own date arithmetic. Import shiftDateOnly from ` +
          `prisma/e2e-fixtures.ts instead (INV-SSOT, #3221).`,
      ).not.toMatch(handRolled);
    }
  });

  it("states the zone it means, rather than inheriting one", () => {
    const fixtures = source("prisma/e2e-fixtures.ts");
    expect(fixtures).toContain('const NZ_TIME_ZONE = "Pacific/Auckland"');
    expect(fixtures).toMatch(/timeZone: NZ_TIME_ZONE/);
    expect(fixtures).toContain("export const E2E_TODAY_NZ = todayDateOnlyNz();");
  });
});
