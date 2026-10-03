import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PaymentSource, PaymentStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { applyPaymentAdjustments } from "@/lib/booking-modify-settlement";
import type { BookingModificationSettlementOptions } from "@/lib/booking-modify-settlement";
import type { LoadedBookingForModify } from "@/lib/booking-modify-validation";
import { OrganiserChildRefundRefusedError } from "@/lib/organiser-child-refund";

// `booking-modify-settlement` reaches `@/lib/cancellation`, which constructs the
// Prisma adapter at import time; nothing here touches the module client.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

/*
  #3653 (`INV-PAY-111`): an edit that reduces a booking the group organiser paid
  for returns the reduction to the organiser's card, from the group's combined
  payment. These pin the edit-door half: one disposition (no account credit),
  and a refusal BEFORE the edit commits when the combined payment cannot pay it.
  The provider half is proved against PostgreSQL in
  `organiser-child-refund.realdb.test.ts`.
*/

const REPO_ROOT = resolve(__dirname, "../../..");

function child(overrides: Record<string, unknown> = {}) {
  return {
    id: "child_1",
    status: "PAID",
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    lodgeId: "lodge_1",
    memberId: "joiner_1",
    organiserSettled: true,
    parentBookingId: "organiser_booking",
    payment: {
      id: "payment_1",
      status: PaymentStatus.SUCCEEDED,
      source: PaymentSource.STRIPE,
      amountCents: 4500,
      refundedAmountCents: 0,
      creditAppliedCents: 0,
      additionalAmountCents: 0,
      additionalPaymentStatus: null,
      xeroInvoiceId: null,
    },
    ...overrides,
  } as unknown as LoadedBookingForModify;
}

const ORGANISER_OPTIONS: BookingModificationSettlementOptions = {
  basisAmountCents: 1500,
  cardRefundAmountCents: 1500,
  cardRefundPercentage: 100,
  accountCreditAmountCents: 0,
  accountCreditPercentage: 0,
  daysUntilCheckIn: 30,
  requiresSettlementMethod: false,
  returnsToOrganiser: true,
};

function txWithSettlement(settlement: Record<string, unknown> | null) {
  return {
    payment: { update: vi.fn().mockResolvedValue({}) },
    groupBookingSettlement: { findFirst: vi.fn().mockResolvedValue(settlement) },
  } as unknown as Parameters<typeof applyPaymentAdjustments>[0];
}

const CARD_SETTLEMENT = {
  id: "settlement_1",
  stripePaymentIntentId: "pi_combined",
  amountCents: 9000,
  status: PaymentStatus.SUCCEEDED,
  refundPlan: null,
};

describe("an organiser child's reduction at the edit door (#3653)", () => {
  it("returns the reduction to the organiser's card from the combined payment, with no method chosen", async () => {
    const tx = txWithSettlement(CARD_SETTLEMENT);
    const result = await applyPaymentAdjustments(tx, {
      booking: child(),
      priceDiffCents: -1500,
      changeFeeCents: 0,
      settlementOptions: ORGANISER_OPTIONS,
    });
    expect(result.settlementMethod).toBe("card");
    expect(result.accountCreditAmountCents).toBe(0);
    expect(result.pendingRefundAmountCents).toBe(1500);
    expect(result.organiserChildRefund).toEqual({
      settlement: CARD_SETTLEMENT,
      amountCents: 1500,
    });
  });

  it("refuses account credit for a booking the organiser paid for, before the edit commits", async () => {
    await expect(
      applyPaymentAdjustments(txWithSettlement(CARD_SETTLEMENT), {
        booking: child(),
        priceDiffCents: -1500,
        changeFeeCents: 0,
        settlementOptions: ORGANISER_OPTIONS,
        settlementMethod: "credit",
      }),
    ).rejects.toThrow("cannot be held as account credit");
  });

  it("refuses the reduction when the organiser's card payment is gone or fully refunded", async () => {
    for (const settlement of [null, { ...CARD_SETTLEMENT, status: PaymentStatus.REFUNDED }]) {
      await expect(
        applyPaymentAdjustments(txWithSettlement(settlement), {
          booking: child(),
          priceDiffCents: -1500,
          changeFeeCents: 0,
          settlementOptions: ORGANISER_OPTIONS,
        }),
      ).rejects.toBeInstanceOf(OrganiserChildRefundRefusedError);
    }
  });

  it("leaves an ordinary booking's refund on the ordinary path", async () => {
    const tx = txWithSettlement(CARD_SETTLEMENT);
    const result = await applyPaymentAdjustments(tx, {
      booking: child({ organiserSettled: false, parentBookingId: null }),
      priceDiffCents: -1500,
      changeFeeCents: 0,
      settlementOptions: { ...ORGANISER_OPTIONS, returnsToOrganiser: false, requiresSettlementMethod: true },
      settlementMethod: "card",
    });
    expect(result.organiserChildRefund).toBeNull();
    expect(result.pendingRefundAmountCents).toBe(1500);
  });

  it("every door that settles an edit through applyPaymentAdjustments writes the child's refund debt before it commits", () => {
    for (const door of [
      "src/lib/booking-batch-modification-service.ts",
      "src/lib/booking-date-modification-service.ts",
      "src/lib/booking-guest-removal-service.ts",
    ]) {
      const source = readFileSync(resolve(REPO_ROOT, door), "utf8");
      expect(source, door).toContain("await applyPaymentAdjustments(tx,");
      expect(source, door).toMatch(/await reserveOrganiserChildModificationRefund\(tx, \{\s+plan: \w+\.organiserChildRefund,/);
      expect(source, door).toMatch(/organiserChildRefund: \w+\.organiserChildRefund,/);
    }
  });
});
