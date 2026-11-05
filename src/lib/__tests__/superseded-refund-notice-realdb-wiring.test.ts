import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4690: the real-PostgreSQL proof that a superseded payment's refund is
 * announced once self-skips without `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI
 * reaches it only because the race harness imports it. Lose that import and the
 * proof silently becomes a no-op while every suite stays green - so the edge is
 * pinned here, as `credit-release-merge-realdb-wiring.test.ts` pins #4491's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("#4690: the superseded refund notice proof stays wired into CI", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(harness).toContain('import "./superseded-refund-notice-once.realdb.test";');
    const suite = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/superseded-refund-notice-once.realdb.test.ts"), "utf8");
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    for (const proof of [
      "the issue's sequence: a stalled attempt refunds and loses its close to the reaper, the next claim closes - one email, one alert, and a second run adds nothing",
      "the next claim's half: an attempt that recorded its refund and stalled before its notice",
      "another door's refund (a cancellation's) brings the row to nothing outstanding: closed with no notice",
    ]) {
      expect(suite).toContain(proof);
    }
  });
});
