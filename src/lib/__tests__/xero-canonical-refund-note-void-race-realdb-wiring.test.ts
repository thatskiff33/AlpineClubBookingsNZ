import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4223: the real-PostgreSQL proof that a canonical refund note voided in Xero
 * while a retry records it stays inactive self-skips without
 * `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it only because the race
 * harness imports it. Lose that import and the proof silently becomes a no-op
 * while every suite stays green - so the edge is pinned here, as
 * `xero-refund-request-note-void-realdb-wiring.test.ts` pins #4195's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the canonical refund-note void race's real-database proof stays wired into CI (#4223)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./xero-canonical-refund-note-void-race.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/xero-canonical-refund-note-void-race.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("a retry that read the canonical note as live, then waited on the inbound void, keeps the void: inactive, status kept, pointer released (race)");
    expect(suite).toContain("a retry that wrote the pointer back before the void committed has it released by its own link write (race)");
    expect(suite).toContain("pg_blocking_pids");
  });
});
