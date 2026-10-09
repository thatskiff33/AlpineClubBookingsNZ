import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PaymentSource, PaymentStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { requireCalendarDate } from "@/lib/club-time";
import {
  applyPaymentAdjustments,
  calculateModificationSettlementOptions,
  organiserChildChargeRefusal,
} from "@/lib/booking-modify-settlement";
import { paymentEligibleForPaidCancelPath } from "@/lib/booking-cancel";
import { ORGANISER_CHILD_CHARGE_REFUSAL } from "@/lib/group-organiser-paid";
import type { BookingModificationSettlementOptions } from "@/lib/booking-modify-settlement";
import { noReductionAgainstUnpaidAsk } from "@/lib/additional-ask-reduction";
import type { LoadedBookingForModify } from "@/lib/booking-modify-validation";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/** #3809: the club's day and format the shared settlement now takes, resolved before its transaction. */
const SETTLEMENT_DAY = { todayAtClub: requireCalendarDate("2026-07-01"), format: CLUB_FORMAT_TEST };
import { OrganiserChildRefundRefusedError } from "@/lib/organiser-child-refund";
import { reopenedRetryAt } from "@/lib/organiser-child-refund-executor";

// `booking-modify-settlement` reaches `@/lib/cancellation`, which constructs the
// Prisma adapter at import time; nothing here touches the module client.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

