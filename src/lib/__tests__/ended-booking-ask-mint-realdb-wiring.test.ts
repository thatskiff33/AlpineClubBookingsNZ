import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4316 (`INV-ADDPAY-044`): the real-PostgreSQL proof that an edit's
 * after-commit mint never leaves a live ask on a booking cancelled in the gap
 * self-skips without `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it
 * only because the race harness imports it. Lose that import and the proof
 * silently becomes a no-op while every suite stays green - so the edge is
 * pinned here, as `superseded-intent-card-doors-realdb-wiring.test.ts` pins
 * #4300's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("INV-ADDPAY-044: the ended-booking mint race proof stays wired into CI (#4316)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./ended-booking-ask-mint-race.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/ended-booking-ask-mint-race.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    for (const race of [
      "a cancel committed before the mint: nothing is minted and nothing is owed",
      "a cancel committed between the provider call and the row write: the minter retires the ask it wrote",
      "the cancel's claim holds the Payment row while the row write waits on it",
      "the row write holds the Payment row first: the cancel reads the new ask on the mirror and retires it itself",
      "a fully REFUNDED payment: the never-captured cancel's claim holds the Payment row while the row write waits on it",
      "a fully REFUNDED payment: the row write holds the Payment row first, and the never-captured cancel reads the new ask and retires it",
      "the recovery runner's replay on a booking bumped before it runs",
      "the recovery runner's replay with a cancel committed between its provider call and its row write",
    ]) {
      expect(suite).toContain(race);
    }
  });
});
