import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #3949: the PostgreSQL proof that an IB group child's edit and appeal
 * hand-backs complete onto its mirror self-skips without
 * `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it only through the race
 * harness's import. Lose the import and the proof silently stops running.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the IB group child hand-back proof stays wired into CI (#3949)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(harness).toContain('import "./ib-group-child-hand-back.realdb.test";');
    const suite = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/ib-group-child-hand-back.realdb.test.ts"), "utf8");
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("an edit's hand-back on a live child completes onto its mirror");
    expect(suite).toContain("a group cancel after a completed edit hand-back sizes the plan net of it and mirrors both");
  });
});
