import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

/**
 * #5149 (A-L1 of the maintainers' comment
 * https://github.com/thatskiff33/AlpineClubBookingsNZ/pull/5149#issuecomment-6952444211):
 * `workPartyCorrection` asks `getBookingEditPolicy` for its officer-only
 * "work-party-correction" mode (`INV-MOD-063`), which lifts the in-progress
 * refusal of a promo change and prices a started stay whole. Like its twin
 * `finishedStayCorrection` (`finished-stay-correction-call-sites.test.ts`), it
 * is never a request field, and exactly one path sets it: the batch service,
 * from its `officerWorkPartyCorrection` service argument, through
 * `resolveTargetDates`, which only passes it on.
 *
 * The population is every non-test source file under `src/`, by WALK, so a
 * route, quote or preview that starts passing the flag to show an officer a
 * figure is seen the day its file exists. It reads text: a flag reached
 * through a renamed variable or a spread built elsewhere is not seen, and the
 * policy's own conditions (admin, an active status, no finished stay, no date
 * change) are what hold then.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SERVICE = "src/lib/booking-batch-modification-service.ts";
const POLICY = "src/lib/booking-edit-policy.ts";
const PASS_THROUGH = "src/lib/booking-modify-validation.ts";
const FLAG = /\bworkPartyCorrection\b/;

let walked: string[] | null = null;

/** Walked once per run: every test reads the same population. */
function sourceFiles(): string[] {
  if (walked) return walked;
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        found.push(path.relative(REPO_ROOT, full).split(path.sep).join("/"));
      }
    }
  };
  walk(path.join(REPO_ROOT, "src"));
  walked = found.sort();
  return walked;
}

const read = (relative: string): string =>
  stripComments(fs.readFileSync(path.join(REPO_ROOT, relative), "utf8"));

let naming: string[] | null = null;

/** Every source file naming the flag, outside comments: read once. */
const namingFiles = (): string[] => (naming ??= sourceFiles().filter((file) => FLAG.test(read(file))));

/** A walk of the whole tree can take seconds under load. */
const WALK_TIMEOUT_MS = 60_000;

describe("workPartyCorrection call sites (#5149, INV-MOD-063)", { timeout: CENSUS_TIMEOUT_MS }, () => {
  it("the population is real, so the census is not vacuous", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(500);
    expect(files).toEqual(expect.arrayContaining([SERVICE, POLICY, PASS_THROUGH]));
  }, WALK_TIMEOUT_MS);

  it("is named only by the service that sets it, the pass-through, and the policy that reads it", () => {
    expect(namingFiles()).toEqual([SERVICE, POLICY, PASS_THROUGH].sort());
  }, WALK_TIMEOUT_MS);

  it("the batch service sets it once, from its officer-only service argument", () => {
    const sets = (read(SERVICE).match(/\bworkPartyCorrection:[^\n]*/g) ?? []).map((line) => line.trim());
    expect(sets).toEqual(["workPartyCorrection: Boolean(officerWorkPartyCorrection),"]);
  });

  it("resolveTargetDates only passes it on, defaulted off, to the edit policy", () => {
    const code = read(PASS_THROUGH);
    const resolve = code.slice(
      code.indexOf("export function resolveTargetDates("),
      code.indexOf("}): ResolvedTargetDates {"),
    );
    expect(resolve).toContain("workPartyCorrection = false,");
    expect(code.match(/\bworkPartyCorrection\b/g)).toHaveLength(3);
    expect(code).toMatch(/getBookingEditPolicy\(\{[^}]*\n\s+workPartyCorrection,\n/);
  });

  it("no route reads it from a request: nothing under src/app names it", () => {
    expect(namingFiles().filter((file) => file.startsWith("src/app/"))).toEqual([]);
  }, WALK_TIMEOUT_MS);
});
