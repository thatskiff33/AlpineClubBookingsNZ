/**
 * No API route resolves the club's timezone from the ENVIRONMENT (CT-4, #2870;
 * epic #2988).
 *
 * ## Scope: the WHOLE `src/app/api` tree, admin and member and public alike
 *
 * It started as CT-4a's admin-only scan (`src/app/api/admin/**`, 297 files) and
 * was widened to all 475 when CT-4b migrated the member and public routes. The
 * widening cost one constant and needed no exemption: measured on this tree, the
 * 178 non-admin files carry ZERO violations of any rule below. That matters
 * because CT-4b hand-wrote a behavioural test for four of its fourteen routes
 * and reasoned about the other ten from the shape of the change — and reasoning
 * about a shape is the thing a census can replace with a measurement.
 *
 * ## What this census claims, and what it deliberately does not
 *
 * It claims exactly one thing: no file under `src/app/api/**` reaches a
 * zone-bearing legacy helper — the ones that default their zone to
 * `APP_TIME_ZONE`, which is the container's `TZ`. That is a property of the
 * FILES THEMSELVES, and it is what stops a route added next month copying its
 * neighbour's environment read.
 *
 * IT IS NOT the claim that this layer no longer touches the environment zone at
 * all, and an earlier draft of this docblock said that it was. Measured by
 * transitive import closure over the admin half: **186 of those 297** files
 * still reach a module that imports `APP_TIME_ZONE` from `@/config/operational`,
 * overwhelmingly through `src/lib/date-only.ts` (144 of them) and
 * `src/lib/nzst-date.ts` (22).
 *
 * THAT MEASUREMENT PREDATES #3123, which deleted `src/lib/nzst-date.ts` outright
 * once its last production caller moved — so the 22 is now ZERO and the 186 can
 * only have fallen. It has NOT been re-measured, and the figure is left standing
 * as the prior measurement rather than adjusted by arithmetic nobody checked; the
 * `date-only.ts` leg is what a later lane still has to close. The non-admin half
 * has not been measured that way at all and no claim is made about it here; the
 * wrappers are shared, so expect a similar picture. Those wrappers — the
 * capacity, pricing, guest-stay, consent and email-template layers among them —
 * are group F's work and CT-6 (#2991) retires the module that remains. Saying so is not a caveat for form's sake:
 * `docs/CLUB_TIME_KERNEL.md` warns specifically against a guard whose headline
 * is "false and green", and a layer-wide claim backed by a file-level scan would
 * be exactly that.
 *
 * The per-route tests prove that the migrated handlers answer with the club's
 * PERSISTED zone. This proves the negative that no route test can: that the
 * route nobody wrote a test for did not reach for the environment either.
 *
 * ## What is forbidden here, and what deliberately is not
 *
 * The legacy module `@/lib/date-only` is a compatibility adapter over
 * `@/lib/club-time` (CT-2, #2990) — the last one, since #3123 deleted the
 * rendering adapter beside it — and its helpers split cleanly in two:
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
 * ## The Xero skip is an allowlist, and it is now a PREFIX
 *
 * `SKIPPED_PATH_PREFIX` is not a scoping rule, whatever it looks like: it is a
 * named exemption for the CT-5 lane (#2869), and it exempts those files from
 * EVERY check here, not only from the two zone-bearing helpers that motivated
 * it. `startOfDateOnlyForTimeZone` and `endOfDateOnlyForTimeZone` are the two:
 * both callers live under `src/app/api/admin/xero/`, both belong to CT-5, and
 * naming them in the banned set instead would hand the sibling lane a test that
 * goes red the moment it fixes them. CT-6 closes the set.
 *
 * It USED to be a plain substring over the whole repo-relative path, and its own
 * assertion warned that any directory whose path merely contained `/xero/`, at
 * any depth under any parent, was silently exempt too. Widening the scan turned
 * that warning into a live case: `src/app/api/cron/xero/route.ts` and
 * `src/app/api/webhooks/xero/route.ts` would have inherited a blanket skip they
 * were never granted. Both are clean under every rule here, so the fix is to
 * narrow the exemption rather than bless them — it is now the exact prefix
 * `src/app/api/admin/xero/`, and the assertion below pins that those two files
 * are scanned. If CT-5 ever needs one of them exempt, that is a deliberate line
 * to add here, not something a substring should grant by accident.
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
const API_DIR = path.join(ROOT, "src", "app", "api");

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
};

/*
  THE SIX `formatNZ*` ROWS ARE GONE, and their absence is the point. They named
  the exports of `src/lib/nzst-date.ts`, the club's second rendering seam, which
  #3123 DELETED once its last production caller moved (CT-6, #2991). A row here
  refuses a NAMED IMPORT; an export of a module that no longer exists cannot be
  imported at all, so keeping one would be a rule that can never fire, reading as
  coverage it does not provide. Rendering now has one seam, `@/lib/club-time`,
  and what keeps it that way is the `toLocale*` arms in `eslint.config.mjs` plus
  the census in `src/lib/club-time/__tests__/club-time-kernel-census.test.ts`,
  which also asserts the deleted file has not come back.
*/

