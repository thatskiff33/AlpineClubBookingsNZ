import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4320 (`INV-PAY-045`): the real-PostgreSQL proof that a manual mark-paid's
 * reversal re-derives which intents stay cancelled and withdraws the rest (one
 * a Stripe outage left FAILED and retrying included), and that the superseded
 * hand-off waits for it on the Payment row, self-skips without
 * `RUN_CONCURRENCY_RACE_TESTS`, and
 * hosted CI reaches it only because the race harness imports it. Lose that
 * import and the proof silently becomes a no-op while every suite stays green -
 * so the edge is pinned here, as `superseded-intent-card-doors-realdb-wiring.test.ts`
 * pins #4300's. Each scenario is matched with its `it("` opening, so one
 * turned into `it.skip(` or `it.todo(` fails here too.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("INV-PAY-045: the mark-paid reversal's retrying-cancel real-database proof stays wired into CI (#4320)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./manual-reversal-retrying-cancel.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/manual-reversal-retrying-cancel.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    for (const scenario of [
      "the mark-paid's own cancel, FAILED and retrying, is withdrawn: the member's capture of that intent settles the booking",
      "the mark-paid's own cancel, FAILED and retrying, is withdrawn: a later worker run cancels nothing",
      "the mark-paid's own cancel, exhausted at the ceiling, is withdrawn too: the reversal makes it moot",
      "an edit's cancel the mark-paid found waiting (FAILED, retrying) outlives the reversal: the superseded intent is still cancelled",
      "an edit's cancel the mark-paid found waiting outlives the reversal: the old tab's capture is refunded, never settles (INV-PAY-138)",
      "MUTATION: an edit on the PAID booking that shares the settle's cancel row: the reversal keeps the intent at the old price cancelled, and its old tab's capture is refunded",
      "MUTATION: a condemned intent's cancellation the runner gave up on during the outage is re-armed by the reversal and cancels once Stripe is back",
      "MUTATION: a condemned intent's cancellation on its last attempt while the reversal runs is re-armed; the worker's failure cannot kill it, and it cancels once Stripe is back",
      "MUTATION: an intent the settle adopted, whose cancellation gave up during the outage, is re-armed by the reversal and cancels once Stripe is back",
      "MUTATION: a settle recorded before #4320 (no adopted list): the reversal still keeps an edit's stale intent cancelled",
      "MUTATION: the hand-off waits for the reversal on the Payment row: a capture landing mid-reversal settles the booking, never charged and refunded",
    ]) {
      expect(suite).toContain(`it("${scenario}"`);
    }
  });
});
