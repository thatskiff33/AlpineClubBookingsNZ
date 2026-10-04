/**
 * The projection census and the group child planner it shares with the
 * back-post load without the Prisma client (#3854): they judge one snapshot
 * in memory, so nothing on their import chain may reach `@/lib/prisma` — the
 * reason the kept formula lives in `cancellation-kept.ts`, not
 * `paid-cancellation-money.ts` (whose `cancellation.ts` does).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => {
  throw new Error("the census reached @/lib/prisma");
});

describe("census purity (#3854)", () => {
  it("imports the census, its report, and the group child planner without reaching the Prisma client", async () => {
    const census = await import("@/lib/booking-ledger-projection-census");
    const report = await import("@/lib/booking-ledger-projection-census-report");
    const plan = await import("@/lib/booking-ledger-group-child-plan");
    expect(typeof census.evaluateBookingLedgerIdentities).toBe("function");
    expect(typeof report.summarizeBookingLedgerCensus).toBe("function");
    expect(plan.groupSettledChildKeptFrom({ amountCents: 4_500, refundedAmountCents: 0 }, { kind: "per-child", committedRefundCents: 5_000 })).toBe(0);
    expect(plan.groupSettledChildKeptFrom({ amountCents: 4_500, refundedAmountCents: 0 }, { kind: "per-child", committedRefundCents: 1_500 })).toBe(3_000);
  });
});
