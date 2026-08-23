/**
 * No admin API route resolves the club's timezone from the ENVIRONMENT (CT-4a,
 * #2870; epic #2988).
 *
 * ## What this census claims, and what it deliberately does not
 *
 * It claims exactly one thing: no file under `src/app/api/admin/**` reaches a
 * zone-bearing legacy helper — the ones that default their zone to
 * `APP_TIME_ZONE`, which is the container's `TZ`. That is a property of the
 * FILES IN THIS DIRECTORY, and it is what stops a route added next month
 * copying its neighbour's environment read.
 *
 * IT IS NOT the claim that this layer no longer touches the environment zone at
 * all, and an earlier draft of this docblock said that it was. Measured on this
 * tree by transitive import closure: **186 of the 297** non-test files under
 * `src/app/api/admin/**` still reach a module that imports `APP_TIME_ZONE` from
 * `@/config/operational`, overwhelmingly through `src/lib/date-only.ts` (144 of
 * them) and `src/lib/nzst-date.ts` (22). Those wrappers — the capacity, pricing,
 * guest-stay, consent and email-template layers among them — are group F's work
 * and CT-6 (#2991) retires the modules themselves. Saying so here is not a
 * caveat for form's sake: `docs/CLUB_TIME_KERNEL.md` warns specifically against
 * a guard whose headline is "false and green", and a layer-wide claim backed by
 * a directory-wide scan would be exactly that.
 *
 * The per-route tests in this directory prove that the migrated handlers answer
 * with the club's PERSISTED zone. This proves the negative that no route test
 * can: that the fourteenth route, the one nobody wrote a test for, did not reach
 * for the environment either.
 *
 * ## What is forbidden here, and what deliberately is not
 *
 * The legacy modules `@/lib/date-only` and `@/lib/nzst-date` are compatibility
 * adapters over `@/lib/club-time` (CT-2, #2990), and they split cleanly in two:
 *
 * - **Zone-bearing.** Every helper in {@link ENVIRONMENT_ZONE_HELPERS} defaults
 *   its zone to `APP_TIME_ZONE`, which is `process.env.TZ` / `NEXT_PUBLIC_TZ`.
 *   That is the environment's opinion, not the club's, and `INV-CONFIG-002` says
 *   the persisted `ClubTimeSettings.timeZone` is the only authority. Banned in
 *   this tree.
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
 *
 * ## The `/xero/` skip is an allowlist, and a coarse one
 *
 * `SKIPPED_PATH_SUBSTRING` is not a scoping rule, whatever it looks like: it is
 * a named exemption for the CT-5 lane, and it exempts those files from EVERY
 * check here, not only from the two helpers that motivated it. It is also a
 * plain substring test over the whole repo-relative path, so any future
 * directory whose path happens to contain `/xero/` — at any depth, under any
 * parent — is silently exempt too. That is more than it needs to be. It is
 * written this way because the alternative on offer was a per-file allowlist
 * that the sibling lane would turn red by doing its job. What is asserted below
 * is the boundary rather than the count: every skipped file must live under
 * `src/app/api/admin/xero/`, so the substring cannot start exempting some other
 * directory that happens to contain it. A count would be tighter still and is
 * deliberately not used — it would go red the moment CT-5 adds a Xero route,
 * which is not a regression.
 *
 * ## Reaching the legacy adapters by named import only
 *
 * A census that reads import bindings can only see the bindings. Five shapes
 * bypassed the first version of this scanner, verified by injecting each into a
 * real route: `import * as ns from`, `await import(...)`, a relative specifier,
 * a single-quoted specifier, and `export { … } from`. All five have zero
 * occurrences in this tree today, so all five are now closed rather than
 * documented — three by widening the reader (either quote, `import` or
 * `export`, any specifier resolving to the module), and two by banning the
 * shapes outright, since a namespace or dynamic import hides WHICH helpers a
 * file reads and there is no reason to write one here.
 *
 * WHAT IS STILL OPEN, so nobody reads this as total. A specifier built by
 * string concatenation; a re-export chain that launders a banned helper through
 * a third module under a new name; `require()`; and a tsconfig path alias other
 * than `@/`. Each needs a resolver rather than a reader, which is the same
 * accepted class the neighbouring `no-restricted-imports` rule writes down as a
 * "KNOWN LIMITATION (accepted)". CT-6 removes the modules, which is the only
 * thing that closes them all.
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

/**
 * The legacy adapter modules, by file basename rather than by import specifier,
 * so a relative path reaches the same verdict as the `@/lib/...` alias. Checked
 * against the tree: `src/lib/date-only.ts` and `src/lib/nzst-date.ts` are the
 * only files with these names, so the basename identifies the module.
 */
const LEGACY_MODULE_BASENAMES = new Set(["date-only", "nzst-date"]);

/** The CT-5 exemption. See the docblock — this is an allowlist, not a scope. */
const SKIPPED_PATH_SUBSTRING = "/xero/";

