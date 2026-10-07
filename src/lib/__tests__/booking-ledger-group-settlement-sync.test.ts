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
  openNonCancellationHandBackCents: vi.fn(async () => 0),
  createMany: vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length })),
  findFirst: vi.fn(async (): Promise<{ id: string } | null> => ({ id: "share-line" })),
}));
vi.mock("@/lib/edit-refund-hand-back", () => ({ openNonCancellationHandBackCents: mocks.openNonCancellationHandBackCents }));
vi.mock("@/lib/booking-ledger-cancellation-sync", () => ({ postCancellationLedgerLines: mocks.postCancellationLedgerLines }));
vi.mock("@/lib/organiser-child-refund", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/organiser-child-refund")),
  organiserChildCommittedRefundCents: mocks.organiserChildCommittedRefundCents,
}));
const logger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("@/lib/logger", () => ({ default: logger }));

import { postGroupCancelChildLedgerLines, postGroupSettlementLedgerLines } from "@/lib/booking-ledger-group-settlement-sync";

const tx = { bookingLedgerLine: { createMany: mocks.createMany, findFirst: mocks.findFirst } } as never;
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

  it("posts no refund for a child whose share this settlement never posted (settled before #3854), as the cancellation posts nothing for it", async () => {
    mocks.findFirst.mockResolvedValueOnce(null);
    await postGroupCancelChildLedgerLines(tx, { child: paidChild, settlement: bank, mirrorPlan: true, refundForChild: 2_250, plannedRefundCents: 2_250 });
    expect(mocks.findFirst).toHaveBeenCalledWith({ where: { bookingId: "c1", postingKey: "group-settlement:gs2:child:c1" }, select: { id: true } });
    expect(mocks.createMany).not.toHaveBeenCalled();
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

  it("#3827 (INV-PAY-117): an open edit hand-back the cancel's refund was sized net of is not kept either, under either plan", async () => {
    // $45 paid, a $10 edit refund promised back by hand; the mirror plan refunds 50% of the $35 left.
    mocks.openNonCancellationHandBackCents.mockResolvedValue(1_000);
    await postGroupCancelChildLedgerLines(tx, { child: paidChild, settlement: bank, mirrorPlan: true, refundForChild: 1_750, plannedRefundCents: 1_750 });
    expect(mocks.openNonCancellationHandBackCents).toHaveBeenCalledWith(tx, "p1");
    expect(kept()).toBe(1_750);
    mocks.organiserChildCommittedRefundCents.mockResolvedValueOnce(1_750);
    await postGroupCancelChildLedgerLines(tx, { child: paidChild, settlement: card, mirrorPlan: false, refundForChild: 1_750, plannedRefundCents: 0 });
    expect(kept()).toBe(1_750);
    mocks.openNonCancellationHandBackCents.mockResolvedValue(0);
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

describe("postGroupSettlementLedgerLines", () => {
  beforeEach(() => vi.clearAllMocks());

  const guest = (bookingId: string, nightCents: number) => ({
    id: `${bookingId}-g`,
    firstName: "Joiner",
    lastName: bookingId,
    ageTier: "ADULT" as const,
    rateMembershipTypeId: null,
    nights: [{ stayDate: new Date("2027-09-01T00:00:00.000Z"), priceCents: nightCents }],
  });

  it("builds each child on its own: one that cannot be built drops only its own lines, and is listed", async () => {
    const store = {
      booking: {
        findMany: vi.fn(async () => [
          { id: "good", lodgeId: "l1", totalPriceCents: 4_500, promoAdjustmentCents: 0, guests: [guest("good", 4_500)] },
          // A negative night price: the write door refuses to build it.
          { id: "bad", lodgeId: "l1", totalPriceCents: -1, promoAdjustmentCents: 0, guests: [guest("bad", -1)] },
        ]),
      },
      bookingLedgerLine: { findFirst: vi.fn(async () => null), createMany: mocks.createMany },
    } as never;

    await postGroupSettlementLedgerLines({
      store,
      settlement: { id: "gs1", source: "STRIPE", amountCents: 4_500 },
      children: [
        { id: "good", lodgeId: "l1", finalPriceCents: 4_500 },
        { id: "bad", lodgeId: "l1", finalPriceCents: 0 },
      ],
    });

    const written = (mocks.createMany.mock.calls[0] as unknown as [{ data: Array<{ bookingId: string; kind: string }> }])[0].data;
    expect(written.map((row) => `${row.bookingId}:${row.kind}`)).toEqual(["good:GUEST_NIGHT", "good:CARD_CAPTURE"]);
    expect(logger.error).toHaveBeenCalledWith(
      { settlementId: "gs1", failedBookingIds: ["bad"] },
      expect.stringContaining("posted no lines for these children"),
    );
  });
});
