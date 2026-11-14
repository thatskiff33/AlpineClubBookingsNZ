import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4284: the PostgreSQL proof that the card-refund owed figure reads a
 * `createdAt` tie the same in either physical order self-skips without
 * `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it only through the race
 * harness's import. Lose the import and the proof silently stops running.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the owed-figure tie-order proof stays wired into CI (#4284)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(harness).toContain('import "./card-refund-owed-tie-order.realdb.test";');
    const suite = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/card-refund-owed-tie-order.realdb.test.ts"), "utf8");
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("forced both physical orders, and read the same figure from each");
    expect(suite).toContain("forced both physical orders, and attributed each refund the same in each");
  });
});
