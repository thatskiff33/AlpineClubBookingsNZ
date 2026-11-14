import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "./support/strip-comments";

/**
 * INV-INT-038: the real-PostgreSQL proof that an abandoned inbound Xero
 * reconcile operation is recovered under a fresh claim self-skips without
 * `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it through the race
 * harness importing it. Lose that import and the proof silently becomes a
 * no-op while every suite stays green - so the edge is pinned here.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

const RACE_IMPORT = 'import "./xero-inbound-abandoned-operation.realdb.test";';
const hasRaceImport = (source: string) => stripComments(source).includes(RACE_IMPORT);

describe("the abandoned inbound operation's real-database proof stays wired into CI (INV-INT-038)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(hasRaceImport(harness)).toBe(true);
    const suite = stripComments(readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/xero-inbound-abandoned-operation.realdb.test.ts"), "utf8"));
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("of two attempts racing to take one abandoned row over, exactly one wins");
    expect(suite).toContain("a takeover racing an officer's Mark failed");
    expect(suite).toContain("refuses the abandoned attempt's late success and late failure");
    expect(suite).toContain('assertSafeRaceDbUrl(RACE_DB_URL, "Abandoned inbound Xero reconcile operation (INV-INT-038)")');
    expect(suite.indexOf("assertSafeRaceDbUrl(RACE_DB_URL")).toBeLessThan(suite.indexOf('await import("@/lib/prisma")'));
  });

  it.each([`// ${RACE_IMPORT}`, `/* ${RACE_IMPORT} */`])("a commented import does not wire the proof: %s", (comment) => {
    expect(hasRaceImport(comment)).toBe(false);
    expect(hasRaceImport(`${comment}\n${RACE_IMPORT}`)).toBe(true);
  });
});
