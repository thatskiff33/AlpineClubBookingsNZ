import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4449: the real-PostgreSQL proof that a cancel queued behind a kept
 * bank-transfer settle reads the net the cash supports self-skips without
 * `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it only because the race
 * harness imports it. Lose that import and the proof silently becomes a no-op
 * while every suite stays green - so the edge is pinned here, as
 * `xero-modification-note-repair-claim-realdb-wiring.test.ts` pins #4259's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the kept settle's queued-cancel real-database proof stays wired into CI (#4449)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./kept-settle-queued-cancel.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/kept-settle-queued-cancel.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("CASE 2:");
    expect(suite).toContain("CASE 1, SETTLE FIRST:");
    expect(suite).toContain("CASE 1, SYNC FIRST:");
    // #5289 B, C, G: the outbound completion and link-only races, on the real sync.
    expect(suite).toContain("LINK-ONLY, SETTLE FIRST:");
    expect(suite).toContain("OUTBOUND FIRST:");
    expect(suite).toContain("syncFakeXeroCreditNote");
  });

  it.each([
    ["voided-modification-note-recount", "reconcileXeroCreditNote"],
    ["bank-transfer-floor-corrections", "syncInternetBankingPaymentsForPaidInvoice"],
    ["card-refund-ledger-never-lowered", "reconcileXeroCreditNote"],
  ])("imports #5289's %s proof too", (name, writer) => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(harness).toContain(`import "./${name}.realdb.test";`);
    const suite = readFileSync(resolve(REPO_ROOT, `src/lib/__tests__/${name}.realdb.test.ts`), "utf8");
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain(writer);
  });

  it("imports the kept settle's failed-later card refund proof too (#4449 review, item 1)", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./kept-settle-failed-card-refund.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/kept-settle-failed-card-refund.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("syncInternetBankingPaymentsForPaidInvoice");
  });

  it("imports the one-floor-alert-per-sync proof too (#4449 verify, low 2)", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(harness).toContain('import "./allocation-floor-alert-once.realdb.test";');
    const suite = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/allocation-floor-alert-once.realdb.test.ts"), "utf8");
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("reconcileXeroCreditNote");
  });
});
