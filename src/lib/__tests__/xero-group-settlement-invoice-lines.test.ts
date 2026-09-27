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

import {
  buildGroupSettlementInvoiceLines,
  invoiceLineItemsTotalCents,
} from "@/lib/xero-group-settlement-invoice-lines";

function child(overrides: Record<string, unknown>) {
  return {
    id: "child",
    lodgeId: "lodge-1",
    checkIn: new Date("2026-07-01T00:00:00.000Z"),
    checkOut: new Date("2026-07-02T00:00:00.000Z"),
    promoAdjustmentCents: 0,
    promoRedemption: null,
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
        promoRedemption: { promoCode: { code: "SAVE5", xeroItemCode: null, xeroAccountCode: null } },
      }),
      child({ id: "full-price", finalPriceCents: 5000 }),
    ]);

    const lines = await buildGroupSettlementInvoiceLines("organiser-booking-1");

    expect(lines.childrenCents).toBe(9500);
    expect(lines.lineCents).toBe(9500);
    expect(lines.lineItems).toContainEqual(
      expect.objectContaining({ description: "Promo adjustment - SAVE5", unitAmount: -5 })
    );
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
