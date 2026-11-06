import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4661: the PostgreSQL proof that an edit's change fee on a booking still to be
 * paid reaches its payment and ledger self-skips without
 * `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it only through the race
 * harness's import. Lose the import and the proof silently stops running.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the unpaid edit change-fee proof stays wired into CI (#4661)", () => {
  it("is imported by the race harness and run by the sandbox's kept-change check", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./unpaid-edit-change-fee-owed.realdb.test";');
    const sandboxCheck = readFileSync(resolve(REPO_ROOT, "scripts/ci/kept-change-realdb.sh"), "utf8");
    expect(sandboxCheck).toContain("src/lib/__tests__/unpaid-edit-change-fee-owed.realdb.test.ts");
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/unpaid-edit-change-fee-owed.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("before its invoice: the fee goes on the payment once");
    expect(suite).toContain("after its invoice: the fee goes on the payment once");
    expect(suite).toContain("through the date door: the fee goes on a card booking's payment once");
    expect(suite).toContain("before a card booking's pay step: the edit opens a payment carrying the fee");
  });
});
