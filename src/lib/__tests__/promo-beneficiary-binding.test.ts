import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-error";

// #2266 (MED-4) — promo beneficiaries bind PEOPLE, not positions. The panel's
// guest selection used to travel as positional indexes that the server
// re-bound to whatever the guest list was at APPLY time, so a concurrent edit
// by another session between preview and save could silently redeem the
// discount for the wrong guest. Existing guests now bind by bookingGuestId
// (stale ids refuse loudly); indexes remain only for TO-BE-ADDED guests
// within the same request, which nothing concurrent can reorder.

const promoMocks = vi.hoisted(() => ({
  validateAndCalculatePromoDiscount: vi.fn(),
  redeemPromoCode: vi.fn(),
  deletePromoRedemptionAndAdjustCount: vi.fn(),
  replacePromoRedemptionAllocations: vi.fn(),
  shouldPersistPromoRedemption: vi.fn().mockReturnValue(false),
  // #2299: applyPromoCodeChanges now row-locks every promo code it may charge
  // or refund before reading any cap, so the mock must export it too.
  lockPromoCodeRowsForUpdate: vi.fn(),
}));

vi.mock("@/lib/promo", () => ({
  validateAndCalculatePromoDiscount: promoMocks.validateAndCalculatePromoDiscount,
  redeemPromoCode: promoMocks.redeemPromoCode,
  deletePromoRedemptionAndAdjustCount:
    promoMocks.deletePromoRedemptionAndAdjustCount,
  replacePromoRedemptionAllocations:
    promoMocks.replacePromoRedemptionAllocations,
  shouldPersistPromoRedemption: promoMocks.shouldPersistPromoRedemption,
  lockPromoCodeRowsForUpdate: promoMocks.lockPromoCodeRowsForUpdate,
}));

import {
  applyPromoCodeChanges,
  resolvePromoBeneficiarySelection,
} from "@/lib/booking-modify-plan";
import { requireCalendarDate } from "@/lib/club-time";

// #3123 — the transaction-bound promo and refund helpers take the CLUB's
// calendar day as a REQUIRED value now: the club timezone is one of the two
// reads that cannot happen under a lock (`INV-LOCK-004`), so it is resolved by
// the caller and threaded in. These call sites are not about a date boundary,
// so the frozen clock's own club day is used.
const CLUB_TODAY_FOR_TEST = requireCalendarDate("2026-07-01");

describe("resolvePromoBeneficiarySelection (#2266 MED-4)", () => {
  const guestNightRates = [
    { bookingGuestId: "g1" },
    { bookingGuestId: "g2" },
    { bookingGuestId: null }, // to-be-added guest 0
    { bookingGuestId: null }, // to-be-added guest 1
  ];

  it("returns undefined when no selection was sent", () => {
    expect(
      resolvePromoBeneficiarySelection({
        guestNightRates,
        addedGuestCount: 2,
      }),
    ).toBeUndefined();
    expect(
      resolvePromoBeneficiarySelection({
        guestNightRates,
        addedGuestCount: 2,
        promoGuestIds: [],
        promoAddedGuestIndexes: [],
      }),
    ).toBeUndefined();
  });

  it("binds existing guests by id — wherever they sit in the priced order", () => {
    expect(
      resolvePromoBeneficiarySelection({
        guestNightRates,
        addedGuestCount: 2,
        promoGuestIds: ["g2"],
      }),
    ).toEqual([1]);
  });

  it("offsets added-guest indexes past the remaining guests", () => {
    expect(
      resolvePromoBeneficiarySelection({
        guestNightRates,
        addedGuestCount: 2,
        promoGuestIds: ["g1"],
        promoAddedGuestIndexes: [1],
      }),
    ).toEqual([0, 3]);
  });

  it("refuses loudly when a bound guest is no longer on the booking (the drift scenario)", () => {
    // Another session removed g2 between this session's preview and save: the
    // priced list no longer contains it. Positional indexes would have
    // silently redeemed for whoever now occupies position 1 — the id refuses.
    const afterConcurrentRemoval = [
      { bookingGuestId: "g1" },
      { bookingGuestId: "g3" },
    ];
    expect(() =>
      resolvePromoBeneficiarySelection({
        guestNightRates: afterConcurrentRemoval,
        addedGuestCount: 0,
        promoGuestIds: ["g2"],
      }),
    ).toThrow(/no longer on this booking/);
  });

  it("refuses an added-guest index outside this request's addGuests", () => {
    expect(() =>
      resolvePromoBeneficiarySelection({
        guestNightRates,
        addedGuestCount: 2,
        promoAddedGuestIndexes: [2],
      }),
    ).toThrow(ApiError);
  });
});

describe("applyPromoCodeChanges — beneficiary binding at apply time (#2266 MED-4)", () => {
  const tx = {
    promoCode: {
      findUnique: vi.fn(),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    promoMocks.shouldPersistPromoRedemption.mockReturnValue(false);
    tx.promoCode.findUnique.mockResolvedValue({
      id: "promo-1",
      code: "MATES50",
      internal: false,
      assignments: [],
      lodges: [],
    });
  });

  function baseArgs(input: Record<string, unknown>) {
    return {
      booking: {
        memberId: "m1",
        lodgeId: "lodge-1",
        promoRedemption: null,
      } as never,
      bookingId: "b1",
      input: input as never,
      inProgressPlan: null,
      newCheckIn: new Date("2026-09-14T00:00:00.000Z"),
      newTotalPriceCents: 20_000,
      guestNightRates: [
        { bookingGuestId: "g1", memberId: "m1", isMember: true, perNightRates: [10_000] },
        { bookingGuestId: "g2", memberId: null, isMember: false, perNightRates: [10_000] },
      ],
      todayAtClub: CLUB_TODAY_FOR_TEST,
    };
  }

  it("refuses the apply when a bound guest was concurrently removed — nothing is redeemed", async () => {
    await expect(
      applyPromoCodeChanges(
        tx as never,
        baseArgs({
promoCode: "MATES50", promoGuestIds: ["g-gone"] }),
      ),
    ).rejects.toThrow(/no longer on this booking/);

    expect(promoMocks.validateAndCalculatePromoDiscount).not.toHaveBeenCalled();
    expect(promoMocks.redeemPromoCode).not.toHaveBeenCalled();
  });

  it("resolves surviving ids against THIS transaction's guest list", async () => {
    promoMocks.validateAndCalculatePromoDiscount.mockResolvedValue({
      discount: {
        discountCents: 5_000,
        priceAdjustmentCents: -5_000,
        freeNightsUsed: 0,
        eligibleGuestCount: 1,
        allocations: [],
      },
      selectedGuestIndexes: [1],
    });

    const result = await applyPromoCodeChanges(
      tx as never,
      baseArgs({
promoCode: "MATES50", promoGuestIds: ["g2"] }),
    );

    expect(result.promoChanged).toBe(true);
    const options =
      promoMocks.validateAndCalculatePromoDiscount.mock.calls[0][3];
    expect(options.selectedGuestIndexes).toEqual([1]);
  });
});
