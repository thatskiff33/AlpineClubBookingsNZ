/**
 * No member, lodge, finance or public PAGE resolves the club's timezone from
 * the ENVIRONMENT (CT-4 group E, #2870; epic #2988; INV-CONFIG-002).
 *
 * ## What this census claims, and what it deliberately does not
 *
 * It claims one thing about one directory, and it now claims it WITH NO
 * EXCEPTIONS: no file under `src/app/**` outside `api/` and `(admin)/` takes the
 * club's civil time from anywhere but the club's own configuration. Four shapes
 * are banned, and each one is a rule the scan really runs — `offendersIn` is the
 * single entry point, and the wiring test at the bottom drives a synthetic
 * offender through it for every one of them:
 *
 *  1. a named import of a zone-bearing legacy helper (`ENVIRONMENT_ZONE_HELPERS`);
 *  2. a namespace or dynamic import that hides which of those — or which of
 *     `@/config/operational`'s exports — a file reads;
 *  3. a named import of `APP_TIME_ZONE` itself;
 *  4. the three reads that reach no module at all: `process.env.TZ`, the
 *     VIEWER's clock via `resolvedOptions()`, and a zone typed in as a literal.
 *
 * That is a property of these files, and it is what stops the next page copying
 * its neighbour's environment read.
 *
 * ## Every claim below is a check that runs, because once they were not
 *
 * This file shipped in the first #2870 round with rules 2 and 4 written out in
 * this docblock, the constants and helpers implementing them declared below, and
 * NOTHING calling them. A page reading `process.env.TZ`, asking `Intl` for the
 * viewer's zone, pinning `"Pacific/Auckland"`, or namespace-importing
 * `@/config/operational` passed a census whose prose said it could not. Nothing
 * failed: an unused module constant is an ESLint warning, and knip does not see
 * a non-exported one. `docs/CLUB_TIME_KERNEL.md` calls that shape "false and
 * green", and this file was an instance of it.
 *
 * So the standing rule for anyone editing this docblock: a sentence here that
 * describes a check must be traceable to a call in `offendersIn`, and the wiring
 * test must drive a positive control through it. Narrow the sentence rather than
 * leave it broad and unbacked.
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
 * for the legacy adapter, which is a gap this census carried until the
 * #2870 fix round: the headline said "WITH NO EXCEPTIONS", and
 * `import * as ops from "@/config/operational"` walked straight past it.
 *
 * Still open, and the accepted class any path-matching import check carries: a
 * specifier built by concatenation, a re-export chain that launders a helper
 * under a new name, `require()`, and a tsconfig path alias other than `@/`.
 * Only removing the modules closes those, which is CT-6's job.
 *
 * There is no `no-restricted-imports` rule covering these three modules today —
 * `eslint.config.mjs`'s only such block is the Xero facade one (#1208), and a
 * lint arm for the club's zone is sequenced for after CT-4's fix lanes land. So
 * this census is the whole of the enforcement, which is why the two opaque
 * shapes are banned outright rather than merely written down.
 *
 * ## The three zone reads that reach no module at all
 *
 * An import census cannot see a page that never imports anything: it can read
 * `process.env.TZ` itself, ask `Intl` for the VIEWER's zone, or simply type
 * `"Pacific/Auckland"` into a formatter. All three produce exactly the defect
 * this group fixed, and all three passed here until the #2870 fix round.
 *
 * The middle one is the load-bearing addition, because no GENERIC guard catches
 * it. `INV-DATE-015`'s lint arm fires on an `Intl.DateTimeFormat` with a MISSING
 * `timeZone` key, and `timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone`
 * has one. A behavioural test catches it only where somebody wrote one that
 * deliberately moves the HOST zone: on CI `TZ` is unset, so the host resolves
 * `UTC`, and a formatter pinned to `"UTC"` and a formatter pinned to the
 * runtime's own zone then render **identically**.
 *
 * Both halves of that were measured in the #2870 fix round, with that exact
 * mutant, `TZ` unset:
 *
 *  • in `display/display-header-clock.tsx`, which HAS such a suite, it killed
 *    3 of the 14 tests in `display/__tests__/display-club-time.test.tsx` —
 *    that suite pins `process.env.TZ` to a third zone on purpose;
 *  • in `(finance)/finance/_components/ratio-explorer.tsx`, which has no
 *    zone-moving suite, it killed 0 of the 5 tests `vitest related` selects
 *    for it, and this census was the only thing in the repository that failed.
 *
 * The second bullet is the case this file exists for, and it is the reason the
 * claim is worth making by census rather than by suite: the page nobody wrote a
 * zone test for.
 *
 * Inside this directory the ban is on the API and not merely on one spelling of
 * it, and that is affordable because nothing here has a legitimate use for it.
 * `resolvedOptions()` has exactly one correct caller in this repository, and it
 * is not a read of the viewer's clock: CT-1's `src/lib/club-time-zone.ts`
 * formats with `{ timeZone: candidate }` — a zone its CALLER supplied — and
 * reads the result back to learn the runtime's canonical name for it, which is
 * how `US/Pacific` becomes `America/Los_Angeles` during the backfill. It lives
 * outside `src/app`, so it is outside this scan by construction rather than by
 * an exemption entry, and a page that ever needs that canonicalisation should
 * call it rather than inline the probe.
 *
 * `ClubTimeProvider` is NOT such a caller, and its docblock says so in terms:
 * the browser never learns the club's zone from its own host. A page under
 * `src/app` takes the zone from `useClubTime()`, whose `BoundClubTime` carries
 * `.zone` — the CLUB's, delivered as data by the server.
 *
 * `timeZone: "UTC"` is the one literal allowed, and it is not an exception: a
 * calendar day is encoded at UTC midnight, so pinning `UTC` over it is provably
 * the identity rather than a projection (`formatCalendarDateShape` in
 * `@/lib/club-time`). Any OTHER literal names one club and is wrong for the rest.
 *
 * ## Comments are stripped first, and what that shares with every other census
 *
 * These three are scanned over `stripComments(source)` — the one shared
 * implementation in `scripts/ci/check-website-render-modes.mjs`, for the reason
 * `importsEnvironmentZone` gives below: twenty-nine of the forty-one files this
 * group migrated name `APP_TIME_ZONE` in a comment explaining what they no
 * longer do, and a census that could not tell an explanation from a call would
 * force every explanation to be deleted. For these three patterns the strip is a
 * PRECAUTION rather than a fix: measured on this branch, no in-scope file
 * mentions any of them even in prose, so stripping changes no verdict today. It
 * is what lets the next migration write the sentence.
 *
 * The shared stripper is a four-state pass, not a parser, and both of its known
 * imprecisions fail SAFE for this census. An apostrophe in JSX text (`It's`)
 * opens a phantom string, so a comment after it survives — a false POSITIVE,
 * which fails loudly and is then corrected. A bare `//` in JSX text opens a
 * phantom line comment, which could hide code later on that same line — a false
 * negative, but only for a shape that would have to be written on one line
 * after unquoted `//` in markup. Neither occurs in this tree, and both the
 * phantom-string behaviour and the `/*`-inside-a-line-comment regression the
 * stripper was rewritten to fix are pinned below, so a change to the shared
 * implementation shows up here rather than silently.
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
};

/*
  THE SIX `formatNZ*` ROWS ARE GONE, and their absence is the point. They named
  the exports of `src/lib/nzst-date.ts`, the club's second rendering seam, which
  #3123 DELETED once its last production caller moved (CT-6, #2991). A helper on
  this map is a named import this census refuses; an export of a module that does
  not exist cannot be imported at all, so a row for one would be a rule that can
  never fire, reading as coverage. The rendering seam is now `@/lib/club-time`
  alone, and the guards that keep it that way are the `toLocale*` arms in
  `eslint.config.mjs` and the `Intl.DateTimeFormat` census in
  `src/lib/club-time/__tests__/club-time-kernel-census.test.ts`, which also
  asserts the deleted file has not come back.
*/

