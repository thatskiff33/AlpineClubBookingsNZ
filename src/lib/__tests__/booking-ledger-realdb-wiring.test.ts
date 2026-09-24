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
