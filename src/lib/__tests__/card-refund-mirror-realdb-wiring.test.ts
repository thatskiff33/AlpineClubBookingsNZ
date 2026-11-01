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
    // #3640 (delta review, D1): the lock-order proofs.
    expect(suite).toContain("a cancel failing an unpaid top-up, racing a card refund's webhook, does not deadlock");
    expect(suite).toContain("nor when the claim's #1491 fold took the transaction row before the top-up write");
  });

  // #4083: the refused-refund proof rides the same harness.
  it("wires the refused card refund's real-database proof the same way (#4083)", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./refused-card-refund-retry.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/refused-card-refund-retry.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("a second enqueue of the edit's refusal writes no second row, and never re-plans a row a worker holds");
    expect(suite).toContain("the REAL cancelBooking, Stripe answering the card refund refused (#4096)");
    expect(suite).toContain("the runner moves a refused slice only on the attempt it holds");
  });

  // #4217: the Payment-row-first proofs ride the same harness.
  it("wires the payment-lock-before-rebuild real-database proof the same way (#4217)", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./payment-lock-before-rebuild.realdb.test";');
    expect(harness).toContain('import "./additional-ask-reduction.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/payment-lock-before-rebuild.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("pg_blocking_pids");
    for (const race of ["RACE 1:", "RACE 2:", "RACE 3:", "RACE 4:", "RACE 5:", "RACE 6 (the cost):", "RACE 7:"]) expect(suite).toContain(race);
    const reduction = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/additional-ask-reduction.realdb.test.ts"),
      "utf8",
    );
    expect(reduction).toContain("RACE (#4217): the capture webhook holding the Payment row while the retire starts");
    expect(reduction).toContain("RACE (#4217 F1): a credit give-back's reduction racing the runner's claim hold");
  });

  // #4104: the failed-later refund proof rides the same harness.
  it("wires the failed-later card refund's real-database proof the same way (#4104)", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./card-refund-failed-later.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/card-refund-failed-later.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("two deliveries at once take the refund out once and write one row");
    expect(suite).toContain("the event before the door's own write");
    expect(suite).toContain("one a worker holds is refused, and nothing commits");
  });

  // #4166: the proof that a cancel's refund failing later is told by its own row rides the same harness.
  it("wires the failed-later cancel refund narrative's real-database proof the same way (#4166)", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./cancel-card-refund-failed-later.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/cancel-card-refund-failed-later.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("refunded, then failed later: on its way - and the runner's retry made it again");
    expect(suite).toContain("the retry failed later too: stalled, the club follows it up - then paid another way");
    expect(suite).toContain("X, the cancel's, fails: the writer records the cancel row as its maker");
    expect(suite).toContain("R, the appeal's, fails: no row of the payment sent it");
  });

  // #4097: the cancel's card refund shortfall proof rides the same harness.
  it("wires the card refund shortfall's real-database proof the same way (#4097)", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./cancel-card-refund-shortfall.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/cancel-card-refund-shortfall.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("a partial plan: the card refunds what it carries, and the rest is ONE task");
    expect(suite).toContain("a zero plan: no card refund, the whole refund owed");
    expect(suite).toContain("the card part still being refunded");
    expect(suite).toContain("both parts: check-then-bank is refused, bank-then-check settles both");
  });

  // #3793: the paid cancel's read-under-lock proof rides the same harness.
  it("wires the paid cancel's refunded-total race proof the same way (#3793)", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./paid-cancel-refunded-total-race.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/paid-cancel-refunded-total-race.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("is not refunded again at the tier");
    expect(suite).toContain("lockPaymentForRefundedTotal(tx, PAYMENT_ID)");
  });

  // #4154: the capacity race's shortfall task rides the same harness.
  it("wires the capacity race's shortfall task proof the same way (#4154)", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(harness).toContain('import "./capacity-race-refund-shortfall-task.realdb.test";');
    const suite = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/capacity-race-refund-shortfall-task.realdb.test.ts"), "utf8");
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("a partial plan: the card refunds what it carries, the rest is ONE task to check");
    expect(suite).toContain("the card refund still being sent: completion is refused, and nothing corrected, until the runner makes the race's refund");
    expect(suite).toContain("an empty plan whose records drifted: nothing by card, the whole charge to check");
    expect(suite).toContain("a later intent's charge captured on the payment, holding plenty, is never the task's");
    expect(suite).toContain("a charge made before the refund ledger started is never corrected");
  });

  // #4125: the capacity race's runner-recorded refund rides the same harness.
  it("wires the capacity race's runner-recorded refund proof the same way (#4125)", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./capacity-race-refund-event.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/capacity-race-refund-event.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("the runner's replay records ONE REFUNDED event for the plan's total");
    expect(suite).toContain("the worker's close finds it closed and writes no event");
    expect(suite).toContain("an event insert the database refuses rolls the close back");
    expect(suite).toContain("a dead row reads as stalled");
  });

  // #4280: the proof that a reversal keeps a Paid another way close's bank cash rides the same harness.
  it("wires the reversal floor's bank cash real-database proof the same way (#4280)", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./card-refund-reversal-bank-cash-floor.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/card-refund-reversal-bank-cash-floor.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("late %s then %s: the total keeps the close's bank cash, and Refunds owed reads nothing");
    expect(suite).toContain("refund first: the close reads it and refuses, so no bank cash is recorded");
    expect(suite).toContain("two deliveries of the failure at once take it out once, write one row, and keep the close's cash");
  });

  // #4210: the proof that a refund failing after a Paid another way close is held, never re-sent, rides the same harness.
  it("wires the held failed-later refund's real-database proof the same way (#4210)", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./card-refund-failed-later-after-paid-another-way.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/card-refund-failed-later-after-paid-another-way.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("full close, late %s then %s: held for an officer, alerted once, never re-sent; Refunds owed reads nothing");
    expect(suite).toContain("with no close, unchanged: the row the runner made it for owes it again, live, and the runner sends it");
    expect(suite).toContain("close first: the failure finds the row closed Paid another way, and its row is held, alerted, never re-sent");
    expect(suite).toContain("two deliveries of the failure at once: one held row, one alert");
  });
});
