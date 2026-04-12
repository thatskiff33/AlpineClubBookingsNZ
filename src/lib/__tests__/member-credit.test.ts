import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock Prisma ─────────────────────────────────────────────────────────────

vi.mock("@/lib/prisma", () => ({
  prisma: {
    memberCredit: {
      aggregate: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
      groupBy: vi.fn(),
    },
    payment: { findUnique: vi.fn() },
    cancellationPolicy: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Tests: Credit Balance Helpers ───────────────────────────────────────────

describe("member-credit helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getMemberCreditBalance", () => {
    it("returns 0 when no credits exist", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.aggregate).mockResolvedValue({
        _sum: { amountCents: null },
        _count: null, _avg: null, _max: null, _min: null,
      } as any);

      const { getMemberCreditBalance } = await import("@/lib/member-credit");
      const balance = await getMemberCreditBalance("member-1");

      expect(balance).toBe(0);
    });

    it("returns correct sum of mixed credits", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.aggregate).mockResolvedValue({
        _sum: { amountCents: 3000 },
        _count: null, _avg: null, _max: null, _min: null,
      } as any);

      const { getMemberCreditBalance } = await import("@/lib/member-credit");
      const balance = await getMemberCreditBalance("member-1");

      expect(balance).toBe(3000);
    });

    it("accepts optional transaction client", async () => {
      const txClient = {
        memberCredit: {
          aggregate: vi.fn().mockResolvedValue({
            _sum: { amountCents: 5000 },
          }),
        },
      };

      const { prisma } = await import("@/lib/prisma");
      const { getMemberCreditBalance } = await import("@/lib/member-credit");
      const balance = await getMemberCreditBalance("member-1", txClient as any);

      expect(balance).toBe(5000);
      expect(txClient.memberCredit.aggregate).toHaveBeenCalled();
      expect(prisma.memberCredit.aggregate).not.toHaveBeenCalled();
    });
  });

  describe("createCancellationCredit", () => {
    it("creates a CANCELLATION_REFUND record with correct fields", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.create).mockResolvedValue({} as any);

      const { createCancellationCredit } = await import("@/lib/member-credit");
      await createCancellationCredit("member-1", 5000, "booking-abc12345", "xero-cn-1");

      expect(prisma.memberCredit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          memberId: "member-1",
          amountCents: 5000,
          type: "CANCELLATION_REFUND",
          sourceBookingId: "booking-abc12345",
          xeroCreditNoteId: "xero-cn-1",
        }),
      });
    });

    it("handles missing Xero credit note ID", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.create).mockResolvedValue({} as any);

      const { createCancellationCredit } = await import("@/lib/member-credit");
      await createCancellationCredit("member-1", 3000, "booking-xyz");

      expect(prisma.memberCredit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          xeroCreditNoteId: null,
        }),
      });
    });
  });

  describe("applyCreditToBooking", () => {
    it("creates a negative BOOKING_APPLIED record", async () => {
      const txClient = {
        memberCredit: {
          aggregate: vi.fn().mockResolvedValue({
            _sum: { amountCents: 10000 },
          }),
          create: vi.fn().mockResolvedValue({} as any),
        },
      };

      const { applyCreditToBooking } = await import("@/lib/member-credit");
      await applyCreditToBooking("member-1", 5000, "booking-new", txClient as any);

      expect(txClient.memberCredit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          memberId: "member-1",
          amountCents: -5000,
          type: "BOOKING_APPLIED",
          appliedToBookingId: "booking-new",
        }),
      });
    });

    it("throws if insufficient balance", async () => {
      const txClient = {
        memberCredit: {
          aggregate: vi.fn().mockResolvedValue({
            _sum: { amountCents: 2000 },
          }),
        },
      };

      const { applyCreditToBooking } = await import("@/lib/member-credit");
      await expect(
        applyCreditToBooking("member-1", 5000, "booking-new", txClient as any)
      ).rejects.toThrow("Insufficient credit balance");
    });

    it("throws if amount is zero or negative", async () => {
      const txClient = { memberCredit: { aggregate: vi.fn() } };

      const { applyCreditToBooking } = await import("@/lib/member-credit");
      await expect(
        applyCreditToBooking("member-1", 0, "booking-new", txClient as any)
      ).rejects.toThrow("Credit amount must be positive");
    });
  });

  describe("restoreCreditFromBooking", () => {
    it("creates a positive restore entry for cancelled booking", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.findMany).mockResolvedValue([
        { id: "c1", amountCents: -3000, type: "BOOKING_APPLIED" },
        { id: "c2", amountCents: -2000, type: "BOOKING_APPLIED" },
      ] as any);
      vi.mocked(prisma.memberCredit.create).mockResolvedValue({} as any);

      const { restoreCreditFromBooking } = await import("@/lib/member-credit");
      const restored = await restoreCreditFromBooking("member-1", "booking-cancelled");

      expect(restored).toBe(5000);
      expect(prisma.memberCredit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          memberId: "member-1",
          amountCents: 5000,
          type: "CANCELLATION_REFUND",
          sourceBookingId: "booking-cancelled",
        }),
      });
    });

    it("returns 0 when no credit was applied", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.findMany).mockResolvedValue([]);

      const { restoreCreditFromBooking } = await import("@/lib/member-credit");
      const restored = await restoreCreditFromBooking("member-1", "booking-new");

      expect(restored).toBe(0);
      expect(prisma.memberCredit.create).not.toHaveBeenCalled();
    });
  });

  describe("createAdminAdjustment", () => {
    it("creates a positive admin adjustment", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.create).mockResolvedValue({} as any);

      const { createAdminAdjustment } = await import("@/lib/member-credit");
      await createAdminAdjustment("member-1", 2000, "Goodwill credit", "admin-1");

      expect(prisma.memberCredit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          memberId: "member-1",
          amountCents: 2000,
          type: "ADMIN_ADJUSTMENT",
          description: "Goodwill credit",
        }),
      });
    });

    it("validates negative adjustment doesn't exceed balance", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.aggregate).mockResolvedValue({
        _sum: { amountCents: 1000 },
        _count: null, _avg: null, _max: null, _min: null,
      } as any);

      const { createAdminAdjustment } = await import("@/lib/member-credit");
      await expect(
        createAdminAdjustment("member-1", -2000, "Correction", "admin-1")
      ).rejects.toThrow("Cannot deduct 2000 cents: only 1000 cents available");
    });

    it("rejects zero amount", async () => {
      const { createAdminAdjustment } = await import("@/lib/member-credit");
      await expect(
        createAdminAdjustment("member-1", 0, "Nothing", "admin-1")
      ).rejects.toThrow("Adjustment amount cannot be zero");
    });
  });
});

