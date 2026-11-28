import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The PostgreSQL proof that an unlinked Internet Banking booking's edit
 * increase is asked for self-skips without `RUN_CONCURRENCY_RACE_TESTS`, and
 * hosted CI reaches it only through the race harness's import. Lose the import
 * and the proof silently stops running.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the unlinked Internet Banking fee-ask proof stays wired into CI (#5288)", () => {
  it("is imported by the race harness and run by the sandbox's kept-change check", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./ib-unlinked-fee-ask.realdb.test";');
    const sandboxCheck = readFileSync(resolve(REPO_ROOT, "scripts/ci/kept-change-realdb.sh"), "utf8");
    expect(sandboxCheck).toContain("src/lib/__tests__/ib-unlinked-fee-ask.realdb.test.ts");
    const suite = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/ib-unlinked-fee-ask.realdb.test.ts"), "utf8");
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("a fee-only date move sends the Internet Banking ask and raises the primary invoice");
    expect(suite).toContain("the batch door asks for the fee the same way");
    expect(suite).toContain("the primary invoice raised later bills the fee once, and its gap check queues nothing");
    expect(suite).toContain("with the Xero module off the member is still asked, and nothing is queued for Xero");
  });
});
