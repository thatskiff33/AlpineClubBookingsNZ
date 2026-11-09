import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4838: the PostgreSQL proof that a #2700 hand-back reads its late capture
 * under the Payment row self-skips without `RUN_CONCURRENCY_RACE_TESTS`, and
 * hosted CI reaches it only through the race harness's import. Lose the import
 * and the proof silently stops running.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the late-capture hand-back race proof stays wired into CI (#4838)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(harness).toContain('import "./late-capture-hand-back-race.realdb.test";');
    const suite = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/late-capture-hand-back-race.realdb.test.ts"), "utf8");
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("recorded while the hand-back waits for the Payment row is read, and the hand-back refused");
    expect(suite).toContain("waitForBlockedBy(webhook.pid)");
    // #4843: and every case runs on a legacy row raised before `kind` existed.
    expect(suite).toContain('{ label: "a legacy row with no kind (#4843)", kind: null, legacy: true }');
    expect(suite).toContain("describe.each(TASK_VARIANTS)");
  });
});
