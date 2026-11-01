import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #3403 (`INV-PAY-140`): the real-PostgreSQL proof that a superseded card
 * change's waiting Xero invoice follows the request carrying its balance
 * self-skips without `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it
 * only because the race harness imports it. Lose that import and the proof
 * silently becomes a no-op while every suite stays green - so the edge is
 * pinned here, as `ended-booking-ask-mint-realdb-wiring.test.ts` pins #4316's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("INV-PAY-140: the superseded-invoice carry proof stays wired into CI (#3403)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./superseded-ask-invoice-carry.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/superseded-ask-invoice-carry.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    for (const proof of [
      "A -> B -> B captured: both invoices go out, each for its own amount, and their payments sum to the capture",
      "B never paid: nothing is invoiced, and when the booking is cancelled both invoices are retired",
      "B captured before A's cancel lands: A's invoice is released at the move",
      "#4422: a DECLINED A is cancelled at Stripe at B's mint, so a stale tab cannot pay it, and its invoice moves all the same",
      "A -> B -> C: three invoices on C's capture, each its own, summing to it",
      "the reduction first, the move queued on A's anchor: A's invoice is retired, counted once, and never moved",
      "the move first: the reduction still retires A's invoice off B and reads it as A's own money, once",
      "%s first: one invoice for A's change, waiting on B",
      "two bank-transfer edits: each invoice was queued unpaid when priced; nothing waits and nothing moves",
      "M1: a DECLINED A paid from a stale tab after its invoice moved takes it back: A's capture records A's invoice",
      "C4: a capture after A, then a newer request: A's invoice moves onto the capture that absorbed it, never dropped",
      "C2 (review 2, F5): the move onto a captured carrier against that carrier's REAL receipt deciding, on the carrier's key",
      "the receipt decides first: it records B, and A's invoice moved onto B goes out unpaid",
      "the move decides first: the receipt already running counts, so A's invoice still goes out unpaid and the receipt records B against it",
      "C5: B's capture lands while the move waits on A's key - the move, reading under the key, releases A's invoice itself",
      "F1: A moved to B, then B captured late while C supersedes - both invoices follow on to C, never stranded on the refunded B",
      "a move made unpaid by the carrier's own receipt is paid again when A's own capture takes it back",
      "the carrier first: its invoices record all of B; A's own capture is recorded by its own receipt, never stood down",
      "the ask first: A's invoice comes back and records A; B's own invoice records only B's own amount, and an officer is told once that B paid A's change again",
      "a carrier with no invoice of its own whose receipt is still queued: the move writes A's invoice unpaid, so B's receipt records B instead of standing down",
      "#4422: a declined ask's stale-tab capture racing its cancel, the carrier already paid and released",
      "the %s claims A first: one superseded refund, both invoices stay on B, nothing recorded for A",
      "#4442: A captures after B is sized; B is withheld and recovery asks only for B's own change",
      "#4442: A captured while B's queue waits on the global key is read under the lock; B is withheld",
      "#4442: A captured inside the recovery runner's replay of B; the claim hold refuses it and the next replay asks only for B",
      "#4442 C-F2: a frozen replay re-reads the live balance it was minted over - A paid inside its mint refuses the write",
    ]) {
      expect(suite).toContain(proof);
    }
  });
});
