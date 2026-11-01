import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4491 (`INV-ADDPAY-052`): the real-PostgreSQL proof that a credit release
 * merges into an unpaid edit request self-skips without
 * `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it only because the race
 * harness imports it. Lose that import and the proof silently becomes a no-op
 * while every suite stays green - so the edge is pinned here, as
 * `superseded-ask-invoice-carry-realdb-wiring.test.ts` pins #3403's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("INV-ADDPAY-052: the credit-release merge proof stays wired into CI (#4491)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(harness).toContain('import "./credit-release-merge-into-edit.realdb.test";');
    const suite = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/credit-release-merge-into-edit.realdb.test.ts"), "utf8");
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    for (const proof of [
      "merges: one request for both, the edit's invoice follows it, and the one card payment is recorded against both invoices, once",
      "waits where the edit's invoice cannot follow yet, and asks for the release alone once the edit is paid",
      "waits where the edit's invoice cannot follow yet, and asks for the release alone once the edit is withdrawn",
      "the edit paid between the release's read and its claim: the claim refuses, nothing is superseded, and the retry asks for the release alone",
      "the edit withdrawn between the release's read and its claim: the claim refuses, and the retry asks for the release alone",
    ]) {
      expect(suite).toContain(proof);
    }
  });
});
