import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "./support/strip-comments";

/**
 * #4655: the real-PostgreSQL proof that an organiser adjustment's credit note,
 * created in Xero after its stalled job was reset, is recorded or surfaced
 * self-skips without `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it
 * only because the race harness imports it. Lose that import and the proof
 * silently becomes a no-op while every suite stays green - so the edge is
 * pinned here, as `xero-late-refund-note-after-resolve-realdb-wiring.test.ts`
 * pins #4426's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

const RACE_IMPORT = 'import "./organiser-late-note-after-reset.realdb.test";';
const hasRaceImport = (source: string) => stripComments(source).includes(RACE_IMPORT);

describe("the organiser late note's real-database proof stays wired into CI (#4655)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(hasRaceImport(harness)).toBe(true);
    const suite = stripComments(readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/organiser-late-note-after-reset.realdb.test.ts"), "utf8"));
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("MUTATION: reset with no resolve, then the late success");
    expect(suite).toContain("MUTATION: reset, then Retry queues the row, then the late success");
    expect(suite).toContain("MUTATION: reset, resolve by hand, then the late success");
    expect(suite).toContain("MUTATION: reset, Retry running its own create, then the first run's late success");
    expect(suite).toContain("markStaleRunningXeroOperationFailed");
    expect(suite).toContain('assertSafeRaceDbUrl(RACE_DB_URL, "Organiser late note after reset (#4655)")');
    expect(suite.indexOf("assertSafeRaceDbUrl(RACE_DB_URL")).toBeLessThan(suite.indexOf('await import("@/lib/prisma")'));
  });

  it.each([`// ${RACE_IMPORT}`, `/* ${RACE_IMPORT} */`])("a commented import does not wire the proof: %s", (comment) => {
    expect(hasRaceImport(comment)).toBe(false);
    expect(hasRaceImport(`${comment}\n${RACE_IMPORT}`)).toBe(true);
  });
});