/*
  #3653 (`INV-PAY-114`): an edit that reduces a booking the group organiser paid
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
    // #3809: no applied credit, so a reduction gives none back.
    memberCredit: { aggregate: vi.fn().mockResolvedValue({ _sum: { amountCents: null } }) },
    // #3827 (composed by #3829): no open by-hand refund task on file.
    // #3954: no increase is waiting on its mint's recovery for a reduction to net off.
    paymentRecoveryOperation: { findMany: vi.fn(async () => []) },
    manualRefundTask: { aggregate: vi.fn(async () => ({ _sum: { amountCents: null } })) },
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
    const result = await applyPaymentAdjustments(tx, { reduction: noReductionAgainstUnpaidAsk(-1500),
      ...SETTLEMENT_DAY,
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
      applyPaymentAdjustments(txWithSettlement(CARD_SETTLEMENT), { reduction: noReductionAgainstUnpaidAsk(-1500),
        ...SETTLEMENT_DAY,
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
        applyPaymentAdjustments(txWithSettlement(settlement), { reduction: noReductionAgainstUnpaidAsk(-1500),
          ...SETTLEMENT_DAY,
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
    const result = await applyPaymentAdjustments(tx, { reduction: noReductionAgainstUnpaidAsk(-1500),
      ...SETTLEMENT_DAY,
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
    // #3827 (composed by #3829): no open by-hand refund task on file.
    // #3954: no increase is waiting on its mint's recovery for a reduction to net off.
    paymentRecoveryOperation: { findMany: vi.fn(async () => []) },
    manualRefundTask: { aggregate: vi.fn(async () => ({ _sum: { amountCents: null } })) },
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
    const card = await calculateModificationSettlementOptions({ reduction: noReductionAgainstUnpaidAsk(-1500),
      booking: child(),
      netChargeCents: -1500,
      db: POLICY_DB,
      todayAtClub,
    });
    expect(card).toMatchObject({ returnsToOrganiser: true, requiresSettlementMethod: false, accountCreditAmountCents: 0 });

    // An organiser who settled by Internet Banking moved no card money: the
    // child keeps the ordinary choice it had before #3653 (#3642 owns that
    // group settlement), and is never quoted a refund to a card.
    const ib = await calculateModificationSettlementOptions({ reduction: noReductionAgainstUnpaidAsk(-1500),
      booking: ibChild(),
      netChargeCents: -1500,
      db: POLICY_DB,
      todayAtClub,
    });
    expect(ib).toMatchObject({ returnsToOrganiser: false, requiresSettlementMethod: true, accountCreditAmountCents: 1500 });
  });

  it("leaves an Internet Banking organiser child's reduction off the organiser's card", async () => {
    const tx = txWithSettlement(CARD_SETTLEMENT);
    const result = await applyPaymentAdjustments(tx, { reduction: noReductionAgainstUnpaidAsk(-1500),
      ...SETTLEMENT_DAY,
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
      applyPaymentAdjustments(txWithSettlement(CARD_SETTLEMENT), { reduction: noReductionAgainstUnpaidAsk(1000),
        ...SETTLEMENT_DAY,
        booking: child(),
        priceDiffCents: 1000,
        changeFeeCents: 0,
      }),
    ).rejects.toBeInstanceOf(OrganiserChildRefundRefusedError);

    // The Internet Banking child keeps its supplementary-invoice path.
    const ib = await applyPaymentAdjustments(txWithSettlement(null), { reduction: noReductionAgainstUnpaidAsk(1000),
      ...SETTLEMENT_DAY,
      booking: ibChild(),
      priceDiffCents: 1000,
      changeFeeCents: 0,
    });
    expect(ib.additionalAsk.amountCents).toBe(0);
  });

  it("the quote shows the refusal the save would meet for an increase, and only for an organiser card child (fix round 2, F3)", () => {
    expect(organiserChildChargeRefusal({ booking: child(), netChargeCents: 1000 })).toBe(ORGANISER_CHILD_CHARGE_REFUSAL);
    expect(organiserChildChargeRefusal({ booking: child(), netChargeCents: -1000 })).toBeNull();
    expect(organiserChildChargeRefusal({ booking: child(), netChargeCents: 0 })).toBeNull();
    expect(organiserChildChargeRefusal({ booking: ibChild(), netChargeCents: 1000 })).toBeNull();
    expect(
      organiserChildChargeRefusal({
        booking: child({ organiserSettled: false, parentBookingId: null }),
        netChargeCents: 1000,
      }),
    ).toBeNull();
    // The quote route answers with the SAME predicate the save refuses on.
    const quote = readFileSync(resolve(REPO_ROOT, "src/app/api/bookings/[id]/modify-quote/route.ts"), "utf8");
    expect(quote).toContain("chargeRefusal: organiserChildChargeRefusal({ booking, netChargeCents }),");
  });

  it("a joiner's organiser-card booking a reduction partly refunded still takes the paid cancel path (fix round 2, F1)", async () => {
    // The executor writes an organiser child's refunds onto its mirror; the
    // child has NO transaction row. Without the organiser rule the gate asks the
    // ledger, finds nothing and sends the cancel down the no-refund branch.
    const noLedger = {
      paymentTransaction: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as Parameters<typeof paymentEligibleForPaidCancelPath>[1];
    const partlyRefunded = {
      id: "payment_1",
      status: PaymentStatus.PARTIALLY_REFUNDED,
      source: PaymentSource.STRIPE,
    };
    await expect(
      paymentEligibleForPaidCancelPath(
        { organiserSettled: true, parentBookingId: "organiser_booking", payment: partlyRefunded },
        noLedger,
      ),
    ).resolves.toBe(true);
    // An ordinary booking in that shape is the mirror-only legacy row (#1491).
    await expect(
      paymentEligibleForPaidCancelPath(
        { organiserSettled: false, parentBookingId: null, payment: partlyRefunded },
        noLedger,
      ),
    ).resolves.toBe(false);
    // An Internet Banking organiser child is not paid by card: ledger rules.
    await expect(
      paymentEligibleForPaidCancelPath(
        {
          organiserSettled: true,
          parentBookingId: "organiser_booking",
          payment: { ...partlyRefunded, source: PaymentSource.INTERNET_BANKING },
        },
        noLedger,
      ),
    ).resolves.toBe(false);
    // Fully refunded is never eligible, organiser child or not.
    await expect(
      paymentEligibleForPaidCancelPath(
        { organiserSettled: true, parentBookingId: "organiser_booking", payment: { ...partlyRefunded, status: PaymentStatus.REFUNDED } },
        noLedger,
      ),
    ).resolves.toBe(false);
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

describe("a reopened organiser child refund waits out Stripe's key window (fix round 2, F2)", () => {
  // The retry re-sends the SAME idempotency key, and inside its 24 hours Stripe
  // answers with the original, now-failed refund: a retry there can only fail
  // and spend the budget. So the reopened debt is next due after the window.
  const created = Date.parse("2026-07-01T00:00:00.000Z") / 1000;

  it("is not due until the key has left the 24-hour window, with a margin", () => {
    const now = new Date("2026-07-01T00:05:00.000Z");
    const due = reopenedRetryAt({ created }, now);
    expect(due.getTime()).toBeGreaterThan(created * 1000 + 24 * 60 * 60 * 1000);
    expect(due.toISOString()).toBe("2026-07-02T01:00:00.000Z");
  });

  it("is due now once the window has already passed", () => {
    const now = new Date("2026-07-05T00:00:00.000Z");
    expect(reopenedRetryAt({ created }, now)).toEqual(now);
  });
});