/**
 * The legacy adapter modules, identified by basename.
 *
 * ONE LEFT. `nzst-date` was the other until #3123 deleted `src/lib/nzst-date.ts`;
 * a basename matching no file is a rule that can never fire, so it is removed
 * rather than kept as decoration.
 */
const LEGACY_MODULE_BASENAMES = new Set(["date-only"]);

/**
 * Modules whose zone-bearing exports must be reached by NAME or not at all.
 *
 * `operational` joins the adapter because `APP_TIME_ZONE` lives there: a
 * namespace import of it hides an environment read exactly as effectively as a
 * namespace import of `date-only` hides `getTodayDateOnly`.
 */
const OPAQUE_READ_BASENAMES = new Set([
  ...LEGACY_MODULE_BASENAMES,
  "operational",
]);

/**
 * Two of the three zone reads that reach no module, and therefore no import
 * census. The third is `PINNED_ZONE_LITERAL` below, which needs the matched
 * value rather than a yes/no.
 *
 * Each is checked against the source with comments stripped, through
 * `ambientZoneReads` from `offendersIn`. See the module doc for why
 * `resolvedOptions` is the one no generic guard in this repository catches.
 */
const AMBIENT_ZONE_READS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly describe: string;
}> = [
  {
    pattern: /\bprocess\.env\.(?:TZ|NEXT_PUBLIC_TZ)\b/,
    describe:
      "reads `process.env.TZ` / `NEXT_PUBLIC_TZ`: that is the CONTAINER's zone, " +
      "which is the club's only by accident. A server page takes the club's zone " +
      "from `clubTime()`; a client component receives it as data",
  },
  {
    pattern: /\bresolvedOptions\s*\(\s*\)/,
    describe:
      "reads the VIEWER's own clock through " +
      "`Intl.DateTimeFormat().resolvedOptions()`. A member in London and a member " +
      "in Ohakune must see the same club time (INV-CONFIG-002), and no generic " +
      "guard catches this: the lint arm fires on a MISSING `timeZone` key, and " +
      "this spelling has one. Only a page that happens to own a behavioural " +
      "suite moving the host zone would notice",
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

/**
 * Reads of a zone-bearing module that hide WHICH exports are being read.
 *
 * Keyed on `OPAQUE_READ_BASENAMES`, so `@/config/operational` is covered
 * alongside the adapter: `import * as ops` hides `ops.APP_TIME_ZONE` exactly as
 * effectively as `import * as dates` hides `dates.getTodayDateOnly`, and
 * `importsEnvironmentZone` below can only see a named clause.
 */
function opaqueZoneModuleReads(source: string): string[] {
  const found: string[] = [];
  const namespace =
    /import\s+(?:type\s+)?\*\s*as\s+(\w+)\s*from\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(namespace)) {
    if (isOpaqueReadSpecifier(match[2])) {
      found.push(`namespace import \`* as ${match[1]}\` of "${match[2]}"`);
    }
  }
  const dynamic = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(dynamic)) {
    if (isOpaqueReadSpecifier(match[1])) {
      found.push(`dynamic \`import("${match[1]}")\``);
    }
  }
  return found;
}

