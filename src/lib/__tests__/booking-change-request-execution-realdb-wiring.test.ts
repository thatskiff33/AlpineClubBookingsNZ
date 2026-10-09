import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #3750: the PostgreSQL proof of the finished-stay change-request execution
 * self-skips without `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it only
 * through the race harness's import. Lose the import and the proof silently
 * stops running.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the finished-stay change-request proof stays wired into CI (#3750)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./booking-change-request-execution.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/booking-change-request-execution.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("two officers approving at once produce exactly one modification and one ask");
    expect(suite).toContain("an approval racing a cancel waits on lock(1)");
  });
});