/** True when this module specifier resolves to one of the legacy adapters. */
function isLegacyModuleSpecifier(specifier: string): boolean {
  const withoutExtension = specifier.replace(/\.(?:ts|tsx|js|mjs|cjs)$/, "");
  const lastSegment = withoutExtension.split("/").pop() ?? "";
  return LEGACY_MODULE_BASENAMES.has(lastSegment);
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

/**
 * Named bindings this file takes from the legacy adapter modules.
 *
 * Covers `import { … } from` and `export { … } from`, either quote style, the
 * `type` modifier, and any specifier resolving to the module — the aliased
 * `@/lib/date-only` and a relative `../../../lib/date-only` alike.
 */
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

/**
 * Reads of a legacy adapter that HIDE which helpers are being read: a namespace
 * import, and a dynamic `import(...)`. Both are banned outright in this tree —
 * see the docblock. Returns a description of each, or an empty array.
 */
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

const FILES = sourceFiles(ADMIN_API_DIR);
const SKIPPED = FILES.filter((file) =>
  path.relative(ROOT, file).split(path.sep).join("/").includes(SKIPPED_PATH_SUBSTRING),
);

describe("admin API temporal convergence (CT-4a, #2870)", () => {
  it("finds the admin API source tree at all", () => {
    // A census whose scan returns nothing passes every assertion below while
    // proving none of them. Pin a file this tree certainly contains.
    expect(FILES.length).toBeGreaterThan(100);
    expect(
      FILES.some((file) => file.endsWith(path.join("bookings", "route.ts"))),
    ).toBe(true);
  });

  it("exempts nothing outside the one directory the exemption is for", () => {
    // The exemption is coarse by design (see the docblock): a plain substring
    // over the whole repo-relative path, so `/xero/` at ANY depth under ANY
    // parent is exempt. The CT-5 lane owns exactly one directory, so that is
    // the boundary asserted here. A count would be tighter still, but it would
    // also go red the moment the sibling lane adds a Xero route, which is not a
    // regression and not this test's business.
    const outsideTheXeroArea = SKIPPED.map((file) =>
      path.relative(ROOT, file).split(path.sep).join("/"),
    ).filter((rel) => !rel.startsWith("src/app/api/admin/xero/"));
    expect(
      outsideTheXeroArea,
      "The `/xero/` exemption is a substring test, so a new directory whose " +
        "path merely contains it inherits a blanket skip of every check in this " +
        "file. Narrow the rule, or move the directory.",
    ).toEqual([]);
    // And it really is exempting something, so the rule is live rather than
    // vestigial — a skip list that matched nothing would pass the check above
    // by matching nothing at all.
    expect(SKIPPED.length).toBeGreaterThan(0);
    expect(FILES.length - SKIPPED.length).toBeGreaterThan(250);
  });

  it("reads no club timezone from the environment", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      // CT-5 (#2869) owns every provider-facing file, and its two remaining
      // callers of the day-boundary pair live here. Not this lane's to move.
      if (rel.includes(SKIPPED_PATH_SUBSTRING)) continue;
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

  /*
    Every assertion above is "the tree contains nothing", which a scanner that
    recognised nothing would pass perfectly. These drive the reader over the
    shapes a real route uses, and over the five that were MEASURED to walk past
    the first version of it — by injecting each into a live route file and
    watching the census stay green.
  */
  describe("the reader itself", () => {
    it("reads a multi-line named import", () => {
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
    });

    it("reads a single-line named import", () => {
      expect(
        legacyImportedNames('import { formatNZDate } from "@/lib/nzst-date";'),
      ).toEqual(["formatNZDate"]);
    });

    it("sees through a rename", () => {
      expect(
        legacyImportedNames(
          'import { getTodayDateOnly as today } from "@/lib/date-only";',
        ),
        "A renamed import is the same read wearing a different name, and it is " +
          "how a census matching call sites instead of import bindings would be " +
          "walked past.",
      ).toEqual(["getTodayDateOnly"]);
    });

    it("does not fire on an import from somewhere else", () => {
      expect(legacyImportedNames('import { formatCents } from "@/lib/utils";')).toEqual(
        [],
      );
      // A module whose name merely CONTAINS a legacy basename is not one.
      expect(
        legacyImportedNames(
          'import { getTodayDateOnly } from "@/lib/date-only-helpers";',
        ),
      ).toEqual([]);
    });

    // BYPASS 1: a single-quoted specifier.
    it("reads a single-quoted specifier", () => {
      expect(
        legacyImportedNames("import { getTodayDateOnly } from '@/lib/date-only';"),
      ).toEqual(["getTodayDateOnly"]);
    });

    // BYPASS 2: a relative path instead of the `@/` alias.
    it("reads a relative specifier", () => {
      expect(
        legacyImportedNames(
          'import { formatNZDate } from "../../../../lib/nzst-date";',
        ),
      ).toEqual(["formatNZDate"]);
      expect(
        legacyImportedNames(
          'import { getTodayDateOnly } from "../../../../lib/date-only.ts";',
        ),
      ).toEqual(["getTodayDateOnly"]);
    });

    // BYPASS 3: `export { … } from`, which re-exports the same read.
    it("reads a re-export", () => {
      expect(
        legacyImportedNames(
          'export { todayDateOnlyForTimeZone } from "@/lib/date-only";',
        ),
      ).toEqual(["todayDateOnlyForTimeZone"]);
    });

    // BYPASS 4: a namespace import, which binds no names to read.
    it("refuses a namespace import of a legacy adapter", () => {
      expect(
        opaqueLegacyModuleReads('import * as dates from "@/lib/date-only";'),
      ).toHaveLength(1);
      expect(
        opaqueLegacyModuleReads('import * as ok from "@/lib/club-time";'),
      ).toEqual([]);
    });

    // BYPASS 5: a dynamic import, which binds no names either.
    it("refuses a dynamic import of a legacy adapter", () => {
      expect(
        opaqueLegacyModuleReads(
          'const { getTodayDateOnly } = await import("@/lib/nzst-date");',
        ),
      ).toHaveLength(1);
      expect(
        opaqueLegacyModuleReads('await import("@/lib/club-time/server");'),
      ).toEqual([]);
    });
  });
});
