// Every hut-leader coverage reader goes through ONE helper (#3818,
// `INV-DATE-030`, `INV-SSOT-001`).
//
// "Is lodge night D covered?" is answered by `src/lib/hut-leader-night-cover.ts`:
// an assignment must claim the night AND its leader must be staying. Before
// #3818 the answer was the assignment's dates alone, written out in four
// places, and a leader who left on Wednesday morning still covered Wednesday
// night everywhere at once. A reader that goes back to dates alone reopens that
// hole silently, so this census fails it.
//
// It reads the tree from disk, so `pnpm run test:related` cannot reach it — run
// it by name (`pnpm run test:named`) when a file starts reading hut-leader
// assignments.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { describe, expect, it } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";

const HELPER_MODULE = "src/lib/hut-leader-night-cover.ts";

/**
 * The coverage readers, each with the helper entry points it must call. A new
 * coverage surface is added here; it may not read assignment dates itself.
 */
const COVERAGE_READERS: ReadonlyArray<{ file: string; entries: readonly RegExp[] }> = [
  { file: "src/lib/hut-leader-coverage.ts", entries: [/\bloadHutLeaderNightCover\s*\(/] },
  {
    file: "src/lib/cron-hut-leader-auto-assign.ts",
    // The cheap probe over the window, and the locked per-night re-ask.
    entries: [/\bloadHutLeaderNightCover\s*\(/, /\bisHutLeaderNightCovered\s*\(\s*tx\b/],
  },
  {
    file: "src/app/api/admin/hut-leaders/eligible-members/route.ts",
    entries: [/\bloadHutLeaderNightCover\s*\(/],
  },
  {
    file: "src/app/api/admin/hut-leaders/unassigned-dates/route.ts",
    entries: [/\bloadHutLeaderNightCover\s*\(/, /\bgetUnassignedHutLeaderDates\s*\(/],
  },
  {
    file: "src/app/(admin)/admin/dashboard/page.tsx",
    entries: [/\bgetHutLeaderDashboardCoverage\s*\(/],
  },
  { file: "src/lib/admin-pending-counts.ts", entries: [/\bgetUnassignedHutLeaderDates\s*\(/] },
  {
    file: "src/lib/stuck-state-dashboard.ts",
    // A `typeof getUnassignedHutLeaderDates` deps type names the function
    // without calling it, so the CALL through deps and the import of the real
    // one are both required.
    entries: [
      /\bdeps\.getUnassignedHutLeaderDates\s*\(/,
      /import\s*\{[^}]*\bgetUnassignedHutLeaderDates\b[^}]*\}\s*from\s*"@\/lib\/hut-leader-coverage"/,
    ],
  },
];

/**
 * The exported coverage functions in `hut-leader-coverage.ts`. Each one's OWN
 * body must take its answer from the cover, so a sibling in the same file
 * calling the helper cannot stand in for it (#3818 review: the file-level check
 * alone stayed green with `getUnassignedHutLeaderDates` back on dates alone).
 */
const COVERAGE_FUNCTIONS: ReadonlyArray<{ name: string; mustContain: readonly RegExp[] }> = [
  {
    name: "getUnassignedHutLeaderDates",
    mustContain: [/\bloadHutLeaderNightCover\s*\(/, /\bcover\.isCovered\s*\(/],
  },
  {
    name: "getHutLeaderDashboardCoverage",
    mustContain: [/\bloadHutLeaderNightCover\s*\(/, /\bgetUnassignedHutLeaderDates\s*\(/],
  },
];

/**
 * DENY BY DEFAULT. A file outside the helper that reads `hutLeaderAssignment`
 * and bounds BOTH `startDate` and `endDate` anywhere in it (in any order, with
 * any operator, inline or in a where built elsewhere in the file), or compares
 * an assignment's dates in memory, is asking "does an assignment include this
 * date?". That is allowed only here, with the reason it is not coverage. A
 * stale entry fails below, so the list only shrinks.
 */
const NOT_COVERAGE: Readonly<Record<string, string>> = {
  "src/lib/hut-leader.ts":
    "isHutLeader is a role check for a member on a date (access, #3817's lane), not whether a night has a leader.",
  "src/lib/lodge-display-state.ts":
    "the lobby wall names tonight's CUSTODIANS (bedId not null); a bed hold is presence by INV-LIFE-062, which the helper also treats as present.",
  "src/lib/kiosk-access.ts":
    "the kiosk's sign-in window for an assigned leader: an access credential, not coverage.",
  "src/lib/lodge-auth.ts": "lodge sign-in for an assigned leader: an access window, not coverage.",
  "src/lib/lodge-pin-session.ts":
    "a leader's PIN session validity window: an access window, not coverage.",
  "src/lib/member-dietary.ts":
    "who may read a party's dietary notes (the assigned leader): an access window, not coverage.",
  "src/lib/hut-leader-overlap-guard.ts":
    "whether a NEW assignment's span overlaps an existing one: a write refusal, deliberately presence-blind (#2887).",
  "src/lib/custodian-occupancy.ts":
    "a custodian's bed hold as bed occupancy (INV-LIFE-062): which beds are taken, not whether a night has a leader.",
  "src/lib/custodian-assignment.ts":
    "expands a custodian's bed hold into the nights its bed is held (INV-LIFE-062): bed occupancy, not coverage.",
  "src/app/api/admin/hut-leaders/route.ts":
    "validates a submitted assignment's own range (start on or before end): input checking, not coverage.",
  "src/app/(admin)/admin/hut-leaders/page.tsx":
    "the assignments table's 'Active' badge says whether a ROW's dates span today; the page's coverage comes from the server's cover (coveredNights / unassigned-dates).",
};

/** A read on the assignment delegate (writes are not coverage questions). */
const ASSIGNMENT_READ =
  /hutLeaderAssignment\s*\??\.\s*(?:findMany|findFirst|findFirstOrThrow|findUnique|findUniqueOrThrow|count|aggregate|groupBy)\s*\(/;
/** A Prisma bound on each date column, any operator. */
const START_BOUND = /\bstartDate\s*:\s*\{\s*(?:lte|lt|gte|gt|equals)\b/;
const END_BOUND = /\bendDate\s*:\s*\{\s*(?:lte|lt|gte|gt|equals)\b/;
/**
 * The in-memory form of the same question: an assignment's `startDate`
 * compared with `<` / `<=` (with or without `.getTime()`), the mirror `>=` /
 * `>` against it, or date-fns `isWithinInterval`.
 */
const IN_MEMORY_PREDICATE =
  /\.startDate(?:\.getTime\(\))?\s*<=?|>=?\s*[\w.]+\.startDate\b|\bisWithinInterval\b/;

function trackedSources(): string[] {
  const listing = execFileSync("git", ["ls-files", "-z", "src"], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return listing
    .split("\0")
    .filter(Boolean)
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => /\.(ts|tsx)$/.test(file))
    .filter((file) => !file.includes("__tests__/") && !/\.test\.tsx?$/.test(file))
    .sort();
}

function read(file: string): string {
  return stripComments(fs.readFileSync(file, "utf8"));
}

/** The text of one exported function, up to the next top-level export. */
function exportedFunctionBody(source: string, name: string): string | null {
  const match = new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`).exec(source);
  if (!match) return null;
  const rest = source.slice(match.index + match[0].length);
  const next = rest.search(/\nexport\s/);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Why a file trips the deny-by-default rule (empty when it does not). */
function coverageShapedReasons(source: string): string[] {
  const reasons: string[] = [];
  if (ASSIGNMENT_READ.test(source) && START_BOUND.test(source) && END_BOUND.test(source)) {
    reasons.push("a hutLeaderAssignment read with both startDate and endDate bounded");
  }
  if (/hutLeader/i.test(source) && IN_MEMORY_PREDICATE.test(source)) {
    reasons.push("an in-memory assignment date-range predicate");
  }
  return reasons;
}

describe("hut-leader coverage census (#3818, INV-DATE-030)", () => {
  it("every registered coverage reader calls the one helper", () => {
    const missing = COVERAGE_READERS.flatMap(({ file, entries }) => {
      const source = read(file);
      return entries
        .filter((entry) => !entry.test(source))
        .map((entry) => `${file} (expected ${entry.source})`);
    });
    expect(
      missing,
      "INV-DATE-030: a hut-leader coverage reader must answer through src/lib/hut-leader-night-cover.ts",
    ).toEqual([]);
  });

  it("no registered coverage reader reads hutLeaderAssignment itself", () => {
    const direct = [...new Set(COVERAGE_READERS.map(({ file }) => file))].filter((file) =>
      ASSIGNMENT_READ.test(read(file)),
    );
    expect(
      direct,
      "INV-DATE-030: a coverage reader takes assignments from the cover, never from its own hutLeaderAssignment read",
    ).toEqual([]);
  });

  it("each coverage function in hut-leader-coverage.ts answers from the cover in its own body", () => {
    const source = read("src/lib/hut-leader-coverage.ts");
    const missing = COVERAGE_FUNCTIONS.flatMap(({ name, mustContain }) => {
      const body = exportedFunctionBody(source, name);
      if (body === null) return [`${name}: not found`];
      return mustContain
        .filter((pattern) => !pattern.test(body))
        .map((pattern) => `${name} (expected ${pattern.source})`);
    });
    expect(missing, "INV-DATE-030: answer through the cover, not through a sibling").toEqual([]);
  });

  it("no other file reads an assignment's dates as coverage", () => {
    const offenders: string[] = [];
    for (const file of trackedSources()) {
      if (file === HELPER_MODULE || NOT_COVERAGE[file]) continue;
      for (const reason of coverageShapedReasons(read(file))) {
        offenders.push(`${file}: ${reason}`);
      }
    }
    expect(
      offenders,
      "INV-DATE-030: 'is night D covered?' needs presence as well as dates — call " +
        "isHutLeaderNightCovered / loadHutLeaderNightCover, or, if this is not a " +
        "coverage question, add the file to NOT_COVERAGE with the reason.",
    ).toEqual([]);
  });

  it("every NOT_COVERAGE entry still holds the shape it excuses", () => {
    const stale = Object.keys(NOT_COVERAGE).filter(
      (file) => !fs.existsSync(file) || coverageShapedReasons(read(file)).length === 0,
    );
    expect(stale, "remove a NOT_COVERAGE entry whose file no longer reads assignment dates").toEqual(
      [],
    );
  });

  it("the school writer still stamps the checkout day the helper derives teacher presence from", () => {
    // `isSchoolRowPresentOnNight` reads a SCHOOL_BOOKING row's nights as
    // [startDate, endDate) BECAUSE the school writer stamps request.checkIn ..
    // request.checkOut. If the writer changes (lane C, #3819), change the
    // helper's school branch in the same PR.
    const source = read("src/lib/school-booking-request.ts");
    expect(source).toMatch(
      /hutLeaderAssignment\.create\(\{[\s\S]{0,200}?startDate:\s*request\.checkIn,\s*endDate:\s*request\.checkOut,[\s\S]{0,600}?source:\s*HutLeaderAssignmentSource\.SCHOOL_BOOKING/,
    );
  });
});
