import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4285 (`INV-PAY-043`): the real-PostgreSQL proof that a card capture's success
 * arriving on a COMPLETED booking is judged as on a PAID one self-skips without
 * `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it only because the race
 * harness imports it. Lose that import and the proof silently becomes a no-op
 * while every suite stays green - so the edge is pinned here, as
 * `third-duplicate-capture-realdb-wiring.test.ts` pins #4211's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the COMPLETED-redelivery real-database proof stays wired into CI (#4285)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./completed-redelivery.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/completed-redelivery.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("the recorded settler's redelivery on a COMPLETED booking answers already paid and changes nothing");
    expect(suite).toContain('await import("@/lib/cron-complete-bookings")');
    expect(suite).toContain("processStripeWebhookEvent(event)");
    expect(suite).toContain("completedRedeliveryDeployQuery()");
  });
});
