import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "./support/strip-comments";

/**
 * INV-INT-039: the real-PostgreSQL proof that a stale PROCESSING Xero inbound
 * event is taken over and applied exactly once self-skips without
 * `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it through the race
 * harness importing it. Lose that import and the proof silently becomes a
 * no-op while every suite stays green - so the edge is pinned here.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

const RACE_IMPORT = 'import "./xero-inbound-stale-event-takeover.realdb.test";';
const hasRaceImport = (source: string) => stripComments(source).includes(RACE_IMPORT);

describe("the stale inbound event takeover's real-database proof stays wired into CI (INV-INT-039)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(hasRaceImport(harness)).toBe(true);
    const suite = stripComments(readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/xero-inbound-stale-event-takeover.realdb.test.ts"), "utf8"));
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("one automatic run applies the stuck event");
    expect(suite).toContain("of two automatic runs racing over one stuck event, it is applied exactly once");
    expect(suite).toContain("leaves an event still inside the lease alone");
    expect(suite).toContain("of two takeovers racing over one stuck event");
    expect(suite).toContain("a takeover never resets a live or reclaimed event");
    expect(suite).toContain('assertSafeRaceDbUrl(RACE_DB_URL, "Stale PROCESSING Xero inbound event takeover (INV-INT-039)")');
    expect(suite.indexOf("assertSafeRaceDbUrl(RACE_DB_URL")).toBeLessThan(suite.indexOf('await import("@/lib/prisma")'));
  });

  it.each([`// ${RACE_IMPORT}`, `/* ${RACE_IMPORT} */`])("a commented import does not wire the proof: %s", (comment) => {
    expect(hasRaceImport(comment)).toBe(false);
    expect(hasRaceImport(`${comment}\n${RACE_IMPORT}`)).toBe(true);
  });
});
