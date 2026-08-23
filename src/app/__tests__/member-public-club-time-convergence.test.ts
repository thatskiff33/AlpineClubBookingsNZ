/**
 * No member, lodge, finance or public PAGE resolves the club's timezone from
 * the ENVIRONMENT (CT-4 group E, #2870; epic #2988; INV-CONFIG-002).
 *
 * ## What this census claims, and what it deliberately does not
 *
 * It claims one thing about one directory, and it now claims it WITH NO
 * EXCEPTIONS: no file under `src/app/**` outside `api/` and `(admin)/` reaches a
 * zone-bearing legacy helper, or pins an `Intl.DateTimeFormat` to
 * `APP_TIME_ZONE`. That is a property of these files, and it is what stops the
 * next page copying its neighbour's environment read.
 *
 * ## There used to be an exemption list here, and it is deliberately GONE
 *
 * `AWAITING_CLIENT_ZONE_BOUNDARY` named fourteen `"use client"` files that
 * needed the club's zone IN THE BROWSER at a time when the shared client
 * boundary did not exist on this branch: CT-4 group C (#3057) was unmerged, and
 * inventing a second delivery mechanism in a page would have been the one thing
 * rule 6 of #2870 forbids. Group C then landed, `ClubTimeProvider` became
 * reachable from all fourteen, and they were migrated — twelve onto
 * `useClubTime()` for a real instant or the club's today, and two onto the
 * calendar-date formatters, having turned out to render nothing but `@db.Date`
 * days and therefore to need no zone at all.
 *
 * The empty map is not kept as a placeholder, and the reason is the one this
 * epic keeps re-learning: a skip-list with no entries is an exemption mechanism
 * standing open, and every assertion that reads it passes by inspecting nothing.
 * The claim above is now unconditional. A future lane that genuinely needs an
 * exemption has to write the mechanism back, in a diff a reviewer can see.
 *
 * IT IS NOT the claim that these surfaces no longer touch the environment zone
 * at all. Measured by transitive import closure on this branch, most of them
 * still reach `APP_TIME_ZONE` through a `src/lib` wrapper — the capacity,
 * pricing, consent and calendar layers among them — which is group F's work and
 * which CT-6 (#2991) finishes by retiring the modules. `docs/CLUB_TIME_KERNEL.md`
 * warns specifically against a guard whose headline is "false and green", and a
 * layer-wide claim backed by a directory scan would be exactly that.
 *
 * The behavioural suites beside this one prove that the migrated pages ANSWER
 * with the club's persisted zone (`dashboard-club-time-zone.test.tsx`,
 * `display/__tests__/display-club-time.test.tsx`) and that a lodge night renders
 * as the day it is stored as on a club west of Greenwich
 * (`member-surfaces-calendar-dates.test.tsx`). This proves the negative that no
 * per-page test can: that the page nobody wrote a test for did not reach for the
 * environment either.
 *
 * ## The zone-FREE half of `date-only.ts` is not banned, and that is deliberate
 *
 * `formatDateOnly`, `parseDateOnly`, `addDaysDateOnly`, `eachDateOnlyInRange`
 * and their siblings take and imply no zone at all: they are the UTC encoding of
 * a calendar day, which `date-only.ts` is the sanctioned home for (#2684,
 * `INV-DATE-019`). None of them can be wrong about a club's civil time. Renaming
 * those call sites ahead of CT-6 would also BLIND
 * `date-only-encoding-guard.test.ts`, whose scanner keys on the encoder names —
 * the same reasoning group A recorded for the admin API.
 *
 * ## Reaching a legacy adapter by named import only
 *
 * This reader sees named `import`/`export … from` clauses, either quote style,
 * the `type` modifier and a rename, and it resolves a specifier by BASENAME so a
 * relative path reaches the same verdict as the `@/lib/...` alias. A namespace
 * import and a dynamic `import()` hide WHICH helpers a file reads, so both are
 * banned outright rather than documented — for `@/config/operational` as well as
 * for the two legacy adapters, which is a gap this census carried until the
 * #2870 fix round: the headline said "WITH NO EXCEPTIONS", and
 * `import * as ops from "@/config/operational"` walked straight past it.
 *
 * Still open, and the same accepted class the neighbouring
 * `no-restricted-imports` rule writes down: a specifier built by concatenation,
 * a re-export chain that launders a helper under a new name, `require()`, and a
 * tsconfig path alias other than `@/`. Only removing the modules closes those,
 * which is CT-6's job.
 *
 * ## The three zone reads that reach no module at all
 *
 * An import census cannot see a page that never imports anything: it can read
 * `process.env.TZ` itself, ask `Intl` for the VIEWER's zone, or simply type
 * `"Pacific/Auckland"` into a formatter. All three produce exactly the defect
 * this group fixed, and all three used to pass here.
 *
 * The middle one is the load-bearing addition, because nothing else in the
 * repository catches it. `INV-DATE-015`'s lint arm fires on an
 * `Intl.DateTimeFormat` with a MISSING `timeZone` key, and
 * `timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone` has one. And a
 * behavioural test cannot reliably catch it either: on CI `TZ` is unset, so the
 * host resolves `UTC`, which makes a formatter pinned to `"UTC"` and a formatter
 * pinned to the runtime's own zone render **identically**. Measured on this
 * branch before the guard existed: that mutant killed 0 of 530 tests in the
 * related set at `TZ=UTC`, and 0 with `TZ` unset.
 *
 * `timeZone: "UTC"` is the one literal allowed, and it is not an exception: a
 * calendar day is encoded at UTC midnight, so pinning `UTC` over it is provably
 * the identity rather than a projection (`formatCalendarDateShape` in
 * `@/lib/club-time`). Any OTHER literal names one club and is wrong for the rest.
 *
 * These three are scanned over the file with COMMENTS STRIPPED, for the reason
 * `importsEnvironmentZone` gives below: half the migrated files in this tree
 * name the thing they no longer do, and a census that could not tell an
 * explanation from a call would force every explanation to be deleted.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { stripComments } from "../../../scripts/ci/check-website-render-modes.mjs";

const ROOT = process.cwd();
const APP_DIR = path.join(ROOT, "src", "app");

/** The two directories other CT-4 groups own. */
const OTHER_GROUPS = ["src/app/api/", "src/app/(admin)/"];

