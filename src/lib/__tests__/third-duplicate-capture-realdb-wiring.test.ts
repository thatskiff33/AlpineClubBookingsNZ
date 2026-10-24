import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4211 (`INV-PAY-043`): the real-PostgreSQL proof that a third card capture on
 * one booking is refunded too self-skips without `RUN_CONCURRENCY_RACE_TESTS`,
 * and hosted CI reaches it only because the race harness imports it. Lose that
 * import and the proof silently becomes a no-op while every suite stays green -
 * so the edge is pinned here, as `settled-capture-order-realdb-wiring.test.ts`
 * pins #4177's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the third-duplicate-capture real-database proof stays wired into CI (#4211)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./third-duplicate-capture.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/third-duplicate-capture.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("the first settles, the other two are refunded once each and name it, and replaying all three changes nothing");
    expect(suite).toContain("permutations(TABS)");
    expect(suite).toContain("the second capture's refund fails at Stripe and stays queued");
  });
});
