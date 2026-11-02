import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "./support/strip-comments";

/**
 * #4680: the real-PostgreSQL proof that an organiser adjustment run whose
 * claim a reset took after it recorded its note never allocates or pays out
 * self-skips without `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it
 * only because the race harness imports it. Lose that import and the proof
 * silently becomes a no-op while every suite stays green - so the edge is
 * pinned here, as `organiser-late-note-after-reset-realdb-wiring.test.ts`
 * pins #4655's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

const RACE_IMPORT = 'import "./organiser-run-claim-check.realdb.test";';
const hasRaceImport = (source: string) => stripComments(source).includes(RACE_IMPORT);

describe("the organiser run claim check's real-database proof stays wired into CI (#4680)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(hasRaceImport(harness)).toBe(true);
    const suite = stripComments(readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/organiser-run-claim-check.realdb.test.ts"), "utf8"));
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("record, stall, reset, Resolve, then wake: no allocation or payment");
    expect(suite).toContain("record, stall, reset with no officer action, then wake");
    expect(suite).toContain("record, stall, reset, Retry queued, then wake");
    expect(suite).toContain("markStaleRunningXeroOperationFailed");
    expect(suite).toContain('assertSafeRaceDbUrl(RACE_DB_URL, "Organiser run claim check (#4680)")');
    expect(suite.indexOf("assertSafeRaceDbUrl(RACE_DB_URL")).toBeLessThan(suite.indexOf('await import("@/lib/prisma")'));
  });

  it.each([`// ${RACE_IMPORT}`, `/* ${RACE_IMPORT} */`])("a commented import does not wire the proof: %s", (comment) => {
    expect(hasRaceImport(comment)).toBe(false);
    expect(hasRaceImport(`${comment}\n${RACE_IMPORT}`)).toBe(true);
  });
});
