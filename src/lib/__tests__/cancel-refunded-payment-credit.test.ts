import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ledgerAppliedCents: 0,
  reducedThroughGiveBack: true,
}));

vi.mock("@/lib/member-credit", () => ({
  deriveBookingAppliedCreditCents: vi.fn(async () => mocks.ledgerAppliedCents),
}));
vi.mock("@/lib/booking-credit-give-back-marker", () => ({
  bookingReducedThroughCreditGiveBack: vi.fn(async () => mocks.reducedThroughGiveBack),
}));
vi.mock("@/lib/cancellation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadCancellationPolicy: vi.fn(async () => [{ daysBeforeStay: 0, refundPercentage: 100, fixedFeeCents: 0 }]),
}));

import { refundedPaymentCreditRestore } from "@/lib/cancel-refunded-payment-credit";

/** $50 card refunded whole by a #3809 reduction to $150; $150 of credit still applied. */
function restore(creditAppliedCents: number) {
  return refundedPaymentCreditRestore({} as never, {
    bookingId: "booking_1",
    booking: {
      checkIn: new Date("2026-08-01T00:00:00.000Z"),
      lodgeId: "lodge_1",
      finalPriceCents: 15_000,
      payment: { amountCents: 5_000, refundedAmountCents: 5_000, changeFeeCents: 0, creditAppliedCents },
    },
    openNonCancellationHandBackCents: 0,
    todayAtClub: "2026-07-01" as never,
  });
}

describe("refundedPaymentCreditRestore reads a clipped mirror from the ledger (#3836 L-1)", () => {
  beforeEach(() => {
    mocks.ledgerAppliedCents = 15_000;
    mocks.reducedThroughGiveBack = true;
  });

  it("MUTATION: a mirror the old inbound sync clipped to the $50 card amount tiers the $150 the ledger holds", async () => {
    expect(await restore(5_000)).toEqual({ appliedCreditBaseCents: 15_000, creditToRestoreCents: 15_000 });
  });

  it("a mirror that agrees with the ledger is read as it is", async () => {
    expect(await restore(15_000)).toEqual({ appliedCreditBaseCents: 15_000, creditToRestoreCents: 15_000 });
  });

  it("a legacy full-price capture (mirror 0 under a card amount) keeps its mirror and restores nothing here (INV-PAY-024)", async () => {
    expect(await restore(0)).toBeNull();
  });
});
