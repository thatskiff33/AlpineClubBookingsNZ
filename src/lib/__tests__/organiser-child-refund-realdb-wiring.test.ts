import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #3653: the PostgreSQL proof of the organiser child refund self-skips without
 * `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it only through the race
 * harness's import. Lose the import and the proof silently stops running.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the organiser child refund proof stays wired into CI (#3653)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(harness).toContain('import "./organiser-child-refund.realdb.test";');
    const suite = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/organiser-child-refund.realdb.test.ts"), "utf8");
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("lets only one of two racing reductions reserve the same captured cents");
    expect(suite).toContain("converges an ambiguous Stripe answer on the one refund Stripe made");
  });
});
