import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4195: the real-PostgreSQL proof that a refund request's own Xero note,
 * voided in Xero, is written inactive and never re-adopted self-skips without
 * `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it only because the race
 * harness imports it. Lose that import and the proof silently becomes a no-op
 * while every suite stays green - so the edge is pinned here, as
 * `xero-subscription-invoice-retry-realdb-wiring.test.ts` pins #3971's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the voided refund-request note's real-database proof stays wired into CI (#4195)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./xero-refund-request-note-void.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/xero-refund-request-note-void.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("the inbound void writes the mirror inactive and moves no money; no retry re-raises it, and a re-raise takes a fresh note, never the voided one");
    expect(suite).toContain("a retry's status-less link write that waited on an inbound void keeps the void: inactive, status kept (race)");
    expect(suite).toContain("pg_blocking_pids");
  });

  it("#4214: the officer's re-raise proof is imported by the same harness, and races two clicks", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./xero-refund-request-note-reraise.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/xero-refund-request-note-reraise.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("two officers at once queue one note; the outbox raises it under the after-void key; a third click is refused");
    expect(suite).toContain("pg_blocking_pids");
  });
});