/**
 * Helpers whose answer depends on a timezone, and which resolve that timezone
 * from the environment rather than from `ClubTimeSettings`.
 *
 * A server page replaces these with `clubTime()` / `clubTimeZone()` from
 * `@/lib/club-time/server`. A client component receives the zone as DATA and
 * binds it — or, far more often, discovers that what it holds is a calendar day
 * and needs no zone at all.
 */
const ENVIRONMENT_ZONE_HELPERS: Record<string, string> = {
  getTodayDateOnly: "use `dateOnlyInstantOf((await clubTime()).today())`",
  todayDateOnlyForTimeZone: "use `(await clubTime()).today()`",
  formatDateOnlyForTimeZone: "use `(await clubTime()).calendarDateOf(instant)`",
  normalizeDateOnlyForTimeZone:
    "a `@db.Date` value is ALREADY the normalised calendar day — read it with `calendarDateOfDateOnlyInstant`, do not round-trip it through a zone",
  startOfDateOnlyForTimeZone: "use `(await clubTime()).startOfDay(date)`",
  endOfDateOnlyForTimeZone:
    "use `(await clubTime()).endOfDayExclusive(date)`, minus a millisecond if the filter is inclusive",
  formatNZDate:
    "use `formatClubDate(calendarDateOfDateOnlyInstant(v))` for a lodge night, `instantDate(v)` for a moment",
  formatNZDateTime: "use `(await clubTime()).instantDateTime(instant)`",
  formatNZLongDate: "use `formatClubLongDate` / `instantLongDate`",
  formatNZTime: "use `(await clubTime()).instantTime(instant)`",
  formatNZMonthYear: "use `(await clubTime()).instantMonthYear(instant)`",
  formatNZWeekdayDate: "use `formatClubWeekdayDate` / `instantWeekdayDate`",
};

/** The legacy adapter modules, identified by basename. */
const LEGACY_MODULE_BASENAMES = new Set(["date-only", "nzst-date"]);

/**
 * Modules whose zone-bearing exports must be reached by NAME or not at all.
 *
 * `operational` joins the two adapters because `APP_TIME_ZONE` lives there: a
 * namespace import of it hides an environment read exactly as effectively as a
 * namespace import of `nzst-date` hides `formatNZDate`.
 */
