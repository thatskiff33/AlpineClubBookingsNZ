import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "./support/strip-comments";

/**
 * #4223: the real-PostgreSQL proof that a canonical refund note voided in Xero
 * while a retry records it stays inactive self-skips without
 * `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it only because the race
 * harness imports it. Lose that import and the proof silently becomes a no-op
 * while every suite stays green - so the edge is pinned here, as
 * `xero-refund-request-note-void-realdb-wiring.test.ts` pins #4195's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

const RACE_IMPORT = 'import "./xero-canonical-refund-note-void-race.realdb.test";';
const hasRaceImport = (source: string) => stripComments(source).includes(RACE_IMPORT);

describe("the canonical refund-note void race's real-database proof stays wired into CI (#4223)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(hasRaceImport(harness)).toBe(true);
    const suite = stripComments(readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/xero-canonical-refund-note-void-race.realdb.test.ts"),
      "utf8",
    ));
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("a retry that read the canonical note as live, then waited on the inbound void, keeps the void: inactive, status kept, pointer released (race)");
    expect(suite).toContain("a retry queued on the void's Payment row keeps the void and leaves the pointer clear (race)");
    expect(suite).toContain("pg_blocking_pids");
    expect(suite).toContain("a retry with no mirror waits for an inbound %s first insertion and keeps it inactive (race)");
    expect(suite).toContain('assertSafeRaceDbUrl(RACE_DB_URL, "Canonical refund-note void")');
    expect(suite.indexOf("assertSafeRaceDbUrl(RACE_DB_URL")).toBeLessThan(suite.indexOf('await import("@/lib/prisma")'));
  });

  it.each([`// ${RACE_IMPORT}`, `/* ${RACE_IMPORT} */`])("a commented import does not wire the proof: %s", (comment) => {
    expect(hasRaceImport(comment)).toBe(false);
    expect(hasRaceImport(`${comment}\n${RACE_IMPORT}`)).toBe(true);
  });
});
