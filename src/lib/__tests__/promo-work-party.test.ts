import { beforeEach, describe, expect, it, vi } from "vitest";
import { PromoCodeType } from "@prisma/client";
import { parseDateOnly } from "@/lib/date-only";
import type { PromoApplicationSubject, BookingDetailsForPromo } from "../promo";

const mocks = vi.hoisted(() => ({
  prisma: {
    workPartyEvent: {
      findUnique: vi.fn(),
    },
    promoRedemptionAllocation: {
      aggregate: vi.fn(),
      count: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: mocks.prisma,
}));

import { validateAndCalculatePromoDiscount } from "../promo";

const d = parseDateOnly;

function makeInternalWorkPartyPromo(
  overrides: Partial<PromoApplicationSubject> = {}
): PromoApplicationSubject {
  return {
    id: "promo-workparty-1",
    active: true,
    validFrom: null,
    validUntil: null,
    maxRedemptionsTotal: null,
    currentRedemptions: 0,
    membersOnly: true,
    maxUsesPerMember: null,
    maxUniqueMembersTotal: null,
    type: PromoCodeType.PERCENTAGE,
    valueCents: null,
    percentOff: 100,
    freeNightsPerIndividual: null,
    lifetimeFreeNightsCap: null,
    fixedNightlyPriceCents: null,
    fixedNightlyMode: null,
    maxGuestsPerBooking: null,
    maxNightlyValueCents: null,
    memberGuestsOnly: false,
    internal: true,
    ...overrides,
  };
}

const baseBookingDetails: Omit<BookingDetailsForPromo, "guests" | "totalPriceCents"> = {
  memberId: "member-1",
  bookingCheckIn: d("2026-07-10"),
};

describe("validateAndCalculatePromoDiscount with internal work party promos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No prior usage for any member/promo by default.
    mocks.prisma.promoRedemptionAllocation.aggregate.mockResolvedValue({
      _sum: { freeNightsUsed: 0 },
    });
    mocks.prisma.promoRedemptionAllocation.count.mockResolvedValue(0);
    mocks.prisma.promoRedemptionAllocation.findMany.mockResolvedValue([]);
  });

  it("applies a 100% discount to a booking fully inside the event window ($0 path)", async () => {
    // Event window covers the whole 3-night stay.
    mocks.prisma.workPartyEvent.findUnique.mockResolvedValue({
      startDate: d("2026-07-10"),
      endDate: d("2026-07-13"),
    });

    const promoCode = makeInternalWorkPartyPromo({ percentOff: 100 });
    const totalPriceCents = 3 * 5000; // 3 nights at $50
    const result = await validateAndCalculatePromoDiscount(
      promoCode,
      {
        ...baseBookingDetails,
        totalPriceCents,
        guests: [
          {
            memberId: "member-1",
            isMember: true,
            perNightRates: [5000, 5000, 5000],
            firstNight: d("2026-07-10"),
          },
        ],
      },
      null
    );

    expect(result.error).toBeUndefined();
    expect(result.discount?.discountCents).toBe(15000);
    expect(result.discount?.priceAdjustmentCents).toBe(-15000);
    // $0 booking: total minus discount is zero.
    expect(totalPriceCents + (result.discount?.priceAdjustmentCents ?? 0)).toBe(0);
  });

  it("applies a partial (50%) discount over the in-window nights", async () => {
    mocks.prisma.workPartyEvent.findUnique.mockResolvedValue({
      startDate: d("2026-07-10"),
      endDate: d("2026-07-13"),
    });

    const promoCode = makeInternalWorkPartyPromo({ percentOff: 50 });
    const totalPriceCents = 3 * 5000;
    const result = await validateAndCalculatePromoDiscount(
      promoCode,
      {
        ...baseBookingDetails,
        totalPriceCents,
        guests: [
          {
            memberId: "member-1",
            isMember: true,
            perNightRates: [5000, 5000, 5000],
            firstNight: d("2026-07-10"),
          },
        ],
      },
      null
    );

    expect(result.error).toBeUndefined();
    // 50% of $150 = $75.
    expect(result.discount?.discountCents).toBe(7500);
    expect(result.discount?.priceAdjustmentCents).toBe(-7500);
  });

  it("only discounts nights that fall inside the event window for a booking that partially overlaps it", async () => {
    // Event runs 2026-07-12 to 2026-07-14 (3 nights). The booking is
    // 2026-07-10 to 2026-07-15 (5 nights), so only nights 12, 13, 14 (3 of
    // the 5) are inside the window.
    mocks.prisma.workPartyEvent.findUnique.mockResolvedValue({
      startDate: d("2026-07-12"),
      endDate: d("2026-07-14"),
    });

    const promoCode = makeInternalWorkPartyPromo({ percentOff: 100 });
    const perNightRates = [5000, 5000, 5000, 5000, 5000]; // 5 nights @ $50
    const totalPriceCents = perNightRates.reduce((a, b) => a + b, 0);
    const result = await validateAndCalculatePromoDiscount(
      promoCode,
      {
        ...baseBookingDetails,
        bookingCheckIn: d("2026-07-10"),
        totalPriceCents,
        guests: [
          {
            memberId: "member-1",
            isMember: true,
            perNightRates,
            firstNight: d("2026-07-10"),
          },
        ],
      },
      null
    );

    expect(result.error).toBeUndefined();
    // Only the 3 in-window nights (12, 13, 14) are discounted at 100%.
    expect(result.discount?.discountCents).toBe(15000);
    expect(result.discount?.priceAdjustmentCents).toBe(-15000);
    // The remaining 2 nights (10, 11) are charged in full.
    expect(totalPriceCents + (result.discount?.priceAdjustmentCents ?? 0)).toBe(10000);
  });

  it("discounts nothing when a guest has no firstNight (fail safe, never over-discount)", async () => {
    mocks.prisma.workPartyEvent.findUnique.mockResolvedValue({
      startDate: d("2026-07-10"),
      endDate: d("2026-07-13"),
    });

    const promoCode = makeInternalWorkPartyPromo({ percentOff: 100 });
    const totalPriceCents = 3 * 5000;
    const result = await validateAndCalculatePromoDiscount(
      promoCode,
      {
        ...baseBookingDetails,
        totalPriceCents,
        guests: [
          {
            memberId: "member-1",
            isMember: true,
            perNightRates: [5000, 5000, 5000],
            // No firstNight provided.
          },
        ],
      },
      null
    );

    expect(result.error).toBeUndefined();
    expect(result.discount?.discountCents).toBe(0);
    expect(result.discount?.priceAdjustmentCents).toBeCloseTo(0);
  });

  it("discounts nothing when the booking does not overlap the event window at all", async () => {
    mocks.prisma.workPartyEvent.findUnique.mockResolvedValue({
      startDate: d("2026-09-01"),
      endDate: d("2026-09-03"),
    });

    const promoCode = makeInternalWorkPartyPromo({ percentOff: 100 });
    const totalPriceCents = 3 * 5000;
    const result = await validateAndCalculatePromoDiscount(
      promoCode,
      {
        ...baseBookingDetails,
        totalPriceCents,
        guests: [
          {
            memberId: "member-1",
            isMember: true,
            perNightRates: [5000, 5000, 5000],
            firstNight: d("2026-07-10"),
          },
        ],
      },
      null
    );

    expect(result.error).toBeUndefined();
    expect(result.discount?.discountCents).toBe(0);
    expect(result.discount?.priceAdjustmentCents).toBeCloseTo(0);
  });

  it("applies the discount to all guests' in-window nights, not just the attending member", async () => {
    mocks.prisma.workPartyEvent.findUnique.mockResolvedValue({
      startDate: d("2026-07-10"),
      endDate: d("2026-07-12"),
    });

    const promoCode = makeInternalWorkPartyPromo({ percentOff: 100 });
    const totalPriceCents = 2 * (5000 + 3000); // 2 guests x 2 nights
    const result = await validateAndCalculatePromoDiscount(
      promoCode,
      {
        ...baseBookingDetails,
        totalPriceCents,
        guests: [
          {
            memberId: "member-1",
            isMember: true,
            perNightRates: [5000, 5000],
            firstNight: d("2026-07-10"),
          },
          {
            // Non-member guest, not the attending member, but still in the
            // booking and inside the event window.
            memberId: null,
            isMember: false,
            perNightRates: [3000, 3000],
            firstNight: d("2026-07-10"),
          },
        ],
      },
      null
    );

    expect(result.error).toBeUndefined();
    expect(result.discount?.discountCents).toBe(totalPriceCents);
  });
});
