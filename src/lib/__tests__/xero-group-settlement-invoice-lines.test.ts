import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3642 (`INV-SSOT-002`): the combined group invoice is built from exactly the
 * children the settlement committed and adds up to the same total — a joiner's
 * promotion is on the invoice as its own line, as it is on a per-booking
 * invoice, because a final price is the stay's total plus that adjustment.
 * Before this the group invoice billed the gross stay, so a discounted joiner
 * made a correctly paid invoice fail the settle's cash check.
 */

const mocks = vi.hoisted(() => ({
  bookingFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findMany: mocks.bookingFindMany },
    season: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));
vi.mock("@/lib/xero-mappings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-mappings")),
  getResolvedAccountMapping: vi.fn().mockResolvedValue({
    code: "200",
    itemCode: null,
    codeExplicitlyConfigured: true,
  }),
  getHutFeeItemCodeMap: vi.fn().mockResolvedValue(new Map()),
}));

import { buildGroupSettlementInvoiceLines } from "@/lib/xero-group-settlement-invoice-lines";
import { CHANGE_FEE_LINE_DESCRIPTION, invoiceLineItemsTotalCents } from "@/lib/xero-modification-line-items";

function child(overrides: Record<string, unknown>) {
  return {
    id: "child",
    lodgeId: "lodge-1",
    checkIn: new Date("2026-07-01T00:00:00.000Z"),
    checkOut: new Date("2026-07-02T00:00:00.000Z"),
    promoAdjustmentCents: 0,
    promoRedemptions: [],
    guests: [
      {
        firstName: "Jo",
        lastName: "Joiner",
        ageTier: "ADULT",
        isMember: true,
        rateMembershipTypeId: null,
        priceCents: 5000,
        nights: [],
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildGroupSettlementInvoiceLines (#3642)", () => {
  it("puts a discounted joiner's promotion on the invoice, so it totals the settlement", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      child({
        id: "discounted",
        finalPriceCents: 4500,
        promoAdjustmentCents: -500,
        promoRedemptions: [{ promoCode: { code: "SAVE5", xeroItemCode: null, xeroAccountCode: null } }],
      }),
      child({ id: "full-price", finalPriceCents: 5000 }),
    ]);

    const lines = await buildGroupSettlementInvoiceLines("organiser-booking-1");

    expect(lines.childrenCents).toBe(9500);
    expect(lines.lineCents).toBe(9500);
    expect(lines.lineItems).toContainEqual(
      expect.objectContaining({ description: "Promo adjustment - SAVE5", unitAmount: -5 })
    );
    // One code records nothing new on the operation.
    expect(lines.operationRecord).toEqual({});
  });

  it("#3955 F3: bills a joiner's recorded change fee, so the invoice still totals the settlement", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      child({ id: "with-fee", finalPriceCents: 5000, payment: { changeFeeCents: 1250 } }),
      child({ id: "no-fee", finalPriceCents: 5000, payment: null }),
    ]);

    const lines = await buildGroupSettlementInvoiceLines("organiser-booking-1");

    expect(lines.childrenCents).toBe(11250);
    expect(lines.lineCents).toBe(11250);
    expect(lines.lineItems.filter((line) => line.description === CHANGE_FEE_LINE_DESCRIPTION)).toEqual([
      expect.objectContaining({ unitAmount: 12.5, quantity: 1 }),
    ]);
  });

  it("gives a several-code joiner one coded promotion line per code, totalling the settlement (#3828)", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      child({
        id: "two-codes",
        finalPriceCents: 4200,
        promoAdjustmentCents: -800,
        promoRedemptions: [
          {
            id: "red-b",
            applicationOrder: 1,
            priceAdjustmentCents: -300,
            allocations: [{ memberId: "m-1", priceAdjustmentCents: -300 }],
            promoCode: { code: "GUESTFREE", xeroItemCode: "FREE-NIGHT", xeroAccountCode: "205" },
          },
          {
            id: "red-a",
            applicationOrder: 0,
            priceAdjustmentCents: -500,
            allocations: [{ memberId: "m-1", priceAdjustmentCents: -500 }],
            promoCode: { code: "SAVE5", xeroItemCode: null, xeroAccountCode: null },
          },
        ],
        nightAdjustments: [
          { promoRedemptionId: "red-a", beneficiaryMemberId: "m-1", amountCents: -500 },
          { promoRedemptionId: "red-b", beneficiaryMemberId: "m-1", amountCents: -300 },
        ],
      }),
    ]);

    const lines = await buildGroupSettlementInvoiceLines("organiser-booking-1");

    const promotion = lines.lineItems.filter((line) =>
      line.description?.startsWith("Promo adjustment"),
    );
    expect(promotion).toEqual([
      expect.objectContaining({ description: "Promo adjustment - SAVE5", unitAmount: -5 }),
      expect.objectContaining({
        description: "Promo adjustment - GUESTFREE",
        unitAmount: -3,
        itemCode: "FREE-NIGHT",
        accountCode: "205",
      }),
    ]);
    expect(lines.lineCents).toBe(lines.childrenCents);
    expect(lines.operationRecord.promoLines).toEqual([
      expect.objectContaining({ bookingId: "two-codes", promoLineSource: "PER_CODE" }),
    ]);
  });

  it("falls back to the child's one aggregate line when its codes do not add up, and says so (#3828)", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      child({
        id: "drifted",
        finalPriceCents: 4200,
        promoAdjustmentCents: -800,
        promoRedemptions: [
          {
            id: "red-a",
            applicationOrder: 0,
            priceAdjustmentCents: -500,
            allocations: [{ memberId: "m-1", priceAdjustmentCents: -500 }],
            promoCode: { code: "SAVE5", xeroItemCode: null, xeroAccountCode: null },
          },
          {
            id: "red-b",
            applicationOrder: 1,
            priceAdjustmentCents: -200,
            allocations: [{ memberId: "m-1", priceAdjustmentCents: -200 }],
            promoCode: { code: "GUESTFREE", xeroItemCode: null, xeroAccountCode: null },
          },
        ],
        nightAdjustments: [
          { promoRedemptionId: "red-a", beneficiaryMemberId: "m-1", amountCents: -500 },
          { promoRedemptionId: "red-b", beneficiaryMemberId: "m-1", amountCents: -200 },
        ],
      }),
    ]);

    const lines = await buildGroupSettlementInvoiceLines("organiser-booking-1");

    expect(
      lines.lineItems.filter((line) => line.description?.startsWith("Promo adjustment")),
    ).toEqual([
      expect.objectContaining({ description: "Promo adjustment - SAVE5, GUESTFREE", unitAmount: -8 }),
    ]);
    expect(lines.lineCents).toBe(lines.childrenCents);
    expect(lines.operationRecord.promoLines).toEqual([
      expect.objectContaining({
        bookingId: "drifted",
        promoLineSource: "AGGREGATE_FALLBACK",
        promoLineReason: "CODE_LINES_DO_NOT_SUM",
      }),
    ]);
  });

  it("reads only the CONFIRMED children the settlement committed", async () => {
    mocks.bookingFindMany.mockResolvedValue([]);

    await buildGroupSettlementInvoiceLines("organiser-booking-1");

    expect(mocks.bookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          parentBookingId: "organiser-booking-1",
          organiserSettled: true,
          deletedAt: null,
          status: "CONFIRMED",
        },
      })
    );
  });

  it("totals lines in cents the way Xero adds them", () => {
    expect(
      invoiceLineItemsTotalCents([
        { unitAmount: 33.33, quantity: 3 },
        { unitAmount: -5, quantity: 1 },
      ])
    ).toBe(9499);
  });
});
