import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #3640: the real-PostgreSQL proof of the card-refund writer self-skips without
 * `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it only because the race
 * harness imports it. Lose that import and the proof silently becomes a no-op
 * while every suite stays green - so the edge is pinned here, as
 * `booking-ledger-realdb-wiring.test.ts` pins the ledger's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the card-refund writer's race proof stays wired into CI (#3640)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./card-refund-mirror-races.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/card-refund-mirror-races.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("two writers recording the SAME refund at once add it once");
    expect(suite).toContain("two writers recording DIFFERENT refunds at once lose neither");
    expect(suite).toContain("a member's credit settlement racing a dashboard refund's webhook keeps both, without refusing");
    expect(suite).toContain("FOR NO KEY UPDATE");
  });
});
