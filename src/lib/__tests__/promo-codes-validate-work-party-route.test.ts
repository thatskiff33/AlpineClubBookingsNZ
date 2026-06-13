import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  prisma: {
    promoCode: {
      findUnique: vi.fn(),
    },
    workPartyEvent: {
      findUnique: vi.fn(),
    },
    season: {
      findMany: vi.fn(),
    },
    groupDiscountSetting: {
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

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "member-1", role: "MEMBER" } })),
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn(async () => null),
}));

vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockReturnValue(null),
  rateLimiters: { bookingQuery: {} },
}));

import { POST } from "@/app/api/promo-codes/validate/route";

function request(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/promo-codes/validate", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const baseGuests = [
  { ageTier: "ADULT", isMember: true, memberId: "member-1" },
];

describe("POST /api/promo-codes/validate - work party events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.season.findMany.mockResolvedValue([
      {
        id: "season-1",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        type: "WINTER",
        rates: [{ ageTier: "ADULT", isMember: true, pricePerNightCents: 5000 }],
      },
    ]);
    mocks.prisma.groupDiscountSetting.findUnique.mockResolvedValue(null);
    mocks.prisma.promoRedemptionAllocation.aggregate.mockResolvedValue({
      _sum: { freeNightsUsed: 0 },
    });
    mocks.prisma.promoRedemptionAllocation.count.mockResolvedValue(0);
    mocks.prisma.promoRedemptionAllocation.findMany.mockResolvedValue([]);
  });

  it("rejects a request with both a promo code and a work party event", async () => {
    const res = await POST(
      request({
        code: "SAVE10",
        workPartyEventId: "event-1",
        checkIn: "2026-07-10",
        checkOut: "2026-07-13",
        guests: baseGuests,
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid input");
  });

  it("rejects a request with neither a promo code nor a work party event", async () => {
    const res = await POST(
      request({
        checkIn: "2026-07-10",
        checkOut: "2026-07-13",
        guests: baseGuests,
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid input");
  });

  it("resolves an active work party event and never exposes its internal code", async () => {
    mocks.prisma.workPartyEvent.findUnique.mockResolvedValue({
      id: "event-1",
      name: "Spring clean-up",
      active: true,
      startDate: new Date("2026-07-10"),
      endDate: new Date("2026-07-13"),
      discountPercent: 100,
      promoCode: {
        id: "promo-1",
        code: "WORKPARTY-AB3X7K2M",
        description: "Working bee: Spring clean-up",
        type: "PERCENTAGE",
        active: true,
        archivedAt: null,
        internal: true,
        percentOff: 100,
        valueCents: null,
        freeNightsPerIndividual: null,
        lifetimeFreeNightsCap: null,
        fixedNightlyPriceCents: null,
        fixedNightlyMode: null,
        maxGuestsPerBooking: null,
        maxNightlyValueCents: null,
        memberGuestsOnly: false,
        membersOnly: true,
        validFrom: null,
        validUntil: null,
        bookingStartFrom: null,
        bookingStartUntil: null,
        maxRedemptionsTotal: null,
        currentRedemptions: 0,
        maxUsesPerMember: null,
        maxUniqueMembersTotal: null,
        assignedMembersOnlyOwnNights: null,
        assignments: [],
      },
    });

    const res = await POST(
      request({
        workPartyEventId: "event-1",
        checkIn: "2026-07-10",
        checkOut: "2026-07-11",
        guests: baseGuests,
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.code).toBeNull();
    expect(body.description).toBeNull();
    expect(body.workPartyEvent).toEqual({
      id: "event-1",
      name: "Spring clean-up",
      discountPercent: 100,
    });
    // 1 night at $50, 100% discount.
    expect(body.discountCents).toBe(5000);
    expect(body.finalPriceCents).toBe(0);
  });

  it("rejects a work party event whose window does not overlap the booking", async () => {
    mocks.prisma.workPartyEvent.findUnique.mockResolvedValue({
      id: "event-1",
      name: "Spring clean-up",
      active: true,
      startDate: new Date("2026-09-01"),
      endDate: new Date("2026-09-03"),
      discountPercent: 100,
      promoCode: { active: true, archivedAt: null },
    });

    const res = await POST(
      request({
        workPartyEventId: "event-1",
        checkIn: "2026-07-10",
        checkOut: "2026-07-11",
        guests: baseGuests,
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.error).toBe("This working bee event does not overlap your booking dates");
  });

  it("treats a manually entered internal promo code like a nonexistent one", async () => {
    mocks.prisma.promoCode.findUnique.mockResolvedValue({
      id: "promo-1",
      code: "WORKPARTY-AB3X7K2M",
      internal: true,
      active: true,
      archivedAt: null,
      type: "PERCENTAGE",
      percentOff: 100,
      assignments: [],
    });

    const res = await POST(
      request({
        code: "WORKPARTY-AB3X7K2M",
        checkIn: "2026-07-10",
        checkOut: "2026-07-11",
        guests: baseGuests,
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.error).toBe("Promo code not found");
  });
});
