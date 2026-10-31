import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4531: the real-PostgreSQL proof that a payment deleted in Xero retires its
 * link self-skips without `RUN_CONCURRENCY_RACE_TESTS`, and the race harness's
 * job reaches it only through this import. Lose the import and the proof is a
 * silent no-op while every suite stays green, so the edge is pinned here, as
 * `xero-voided-note-recount-realdb-wiring.test.ts` pins #4291's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the deleted-payment link retire's real-database proof stays wired into CI (#4531)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(harness).toContain('import "./xero-deleted-payment-links.realdb.test";');
    const suite = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/xero-deleted-payment-links.realdb.test.ts"), "utf8");
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("retires the deleted payment's link, keeps the replacement, and a replay changes nothing");
    expect(suite).toContain("a payload without Payments retires nothing and asks Xero nothing");
    expect(suite).toContain("the guarded write keeps a concurrent writer's metadata");
  });
});
