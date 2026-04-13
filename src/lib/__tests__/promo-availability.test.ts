import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    promoCodeAssignment: {
      findMany: vi.fn(),
    },
  },
}));

describe("getAvailablePromoCodesForMember", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns only currently usable assigned promo codes", async () => {
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.promoCodeAssignment.findMany).mockResolvedValue([
      {
        promoCode: {
          code: "READY10",
          description: "Assigned and ready",
          type: "PERCENTAGE",
          percentOff: 10,
          valueCents: null,
          freeNights: null,
          active: true,
          archivedAt: null,
          validFrom: null,
          validUntil: null,
          maxRedemptions: null,
          currentRedemptions: 0,
          singleUse: false,
          redemptions: [],
        },
      },
      {
        promoCode: {
          code: "USEDONCE",
          description: "Already redeemed",
          type: "FREE_NIGHTS",
          percentOff: null,
          valueCents: null,
          freeNights: 1,
          active: true,
          archivedAt: null,
          validFrom: null,
          validUntil: null,
          maxRedemptions: null,
          currentRedemptions: 1,
          singleUse: true,
          redemptions: [{ id: "redemption-1", freeNightsUsed: 1 }],
        },
      },
      {
        promoCode: {
          code: "EXPIRED",
          description: "Expired promo",
          type: "FIXED_AMOUNT",
          percentOff: null,
          valueCents: 2500,
          freeNights: null,
          active: true,
          archivedAt: null,
          validFrom: null,
          validUntil: new Date("2026-01-01T00:00:00Z"),
          maxRedemptions: null,
          currentRedemptions: 0,
          singleUse: false,
          redemptions: [],
        },
      },
      {
        promoCode: {
          code: "MAXED",
          description: "No uses left",
          type: "FIXED_AMOUNT",
          percentOff: null,
          valueCents: 1000,
          freeNights: null,
          active: true,
          archivedAt: null,
          validFrom: null,
          validUntil: null,
          maxRedemptions: 1,
          currentRedemptions: 1,
          singleUse: false,
          redemptions: [],
        },
      },
    ] as any);

    const { getAvailablePromoCodesForMember } = await import("../promo");
    const result = await getAvailablePromoCodesForMember(
      "member-1",
      new Date("2026-07-15T12:00:00Z")
    );

    expect(result).toEqual([
      {
        code: "READY10",
        description: "Assigned and ready",
        type: "PERCENTAGE",
        percentOff: 10,
        valueCents: null,
        freeNights: null,
      },
    ]);
    expect(prisma.promoCodeAssignment.findMany).toHaveBeenCalledWith({
      where: { memberId: "member-1" },
      include: {
        promoCode: {
          include: {
            redemptions: {
              where: { memberId: "member-1" },
              select: { id: true, freeNightsUsed: true },
            },
          },
        },
      },
    });
  });
});
