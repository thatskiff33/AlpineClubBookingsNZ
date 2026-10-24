import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #3953: the PostgreSQL proof that a change's card capture gets one Xero
 * receipt self-skips without `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI
 * reaches it only through the race harness's import. Lose the import and the
 * proof silently stops running.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the change capture receipt proof stays wired into CI (#3953)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./additional-capture-receipt.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/additional-capture-receipt.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("the webhook and the confirm route at once, then a replay, queue one receipt");
    expect(suite).toContain("many enqueues at once make one row");
    expect(suite).toContain("queues behind a session holding the change's supplementary-invoice anchor lock");
    expect(suite).toContain("is recorded once, by its receipt, where the figures say the primary's cash did not cover it");
    expect(suite).toContain("is recorded once, by the gap invoice that names it, where the figures cannot say");
    expect(suite).toContain("only one of two receipts claimed at once reaches Xero; the other waits for it");
    expect(suite).toContain("both gates queue on the booking's anchor lock held elsewhere; released, only one passes");
    expect(suite).toContain("an invoice for the change queued after its capture's receipt stored a decision is raised unpaid");
    expect(suite).toContain("a create dead past the staleness threshold blocks neither; a live one blocks both");
    expect(suite).toContain("a retired invoice revived for the capture while its receipt stores a decision is revived unpaid");
    // Round 7: a capture whose ledger row carries no change stamp.
    expect(harness).toContain('import "./additional-capture-receipt-unattributed.realdb.test";');
    const unattributed = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/additional-capture-receipt-unattributed.realdb.test.ts"),
      "utf8",
    );
    expect(unattributed).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(unattributed).toContain("a review charge's capture, read to its change by its reason, makes that change's paid invoice unpaid");
    expect(unattributed).toContain("a capture no change can be read from: the enqueue queues on the booking's lock first");
    expect(unattributed).toContain("a legacy capture's receipt leaves a later change's invoice naming its own capture paid");
  });
});