// ── Tests: Dual Refund Percentages ──────────────────────────────────────────

describe("cancellation dual refund percentages", () => {
  describe("getRefundTier", () => {
    it("returns both card and credit percentages", async () => {
      const { getRefundTier } = await import("@/lib/cancellation");

      const policy = [
        { daysBeforeStay: 14, refundPercentage: 90, creditRefundPercentage: 100 },
        { daysBeforeStay: 7, refundPercentage: 50, creditRefundPercentage: 75 },
        { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
      ];

      const tier = getRefundTier(15, policy);
      expect(tier.refundPercentage).toBe(90);
      expect(tier.creditRefundPercentage).toBe(100);
    });

    it("returns correct tier for mid-range days", async () => {
      const { getRefundTier } = await import("@/lib/cancellation");

      const policy = [
        { daysBeforeStay: 14, refundPercentage: 90, creditRefundPercentage: 100 },
        { daysBeforeStay: 7, refundPercentage: 50, creditRefundPercentage: 75 },
        { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
      ];

      const tier = getRefundTier(10, policy);
      expect(tier.refundPercentage).toBe(50);
      expect(tier.creditRefundPercentage).toBe(75);
    });

    it("returns 0/0 for empty policy", async () => {
      const { getRefundTier } = await import("@/lib/cancellation");
      const tier = getRefundTier(10, []);
      expect(tier.refundPercentage).toBe(0);
      expect(tier.creditRefundPercentage).toBe(0);
    });
  });

  describe("calculateRefundAmount", () => {
    it("uses card percentage by default", async () => {
      const { calculateRefundAmount } = await import("@/lib/cancellation");

      const policy = [
        { daysBeforeStay: 14, refundPercentage: 90, creditRefundPercentage: 100 },
        { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
      ];

      const result = calculateRefundAmount(10000, 15, policy);
      expect(result.refundAmountCents).toBe(9000);
      expect(result.refundPercentage).toBe(90);
    });

    it("uses credit percentage when refundMethod is credit", async () => {
      const { calculateRefundAmount } = await import("@/lib/cancellation");

      const policy = [
        { daysBeforeStay: 14, refundPercentage: 90, creditRefundPercentage: 100 },
        { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
      ];

      const result = calculateRefundAmount(10000, 15, policy, "credit");
      expect(result.refundAmountCents).toBe(10000);
      expect(result.refundPercentage).toBe(100);
    });
  });

  describe("calculateDualRefundAmounts", () => {
    it("returns both card and credit amounts", async () => {
      const { calculateDualRefundAmounts } = await import("@/lib/cancellation");

      const policy = [
        { daysBeforeStay: 14, refundPercentage: 90, creditRefundPercentage: 100 },
        { daysBeforeStay: 7, refundPercentage: 50, creditRefundPercentage: 75 },
        { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
      ];

      const result = calculateDualRefundAmounts(10000, 15, policy);
      expect(result.cardRefundAmountCents).toBe(9000);
      expect(result.cardRefundPercentage).toBe(90);
      expect(result.creditRefundAmountCents).toBe(10000);
      expect(result.creditRefundPercentage).toBe(100);
    });

    it("rounds correctly for odd amounts", async () => {
      const { calculateDualRefundAmounts } = await import("@/lib/cancellation");

      const policy = [
        { daysBeforeStay: 7, refundPercentage: 33, creditRefundPercentage: 50 },
        { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
      ];

      const result = calculateDualRefundAmounts(999, 10, policy);
      expect(result.cardRefundAmountCents).toBe(330);
      expect(result.creditRefundAmountCents).toBe(500);
    });
  });
});

// ── Tests: Schema Contracts ─────────────────────────────────────────────────

describe("schema contracts", () => {
  it("adjustment schema requires description", async () => {
    const { z } = await import("zod");
    const schema = z.object({
      amountCents: z.number().int().refine((v: number) => v !== 0, "Amount cannot be zero"),
      description: z.string().min(1, "Description is required").max(500),
    });

    expect(schema.safeParse({ amountCents: 100 }).success).toBe(false);
    expect(schema.safeParse({ amountCents: 100, description: "" }).success).toBe(false);
    expect(schema.safeParse({ amountCents: 0, description: "test" }).success).toBe(false);
    expect(schema.safeParse({ amountCents: 100, description: "test" }).success).toBe(true);
    expect(schema.safeParse({ amountCents: -500, description: "deduct" }).success).toBe(true);
  });

  it("cancellation policy schema accepts creditRefundPercentage", async () => {
    const { z } = await import("zod");
    const policySchema = z.object({
      rules: z.array(
        z.object({
          daysBeforeStay: z.number().int().min(0),
          refundPercentage: z.number().int().min(0).max(100),
          creditRefundPercentage: z.number().int().min(0).max(100).optional(),
        })
      ).min(1),
    });

    expect(policySchema.safeParse({
      rules: [{ daysBeforeStay: 14, refundPercentage: 90 }],
    }).success).toBe(true);

    expect(policySchema.safeParse({
      rules: [{ daysBeforeStay: 14, refundPercentage: 90, creditRefundPercentage: 100 }],
    }).success).toBe(true);
  });
});
