import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4215 (`INV-ADDPAY-021`, `INV-PAY-118`): the real-PostgreSQL proof that the
 * inbound recount of a bank-transfer payment keeps a refund request's paid-back
 * cash self-skips without `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it
 * only because the race harness imports it. Lose that import and the proof
 * silently becomes a no-op while every suite stays green - so the edge is
 * pinned here, as `settled-capture-order-realdb-wiring.test.ts` pins #4177's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the bank-transfer request-cash recount real-database proof stays wired into CI (#4215)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./xero-bt-repair-request-cash.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/xero-bt-repair-request-cash.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("a canonical-note reconcile keeps the request's $50 beside the note's $100");
    expect(suite).toContain("keeps it while the request's note is still queued, and after Xero voids it");
    expect(suite).toContain("the canonical note voided: its $100 goes (INV-ADDPAY-041), the request's $50 stays");
  });
});
