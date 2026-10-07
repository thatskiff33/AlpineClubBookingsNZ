// #3372 (owner, 7 Oct 2026): "Those numbers need to reconcile as the total of
// all refunds owed but not yet paid and all credits issued and not yet
// applied/used." Each figure is checked against an independent sum of the
// shared fixture, not against the code's own arithmetic.
import { describe, expect, it, vi } from "vitest";

import {
  REFUNDS_AND_CREDITS_OWED_FIXTURE,
  creditBalanceGroupRows,
  refundsOwedTaskRows,
} from "@/lib/__tests__/helpers/net-collected-scope-fixture";
import { readRefundsAndCreditsOwed } from "@/lib/refunds-and-credits-owed";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

function fakeDb() {
  return {
    manualRefundTask: { findMany: vi.fn(async () => refundsOwedTaskRows()) },
    memberCredit: { groupBy: vi.fn(async () => creditBalanceGroupRows()) },
  };
}

describe("Refunds owed and Credits owed reconcile to their totals", () => {
  it("Refunds owed is the sum of every open refund obligation", async () => {
    const db = fakeDb();
    const owed = await readRefundsAndCreditsOwed(db as never);

    const openObligations = REFUNDS_AND_CREDITS_OWED_FIXTURE.openTasks
      .filter((task) => task.refundOwed)
      .reduce((sum, task) => sum + (task.amountCents ?? 0), 0);
    expect(owed.refundsOwedCents).toBe(openObligations);
    expect(owed.refundsOwedCents).toBe(REFUNDS_AND_CREDITS_OWED_FIXTURE.expectedRefundsOwedCents);
    // Read as at today: every OPEN task, no date, lodge or booking filter.
    expect(db.manualRefundTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "OPEN" } }),
    );
  });

  it("Credits owed is the sum of members' unused credit balances", async () => {
    const owed = await readRefundsAndCreditsOwed(fakeDb() as never);

    const balances = new Map<string, number>();
    for (const entry of REFUNDS_AND_CREDITS_OWED_FIXTURE.creditEntries) {
      balances.set(entry.memberId, (balances.get(entry.memberId) ?? 0) + entry.amountCents);
    }
    const unused = [...balances.values()].filter((cents) => cents > 0).reduce((a, b) => a + b, 0);
    expect(owed.creditsOwedCents).toBe(unused);
    expect(owed.creditsOwedCents).toBe(REFUNDS_AND_CREDITS_OWED_FIXTURE.expectedCreditsOwedCents);
  });

  it("drops a refund from Refunds owed once it is paid back or dismissed", async () => {
    const db = fakeDb();
    db.manualRefundTask.findMany.mockResolvedValue(
      refundsOwedTaskRows().map((task) => ({ ...task, status: "COMPLETED" })),
    );
    expect((await readRefundsAndCreditsOwed(db as never)).refundsOwedCents).toBe(0);
  });
});
