import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #5190: the real-PostgreSQL proof of the liability opt-in self-skips without
 * `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it only because the race
 * harness imports it. Lose that import and the proof silently becomes a no-op
 * while every suite stays green, so the edge is pinned here, as
 * `membership-family-rebill-realdb-wiring.test.ts` pins #4110's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the liability opt-in real-database proof stays wired into CI (#5190)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./subscription-liability-opt-in.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/subscription-liability-opt-in.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("opting in flips only the untouched and the covered-then-released row");
    expect(suite).toContain("confirm queued first");
    expect(suite).toContain("save queued first");
    expect(suite).toContain("the SQL date-of-birth check agrees with the TS rule");
  });
});
