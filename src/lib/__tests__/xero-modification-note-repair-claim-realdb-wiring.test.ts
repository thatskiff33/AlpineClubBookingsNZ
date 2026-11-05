import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4259: the real-PostgreSQL proof that the PARTIAL modification credit-note
 * repair claims its row and closes it self-skips without
 * `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it only because the race
 * harness imports it. Lose that import and the proof silently becomes a no-op
 * while every suite stays green - so the edge is pinned here, as
 * `xero-partial-repair-claim-realdb-wiring.test.ts` pins #4256's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the modification note repair claim's real-database proof stays wired into CI (#4259)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./xero-modification-note-repair-claim.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/xero-modification-note-repair-claim.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("waits on its claim wins: no Xero call");
    expect(suite).toContain("two retries of one row at once make one allocation and close the row once");
  });
});
