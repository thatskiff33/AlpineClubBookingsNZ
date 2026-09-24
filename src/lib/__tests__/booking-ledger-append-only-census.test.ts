import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

// `INV-SSOT-004`: the one comment/string stripper in the tree. A local copy
// that mis-reads a regex literal deletes the rest of the line, and a census
// whose stripper under-reports goes FALSELY GREEN.
import { stripCommentsAndStrings } from "@/lib/__tests__/support/strip-comments";

/**
 * #3580 (programme #3527): THE LEDGER IS APPEND-ONLY, AND THIS IS WHAT HOLDS IT.
 *
 * A `BookingLedgerLine` records something that happened. It is never updated
 * and never deleted; a correction is a new line naming the one it reverses.
 * That rule is what makes the table trustworthy as the source of a booking's
 * money, and it is worth nothing if any module can reach
 * `prisma.bookingLedgerLine.update`.
 *
 * `booking-ledger-write.ts` is therefore the one door, and it exposes creation
 * alone. This census asks the tree two questions a behaviour test cannot:
 *
 *  1. **Who writes the table at all?** Exactly one module. A second writer
 *     fails here with its own file name, whatever it intends.
 *  2. **Does anything anywhere update or delete a line?** Nothing may, not
 *     even the one door — there is no legitimate caller, so the shape is
 *     absent from the tree rather than merely unused.
 *
 * Source is read with comments and strings STRIPPED, because this repository
 * documents a defect at the site it removed it from: the modules that describe
 * an update at length are exactly the ones that must not perform one.
 */

const REPO_ROOT = resolve(__dirname, "../../..");
const SRC = join(REPO_ROOT, "src");
const SCRIPTS = join(REPO_ROOT, "scripts");

/** The one module allowed to write the table. */
const THE_ONE_DOOR = "src/lib/booking-ledger-write.ts";

/** Every mutating spelling of the delegate, as this codebase writes them. */
const WRITE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["create", /\bbookingLedgerLine\s*\.\s*create\b/],
  ["createMany", /\bbookingLedgerLine\s*\.\s*createMany\b/],
  ["createManyAndReturn", /\bbookingLedgerLine\s*\.\s*createManyAndReturn\b/],
  ["update", /\bbookingLedgerLine\s*\.\s*update\b/],
  ["updateMany", /\bbookingLedgerLine\s*\.\s*updateMany\b/],
  ["upsert", /\bbookingLedgerLine\s*\.\s*upsert\b/],
  ["delete", /\bbookingLedgerLine\s*\.\s*delete\b/],
  ["deleteMany", /\bbookingLedgerLine\s*\.\s*deleteMany\b/],
];

/** The spellings that would mutate or remove a posted line. */
const FORBIDDEN_EVERYWHERE = new Set([
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
  "createManyAndReturn",
]);

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (/\.test\.tsx?$/.test(entry.name)) continue;
      found.push(full);
    }
  };
  walk(SRC);
  walk(SCRIPTS);
  return found;
}

type Hit = { file: string; spelling: string };

/**
 * Walked ONCE per file. Each case used to re-read the whole of `src/` and
 * `scripts/`, which put the suite past vitest's 5 s default under parallel
 * load (measured: 4.1 s alone) — the load-sensitive class `docs/TESTING.md`
 * names, and one this census had no reason to be in. The tree does not change
 * between cases, so neither does the answer.
 */
let cachedSites: Hit[] | null = null;

function writeSites(): Hit[] {
  if (cachedSites) return cachedSites;
  cachedSites = scanWriteSites();
  return cachedSites;
}

function scanWriteSites(): Hit[] {
  const hits: Hit[] = [];
  for (const file of sourceFiles()) {
    const code = stripCommentsAndStrings(readFileSync(file, "utf8"));
    for (const [spelling, pattern] of WRITE_PATTERNS) {
      if (pattern.test(code)) {
        hits.push({ file: relative(REPO_ROOT, file).split("\\").join("/"), spelling });
      }
    }
  }
  return hits;
}

describe("the booking ledger is append-only (#3580, INV-MONEY-032)", () => {
  it("has exactly one module that writes the table", () => {
    const writers = [...new Set(writeSites().map((hit) => hit.file))].sort();
    expect(writers).toEqual([THE_ONE_DOOR]);
  });

  it("contains no update, upsert or delete of a posted line anywhere — including in the door", () => {
    const mutations = writeSites().filter((hit) => FORBIDDEN_EVERYWHERE.has(hit.spelling));
    expect(mutations).toEqual([]);
  });

  it("finds the door itself, so the scan cannot pass by seeing nothing (fixture proof)", () => {
    // The census's own canary: if the pattern stopped matching, both
    // assertions above would go vacuously green.
    const door = writeSites().filter((hit) => hit.file === THE_ONE_DOOR);
    expect(door.map((hit) => hit.spelling)).toContain("createMany");
  });

  it("FAILS on a second writer, and on a mutation (fixture proof)", () => {
    // The mutation probe, in-line: the same patterns run over fixture text
    // rather than the tree, so the guard's teeth are proved without leaving a
    // probe in a real file (docs/TESTING.md).
    const secondWriter = "await tx.bookingLedgerLine.create({ data });";
    const mutation = "await tx.bookingLedgerLine.updateMany({ where, data });";
    const spellings = (code: string) =>
      WRITE_PATTERNS.filter(([, pattern]) => pattern.test(stripCommentsAndStrings(code))).map(
        ([spelling]) => spelling,
      );
    expect(spellings(secondWriter)).toContain("create");
    expect(spellings(mutation)).toContain("updateMany");
    expect(spellings(mutation).some((spelling) => FORBIDDEN_EVERYWHERE.has(spelling))).toBe(true);
    // And a commented-out one is NOT a site, which is why the stripper is here.
    expect(spellings("// await tx.bookingLedgerLine.updateMany({});")).toEqual([]);
  });
});