/**
 * The legacy adapter module, by file basename rather than by import specifier,
 * so a relative path reaches the same verdict as the `@/lib/...` alias. Checked
 * against the tree: `src/lib/date-only.ts` is the only file with that name, so
 * the basename identifies the module.
 *
 * ONE LEFT. `nzst-date` sat beside it until #3123 deleted `src/lib/nzst-date.ts`.
 */
const LEGACY_MODULE_BASENAMES = new Set(["date-only"]);

/** The CT-5 exemption. See the docblock — this is an allowlist, not a scope. */
const SKIPPED_PATH_PREFIX = "src/app/api/admin/xero/";

/** Repo-relative, forward-slashed, so one spelling is compared everywhere. */
function repoPath(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

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

const FILES = sourceFiles(API_DIR);
const SKIPPED = FILES.filter((file) => repoPath(file).startsWith(SKIPPED_PATH_PREFIX));

describe("API temporal convergence (CT-4, #2870)", () => {
  it("finds the whole API source tree, member and public routes included", () => {
    // A census whose scan returns nothing passes every assertion below while
    // proving none of them. Pin files this tree certainly contains — and pin one
    // from EACH half, because the scan being silently narrowed back to
    // `src/app/api/admin` is the specific regression that would make CT-4b's ten
    // untested routes unguarded again without anything going red.
    expect(FILES.length).toBeGreaterThan(400);
    const paths = FILES.map(repoPath);
    expect(paths).toContain("src/app/api/admin/bookings/route.ts");
    expect(paths).toContain("src/app/api/bookings/[id]/modify-quote/route.ts");
    expect(paths).toContain("src/app/api/booking-requests/whole-lodge/route.ts");
    expect(paths).toContain("src/app/api/profile/route.ts");
  });

  it("exempts the CT-5 directory and nothing that merely looks like it", () => {
    // The exemption is a prefix, not a substring, and this is what that buys.
    // Both of these contain `/xero/` and neither belongs to the CT-5 lane, so
    // both must be SCANNED. Under the old substring rule they were exempt from
    // every check in this file the moment the scan widened past `admin`.
    const paths = FILES.map(repoPath);
    const scanned = paths.filter((rel) => !rel.startsWith(SKIPPED_PATH_PREFIX));
    expect(scanned).toContain("src/app/api/cron/xero/route.ts");
    expect(scanned).toContain("src/app/api/webhooks/xero/route.ts");

    // And it really is exempting something, so the rule is live rather than
    // vestigial — a skip list that matched nothing would pass by matching
    // nothing at all.
    expect(SKIPPED.length).toBeGreaterThan(0);
    expect(SKIPPED.every((file) => repoPath(file).startsWith(SKIPPED_PATH_PREFIX))).toBe(
      true,
    );
    expect(FILES.length - SKIPPED.length).toBeGreaterThan(400);
  });

  it("reads no club timezone from the environment", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const rel = repoPath(file);
      // CT-5 (#2869) owns the admin Xero area, and its two remaining callers of
      // the day-boundary pair live there. Not this lane's to move.
      if (rel.startsWith(SKIPPED_PATH_PREFIX)) continue;
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
      "INV-CONFIG-002 (docs/invariants/product-configuration.md): an API route " +
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
        legacyImportedNames('import { formatDateOnlyForTimeZone } from "@/lib/date-only";'),
      ).toEqual(["formatDateOnlyForTimeZone"]);
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
          'import { formatDateOnlyForTimeZone } from "../../../../lib/date-only";',
        ),
      ).toEqual(["formatDateOnlyForTimeZone"]);
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
          'const { getTodayDateOnly } = await import("@/lib/date-only");',
        ),
      ).toHaveLength(1);
      expect(
        opaqueLegacyModuleReads('await import("@/lib/club-time/server");'),
      ).toEqual([]);
    });
  });
});
