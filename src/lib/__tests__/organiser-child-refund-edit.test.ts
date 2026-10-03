import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PaymentSource, PaymentStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { requireCalendarDate } from "@/lib/club-time";
import {
  applyPaymentAdjustments,
  calculateModificationSettlementOptions,
} from "@/lib/booking-modify-settlement";
import type { BookingModificationSettlementOptions } from "@/lib/booking-modify-settlement";
import type { LoadedBookingForModify } from "@/lib/booking-modify-validation";
import { OrganiserChildRefundRefusedError } from "@/lib/organiser-child-refund";

// `booking-modify-settlement` reaches `@/lib/cancellation`, which constructs the
// Prisma adapter at import time; nothing here touches the module client.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

/*
  #3653 (`INV-PAY-113`): an edit that reduces a booking the group organiser paid
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

  /** A policy db for `calculateModificationSettlementOptions`: one 100% card, 100% credit tier. */
  const POLICY_DB = {
    lodge: { findFirst: vi.fn().mockResolvedValue({ id: "lodge_1" }) },
    bookingPeriod: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    bookingDefaults: { findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn().mockResolvedValue(null) },
    cancellationPolicy: {
      findMany: vi.fn().mockResolvedValue([
        { lodgeId: "lodge_1", daysBeforeStay: 0, refundPercentage: 100, creditRefundPercentage: 100, fixedFeeCents: 0, creditFixedFeeCents: 0 },
      ]),
    },
  } as unknown as Parameters<typeof calculateModificationSettlementOptions>[0]["db"];

  function ibChild() {
    const booking = child();
    return {
      ...booking,
      payment: { ...booking.payment!, source: PaymentSource.INTERNET_BANKING },
    } as unknown as LoadedBookingForModify;
  }

  it("quotes the organiser's card only for a child the organiser paid for BY CARD", async () => {
    const todayAtClub = requireCalendarDate("2026-07-01");
    const card = await calculateModificationSettlementOptions({
      booking: child(),
      netChargeCents: -1500,
      db: POLICY_DB,
      todayAtClub,
    });
    expect(card).toMatchObject({ returnsToOrganiser: true, requiresSettlementMethod: false, accountCreditAmountCents: 0 });

    // An organiser who settled by Internet Banking moved no card money: the
    // child keeps the ordinary choice it had before #3653 (#3642 owns that
    // group settlement), and is never quoted a refund to a card.
    const ib = await calculateModificationSettlementOptions({
      booking: ibChild(),
      netChargeCents: -1500,
      db: POLICY_DB,
      todayAtClub,
    });
    expect(ib).toMatchObject({ returnsToOrganiser: false, requiresSettlementMethod: true, accountCreditAmountCents: 1500 });
  });

  it("leaves an Internet Banking organiser child's reduction off the organiser's card", async () => {
    const tx = txWithSettlement(CARD_SETTLEMENT);
    const result = await applyPaymentAdjustments(tx, {
      booking: ibChild(),
      priceDiffCents: -1500,
      changeFeeCents: 0,
      settlementOptions: {
        ...ORGANISER_OPTIONS,
        accountCreditAmountCents: 1500,
        returnsToOrganiser: false,
        requiresSettlementMethod: true,
      },
      settlementMethod: "credit",
    });
    expect(result.organiserChildRefund).toBeNull();
    expect(result.accountCreditAmountCents).toBe(1500);
  });

  it("refuses a price increase on a child the organiser paid for by card, before the edit commits", async () => {
    // An ask here would charge the JOINER for a booking the organiser paid for,
    // and its transaction row would make the next reconcile wipe the child's
    // refunded total - the 10000 paid / 4000 refunded / +1000 sequence that
    // re-promised the 4000 to a later cancellation.
    await expect(
      applyPaymentAdjustments(txWithSettlement(CARD_SETTLEMENT), {
        booking: child(),
        priceDiffCents: 1000,
        changeFeeCents: 0,
      }),
    ).rejects.toBeInstanceOf(OrganiserChildRefundRefusedError);

    // The Internet Banking child keeps its supplementary-invoice path.
    const ib = await applyPaymentAdjustments(txWithSettlement(null), {
      booking: ibChild(),
      priceDiffCents: 1000,
      changeFeeCents: 0,
    });
    expect(ib.additionalAsk.amountCents).toBe(0);
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
