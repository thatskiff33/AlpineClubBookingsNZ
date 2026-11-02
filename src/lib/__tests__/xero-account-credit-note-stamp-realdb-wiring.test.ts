import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "./support/strip-comments";

/**
 * #4685: the real-PostgreSQL proof that an account-credit Xero note stamps the
 * one credit it was raised for self-skips without `RUN_CONCURRENCY_RACE_TESTS`,
 * and hosted CI reaches it through the race harness importing it. Lose that
 * import and the proof silently becomes a no-op while every suite stays green -
 * so the edge is pinned here, as `xero-late-failure-after-retry-realdb-wiring.test.ts`
 * pins #4673's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

const RACE_IMPORT = 'import "./xero-account-credit-note-stamp.realdb.test";';
const hasRaceImport = (source: string) => stripComments(source).includes(RACE_IMPORT);

describe("the account-credit note stamp's real-database proof stays wired into CI (#4685)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(hasRaceImport(harness)).toBe(true);
    const suite = stripComments(readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/xero-account-credit-note-stamp.realdb.test.ts"), "utf8"));
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("MUTATION: two equal credits on one booking each get their own note");
    expect(suite).toContain("MUTATION: a row queued without the credit id, as the deployed release queues it, still stamps by the old match");
    expect(suite).toContain("a replay of the linked note stamps no second credit");
    expect(suite).toContain("MUTATION: a failed create keeps the credit on its executed payload, and the Retry stamps that credit");
    expect(suite).toContain("MUTATION #4705: an inbound note on a booking with two equal cancellation credits stamps one only, the oldest");
    expect(suite).toContain("MUTATION #4705: an inbound note stamps the credit its own outbox row named, not the older equal one");
    expect(suite).toContain("MUTATION #4705: an inbound note a lot of another kind already records stamps no cancellation credit");
    expect(suite).toContain("MUTATION #4705: an inbound note reaching the payment by a link no account-credit outbox row explains stamps nothing");
    expect(suite).toContain("processQueuedXeroOutboxOperations");
    expect(suite).toContain("enqueueXeroAccountCreditNoteOperation");
    expect(suite).toContain('assertSafeRaceDbUrl(RACE_DB_URL, "Account-credit note stamp by id (#4685)")');
    expect(suite.indexOf("assertSafeRaceDbUrl(RACE_DB_URL")).toBeLessThan(suite.indexOf('await import("@/lib/prisma")'));
  });

  it.each([`// ${RACE_IMPORT}`, `/* ${RACE_IMPORT} */`])("a commented import does not wire the proof: %s", (comment) => {
    expect(hasRaceImport(comment)).toBe(false);
    expect(hasRaceImport(`${comment}\n${RACE_IMPORT}`)).toBe(true);
  });
});
