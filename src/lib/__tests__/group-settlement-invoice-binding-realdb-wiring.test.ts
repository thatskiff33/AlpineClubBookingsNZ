import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #3642: the real-PostgreSQL proof of the bound group-settlement invoice
 * self-skips without `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it
 * only because the race harness imports it. Lose that import and the proof
 * silently becomes a no-op while every suite stays green - so the edge is
 * pinned here, as `card-refund-mirror-realdb-wiring.test.ts` pins #3640's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the bound group-settlement invoice's race proof stays wired into CI (#3642)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./group-settlement-invoice-binding-races.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/group-settlement-invoice-binding-races.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("a refused change to a bound settlement rolls back the bed it claimed for a late joiner");
    expect(suite).toContain("the reaper's release and the create worker's fence decide one invoice exactly once");
    expect(suite).toContain('"fence-first"');
    expect(suite).toContain('"reaper-first"');
    expect(suite).toContain("two observers abandoning one invoice converge on one VOID row");
    expect(suite).toContain("pg_advisory_xact_lock(1)");
  });
});
