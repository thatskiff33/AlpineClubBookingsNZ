/**
 * The organiser cancel's per-child ledger half (#3854): which refund line it
 * posts and what it says the club keeps, for each kind of plan. The lines
 * themselves are proved against PostgreSQL in
 * `booking-ledger-group-settlement.realdb.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  postCancellationLedgerLines: vi.fn(async () => {}),
  organiserChildCommittedRefundCents: vi.fn(async () => 0),
  createMany: vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length })),
}));
vi.mock("@/lib/booking-ledger-cancellation-sync", () => ({ postCancellationLedgerLines: mocks.postCancellationLedgerLines }));
vi.mock("@/lib/organiser-child-refund", () => ({ organiserChildCommittedRefundCents: mocks.organiserChildCommittedRefundCents }));
vi.mock("@/lib/logger", () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { postGroupCancelChildLedgerLines } from "@/lib/booking-ledger-group-settlement-sync";

const tx = { bookingLedgerLine: { createMany: mocks.createMany } } as never;
const paidChild = {
  id: "c1",
  lodgeId: "l1",
  status: "PAID" as const,
  payment: { id: "p1", status: "SUCCEEDED", amountCents: 4_500, refundedAmountCents: 0 },
};
const card = { id: "gs1", source: "STRIPE" as const, stripePaymentIntentId: "pi_1" };
const bank = { id: "gs2", source: "INTERNET_BANKING" as const, stripePaymentIntentId: null };
const kept = () => (mocks.postCancellationLedgerLines.mock.calls.at(-1) as unknown as [{ keptCents: number }])[0].keptCents;

describe("postGroupCancelChildLedgerLines", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a mirror plan: posts the refund beside the mirror and keeps the share less it", async () => {
    await postGroupCancelChildLedgerLines(tx, { child: paidChild, settlement: bank, mirrorPlan: true, refundForChild: 2_250, plannedRefundCents: 2_250 });
    expect(mocks.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ bookingId: "c1", kind: "BANK_REFUND", amountCents: -2_250, anchorKind: "GROUP_SETTLEMENT", anchorId: "gs2" })],
      skipDuplicates: true,
    });
    expect(kept()).toBe(2_250);
  });

  it("a card mirror plan whose refund failed: no refund line yet, but the frozen plan already counts as owed", async () => {
    await postGroupCancelChildLedgerLines(tx, { child: paidChild, settlement: card, mirrorPlan: true, refundForChild: 0, plannedRefundCents: 4_500 });
    expect(mocks.createMany).not.toHaveBeenCalled();
    expect(kept()).toBe(0);
  });

  it("a #3653 per-child plan: posts no refund line (its refund row does) and keeps the share less every refund made or owed", async () => {
    mocks.organiserChildCommittedRefundCents.mockResolvedValueOnce(3_000);
    await postGroupCancelChildLedgerLines(tx, { child: paidChild, settlement: card, mirrorPlan: false, refundForChild: 1_500, plannedRefundCents: 0 });
    expect(mocks.createMany).not.toHaveBeenCalled();
    expect(mocks.organiserChildCommittedRefundCents).toHaveBeenCalledWith(tx, paidChild.payment, "pi_1");
    expect(kept()).toBe(1_500);
  });

  it("keeps nothing for a child the settlement never paid, or with no settlement", async () => {
    await postGroupCancelChildLedgerLines(tx, {
      child: { ...paidChild, status: "CONFIRMED", payment: null },
      settlement: card,
      mirrorPlan: false,
      refundForChild: 0,
      plannedRefundCents: 0,
    });
    expect(kept()).toBe(0);
    await postGroupCancelChildLedgerLines(tx, { child: paidChild, settlement: null, mirrorPlan: false, refundForChild: 0, plannedRefundCents: 0 });
    expect(kept()).toBe(0);
    expect(mocks.postCancellationLedgerLines).toHaveBeenLastCalledWith(
      expect.objectContaining({ bookingId: "c1", site: "group-cancel:organiser-settled-child" }),
    );
  });
});
