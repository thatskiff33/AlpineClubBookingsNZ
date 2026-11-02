import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "./support/strip-comments";

/**
 * #4426: the real-PostgreSQL proof that a stalled refund-note create returning
 * after a reset and a resolve by hand records nothing self-skips without
 * `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it only because the race
 * harness imports it. Lose that import and the proof silently becomes a no-op
 * while every suite stays green - so the edge is pinned here, as
 * `resolve-records-refund-note-realdb-wiring.test.ts` pins #4421's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

const RACE_IMPORT = 'import "./xero-late-refund-note-after-resolve.realdb.test";';
const hasRaceImport = (source: string) => stripComments(source).includes(RACE_IMPORT);

describe("the late refund note's real-database proof stays wired into CI (#4426)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(hasRaceImport(harness)).toBe(true);
    const suite = stripComments(readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/xero-late-refund-note-after-resolve.realdb.test.ts"), "utf8"));
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("MUTATION: reset, resolve by hand with note A, then the stalled run returns note B - A stays recorded and linked, B is alerted once and never linked or settled");
    expect(suite).toContain("control: a reset with no resolve");
    expect(suite).toContain("MUTATION: the officer resolved with B itself");
    expect(suite).toContain("MUTATION: a plain resolve recorded no note");
    expect(suite).toContain("race, canonical note: the create's record holding the Payment row makes the resolve's claim wait on it");
    expect(suite).toContain("race, per-refund note (no pointer): the resolve's claim still waits on the Payment row");
    expect(suite).toContain("pg_blocking_pids");
    expect(suite).toContain('assertSafeRaceDbUrl(RACE_DB_URL, "Late refund note after resolve (#4426)")');
    expect(suite.indexOf("assertSafeRaceDbUrl(RACE_DB_URL")).toBeLessThan(suite.indexOf('await import("@/lib/prisma")'));
  });

  it.each([`// ${RACE_IMPORT}`, `/* ${RACE_IMPORT} */`])("a commented import does not wire the proof: %s", (comment) => {
    expect(hasRaceImport(comment)).toBe(false);
    expect(hasRaceImport(`${comment}\n${RACE_IMPORT}`)).toBe(true);
  });
});