/**
 * The ambient zone reads present in this file's CODE.
 *
 * Takes source with comments already stripped — see the module doc. The
 * patterns carry no `g` flag, so `test` is stateless here.
 */
function ambientZoneReads(code: string): string[] {
  return AMBIENT_ZONE_READS.filter((read) => read.pattern.test(code)).map(
    (read) => read.describe,
  );
}

/**
 * Every `timeZone: "…"` literal in this file's CODE except the zone-free pin.
 *
 * `matchAll` rather than `test`/`exec`: `PINNED_ZONE_LITERAL` is a module-scope
 * global regex, and `matchAll` runs a clone rather than advancing its
 * `lastIndex`, so file N+1 cannot be scanned from where file N stopped.
 */
function pinnedClubZoneLiterals(code: string): string[] {
  const found: string[] = [];
  for (const match of code.matchAll(PINNED_ZONE_LITERAL)) {
    if (match[1] !== ZONE_FREE_PIN) found.push(match[1]);
  }
  return found;
}

/**
 * True when this file IMPORTS `APP_TIME_ZONE` — the container's `TZ`.
 *
 * Deliberately the import rather than any mention of the identifier: measured
 * on this branch, twenty-nine of the forty-one files this group migrated name it
 * in a comment explaining what they no longer do, and a census that could not
 * tell those apart would force every one of those explanations to be deleted.
 */
