import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4646 (`INV-PAY-089`): the real-PostgreSQL proof that an asynchronous capture
 * of a lost-answer saved-card charge is adopted by its metadata self-skips
 * without `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it only because
 * the race harness imports it. Lose that import and the proof silently becomes
 * a no-op while every suite stays green - so the edge is pinned here, as
 * `saved-card-charge-worth-realdb-wiring.test.ts` pins #4357's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the saved-card asynchronous capture real-database proof stays wired into CI (#4646)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./saved-card-async-capture-adopt.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/saved-card-async-capture-adopt.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("the asynchronous capture (request null) adopts the row and settles the booking once");
    expect(suite).toContain("exactly one writes the capture as new money, the other writes nothing");
  });
});
