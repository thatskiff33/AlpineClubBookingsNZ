import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4230 (`INV-ADDPAY-021`, `INV-PAY-124`): the real-PostgreSQL pins that a
 * group organiser's hand-back leaves the bank-transfer recount nothing to drop,
 * that the recount never writes the charge rows the #4162 floor keeps, of the
 * later refunds noted on their own records (#4287, #4312) and the alert a
 * refund folded before them raises, and of the deploy note's query,
 * self-skip without `RUN_CONCURRENCY_RACE_TESTS`; hosted CI reaches them only
 * because the race harness imports them. Lose that import and they silently
 * become a no-op while every suite stays green, so the edge is pinned here.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the bank-transfer recount hand-back pins stay wired into CI (#4230)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(harness).toContain('import "./xero-bt-recount-handbacks.realdb.test";');
    const suite = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/xero-bt-recount-handbacks.realdb.test.ts"), "utf8");
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("a group organiser's hand-back moves no payment's refunded total");
    expect(suite).toContain("the recount writes the payment's refunded total and never its charge rows");
    expect(suite).toContain("a second cancellation hand-back is queued its own note, keyed on its task");
    expect(suite).toContain("a refund request's card part on a bank transfer is queued its own note, keyed on its card refund");
    expect(suite).toContain("a payment whose refunds all have notes is not listed by the deploy note's query");
    expect(suite).toContain("a review's refund on a cancelled booking counts with its own note");
    expect(suite).toContain("a void the nightly follow-up undid is not listed");
    expect(suite).toContain("which void states reach the alert");
  });

  it("#4287's per-refund note proofs (INV-ADDPAY-043) are imported by the race harness too", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(harness).toContain('import "./xero-bt-per-refund-notes.realdb.test";');
    const suite = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/xero-bt-per-refund-notes.realdb.test.ts"), "utf8");
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("a second cancellation hand-back gets its own note, keyed and sized on its task");
    expect(suite).toContain("two hand-backs completed at once on a payment with no note yet");
    expect(suite).toContain("the hand-back's own note never squeezes the card note raised after it");
    expect(suite).toContain("a refund the old release absorbed is never given a note");
    expect(suite).toContain("the nightly self-heal never selects a bank-transfer payment");
    expect(suite).toContain("two hand-backs of the same amount completed at once: two notes");
    expect(suite).toContain("a card refund landing after the hand-back completes cannot shrink its note");
    expect(suite).toContain("a later card note is raised in full (review F1)");
    expect(suite).toContain("a later canonical note on a bank transfer is raised in full (review F1)");
    expect(suite).toContain("a re-confirmed follow-up's fresh note counts beside its cash");
    expect(suite).toContain("a follow-up re-confirmed with a note made by hand in Xero counts once");
    expect(suite).toContain("that hand-made note voided in Xero and undone in turn");
  });

  it("#4312's card refund note proofs (INV-ADDPAY-047) are imported by the race harness too", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(harness).toContain('import "./xero-bt-card-refund-notes.realdb.test";');
    const suite = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/xero-bt-card-refund-notes.realdb.test.ts"), "utf8");
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("a refund request's card part: the approval notes each refund it made on its own record");
    expect(suite).toContain("a refund request's card part the recovery queue makes later");
    expect(suite).toContain("a recovery row an older approval wrote");
    expect(suite).toContain("the webhook: a refund made in the Stripe dashboard gets its own note");
    expect(suite).toContain("the webhook leaves a refund request's refund to the approval");
    expect(suite).toContain("a late capture's refund on a bank transfer gets its own note");
    expect(suite).toContain("two writers asking for one card refund at once raise one row (race)");
    expect(suite).toContain("a refund made before the cutover still takes the one note an older release gave it");
    expect(suite).toContain("a late capture on a payment with no note yet");
    expect(suite).toContain("a card refund's voided note is never matched to a bank refund");
  });
});
