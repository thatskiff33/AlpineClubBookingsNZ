import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The PostgreSQL proof that an unpaid booking's date move records no late-notice
 * fee self-skips without `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it
 * only through the race harness's import. Lose the import and the proof silently
 * stops running.
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
    expect(suite).toContain("before its invoice: the price changes and no late-notice fee is recorded");
    expect(suite).toContain("after its invoice: a price increase is invoiced without a fee");
    expect(suite).toContain("a card booking still at its pay step gains no fee");
    expect(suite).toContain("before a card booking's pay step: no fee-only payment row is opened");
    expect(suite).toContain("an unpaid whole-lodge booking keeps no payment row and no fee");
    expect(suite).toContain("a paid booking still records the policy fee once");
    expect(suite).toContain("a credit-paid booking is charged the fee");
  });
});
