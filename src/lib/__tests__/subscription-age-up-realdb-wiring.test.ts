import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #5190 PR 3: the real-PostgreSQL proof of the mid-season age-up self-skips
 * without `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it only because
 * the race harness imports it. Lose that import and the proof silently becomes
 * a no-op while every suite stays green, so the edge is pinned here, as
 * `subscription-liability-opt-in-realdb-wiring.test.ts` pins the opt-in's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the age-up real-database proof stays wired into CI (#5190)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./subscription-age-up.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/subscription-age-up.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("one run raises a part-season charge, a top-up and a credit");
    expect(suite).toContain("a top-up holds its member back only once its invoice is issued and unpaid");
    expect(suite).toContain("a voided top-up is named, not raised again");
    expect(suite).toContain("the unique key refuses a second adjustment for one birthday");
    expect(suite).toContain("two credit workers on one adjustment grant one credit lot");
  });
});
