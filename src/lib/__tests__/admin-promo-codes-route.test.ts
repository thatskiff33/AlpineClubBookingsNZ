import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => {
  const tx = {
    promoCode: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
    },
    promoCodeAssignment: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  };

  return {
    tx,
    auth: vi.fn(),
    requireActiveSessionUser: vi.fn(),
    logAudit: vi.fn(),
    prisma: {
      promoCode: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      promoRedemption: { groupBy: vi.fn() },
      $transaction: vi.fn(async (callback: (innerTx: typeof tx) => unknown) => callback(tx)),
    },
  };
});

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: mocks.prisma,
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mocks.logAudit,
}));

import { GET, POST } from "@/app/api/admin/promo-codes/route";
import { DELETE, PUT } from "@/app/api/admin/promo-codes/[id]/route";
import { BENEFICIAL_PROMO_ALLOCATION_FILTER } from "@/lib/promo-usage-counts";

function request(url: string, body: Record<string, unknown>) {
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("admin promo code routes - fixed nightly price", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.prisma.$transaction.mockImplementation(async (callback: (tx: typeof mocks.tx) => unknown) => callback(mocks.tx));
  });

  it("rejects creating a fixed nightly promo without a price", async () => {
    const response = await POST(request("http://localhost/api/admin/promo-codes", {
      code: "FIXED30",
      type: "FIXED_NIGHTLY_PRICE",
      fixedNightlyMode: "SET_PRICE",
    }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("fixedNightlyPriceCents");
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("creates fixed nightly promos with signed-adjustment fields isolated from other discount config", async () => {
    mocks.prisma.promoCode.findUnique.mockResolvedValueOnce(null);
    mocks.tx.promoCode.create.mockResolvedValue({ id: "pc-1" });
    mocks.tx.promoCode.findUnique.mockResolvedValue({
      lodges: [],
      id: "pc-1",
      code: "FIXED30",
      type: "FIXED_NIGHTLY_PRICE",
      fixedNightlyPriceCents: 3000,
      fixedNightlyMode: "SET_PRICE",
      maxNightlyValueCents: null,
      assignments: [],
    });

    const response = await POST(request("http://localhost/api/admin/promo-codes", {
      code: "fixed30",
      type: "FIXED_NIGHTLY_PRICE",
      fixedNightlyPriceCents: 3000,
      fixedNightlyMode: "SET_PRICE",
      maxNightlyValueCents: 2000,
      valueCents: 1000,
      percentOff: 10,
      freeNightsPerIndividual: 2,
    }));

    expect(response.status).toBe(201);
    expect(mocks.tx.promoCode.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        code: "FIXED30",
        type: "FIXED_NIGHTLY_PRICE",
        valueCents: null,
        percentOff: null,
        freeNightsPerIndividual: null,
        fixedNightlyPriceCents: 3000,
        fixedNightlyMode: "SET_PRICE",
        maxNightlyValueCents: null,
        // Group fixed-nightly codes (not member-guests-only) default to group
        // scope so they price the whole booking (issue #756).
        assignedMembersOnlyOwnNights: false,
      }),
    });
  });

  it("defaults a member-guests-only fixed nightly promo to own-night scoping", async () => {
    mocks.prisma.promoCode.findUnique.mockResolvedValueOnce(null);
    mocks.tx.promoCode.create.mockResolvedValue({ id: "pc-1" });
    mocks.tx.promoCode.findUnique.mockResolvedValue({
      lodges: [],
      id: "pc-1",
      code: "MEMBER30",
      type: "FIXED_NIGHTLY_PRICE",
      assignments: [],
    });

    const response = await POST(request("http://localhost/api/admin/promo-codes", {
      code: "member30",
      type: "FIXED_NIGHTLY_PRICE",
      fixedNightlyPriceCents: 3000,
      fixedNightlyMode: "SET_PRICE",
      memberGuestsOnly: true,
    }));

    expect(response.status).toBe(201);
    expect(mocks.tx.promoCode.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        memberGuestsOnly: true,
        // member-guests-only fixed-nightly codes are not group-capable, so they
        // keep the standard own-night default.
        assignedMembersOnlyOwnNights: true,
      }),
    });
  });

  it("defaults a non-fixed-nightly promo to own-night scoping", async () => {
    mocks.prisma.promoCode.findUnique.mockResolvedValueOnce(null);
    mocks.tx.promoCode.create.mockResolvedValue({ id: "pc-1" });
    mocks.tx.promoCode.findUnique.mockResolvedValue({
      lodges: [],
      id: "pc-1",
      code: "PCT25",
      type: "PERCENTAGE",
      assignments: [],
    });

    const response = await POST(request("http://localhost/api/admin/promo-codes", {
      code: "pct25",
      type: "PERCENTAGE",
      percentOff: 25,
    }));

    expect(response.status).toBe(201);
    expect(mocks.tx.promoCode.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        assignedMembersOnlyOwnNights: true,
      }),
    });
  });

  it("allows one-day promo validity windows and stores date-only values", async () => {
    mocks.prisma.promoCode.findUnique.mockResolvedValueOnce(null);
    mocks.tx.promoCode.create.mockResolvedValue({ id: "pc-1" });
    mocks.tx.promoCode.findUnique.mockResolvedValue({
      lodges: [],
      id: "pc-1",
      code: "ONEDAY",
      type: "PERCENTAGE",
      assignments: [],
    });

    const response = await POST(request("http://localhost/api/admin/promo-codes", {
      code: "oneday",
      type: "PERCENTAGE",
      percentOff: 25,
      validFrom: "2026-07-15",
      validUntil: "2026-07-15",
      assignedMembersOnlyOwnNights: false,
    }));

    expect(response.status).toBe(201);
    expect(mocks.tx.promoCode.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        validFrom: new Date("2026-07-15T00:00:00.000Z"),
        validUntil: new Date("2026-07-15T00:00:00.000Z"),
        assignedMembersOnlyOwnNights: false,
      }),
    });
  });

  it("rejects updating to fixed nightly without an effective price", async () => {
    mocks.prisma.promoCode.findUnique.mockResolvedValueOnce({
      id: "pc-1",
      code: "FIXED30",
      type: "PERCENTAGE",
      percentOff: 10,
      valueCents: null,
      freeNightsPerIndividual: null,
      fixedNightlyPriceCents: null,
      bookingStartFrom: null,
      bookingStartUntil: null,
    });

    const response = await PUT(request("http://localhost/api/admin/promo-codes/pc-1", {
      type: "FIXED_NIGHTLY_PRICE",
    }), { params: Promise.resolve({ id: "pc-1" }) });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("fixedNightlyPriceCents");
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("updates fixed nightly fields and clears percentage/free-night-only config", async () => {
    mocks.prisma.promoCode.findUnique.mockResolvedValueOnce({
      id: "pc-1",
      code: "CAP30",
      type: "PERCENTAGE",
      percentOff: 20,
      valueCents: null,
      freeNightsPerIndividual: null,
      lifetimeFreeNightsCap: null,
      fixedNightlyPriceCents: null,
      fixedNightlyMode: null,
      maxNightlyValueCents: 4000,
      bookingStartFrom: null,
      bookingStartUntil: null,
    });
    mocks.tx.promoCode.findUnique.mockResolvedValue({
      lodges: [],
      id: "pc-1",
      code: "CAP30",
      type: "FIXED_NIGHTLY_PRICE",
      fixedNightlyPriceCents: 3500,
      fixedNightlyMode: "CAP_ONLY",
      assignments: [],
    });

    const response = await PUT(request("http://localhost/api/admin/promo-codes/pc-1", {
      type: "FIXED_NIGHTLY_PRICE",
      fixedNightlyPriceCents: 3500,
      fixedNightlyMode: "CAP_ONLY",
      maxNightlyValueCents: 1000,
      assignedMembersOnlyOwnNights: true,
    }), { params: Promise.resolve({ id: "pc-1" }) });

    expect(response.status).toBe(200);
    expect(mocks.tx.promoCode.update).toHaveBeenCalledWith({
      where: { id: "pc-1" },
      data: expect.objectContaining({
        type: "FIXED_NIGHTLY_PRICE",
        percentOff: null,
        valueCents: null,
        freeNightsPerIndividual: null,
        fixedNightlyPriceCents: 3500,
        fixedNightlyMode: "CAP_ONLY",
        maxNightlyValueCents: null,
        assignedMembersOnlyOwnNights: true,
      }),
    });
  });
});

