import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments } from "./support/strip-comments";

/**
 * #3595: the real-PostgreSQL proof of the ledger's idempotency self-skips
 * without `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it only because
 * the race harness imports it. Lose that import and the whole proof silently
 * becomes a no-op while every suite stays green — so the edge is pinned here,
 * the way `review-findings-contracts.test.ts` pins the harness's own step.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

/**
 * A suite's code with its comments blanked (strings kept), so a commented-out
 * import or case cannot keep a pin green (INV-SSOT-004; #3740 SSOT F6).
 */
function source(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

describe("the ledger idempotency proof stays wired into CI (#3595)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = source(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
    );
    expect(harness).toContain('import "./booking-ledger-posting-key.realdb.test";');
  });

  it("carries #3581's settlement-sync proof into the same harness", () => {
    const harness = source(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
    );
    expect(harness).toContain('import "./booking-ledger-settlement-sync.realdb.test";');
    const suite = source(
      resolve(REPO_ROOT, "src/lib/__tests__/booking-ledger-settlement-sync.realdb.test.ts"),
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("matches the mirror's own arithmetic where both read the same rows: captures, and refunds with a refund row");
    expect(suite).toContain("while the mirror keeps counting it");
    expect(suite).toContain("posts through a REAL writer");
    expect(suite).toContain("posts a row paid AGAIN after its mark-paid was reversed");
  });

  it("carries #3599's credit and hand-back proof into the same harness", () => {
    const harness = source(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
    );
    expect(harness).toContain('import "./booking-ledger-credit-sync.realdb.test";');
    const suite = source(
      resolve(REPO_ROOT, "src/lib/__tests__/booking-ledger-credit-sync.realdb.test.ts"),
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    for (const caseName of [
      "posts credit applied and a clamp give-back one line per row, summing to what the booking holds applied",
      "posts a TIERED restore for exactly what was restored, anchored on the cancellation",
      "posts a cancellation credit against its own row",
      "posts a reduction credit against its own row",
      "posts NO hand-back for a task on a card payment",
      "posts a completed hand-back through the REAL resolver",
    ]) {
      expect(suite).toContain(caseName);
    }
  });

  it("carries #3582's edit and review-closure proof into the same harness", () => {
    const harness = source(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
    );
    expect(harness).toContain('import "./booking-ledger-modification.realdb.test";');
    const suite = source(
      resolve(REPO_ROOT, "src/lib/__tests__/booking-ledger-modification.realdb.test.ts"),
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    for (const caseName of [
      "TWO EDITS: the second reverses the first edit's re-post, never a line already reversed",
      "a replayed posting posts nothing and the transaction still commits",
      "posts nothing for a booking not yet confirmed on the ledger",
      "a closure's re-price posts under its history row from the real guest rows, and the share posts no second record",
      "REFUND: the first closure's re-price carries both removals, the second posts nothing, and the ledger bills the booking's price",
      "REFUND, dismiss then complete: the dismissal's re-price stands and the completion adds nothing",
      "REFUND, declined then re-priced: the stand-in is reversed by its line id when the re-price carries it",
      "CHARGE: the first closure's re-price carries both additions, the second posts nothing",
      "a same-price category change, then a second edit: the second reverses the FIRST EDIT'S re-post, never the stale confirmation line",
      "a direct write of a reversal of an already-reversed line inserts nothing, and the transaction stays usable",
      "a replayed change-fee-only edit posts its fee once: the replay's plan is identical, and ON CONFLICT skips it",
      "an admin date shift through the REAL door re-dates every night, netting to zero, and a later edit reverses the shifted line (#3741)",
    ]) {
      expect(suite).toContain(caseName);
    }
  });

  it("carries #3611's cancellation proof into the same harness", () => {
    const harness = source(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
    );
    expect(harness).toContain('import "./booking-ledger-cancellation.realdb.test";');
    const suite = source(
      resolve(REPO_ROOT, "src/lib/__tests__/booking-ledger-cancellation.realdb.test.ts"),
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    for (const caseName of [
      "AFTER AN EDIT: the cancellation reverses the edit's re-post, never a reversed line; a card refund brings owed to zero; a replay posts nothing",
      "posts nothing for a booking not yet confirmed on the ledger",
      "the REAL cancelBooking, cash-settled at a 50% tier: reversals and the kept fee post in the claim, and the hand-back brings owed to zero",
      "the REAL cancelBooking on an unpaid booking confirmed on the ledger (its mark-paid since reversed): the stay is reversed and no fee posts",
    ]) {
      expect(suite).toContain(caseName);
    }
  });

  it("still gates on the harness's variable and carries its three proofs", () => {
    const suite = source(
      resolve(REPO_ROOT, "src/lib/__tests__/booking-ledger-posting-key.realdb.test.ts"),
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    for (const caseName of [
      "skips a repeated key rather than refusing it, and the transaction survives to commit",
      "CONTRAST: the same repeat without the door's skip is refused and loses the whole transaction",
      "the confirmation fence sees a line with NO key, so a line posted before keys existed still fences",
    ]) {
      expect(suite).toContain(caseName);
    }
  });
});
