import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "./support/strip-comments";

/**
 * #4673: the real-PostgreSQL proof that a stalled Xero run's late failure never
 * undoes an officer's in-place Retry self-skips without
 * `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it through the race
 * harness importing it. Lose that import and the proof silently becomes a
 * no-op while every suite stays green - so the edge is pinned here, as
 * `organiser-late-note-after-reset-realdb-wiring.test.ts` pins #4655's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

const RACE_IMPORT = 'import "./xero-late-failure-after-retry.realdb.test";';
const hasRaceImport = (source: string) => stripComments(source).includes(RACE_IMPORT);

describe("the late failure's real-database proof stays wired into CI (#4673)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(hasRaceImport(harness)).toBe(true);
    const suite = stripComments(readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/xero-late-failure-after-retry.realdb.test.ts"), "utf8"));
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("MUTATION: stall, reset, Retry queues the row, then the stalled create fails");
    expect(suite).toContain("MUTATION: stall, reset, Retry, the queued run fails under its own claim, then the stalled create fails");
    expect(suite).toContain("markStaleRunningXeroOperationFailed");
    expect(suite).toContain("retryXeroSyncOperation");
    expect(suite).toContain('assertSafeRaceDbUrl(RACE_DB_URL, "Late failure after an in-place Retry (#4673)")');
    expect(suite.indexOf("assertSafeRaceDbUrl(RACE_DB_URL")).toBeLessThan(suite.indexOf('await import("@/lib/prisma")'));
  });

  it.each([`// ${RACE_IMPORT}`, `/* ${RACE_IMPORT} */`])("a commented import does not wire the proof: %s", (comment) => {
    expect(hasRaceImport(comment)).toBe(false);
    expect(hasRaceImport(`${comment}\n${RACE_IMPORT}`)).toBe(true);
  });
});