const OPAQUE_READ_BASENAMES = new Set([
  ...LEGACY_MODULE_BASENAMES,
  "operational",
]);

/**
 * Zone reads that reach no module, and therefore no import census.
 *
 * Each is checked against the source with comments stripped. See the module doc
 * for why `resolvedOptions` is the one that nothing else in this repository
 * catches.
 */
const AMBIENT_ZONE_READS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly describe: string;
}> = [
  {
    pattern: /process\.env\.(?:TZ|NEXT_PUBLIC_TZ)/,
    describe:
      "reads `process.env.TZ` / `NEXT_PUBLIC_TZ`: that is the CONTAINER's zone, " +
      "which is the club's only by accident. A server page takes the club's zone " +
      "from `clubTime()`; a client component receives it as data",
  },
  {
    pattern: /resolvedOptions\s*\(\s*\)/,
    describe:
      "reads the VIEWER's own clock through " +
      "`Intl.DateTimeFormat().resolvedOptions()`. A member in London and a member " +
      "in Ohakune must see the same club time (INV-CONFIG-002), and nothing else " +
      "catches this: the lint arm fires on a MISSING `timeZone` key, and this " +
      "spelling has one",
  },
];

/** `timeZone: "..."` options, and the one value that is not a club's zone. */
const PINNED_ZONE_LITERAL = /timeZone\s*:\s*["']([^"']+)["']/g;
const ZONE_FREE_PIN = "UTC";

function relative(absolute: string): string {
  return path.relative(ROOT, absolute).split(path.sep).join("/");
}

function basenameOf(specifier: string): string {
  return specifier.replace(/\.(?:ts|tsx|js|mjs|cjs)$/, "").split("/").pop() ?? "";
}

function isLegacyModuleSpecifier(specifier: string): boolean {
  return LEGACY_MODULE_BASENAMES.has(basenameOf(specifier));
}

function isOpaqueReadSpecifier(specifier: string): boolean {
  return OPAQUE_READ_BASENAMES.has(basenameOf(specifier));
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      found.push(...sourceFiles(full));
      continue;
    }
    if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

/** Named bindings this file takes from the legacy adapter modules. */
function legacyImportedNames(source: string): string[] {
  const names: string[] = [];
  const clause =
    /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(clause)) {
    if (!isLegacyModuleSpecifier(match[2])) continue;
    for (const raw of match[1].split(",")) {
      const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
  }
  return names;
}

/** Reads of a legacy adapter that hide WHICH helpers are being read. */
function opaqueLegacyModuleReads(source: string): string[] {
  const found: string[] = [];
  const namespace =
    /import\s+(?:type\s+)?\*\s*as\s+(\w+)\s*from\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(namespace)) {
    if (isLegacyModuleSpecifier(match[2])) {
      found.push(`namespace import \`* as ${match[1]}\` of "${match[2]}"`);
    }
  }
  const dynamic = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(dynamic)) {
    if (isLegacyModuleSpecifier(match[1])) {
      found.push(`dynamic \`import("${match[1]}")\``);
    }
  }
  return found;
}

/**
 * True when this file IMPORTS `APP_TIME_ZONE` — the container's `TZ`.
 *
 * Deliberately the import rather than any mention of the identifier: half the
 * migrated files in this tree name it in a comment explaining what they no
 * longer do, and a census that could not tell those apart would force every one
 * of those explanations to be deleted.
 */
function importsEnvironmentZone(source: string): boolean {
  const clause = /import\s+\{([^}]*)\}\s*from\s*["'][^"']*config\/operational["']/g;
  for (const match of source.matchAll(clause)) {
    if (/\bAPP_TIME_ZONE\b/.test(match[1])) return true;
  }
  return false;
}

const FILES = sourceFiles(APP_DIR).filter((file) => {
  const rel = relative(file);
  return !OTHER_GROUPS.some((prefix) => rel.startsWith(prefix));
});

