import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #3595: the real-PostgreSQL proof of the ledger's idempotency self-skips
 * without `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it only because
 * the race harness imports it. Lose that import and the whole proof silently
 * becomes a no-op while every suite stays green — so the edge is pinned here,
 * the way `review-findings-contracts.test.ts` pins the harness's own step.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the ledger idempotency proof stays wired into CI (#3595)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./booking-ledger-posting-key.realdb.test";');
  });

  it("carries #3581's settlement-sync proof into the same harness", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./booking-ledger-settlement-sync.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/booking-ledger-settlement-sync.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("matches the mirror's own arithmetic where both read the same rows: captures, and refunds with a refund row");
    expect(suite).toContain("while the mirror keeps counting it");
    expect(suite).toContain("posts through a REAL writer");
    expect(suite).toContain("posts a row paid AGAIN after its mark-paid was reversed");
  });

  it("carries #3599's credit and hand-back proof into the same harness", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./booking-ledger-credit-sync.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/booking-ledger-credit-sync.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    for (const caseName of [
      "posts credit applied and a clamp give-back one line per row, summing to what the booking holds applied",
      "posts a TIERED restore for exactly what was restored, anchored on the cancellation",
      "posts a cancellation credit against its own row",
      "posts a reduction credit against its own row",
      "posts NO hand-back for a task on a card payment",
      "posts a completed hand-back through the REAL resolver",
    ]) {
      expect(suite).toContain(caseName);
    }
  });

  it("still gates on the harness's variable and carries its three proofs", () => {
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/booking-ledger-posting-key.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    for (const caseName of [
      "skips a repeated key rather than refusing it, and the transaction survives to commit",
      "CONTRAST: the same repeat without the door's skip is refused and loses the whole transaction",
      "the confirmation fence sees a line with NO key, so a line posted before keys existed still fences",
    ]) {
      expect(suite).toContain(caseName);
    }
  });
});
