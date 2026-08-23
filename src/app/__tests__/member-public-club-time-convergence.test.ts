/**
 * No member, lodge, finance or public PAGE resolves the club's timezone from
 * the ENVIRONMENT (CT-4 group E, #2870; epic #2988; INV-CONFIG-002).
 *
 * ## What this census claims, and what it deliberately does not
 *
 * It claims one thing about one directory: no file under `src/app/**` outside
 * `api/` and `(admin)/` reaches a zone-bearing legacy helper, or pins an
 * `Intl.DateTimeFormat` to `APP_TIME_ZONE` — except the files named on
 * {@link AWAITING_CLIENT_ZONE_BOUNDARY}, each with the reason it is still there.
 * That is a property of these files, and it is what stops the next page copying
 * its neighbour's environment read.
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
 * banned outright rather than documented. Still open, and the same accepted
 * class the neighbouring `no-restricted-imports` rule writes down: a specifier
 * built by concatenation, a re-export chain that launders a helper under a new
 * name, `require()`, and a tsconfig path alias other than `@/`. Only removing
 * the modules closes those, which is CT-6's job.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

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
 * Files that still reach the environment for the club's civil time, and why
 * each one could not be finished in this group.
 *
 * EVERY ENTRY IS THE SAME BLOCKER, and it is structural rather than a matter of
 * effort. Each is a `"use client"` component that needs the club's zone IN THE
 * BROWSER — because what it renders is a real instant (`createdAt`, an expiry, a
 * "last updated" stamp) or because it derives the club's "today" for a date
 * input's bound. A browser cannot read `ClubTimeSettings`, so the zone has to
 * arrive as data through the shared client boundary that CT-4 group C (#3057)
 * builds in `src/components/**`. That component does not exist on this branch:
 * it is a sibling group's file, off-limits to this one, and unmerged at the time
 * this lane was cut.
 *
 * Inventing a second delivery mechanism here would be the exact thing rule 6 of
 * this issue forbids — a page designing its own timezone plumbing — and every
 * line of it would be deleted when the shared one lands. So these files are
 * named and left, rather than half-migrated into a shape somebody has to undo.
 *
 * **THE BLOCKER HAS SINCE CLEARED, AND THESE ROWS ARE NOW ACTIONABLE.** Group C
 * landed on the integration branch while this lane was building: `ClubTimeProvider`
 * exists, `AppProviders` and `WebsiteChrome` mount it for every route group, and
 * `useClubTime()` is reachable from all fourteen files below. Each is now a small,
 * mechanical change — swap the legacy helper for the hook's binding, delete the
 * row — and none of them needs a decision. What they still need is a lane, and
 * the honest thing is that this file is the list of what is left rather than a
 * claim that nothing is.
 *
 * `/display` is the one surface that is NOT on this list despite being outside
 * the shared boundary, and the reason is that it is outside it BY DESIGN: it is
 * an unattended kiosk with no route-group chrome, so its server page resolves the
 * zone and hands it down as a prop. See `src/app/display/page.tsx`.
 *
 * TO REMOVE A ROW: migrate the file onto the shared client boundary, then delete
 * its entry. The list is asserted for exact equality, so it cannot grow by
 * accident and cannot silently keep a row for a file that no longer needs one.
 */
const AWAITING_CLIENT_ZONE_BOUNDARY: Record<string, string> = {
  "src/app/(authenticated)/bookings/_components/my-exception-requests.tsx":
    "renders `createdAt`, `reviewedAt` and `lastConflictAt` — three real instants — in a client list.",
  "src/app/(authenticated)/lodge-instructions/page.tsx":
    'a `"use client"` PAGE whose "last updated" stamp is a real instant; it has no server parent to take a prop from.',
  "src/app/(authenticated)/profile/account-credit-section.tsx":
    "renders each credit transaction's `createdAt`, fetched into the browser after mount.",
  "src/app/(authenticated)/profile/membership-cancellation-panel.tsx":
    "renders the cancellation request's `submittedAt`, a real instant.",
  "src/app/(authenticated)/profile/profile-form.tsx":
    "derives the club's today for the date-of-birth field's bound.",
  "src/app/(finance)/finance/_components/finance-dashboard-client.tsx":
    "derives the club's today to seed the finance range pickers.",
  "src/app/(lodge)/lodge/kiosk/page.tsx":
    'a `"use client"` PAGE that derives the club\'s today AND ticks it over at the club-day rollover; it also holds the last `APP_TIME_ZONE` formatter in this tree.',
  "src/app/(public)/pay/[token]/page.tsx":
    'a `"use client"` PAGE showing when the payment link expires — a real instant on a public token page.',
  "src/app/(website-dynamic)/booking-requests/booking-request-form.tsx":
    "derives the club's today for the earliest selectable lodge night.",
  "src/app/(website-dynamic)/booking-requests/respond/[token]/booking-request-respond-client.tsx":
    "renders the offer's `expiresAt` beside a live countdown.",
  "src/app/(website-dynamic)/hut-leader-instructions/hut-leader-instructions-client.tsx":
    'renders the instructions\' "last updated" stamp, a real instant.',
  "src/app/(website-dynamic)/join/[code]/group-join-page-client.tsx":
    "renders the group's `joinDeadline`, a real instant.",
  "src/app/(website-dynamic)/join/[code]/member-group-join-panel.tsx":
    "renders the same `joinDeadline` for a signed-in member.",
  "src/app/(website-dynamic)/school-bookings/school-booking-form.tsx":
    "derives the club's today for the earliest selectable stay date.",
};

function relative(absolute: string): string {
  return path.relative(ROOT, absolute).split(path.sep).join("/");
}

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

  it("names only files that exist, and only ones that really still need it", () => {
    /*
      A row for a deleted or renamed file makes this census inspect nothing while
      still passing, which is the failure mode the group C mount census met and
      wrote down. And a row for a file that has already been migrated is a
      standing permission nobody needs: it would let a future edit reintroduce
      the environment read with no test going red.
    */
    const stale: string[] = [];
    const unnecessary: string[] = [];
    for (const rel of Object.keys(AWAITING_CLIENT_ZONE_BOUNDARY)) {
      const absolute = path.join(ROOT, rel);
      if (!fs.existsSync(absolute)) {
        stale.push(rel);
        continue;
      }
      const source = fs.readFileSync(absolute, "utf8");
      const stillNeedsIt =
        importsEnvironmentZone(source) ||
        legacyImportedNames(source).some((name) => name in ENVIRONMENT_ZONE_HELPERS);
      if (!stillNeedsIt) unnecessary.push(rel);
    }

    expect(
      stale,
      "AWAITING_CLIENT_ZONE_BOUNDARY names files that do not exist. Point the " +
        "row at wherever the surface moved to, or remove it — a row for a " +
        "missing file exempts nothing and hides that fact.",
    ).toEqual([]);

    expect(
      unnecessary,
      "These files no longer read the club's timezone from the environment, so " +
        "their exemption is now a standing permission for a defect nobody is " +
        "committing. Delete the rows.",
    ).toEqual([]);

    // The list is live rather than vestigial. When it finally empties, delete
    // this expectation along with it — that is the day CT-4 group E is done.
    expect(Object.keys(AWAITING_CLIENT_ZONE_BOUNDARY).length).toBeGreaterThan(0);
  });

  it("reads no club timezone from the environment", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const rel = relative(file);
      if (rel in AWAITING_CLIENT_ZONE_BOUNDARY) continue;
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