describe("member/lodge/finance/public page temporal convergence (CT-4 group E, #2870)", () => {
  it("finds the page tree at all", () => {
    // A census whose scan returns nothing passes every assertion below while
    // proving none of them. Pin files this tree certainly contains, in three
    // different route groups, so a walker that lost a subtree is visible too.
    expect(FILES.length).toBeGreaterThan(80);
    const found = new Set(FILES.map(relative));
    expect(found.has("src/app/(authenticated)/dashboard/page.tsx")).toBe(true);
    expect(found.has("src/app/(lodge)/lodge/kiosk/page.tsx")).toBe(true);
    expect(found.has("src/app/display/display-screen.tsx")).toBe(true);
  });

  it("reads no club timezone from the environment", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const rel = relative(file);
      const source = fs.readFileSync(file, "utf8");

      for (const name of legacyImportedNames(source)) {
        const fix = ENVIRONMENT_ZONE_HELPERS[name];
        if (fix) offenders.push(`${rel} — ${name}: ${fix}`);
      }
      for (const shape of opaqueLegacyModuleReads(source)) {
        offenders.push(
          `${rel} — ${shape}: import the names you need, so this census can see ` +
            "which helpers the file reads",
        );
      }
      if (importsEnvironmentZone(source)) {
        offenders.push(
          `${rel} — imports APP_TIME_ZONE: a formatter pinned to the container's ` +
            "`TZ` is the club's zone only by accident. A CALENDAR DAY takes no " +
            'zone (pin `"UTC"` over the UTC-midnight encoding, which is provably ' +
            "the identity); an INSTANT takes the club's, from `clubTime()` on the " +
            "server or a bound zone delivered as data on the client.",
        );
      }
    }

    expect(
      offenders,
      "INV-CONFIG-002 (docs/invariants/product-configuration.md): a member, " +
        "lodge, finance or public page resolved the club's civil time from " +
        "`APP_TIME_ZONE`, which is the CONTAINER's `TZ`. The club's civil time is " +
        "the persisted `ClubTimeSettings.timeZone`, and the two agree on every " +
        "deployment today — which is exactly why nothing catches this at " +
        "runtime. The zone-FREE date-only encoders (`formatDateOnly` and " +
        "friends) are unaffected and stay where they are.",
    ).toEqual([]);
  });

  /*
    Every assertion above is "the tree contains nothing", which a reader that
    recognised nothing would pass perfectly. These drive it over the shapes a
    real page uses, and over the ones measured to walk past the first version of
    the equivalent census in group A.
  */
  describe("the reader itself", () => {
    it("reads a multi-line named import", () => {
      expect(
        legacyImportedNames(
          ["import {", "  formatDateOnly,", "  getTodayDateOnly,", '} from "@/lib/date-only";'].join("\n"),
        ),
      ).toEqual(["formatDateOnly", "getTodayDateOnly"]);
    });

    it("sees through a rename, a relative specifier and a single quote", () => {
      expect(
        legacyImportedNames(
          "import { getTodayDateOnly as today } from '../../lib/date-only';",
        ),
      ).toEqual(["getTodayDateOnly"]);
    });

    it("sees an `export … from` re-export", () => {
      expect(
        legacyImportedNames('export { formatNZTime } from "@/lib/nzst-date";'),
      ).toEqual(["formatNZTime"]);
    });

    it("catches a namespace import and a dynamic import", () => {
      expect(
        opaqueLegacyModuleReads('import * as dates from "@/lib/date-only";'),
      ).toHaveLength(1);
      expect(
        opaqueLegacyModuleReads('const m = await import("@/lib/nzst-date");'),
      ).toHaveLength(1);
    });

    it("ignores a module that merely looks like one of the adapters", () => {
      expect(
        legacyImportedNames('import { thing } from "@/lib/date-only-helpers";'),
      ).toEqual([]);
      expect(opaqueLegacyModuleReads('import * as x from "@/lib/other";')).toEqual([]);
    });

    it("tells an APP_TIME_ZONE import apart from a comment naming it", () => {
      expect(
        importsEnvironmentZone('import { APP_LOCALE, APP_TIME_ZONE } from "@/config/operational";'),
      ).toBe(true);
      expect(
        importsEnvironmentZone('import { APP_LOCALE } from "@/config/operational";'),
      ).toBe(false);
      expect(
        importsEnvironmentZone("// it used to be pinned to APP_TIME_ZONE, and is not any more"),
      ).toBe(false);
    });
  });
});
