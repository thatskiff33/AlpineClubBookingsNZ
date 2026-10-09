import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #3971: the real-PostgreSQL proof of the membership subscription invoice
 * retry self-skips without `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches
 * it only because the race harness imports it. Lose that import and the proof
 * silently becomes a no-op while every suite stays green - so the edge is
 * pinned here, as `group-settlement-invoice-binding-realdb-wiring.test.ts`
 * pins #3642's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the subscription invoice retry's real-database proof stays wired into CI (#3971)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./xero-subscription-invoice-retry.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/xero-subscription-invoice-retry.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("requeues one FAILED row exactly once when two retries race");
    expect(suite).toContain("through the real active-correlation-key index");
  });
});
