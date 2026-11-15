import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4936: the real-PostgreSQL proof that the refund-note gap list's pre-filter
 * answers as the exact reader self-skips without `RUN_CONCURRENCY_RACE_TESTS`.
 * Hosted CI reaches it only because the race harness imports it. Lose that
 * import and the proof silently becomes a no-op while every suite stays green,
 * so the edge is pinned here, as
 * `resolved-voided-refund-note-coverage-realdb-wiring.test.ts` pins #4250's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the refund-note gap pre-filter's real-database proof stays wired into CI (#4936)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(harness).toContain('import "./refund-gap-prefilter.realdb.test";');
    const suite = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/refund-gap-prefilter.realdb.test.ts"), "utf8");
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("the list is the exact reader's answer for every payment, in order");
  });
});
