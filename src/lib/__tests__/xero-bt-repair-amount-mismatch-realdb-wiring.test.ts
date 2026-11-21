import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4328: the real-PostgreSQL proof that the booking repair tool judges a
 * bank-transfer payment's refund by all its live refund notes self-skips
 * without `RUN_CONCURRENCY_RACE_TESTS`. Hosted CI reaches it only because the
 * race harness imports it. Lose that import and the proof silently becomes a
 * no-op while every suite stays green, so the edge is pinned here, as
 * `own-live-refund-note-coverage-realdb-wiring.test.ts` pins #4265's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the bank-transfer repair amount-mismatch real-database proof stays wired into CI (#4328)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(harness).toContain('import "./xero-bt-repair-amount-mismatch.realdb.test";');
    const suite = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/xero-bt-repair-amount-mismatch.realdb.test.ts"), "utf8");
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("a canonical note, a later hand-back's note and a card refund's note together answer the refund");
  });
});