// #2299: a promo application that gave nobody a benefit consumes no usage cap,
// but it is still a recorded redemption — which the admin surface has to keep
// straight in two places.
describe("admin promo code routes - zero-benefit redemptions (#2299)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
    });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
  });

  it("lists cap-consuming allocations separately from every recorded application", async () => {
    mocks.prisma.promoCode.findMany.mockResolvedValue([
      {
        id: "pc-1",
        code: "WINTER20",
        // Three applications; ONE of them benefited two members, the other two
        // benefited nobody. So the units genuinely differ: 2 beneficiary rows
        // against 3 applications, of which 2 gave nothing.
        currentRedemptions: 2,
        allocations: [
          {
            id: "alloc-1",
            discountCents: 2000,
            priceAdjustmentCents: -2000,
            memberId: "member-1",
            createdAt: new Date("2026-07-01T00:00:00Z"),
          },
          {
            id: "alloc-2",
            discountCents: 1500,
            priceAdjustmentCents: -1500,
            memberId: "member-2",
            createdAt: new Date("2026-07-01T00:00:00Z"),
          },
        ],
        _count: { redemptions: 3 },
        lodges: [],
        assignments: [],
      },
    ]);
    mocks.prisma.promoRedemption.groupBy.mockResolvedValue([
      { promoCodeId: "pc-1", _count: { _all: 2 } },
    ]);

    const response = await GET(
      new NextRequest("http://localhost/api/admin/promo-codes")
    );
    expect(response.status).toBe(200);
    const body = await response.json();

    // The cap-facing list is filtered to beneficial rows...
    expect(mocks.prisma.promoCode.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          allocations: expect.objectContaining({
            where: BENEFICIAL_PROMO_ALLOCATION_FILTER,
          }),
          _count: { select: { redemptions: true } },
        }),
      })
    );
    // ...while the operator still sees that the code was applied three times.
    expect(body[0].redemptions).toHaveLength(2);
    expect(body[0].totalRedemptionCount).toBe(3);
    expect(body[0]._count).toBeUndefined();

    // The benefit-free figure is COUNTED, never derived. The old subtraction
    // (3 applications - 2 beneficiary rows) would have said 1, and would have
    // hidden the line entirely on a code with more beneficiaries than
    // applications.
    expect(body[0].benefitFreeRedemptionCount).toBe(2);
    expect(mocks.prisma.promoRedemption.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["promoCodeId"],
        where: expect.objectContaining({
          allocations: { none: BENEFICIAL_PROMO_ALLOCATION_FILTER },
        }),
      })
    );
  });

  it("reports zero benefit-free applications for a code with no such rows", async () => {
    mocks.prisma.promoCode.findMany.mockResolvedValue([
      {
        id: "pc-2",
        code: "CLEAN",
        currentRedemptions: 1,
        allocations: [
          {
            id: "alloc-9",
            discountCents: 500,
            priceAdjustmentCents: -500,
            memberId: "member-9",
            createdAt: new Date("2026-07-01T00:00:00Z"),
          },
        ],
        _count: { redemptions: 1 },
        lodges: [],
        assignments: [],
      },
    ]);
    // groupBy returns no row at all for a code with nothing to report.
    mocks.prisma.promoRedemption.groupBy.mockResolvedValue([]);

    const response = await GET(
      new NextRequest("http://localhost/api/admin/promo-codes")
    );
    const body = await response.json();
    expect(body[0].benefitFreeRedemptionCount).toBe(0);
  });

  it("archives (never hard-deletes) a code whose only application gave no benefit", async () => {
    // PromoRedemption.promoCodeId is onDelete: Restrict, so counting
    // allocations here would offer a delete the database then refuses.
    mocks.prisma.promoCode.findUnique.mockResolvedValue({
      id: "pc-1",
      code: "WINTER20",
      internal: false,
      _count: { redemptions: 1 },
    });

    const response = await DELETE(
      new NextRequest("http://localhost/api/admin/promo-codes/pc-1", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "pc-1" }) }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, archived: true });
    expect(mocks.prisma.promoCode.delete).not.toHaveBeenCalled();
    expect(mocks.prisma.promoCode.update).toHaveBeenCalledWith({
      where: { id: "pc-1" },
      data: expect.objectContaining({ active: false }),
    });
  });

  it("still hard-deletes a code that was never applied to a booking", async () => {
    mocks.prisma.promoCode.findUnique.mockResolvedValue({
      id: "pc-1",
      code: "UNUSED",
      internal: false,
      _count: { redemptions: 0 },
    });

    const response = await DELETE(
      new NextRequest("http://localhost/api/admin/promo-codes/pc-1", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "pc-1" }) }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, archived: false });
    expect(mocks.prisma.promoCode.delete).toHaveBeenCalledWith({ where: { id: "pc-1" } });
  });
});
