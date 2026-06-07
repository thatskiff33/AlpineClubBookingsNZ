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
      },
      $transaction: vi.fn(async (callback: (tx: typeof tx) => unknown) => callback(tx)),
    },
  };
});

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: mocks.prisma,
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mocks.logAudit,
}));

import { POST } from "@/app/api/admin/promo-codes/route";
import { PUT } from "@/app/api/admin/promo-codes/[id]/route";

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
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
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
      }),
    });
  });
});
