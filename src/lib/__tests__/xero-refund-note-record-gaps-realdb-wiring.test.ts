import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "./support/strip-comments";

/**
 * #4656: the real-PostgreSQL proof that the refund-note create's record asks
 * freshness under the Payment row and survives (or, past its budget, traces)
 * a long holder self-skips without `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI
 * reaches it only because the race harness imports it. Lose that import and the
 * proof silently becomes a no-op while every suite stays green - so the edge is
 * pinned here, as `xero-late-refund-note-after-resolve-realdb-wiring.test.ts`
 * pins #4426's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

const RACE_IMPORT = 'import "./xero-refund-note-record-gaps.realdb.test";';
const hasRaceImport = (source: string) => stripComments(source).includes(RACE_IMPORT);

describe("the refund-note record gaps' real-database proof stays wired into CI (#4656)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(hasRaceImport(harness)).toBe(true);
    const suite = stripComments(readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/xero-refund-note-record-gaps.realdb.test.ts"), "utf8"));
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("MUTATION: two records of one note on two rows - the second queues on the Payment row");
    expect(suite).toContain("MUTATION: a record behind a Payment row held past Prisma's 5s default still records");
    expect(suite).toContain("MUTATION: a record behind a Payment row held past its whole budget writes nothing and fails nothing");
    expect(suite).toContain("MUTATION (S2): a queued retry whose record loses its wait behind a long Payment hold fails its REQUEUE row naming the note");
    expect(suite).toContain("pg_blocking_pids");
    expect(suite).toContain('assertSafeRaceDbUrl(RACE_DB_URL, "Refund-note record gaps (#4656)")');
    expect(suite.indexOf("assertSafeRaceDbUrl(RACE_DB_URL")).toBeLessThan(suite.indexOf('await import("@/lib/prisma")'));
  });

  it.each([`// ${RACE_IMPORT}`, `/* ${RACE_IMPORT} */`])("a commented import does not wire the proof: %s", (comment) => {
    expect(hasRaceImport(comment)).toBe(false);
    expect(hasRaceImport(`${comment}\n${RACE_IMPORT}`)).toBe(true);
  });
});