function importsEnvironmentZone(source: string): boolean {
  const clause = /import\s+\{([^}]*)\}\s*from\s*["'][^"']*config\/operational["']/g;
  for (const match of source.matchAll(clause)) {
    if (/\bAPP_TIME_ZONE\b/.test(match[1])) return true;
  }
  return false;
}

/**
 * Every rule this census enforces, applied to ONE file.
 *
 * Deliberately a function rather than a loop body: the wiring test below drives
 * it over a synthetic file for each rule, which is what proves each rule is
 * reachable from the scan instead of merely declared above it. This file has
 * shipped once with three checks written down and never called, and only a
 * positive control routed through the real entry point catches that.
 */
function offendersIn(rel: string, source: string): string[] {
  const offenders: string[] = [];

  for (const name of legacyImportedNames(source)) {
    const fix = ENVIRONMENT_ZONE_HELPERS[name];
    if (fix) offenders.push(`${rel} — ${name}: ${fix}`);
  }
  for (const shape of opaqueZoneModuleReads(source)) {
    offenders.push(
      `${rel} — ${shape}: import the names you need, so this census can see ` +
        "which zone-bearing exports the file reads",
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

  // The three reads that reach no module. Comments are stripped first, so a
  // migrated file may keep the sentence explaining what it no longer does.
  const code = stripComments(source);
  for (const note of ambientZoneReads(code)) {
    offenders.push(`${rel} — ${note}`);
  }
  for (const zone of pinnedClubZoneLiterals(code)) {
    offenders.push(
      `${rel} — pins \`timeZone: "${zone}"\`: that names ONE club, and this ` +
        "repository is the generic product (INV-CONFIG-001). A calendar day " +
        'takes `"UTC"`; an instant takes the club\'s persisted zone, from ' +
        "`clubTime()` on the server or `useClubTime()` in the browser.",
    );
  }

  return offenders;
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

  it("takes no club timezone from the environment, the viewer, or a literal", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      offenders.push(
        ...offendersIn(relative(file), fs.readFileSync(file, "utf8")),
      );
    }

    expect(
      offenders,
      "INV-CONFIG-002 (docs/invariants/product-configuration.md): a member, " +
        "lodge, finance or public page resolved the club's civil time from " +
        "something that is not the club's configuration — the CONTAINER's `TZ` " +
        "(`APP_TIME_ZONE`), the VIEWER's own clock, or a zone typed in as a " +
        "literal. The club's civil time is the persisted " +
        "`ClubTimeSettings.timeZone`. All three agree with it on our own " +
        "deployment today, which is exactly why nothing catches any of them at " +
        "runtime. The zone-FREE date-only encoders (`formatDateOnly` and " +
        'friends) and the `timeZone: "UTC"` pin over a calendar day are ' +
        "unaffected and stay where they are.",
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
        legacyImportedNames(
          'export { todayDateOnlyForTimeZone } from "@/lib/date-only";',
        ),
      ).toEqual(["todayDateOnlyForTimeZone"]);
    });

    it("catches a namespace import and a dynamic import", () => {
      expect(
        opaqueZoneModuleReads('import * as dates from "@/lib/date-only";'),
      ).toHaveLength(1);
      expect(
        opaqueZoneModuleReads('const m = await import("@/lib/date-only");'),
      ).toHaveLength(1);
    });

    it("covers `@/config/operational` with the same two shapes", () => {
      // The gap this census carried until the #2870 fix round: the headline
      // said "WITH NO EXCEPTIONS", `OPAQUE_READ_BASENAMES` was written to close
      // it, and the reader went on consulting the adapters-only set — so
      // `ops.APP_TIME_ZONE` walked straight past a check that named it.
      expect(
        opaqueZoneModuleReads('import * as ops from "@/config/operational";'),
      ).toHaveLength(1);
      expect(
        opaqueZoneModuleReads('const m = await import("@/config/operational");'),
      ).toHaveLength(1);
      expect(
        opaqueZoneModuleReads('import * as ops from "../../config/operational";'),
      ).toHaveLength(1);
    });

    it("ignores a module that merely looks like one of the adapters", () => {
      expect(
        legacyImportedNames('import { thing } from "@/lib/date-only-helpers";'),
      ).toEqual([]);
      expect(opaqueZoneModuleReads('import * as x from "@/lib/other";')).toEqual([]);
      expect(
        opaqueZoneModuleReads('import * as Sentry from "@sentry/nextjs";'),
      ).toEqual([]);
    });

    it("catches the two zone reads that reach no module", () => {
      expect(ambientZoneReads("const zone = process.env.TZ;")).toHaveLength(1);
      expect(
        ambientZoneReads("const zone = process.env.NEXT_PUBLIC_TZ;"),
      ).toHaveLength(1);
      expect(
        ambientZoneReads(
          "const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;",
        ),
      ).toHaveLength(1);
      // The spelling `INV-DATE-015`'s lint arm cannot see, because it HAS a
      // `timeZone` key — it is just the wrong one.
      expect(
        ambientZoneReads(
          'new Intl.DateTimeFormat("en-NZ", { timeZone: Intl.DateTimeFormat().resolvedOptions( ).timeZone })',
        ),
      ).toHaveLength(1);
      expect(ambientZoneReads("const zone = (await clubTime()).zone;")).toEqual([]);
      expect(ambientZoneReads("const url = process.env.NEXTAUTH_URL;")).toEqual([]);
    });

    it("allows the `UTC` pin and no other zone literal", () => {
      expect(
        pinnedClubZoneLiterals('new Intl.DateTimeFormat("en-NZ", { timeZone: "UTC" })'),
      ).toEqual([]);
      expect(
        pinnedClubZoneLiterals('{ timeZone: "Pacific/Auckland" }'),
      ).toEqual(["Pacific/Auckland"]);
      expect(pinnedClubZoneLiterals("{ timeZone : 'Australia/Sydney' }")).toEqual([
        "Australia/Sydney",
      ]);
      // A module-scope `/g` regex read twice: the second call must not resume
      // from where the first one stopped.
      expect(
        pinnedClubZoneLiterals('{ timeZone: "Pacific/Auckland" }'),
      ).toEqual(["Pacific/Auckland"]);
      expect(pinnedClubZoneLiterals("{ timeZone: clubZone }")).toEqual([]);
    });

    it("reads the ambient shapes over code, not over prose explaining them", () => {
      const explaining = [
        '// it used to read process.env.TZ and pin timeZone: "Pacific/Auckland"',
        "const zone = (await clubTime()).zone;",
      ].join("\n");
      // Load-bearing, not decorative: the raw text trips both, the stripped
      // code trips neither.
      expect(ambientZoneReads(explaining)).toHaveLength(1);
      expect(pinnedClubZoneLiterals(explaining)).toEqual(["Pacific/Auckland"]);
      expect(ambientZoneReads(stripComments(explaining))).toEqual([]);
      expect(pinnedClubZoneLiterals(stripComments(explaining))).toEqual([]);
    });

    it("does not let a `/*` inside a line comment swallow the code below it", () => {
      // The measured regression the shared stripper was rewritten to fix: a
      // block-comments-first pass turned `/admin/*` in a LINE comment into an
      // open block that closed 91 lines later, deleting 4,739 of 6,290
      // characters of `(admin)/layout.tsx`. Both halves are asserted — the live
      // code survives, AND the check still fires on it.
      const source = [
        "// the old route was /admin/* and is gone",
        "const zone = process.env.TZ;",
        'const KEEP = "load-bearing";',
      ].join("\n");
      const code = stripComments(source);
      expect(code).toContain('const KEEP = "load-bearing";');
      expect(ambientZoneReads(code)).toHaveLength(1);
    });

    it("pins the phantom-string imprecision, which fails LOUD not silent", () => {
      // An apostrophe in JSX text puts the shared stripper into string mode, so
      // the comment below it survives and this census reports an offender that
      // is only prose. That is the safe direction — a false positive gets
      // corrected, a false negative ships — and it is asserted rather than
      // merely believed, because "fails safe" is a claim about the shared
      // implementation and this file does not own it.
      const odd = ["<p>It's the club clock</p>", "// process.env.TZ"].join("\n");
      expect(stripComments(odd)).toContain("// process.env.TZ");
      expect(ambientZoneReads(stripComments(odd))).toHaveLength(1);

      // A SECOND apostrophe closes the phantom string again, so the same prose
      // written as "the club's own time" strips normally. Pinned because it is
      // the difference between this imprecision biting and not, and reading the
      // stripper is the only way to know that.
      const even = ["<p>It's the club's clock</p>", "// process.env.TZ"].join("\n");
      expect(stripComments(even)).not.toContain("// process.env.TZ");
      expect(ambientZoneReads(stripComments(even))).toEqual([]);
    });

    it("routes every rule through the scan, not just past the declarations", () => {
      // The vacuity floor. `AMBIENT_ZONE_READS`, `PINNED_ZONE_LITERAL`,
      // `ZONE_FREE_PIN`, `isOpaqueReadSpecifier` and `stripComments` were all
      // declared, documented in the module doc as enforced, and never called —
      // so every offending shape below passed this census. A predicate test
      // would not have caught that; only driving the real entry point does.
      const cases: ReadonlyArray<readonly [string, string]> = [
        ["a zone-bearing legacy helper", 'import { getTodayDateOnly } from "@/lib/date-only";'],
        ["a namespace import of an adapter", 'import * as d from "@/lib/date-only";'],
        ["a namespace import of the config module", 'import * as ops from "@/config/operational";'],
        ["a dynamic import of the config module", 'const m = await import("@/config/operational");'],
        ["an APP_TIME_ZONE import", 'import { APP_TIME_ZONE } from "@/config/operational";'],
        ["the container's zone", "const zone = process.env.TZ;"],
        ["the viewer's clock", "const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;"],
        ["a zone literal", 'const f = new Intl.DateTimeFormat("en-NZ", { timeZone: "Pacific/Auckland" });'],
      ];
      for (const [what, source] of cases) {
        expect(offendersIn("src/app/probe.tsx", source), what).toHaveLength(1);
      }

      // And the sanctioned shapes stay silent, so the scan is a census and not
      // a blanket ban on the words.
      expect(
        offendersIn(
          "src/app/probe.tsx",
          [
            'import { formatDateOnly, parseDateOnly } from "@/lib/date-only";',
            'import { APP_LOCALE } from "@/config/operational";',
            'const f = new Intl.DateTimeFormat("en-NZ", { timeZone: "UTC" });',
            "// APP_TIME_ZONE is what this page used to read",
          ].join("\n"),
        ),
      ).toEqual([]);
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
