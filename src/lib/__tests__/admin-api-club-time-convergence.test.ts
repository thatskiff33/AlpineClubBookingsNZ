/**
 * The admin API layer reads the club's timezone from ONE place (CT-4a, #2870;
 * epic #2988).
 *
 * ## Why a census and not just the route tests
 *
 * The per-route tests in this directory prove that thirteen migrated handlers
 * answer with the club's persisted zone. They cannot prove anything about the
 * fourteenth, and "we moved this layer onto the boundary" is a claim about the
 * layer. A new admin route added next month reaches for whatever its neighbour
 * used; if a neighbour still reads the environment, so will it. This is the
 * cheapest thing that keeps the answer true after the lane that made it true has
 * gone.
 *
 * ## What is forbidden here, and what deliberately is not
 *
 * The legacy modules `@/lib/date-only` and `@/lib/nzst-date` are compatibility
 * adapters over `@/lib/club-time` (CT-2, #2990), and they split cleanly in two:
 *
 * - **Zone-bearing.** Every helper below defaults its zone to `APP_TIME_ZONE`,
 *   which is `process.env.TZ` / `NEXT_PUBLIC_TZ`. That is the environment's
 *   opinion, not the club's, and `INV-CONFIG-002` says the persisted
 *   `ClubTimeSettings.timeZone` is the only authority. These are banned in this
 *   tree.
 * - **Zone-free.** `formatDateOnly`, `parseDateOnly`, `isDateOnlyString`,
 *   `addDaysDateOnly`, `eachDateOnlyInRange` and the rest take and imply no zone
 *   at all: they are the UTC encoding of a calendar day, which `date-only.ts` is
 *   the sanctioned home for (#2684, `INV-DATE-019`). Nothing about them is
 *   NZ-specific and none of them can be wrong about a club's civil time, so they
 *   are NOT banned here. CT-6 (#2991) retires the module itself; renaming those
 *   call sites ahead of it would also blind
 *   `date-only-encoding-guard.test.ts`, whose scanner keys on the encoder names.
 *
 * `startOfDateOnlyForTimeZone` and `endOfDateOnlyForTimeZone` are zone-bearing
 * and are deliberately absent from the banned set: two callers remain in this
 * tree, both under `src/app/api/admin/xero/`, and both belong to CT-5 (#2869,
 * pull request #3013) rather than to this lane. Adding them with an allowlist
 * would hand the sibling lane a test that goes red the moment it fixes them,
 * which is a worse failure than the gap. CT-6 closes the set.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const ADMIN_API_DIR = path.join(ROOT, "src", "app", "api", "admin");

/**
 * Helpers whose answer depends on a timezone, and which resolve that timezone
 * from the environment rather than from `ClubTimeSettings`.
 *
 * The replacement in every case is `clubTime()` / `clubTimeZone()` from
 * `@/lib/club-time/server`, which resolves the persisted identifier once per
 * request.
 */
const ENVIRONMENT_ZONE_HELPERS: Record<string, string> = {
  getTodayDateOnly: "use `dateOnlyInstantOf((await clubTime()).today())`",
  todayDateOnlyForTimeZone: "use `(await clubTime()).today()`",
  formatDateOnlyForTimeZone: "use `(await clubTime()).calendarDateOf(instant)`",
  normalizeDateOnlyForTimeZone:
    "a `@db.Date` value is ALREADY the normalised calendar day — read it as one, do not round-trip it through a zone",
  formatNZDate: "use `formatClubDate` for a calendar day, `instantDate` for a moment",
  formatNZDateTime: "use `(await clubTime()).instantDateTime(instant)`",
  formatNZLongDate: "use `formatClubLongDate` / `instantLongDate`",
  formatNZTime: "use `(await clubTime()).instantTime(instant)`",
  formatNZMonthYear: "use `(await clubTime()).instantMonthYear(instant)`",
  formatNZWeekdayDate: "use `(await clubTime()).instantWeekdayDate(instant)`",
};

const LEGACY_MODULES = ["@/lib/date-only", "@/lib/nzst-date"];

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

/** Named imports this file takes from the legacy adapter modules. */
function legacyImportedNames(source: string): string[] {
  const names: string[] = [];
  for (const legacyModule of LEGACY_MODULES) {
    const pattern = new RegExp(
      String.raw`import\s*\{([^}]*)\}\s*from\s*"${legacyModule}"`,
      "g",
    );
    for (const match of source.matchAll(pattern)) {
      for (const raw of match[1].split(",")) {
        const name = raw.trim().split(/\s+as\s+/)[0].trim();
        if (name) names.push(name);
      }
    }
  }
  return names;
}

const FILES = sourceFiles(ADMIN_API_DIR);

describe("admin API temporal convergence (CT-4a, #2870)", () => {
  it("finds the admin API source tree at all", () => {
    // A census whose scan returns nothing passes every assertion below while
    // proving none of them. Pin a file this tree certainly contains.
    expect(FILES.length).toBeGreaterThan(100);
    expect(
      FILES.some((file) => file.endsWith(path.join("bookings", "route.ts"))),
    ).toBe(true);
  });

  it("reads no club timezone from the environment", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      // CT-5 (#2869) owns every provider-facing file, and its two remaining
      // callers of the day-boundary pair live here. Not this lane's to move.
      if (rel.includes("/xero/")) continue;
      for (const name of legacyImportedNames(fs.readFileSync(file, "utf8"))) {
        const fix = ENVIRONMENT_ZONE_HELPERS[name];
        if (fix) offenders.push(`${rel} — ${name}: ${fix}`);
      }
    }

    expect(
      offenders,
      "INV-CONFIG-002 (docs/invariants/product-configuration.md): an admin route " +
        "resolved the club's timezone from `APP_TIME_ZONE`, which is the " +
        "CONTAINER's `TZ`. The club's civil time is the persisted " +
        "`ClubTimeSettings.timeZone`, and the two agree on every deployment " +
        "today — which is exactly why nothing catches this at runtime. Resolve " +
        "the zone with `clubTime()` or `clubTimeZone()` from " +
        "`@/lib/club-time/server` instead. The zone-FREE date-only encoders " +
        "(`formatDateOnly` and friends) are unaffected and stay where they are.",
    ).toEqual([]);
  });

  it("would notice one, on a file shaped like the ones it scans", () => {
    // Every assertion above is "the tree contains nothing", which a scanner that
    // recognised nothing would pass perfectly. Run the same reader over the
    // shapes a real route uses.
    const multiLine = [
      "import {",
      "  formatDateOnly,",
      "  getTodayDateOnly,",
      '} from "@/lib/date-only";',
    ].join("\n");
    expect(legacyImportedNames(multiLine)).toEqual([
      "formatDateOnly",
      "getTodayDateOnly",
    ]);

    const singleLine = 'import { formatNZDate } from "@/lib/nzst-date";';
    expect(legacyImportedNames(singleLine)).toEqual(["formatNZDate"]);

    const renamed = 'import { getTodayDateOnly as today } from "@/lib/date-only";';
    expect(
      legacyImportedNames(renamed),
      "A renamed import is the same read wearing a different name, and it is how " +
        "a census that matched call sites instead of import bindings would be walked past.",
    ).toEqual(["getTodayDateOnly"]);

    // And an import from somewhere else is not a false positive.
    const unrelated = 'import { formatCents } from "@/lib/utils";';
    expect(legacyImportedNames(unrelated)).toEqual([]);
  });
});
