import { describe, it, expect, vi, beforeEach } from "vitest";

// Bed allocation reconciliation is exercised elsewhere; stub it here.
const mockReconcile = vi.fn().mockResolvedValue({ enabled: false, deletedCount: 0, createdCount: 0 });
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: (...args: unknown[]) => mockReconcile(...args),
}));

// Promo machinery used by recalculateBookingPromo (in booking-guest-removal-service).
const mockValidatePromo = vi.fn();
const mockDeletePromo = vi.fn().mockResolvedValue(undefined);
const mockReplaceAllocations = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/promo", () => ({
  validateAndCalculatePromoDiscount: (...args: unknown[]) => mockValidatePromo(...args),
  deletePromoRedemptionAndAdjustCount: (...args: unknown[]) => mockDeletePromo(...args),
  replacePromoRedemptionAllocations: (...args: unknown[]) => mockReplaceAllocations(...args),
}));

const { applyPartialBumpInTransaction } = await import("../partial-bump");

const CHECK_IN = new Date("2026-07-10");
const CHECK_OUT = new Date("2026-07-12"); // two nights

const SEASON = {
  id: "s1",
  startDate: new Date("2026-01-01"),
  endDate: new Date("2026-12-31"),
  rates: [
    { ageTier: "ADULT", isMember: true, pricePerNightCents: 4000 },
    { ageTier: "ADULT", isMember: false, pricePerNightCents: 6000 },
  ],
};

function makeGuest(id: string, isMember: boolean, memberId: string | null) {
  return {
    id,
    bookingId: "bk1",
    firstName: id,
    lastName: "Test",
    ageTier: "ADULT" as const,
    isMember,
    memberId,
    stayStart: CHECK_IN,
    stayEnd: CHECK_OUT,
    priceCents: isMember ? 8000 : 12000,
  };
}

function makeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "bk1",
    memberId: "m1",
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    status: "PENDING",
    hasNonMembers: true,
    cancelIfGuestsBumped: false,
    totalPriceCents: 20000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 20000,
    promoRedemption: null,
    guests: [
      makeGuest("g1", true, "m1"),
      makeGuest("g2", false, null),
    ],
    ...overrides,
  };
}

function makeTx() {
  return {
    booking: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    choreAssignment: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    bookingGuest: {
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    season: { findMany: vi.fn().mockResolvedValue([SEASON]) },
  };
}

describe("applyPartialBumpInTransaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReconcile.mockResolvedValue({ enabled: false, deletedCount: 0, createdCount: 0 });
  });

  it("removes non-member guests, keeps members, and reprices (no promo)", async () => {
    const tx = makeTx();
    const result = await applyPartialBumpInTransaction({
      tx: tx as never,
      booking: makeBooking() as never,
    });

    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;

    // Claim flips hasNonMembers off and clears the hold.
    expect(tx.booking.updateMany).toHaveBeenCalledWith({
      where: { id: "bk1", status: "PENDING", hasNonMembers: true },
      data: { hasNonMembers: false, nonMemberHoldUntil: null },
    });
    // Non-member guest deleted; member guest kept.
    expect(tx.bookingGuest.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["g2"] } },
    });
    expect(result.removedGuests.map((g) => g.id)).toEqual(["g2"]);
    expect(result.remainingGuests.map((g) => g.id)).toEqual(["g1"]);

    // One member ADULT * 2 nights * 4000 = 8000.
    expect(result.newTotalPriceCents).toBe(8000);
    expect(result.newFinalPriceCents).toBe(8000);
    expect(result.promoRemoved).toBe(false);

    // Booking repriced to the members-only total.
    expect(tx.booking.update).toHaveBeenCalledWith({
      where: { id: "bk1" },
      data: {
        totalPriceCents: 8000,
        discountCents: 0,
        promoAdjustmentCents: 0,
        finalPriceCents: 8000,
      },
    });
    expect(mockReconcile).toHaveBeenCalled();
    // No promo work when there is no redemption.
    expect(mockValidatePromo).not.toHaveBeenCalled();
  });

  it("re-applies a still-valid promo to the remaining guests", async () => {
    const tx = makeTx();
    mockValidatePromo.mockResolvedValue({
      discount: {
        discountCents: 1000,
        priceAdjustmentCents: -1000,
        freeNightsUsed: 0,
        eligibleGuestCount: 1,
        allocations: [],
      },
      selectedGuestIndexes: undefined,
    });
    const booking = makeBooking({
      discountCents: 2000,
      promoAdjustmentCents: -2000,
      finalPriceCents: 18000,
      promoRedemption: {
        id: "pr1",
        promoCodeId: "pc1",
        guestTargets: [],
        promoCode: { id: "pc1", code: "SAVE", assignments: [] },
      },
    });

    const result = await applyPartialBumpInTransaction({
      tx: tx as never,
      booking: booking as never,
    });

    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(mockValidatePromo).toHaveBeenCalled();
    expect(mockReplaceAllocations).toHaveBeenCalled();
    expect(mockDeletePromo).not.toHaveBeenCalled();
    // 8000 members-only total minus 1000 promo adjustment.
    expect(result.newPromoAdjustmentCents).toBe(-1000);
    expect(result.newFinalPriceCents).toBe(7000);
    expect(result.promoRemoved).toBe(false);
  });

  it("drops a promo that no longer applies to the remaining guests", async () => {
    const tx = makeTx();
    mockValidatePromo.mockResolvedValue({ error: "Not eligible", discount: null });
    const booking = makeBooking({
      discountCents: 2000,
      promoAdjustmentCents: -2000,
      finalPriceCents: 18000,
      promoRedemption: {
        id: "pr1",
        promoCodeId: "pc1",
        guestTargets: [],
        promoCode: { id: "pc1", code: "SAVE", assignments: [] },
      },
    });

    const result = await applyPartialBumpInTransaction({
      tx: tx as never,
      booking: booking as never,
    });

    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(mockDeletePromo).toHaveBeenCalled();
    expect(result.promoRemoved).toBe(true);
    expect(result.newPromoAdjustmentCents).toBe(0);
    expect(result.newFinalPriceCents).toBe(8000);
  });

  it("returns no-non-members when every guest is a member", async () => {
    const tx = makeTx();
    const booking = makeBooking({
      guests: [makeGuest("g1", true, "m1"), makeGuest("g3", true, "m2")],
    });

    const result = await applyPartialBumpInTransaction({
      tx: tx as never,
      booking: booking as never,
    });

    expect(result.kind).toBe("no-non-members");
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
    expect(tx.bookingGuest.deleteMany).not.toHaveBeenCalled();
  });

  it("returns no-members-remain when every guest is a non-member", async () => {
    const tx = makeTx();
    const booking = makeBooking({
      guests: [makeGuest("g2", false, null), makeGuest("g4", false, null)],
    });

    const result = await applyPartialBumpInTransaction({
      tx: tx as never,
      booking: booking as never,
    });

    expect(result.kind).toBe("no-members-remain");
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
  });

  it("returns already-processed when the claim is lost (idempotency)", async () => {
    const tx = makeTx();
    tx.booking.updateMany.mockResolvedValue({ count: 0 });

    const result = await applyPartialBumpInTransaction({
      tx: tx as never,
      booking: makeBooking() as never,
    });

    expect(result.kind).toBe("already-processed");
    // No mutation past the failed claim.
    expect(tx.bookingGuest.deleteMany).not.toHaveBeenCalled();
    expect(tx.booking.update).not.toHaveBeenCalled();
  });
});
