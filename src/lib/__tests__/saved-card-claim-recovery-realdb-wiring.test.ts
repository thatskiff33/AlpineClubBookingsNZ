import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4993 (`INV-PAY-055`): the real-PostgreSQL proof that a stranded saved-card
 * claim is recovered, and never while its money is captured, self-skips
 * without `RUN_CONCURRENCY_RACE_TESTS`; hosted CI reaches it only because the
 * race harness imports it. Lose that import and the proof silently becomes a
 * no-op while every suite stays green - so the edge is pinned here, as
 * `saved-card-async-capture-adopt-realdb-wiring.test.ts` pins #4646's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the saved-card claim recovery real-database proof stays wired into CI (#4993)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./saved-card-claim-recovery.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/saved-card-claim-recovery.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("hands a stranded claim back once");
    expect(suite).toContain("recovery racing the capture's adoption");
  });
});
