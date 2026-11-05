import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "./support/strip-comments";

/**
 * #4688: the real-PostgreSQL proof that an unrecorded refund note fences the
 * payment's later refund notes self-skips without `RUN_CONCURRENCY_RACE_TESTS`,
 * and hosted CI reaches it only because the race harness imports it. Lose that
 * import and the proof silently becomes a no-op while every suite stays green -
 * so the edge is pinned here, as `xero-refund-note-record-gaps-realdb-wiring.test.ts`
 * pins #4656's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

const RACE_IMPORT = 'import "./xero-unrecorded-refund-note-fence.realdb.test";';
const hasRaceImport = (source: string) => stripComments(source).includes(RACE_IMPORT);

describe("the unrecorded refund-note fence's real-database proof stays wired into CI (#4688)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(hasRaceImport(harness)).toBe(true);
    const suite = stripComments(readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/xero-unrecorded-refund-note-fence.realdb.test.ts"), "utf8"));
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("MUTATION: past 15 minutes, a later refund's note, the nightly self-heal and Retry all raise nothing");
    expect(suite).toContain("pg_blocking_pids");
    expect(suite).toContain('assertSafeRaceDbUrl(RACE_DB_URL, "Unrecorded refund-note fence (#4688)")');
    expect(suite.indexOf("assertSafeRaceDbUrl(RACE_DB_URL")).toBeLessThan(suite.indexOf('await import("@/lib/prisma")'));
  });

  it.each([`// ${RACE_IMPORT}`, `/* ${RACE_IMPORT} */`])("a commented import does not wire the proof: %s", (comment) => {
    expect(hasRaceImport(comment)).toBe(false);
    expect(hasRaceImport(`${comment}\n${RACE_IMPORT}`)).toBe(true);
  });
});
