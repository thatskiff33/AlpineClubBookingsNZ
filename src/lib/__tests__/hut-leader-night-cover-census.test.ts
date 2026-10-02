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
 * The coverage readers, each with the helper entry point it must call. A new
 * coverage surface is added here; it may not read assignment dates itself.
 */
const COVERAGE_READERS: ReadonlyArray<{ file: string; entry: RegExp }> = [
  { file: "src/lib/hut-leader-coverage.ts", entry: /\bloadHutLeaderNightCover\s*\(/ },
  { file: "src/lib/cron-hut-leader-auto-assign.ts", entry: /\bisHutLeaderNightCovered\s*\(/ },
  {
    file: "src/app/api/admin/hut-leaders/eligible-members/route.ts",
    entry: /\bloadHutLeaderNightCover\s*\(/,
  },
  {
    file: "src/app/api/admin/hut-leaders/unassigned-dates/route.ts",
    entry: /\bloadHutLeaderNightCover\s*\(/,
  },
  { file: "src/app/(admin)/admin/dashboard/page.tsx", entry: /\bgetUnassignedHutLeaderDates\s*\(/ },
  { file: "src/app/(admin)/admin/dashboard/page.tsx", entry: /\bgetHutLeaderHandovers\s*\(/ },
  { file: "src/lib/admin-pending-counts.ts", entry: /\bgetUnassignedHutLeaderDates\s*\(/ },
  { file: "src/lib/stuck-state-dashboard.ts", entry: /\bgetUnassignedHutLeaderDates\b/ },
];

/**
 * Files that ask "does an assignment include this date?" for a reason that is
 * NOT coverage. Each says why; a stale entry fails below so the list only
 * shrinks.
 */
const NOT_COVERAGE: Readonly<Record<string, string>> = {
  "src/lib/hut-leader.ts":
    "isHutLeader is a role check for a member on a date (access, #3817's lane), not whether a night has a leader.",
  "src/lib/lodge-display-state.ts":
    "the lobby wall names tonight's CUSTODIANS (bedId not null); a bed hold is presence by INV-LIFE-062, which the helper also treats as present.",
};

// A Prisma read on hutLeaderAssignment asking whether ONE date falls inside the
// row: the same identifier on both sides of `startDate lte` / `endDate gte`.
const SINGLE_NIGHT_PROBE =
  /hutLeaderAssignment\s*\.\s*(?:findFirst|findMany|count)\s*\(\s*\{[\s\S]{0,400}?startDate\s*:\s*\{\s*lte\s*:\s*([\w.]+)\s*\}[\s\S]{0,120}?endDate\s*:\s*\{\s*gte\s*:\s*\1\s*\}/g;
// The in-memory form of the same question.
const IN_MEMORY_PREDICATE = /\.startDate\.getTime\(\)\s*<=/g;

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

describe("hut-leader coverage census (#3818, INV-DATE-030)", () => {
  it("every registered coverage reader calls the one helper", () => {
    const missing = COVERAGE_READERS.filter(({ file, entry }) => !entry.test(read(file))).map(
      ({ file, entry }) => `${file} (expected ${entry.source})`,
    );
    expect(
      missing,
      "INV-DATE-030: a hut-leader coverage reader must answer through src/lib/hut-leader-night-cover.ts",
    ).toEqual([]);
  });

  it("no other file reads an assignment's dates as coverage", () => {
    const offenders: string[] = [];
    for (const file of trackedSources()) {
      if (file === HELPER_MODULE || NOT_COVERAGE[file]) continue;
      const source = read(file);
      if (new RegExp(SINGLE_NIGHT_PROBE.source).test(source)) {
        offenders.push(`${file}: a single-night hutLeaderAssignment date probe`);
      }
      if (/hutLeader/i.test(source) && new RegExp(IN_MEMORY_PREDICATE.source).test(source)) {
        offenders.push(`${file}: an in-memory assignment date-range predicate`);
      }
    }
    expect(
      offenders,
      "INV-DATE-030: 'is night D covered?' needs presence as well as dates — call " +
        "isHutLeaderNightCovered / loadHutLeaderNightCover, or, if this is not a " +
        "coverage question, add the file to NOT_COVERAGE with the reason.",
    ).toEqual([]);
  });

  it("every NOT_COVERAGE entry still holds the probe it excuses", () => {
    const stale = Object.keys(NOT_COVERAGE).filter(
      (file) =>
        !fs.existsSync(file) || !new RegExp(SINGLE_NIGHT_PROBE.source).test(read(file)),
    );
    expect(stale, "remove a NOT_COVERAGE entry whose file no longer probes").toEqual([]);
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
