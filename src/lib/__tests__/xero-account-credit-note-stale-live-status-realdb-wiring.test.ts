import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "./support/strip-comments";

/**
 * #4347: the real-PostgreSQL proof that an older live Xero reading never
 * revives a voided account-credit note, or counts its refund again, self-skips
 * without `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it only because
 * the race harness imports it. Lose that import and the proof silently becomes
 * a no-op while every suite stays green - so the edge is pinned here, as
 * `xero-refund-note-stale-live-status-realdb-wiring.test.ts` pins #4288's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

const RACE_IMPORT = 'import "./xero-account-credit-note-stale-live-status.realdb.test";';
const hasRaceImport = (source: string) => stripComments(source).includes(RACE_IMPORT);

describe("the stale live account-credit note proof stays wired into CI (#4347)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(hasRaceImport(harness)).toBe(true);
    const suite = stripComments(readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/xero-account-credit-note-stale-live-status.realdb.test.ts"), "utf8"));
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("void, then an older AUTHORISED reading: the void and the $0 refunded total stand (sequential)");
    expect(suite).toContain("an older AUTHORISED reading taken before the void and written after it keeps the void (schedule A)");
    expect(suite).toContain("void then older AUTHORISED (lock-queued): the older reconcile waits on the void's account-credit row and keeps the void");
    expect(suite).toContain("older AUTHORISED then void (lock-queued): the void's reconcile waits on the older write's row and wins");
    expect(suite).toContain("MUTATION (order): between two live readings the older one keeps the newer stored snapshot");
    expect(suite).toContain("a newer live reading after an older live one still applies");
    expect(suite).toContain("card control: both orders keep the void on the link and never raise the card ledger from the voided note");
    expect(suite).toContain("MUTATION (mirror, review): the outside-spend mirror re-checks the reading under the member's credit lock");
    expect(suite).toContain("MUTATION (allocation repair): an older reading's allocation posts nothing to the member's ledger after the void");
    expect(suite).toContain("lock order: the account-credit link write never waits on a held Payment row, and a Payment-first refund-note void completes beside it");
    expect(suite).toContain("pg_blocking_pids");
    expect(suite).toContain('assertSafeRaceDbUrl(RACE_DB_URL, "Stale live account-credit note status")');
    expect(suite.indexOf("assertSafeRaceDbUrl(RACE_DB_URL")).toBeLessThan(suite.indexOf('await import("@/lib/prisma")'));
  });

  it.each([`// ${RACE_IMPORT}`, `/* ${RACE_IMPORT} */`])("a commented import does not wire the proof: %s", (comment) => {
    expect(hasRaceImport(comment)).toBe(false);
    expect(hasRaceImport(`${comment}\n${RACE_IMPORT}`)).toBe(true);
  });
});
