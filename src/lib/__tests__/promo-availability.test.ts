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
          freeNightsPerIndividual: null,
          active: true,
          archivedAt: null,
          validFrom: null,
          validUntil: null,
          maxRedemptionsTotal: null,
          currentRedemptions: 0,
          maxUsesPerMember: null,
          allocations: [],
        },
      },
      {
        promoCode: {
          code: "USEDONCE",
          description: "Already redeemed",
          type: "FREE_NIGHTS",
          percentOff: null,
          valueCents: null,
          freeNightsPerIndividual: 1,
          active: true,
          archivedAt: null,
          validFrom: null,
          validUntil: null,
          maxRedemptionsTotal: null,
          currentRedemptions: 1,
          maxUsesPerMember: 1,
          allocations: [{ id: "allocation-1", freeNightsUsed: 1 }],
        },
      },
      {
        promoCode: {
          code: "EXPIRED",
          description: "Expired promo",
          type: "FIXED_AMOUNT",
          percentOff: null,
          valueCents: 2500,
          freeNightsPerIndividual: null,
          active: true,
          archivedAt: null,
          validFrom: null,
          validUntil: new Date("2026-01-01T00:00:00Z"),
          maxRedemptionsTotal: null,
          currentRedemptions: 0,
          maxUsesPerMember: null,
          allocations: [],
        },
      },
      {
        promoCode: {
          code: "MAXED",
          description: "No uses left",
          type: "FIXED_AMOUNT",
          percentOff: null,
          valueCents: 1000,
          freeNightsPerIndividual: null,
          active: true,
          archivedAt: null,
          validFrom: null,
          validUntil: null,
          maxRedemptionsTotal: 1,
          currentRedemptions: 1,
          maxUsesPerMember: null,
          allocations: [],
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
        freeNightsPerIndividual: null,
      },
    ]);
    expect(prisma.promoCodeAssignment.findMany).toHaveBeenCalledWith({
      where: { memberId: "member-1", promoCode: { internal: false } },
      include: {
        promoCode: {
          include: {
            allocations: {
              where: { memberId: "member-1" },
              select: { id: true, freeNightsUsed: true },
            },
          },
        },
      },
    });
  });

  it("keeps member-visible and admin summary eligibility consistent", async () => {
    const { prisma } = await import("@/lib/prisma");
    const assignments = [
      {
        createdAt: new Date("2026-05-01T00:00:00Z"),
        promoCode: {
          id: "promo-ready",
          code: "READY10",
          description: "Assigned and ready",
          type: "PERCENTAGE",
          percentOff: 10,
          valueCents: null,
          freeNightsPerIndividual: null,
          active: true,
          archivedAt: null,
          validFrom: null,
          validUntil: null,
          bookingStartFrom: null,
          bookingStartUntil: null,
          maxRedemptionsTotal: null,
          currentRedemptions: 0,
          maxUsesPerMember: null,
          allocations: [],
        },
      },
      {
        createdAt: new Date("2026-05-01T00:00:00Z"),
        promoCode: {
          id: "promo-expired",
          code: "EXPIRED",
          description: "Expired promo",
          type: "FIXED_AMOUNT",
          percentOff: null,
          valueCents: 2500,
          freeNightsPerIndividual: null,
          active: true,
          archivedAt: null,
          validFrom: null,
          validUntil: new Date("2026-06-01T00:00:00Z"),
          bookingStartFrom: null,
          bookingStartUntil: null,
          maxRedemptionsTotal: null,
          currentRedemptions: 0,
          maxUsesPerMember: null,
          allocations: [],
        },
      },
    ];
    vi.mocked(prisma.promoCodeAssignment.findMany)
      .mockResolvedValueOnce(assignments as any)
      .mockResolvedValueOnce(assignments as any);

    const {
      getAssignedPromoCodeSummariesForMember,
      getAvailablePromoCodesForMember,
    } = await import("../promo");
    const now = new Date("2026-07-15T12:00:00Z");

    const adminSummaries = await getAssignedPromoCodeSummariesForMember(
      "member-1",
      now
    );
    const memberVisible = await getAvailablePromoCodesForMember("member-1", now);

    expect(adminSummaries.map((promo) => ({
      code: promo.code,
      visibleToMember: promo.visibleToMember,
      statusReason: promo.statusReason,
    }))).toEqual([
      {
        code: "READY10",
        visibleToMember: true,
        statusReason: "Available to member",
      },
      {
        code: "EXPIRED",
        visibleToMember: false,
        statusReason: "Expired",
      },
    ]);
    expect(memberVisible.map((promo) => promo.code)).toEqual(
      adminSummaries
        .filter((promo) => promo.visibleToMember)
        .map((promo) => promo.code)
    );
  });
});
