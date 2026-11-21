import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4279: the real-PostgreSQL proof that a refund-note repair losing its claim
 * after a void leaves no pointer to the voided note self-skips without
 * `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it only because the race
 * harness imports it. Lose that import and the proof silently becomes a no-op
 * while every suite stays green - so the edge is pinned here, as
 * `xero-partial-repair-claim-realdb-wiring.test.ts` pins #4256's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the refund-note repair's lost-claim void proof stays wired into CI (#4279)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./xero-refund-repair-lost-claim-void.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/xero-refund-repair-lost-claim-void.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("then lost its claim after Xero %s it, leaves no pointer and no live link to it");
  });
});
