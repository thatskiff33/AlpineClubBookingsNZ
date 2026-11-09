import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4858: the real-PostgreSQL proof that a plan-less superseded refund holds
 * while another door's refund sizes it self-skips without
 * `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it only because the race
 * harness imports it. Lose that import and the proof silently becomes a no-op
 * while every suite stays green - so the edge is pinned here, as
 * `superseded-refund-notice-realdb-wiring.test.ts` pins #4690's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("#4858: the superseded refund hold proof stays wired into CI", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(harness).toContain('import "./superseded-refund-another-door-hold.realdb.test";');
    const suite = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/superseded-refund-another-door-hold.realdb.test.ts"), "utf8");
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    for (const proof of [
      "the issue's race: another door's refund recorded while the runner's preflight waits for the Payment row holds the row, nothing sent; that refund failing later is owed once, on a row of its own",
      "another door's refund made before the row was raised is only taken off the ask (#4699): the rest is sent",
    ]) {
      expect(suite).toContain(proof);
    }
  });
});
