import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "./support/strip-comments";

/**
 * #4288: the real-PostgreSQL proof that an older live Xero reading never
 * revives a voided refund-note mirror self-skips without
 * `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it only because the race
 * harness imports it. Lose that import and the proof silently becomes a no-op
 * while every suite stays green - so the edge is pinned here, as
 * `xero-canonical-refund-note-void-race-realdb-wiring.test.ts` pins #4223's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

const RACE_IMPORT = 'import "./xero-refund-note-stale-live-status.realdb.test";';
const hasRaceImport = (source: string) => stripComments(source).includes(RACE_IMPORT);

describe("the stale live refund-note status proof stays wired into CI (#4288)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(hasRaceImport(harness)).toBe(true);
    const suite = stripComments(readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/xero-refund-note-stale-live-status.realdb.test.ts"), "utf8"));
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain('const CASES: Case[] = ["bank-transfer canonical", "Stripe per-delta", "bank-transfer per-refund", "refund request"];');
    expect(suite).toContain("%s: a live reading taken before the void and written after it keeps the void (schedule A)");
    expect(suite).toContain("bank-transfer canonical: a live reconcile queued on the void's row lock keeps the void (lock-queued)");
    expect(suite).toContain("MUTATION (order): an older live reading queued behind a newer live one keeps the newer snapshot (lock-queued)");
    expect(suite).toContain("a newer live reading is applied through the real reconcile: AUTHORISED to PAID is ordinary");
    expect(suite).toContain("MUTATION (pointer): a stale live write keeps the void without waiting on the Payment a Payment-first enqueue holds (race)");
    expect(suite).toContain("MUTATION (recount): a bank transfer's stale reconcile recounts the kept void, so the void's lowered total is not raised back");
    expect(suite).toContain("MUTATION (recount, card): a card payment's stale reconcile never raises its total from the voided note");
    expect(suite).toContain("MUTATION (review 1): A's live link write, then B's void and B's recount, then A's recount - A counts the void it reads now");
    expect(suite).toContain("MUTATION (review 2): a stale reading kept under a newer LIVE snapshot still records its allocations and refund payments");
    expect(suite).toContain("MUTATION (refund payments): a stale reconcile writes no refund-payment link from its older reading's payments");
    expect(suite).toContain("MUTATION (allocations): a stale reconcile writes no allocation link from its older reading's allocations");
    expect(suite).toContain("MUTATION (round 4, review 1): A reads the live note's row, then the void and B's recount, then A claims - A recounts the void");
    expect(suite).toContain("MUTATION (round 6): on a card payment A writes nothing when the void commits before its locked re-read");
    expect(suite).toContain("MUTATION (round 6): a void committing after A's locked re-read is A, then the void, then B - on a bank transfer B lowers it back");
    expect(suite).toContain("MUTATION (round 5, F4): a live row deactivated between A's read and its claim recounts too - judged by the rule that counted it");
    expect(suite).toContain("MUTATION (round 7, F4): the pointer-named canonical note - the void waits on A's Payment lock before it takes the link");
    expect(suite).toContain("round 6 stated limit: on a card the same order leaves A's raise standing, raise-only, and alerts");
    expect(suite).toContain("pg_blocking_pids");
    expect(suite).toContain('assertSafeRaceDbUrl(RACE_DB_URL, "Stale live refund-note status")');
    expect(suite.indexOf("assertSafeRaceDbUrl(RACE_DB_URL")).toBeLessThan(suite.indexOf('await import("@/lib/prisma")'));
  });

  it.each([`// ${RACE_IMPORT}`, `/* ${RACE_IMPORT} */`])("a commented import does not wire the proof: %s", (comment) => {
    expect(hasRaceImport(comment)).toBe(false);
    expect(hasRaceImport(`${comment}\n${RACE_IMPORT}`)).toBe(true);
  });
});
