/**
 * #3827 (`INV-PAY-114`): an edit refund hand-back is raised when the edit
 * commits, but the payment's `refundedAmountCents` moves only when the treasurer
 * marks it paid back. Until then every later edit, acceptance and cancellation
 * must size its refund off the captured cash NET of those open tasks, so the
 * club never promises back more than it took.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
const policy = vi.hoisted(() => ({ loadCancellationPolicy: vi.fn() }));
vi.mock("@/lib/cancellation", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/cancellation")),
  loadCancellationPolicy: policy.loadCancellationPolicy,
}));

import {
  applyPaymentAdjustments,
  calculateModificationSettlementOptions,
} from "@/lib/booking-modify-settlement";
import { requireCalendarDate } from "@/lib/club-time";
import {
  openNonCancellationHandBackCents,
  refundableCashNetOfOpenHandBacks,
} from "@/lib/edit-refund-hand-back";
import { paidCancellationMoney } from "@/lib/paid-cancellation-money";
import { calculateCancellationPreview } from "@/lib/policies/booking-route-decisions";

const TODAY = requireCalendarDate("2026-07-01");
const FULL_REFUND = [{ daysBeforeStay: 0, refundPercentage: 100, creditRefundPercentage: 100, fixedFeeCents: 0 }];

function store(openCents: number | null) {
  return {
    manualRefundTask: { aggregate: vi.fn(async () => ({ _sum: { amountCents: openCents } })) },
    payment: { update: vi.fn() },
  };
}

/** $300 paid by internet banking, nothing refunded yet. */
function ibPayment(overrides: Record<string, unknown> = {}) {
  return {
    id: "pay-1",
    source: "INTERNET_BANKING",
    status: "SUCCEEDED",
    amountCents: 30000,
    refundedAmountCents: 0,
    changeFeeCents: 0,
    creditAppliedCents: 0,
    additionalAmountCents: 0,
    additionalPaymentStatus: null,
    xeroInvoiceId: "inv-1",
    ...overrides,
  };
}

function paidBooking(finalPriceCents: number, payment = ibPayment()) {
  return {
    id: "booking-1",
    status: "PAID",
    lodgeId: "lodge-1",
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    finalPriceCents,
    payment,
  };
}

describe("the money already promised back by hand", () => {
  it("is the sum of the payment's OPEN edit refund hand-backs, by kind and key prefix", async () => {
    const db = store(20000);
    expect(await openNonCancellationHandBackCents(db as never, "pay-1")).toBe(20000);
    expect(db.manualRefundTask.aggregate).toHaveBeenCalledWith({
      where: {
        paymentId: "pay-1",
        status: "OPEN",
        kind: "CANCELLED_BOOKING_HAND_BACK",
        occurrenceKey: { startsWith: "edit-refund-hand-back:" },
      },
      _sum: { amountCents: true },
    });
  });

  it("is zero with no payment, and with no task on file", async () => {
    const db = store(null);
    expect(await openNonCancellationHandBackCents(db as never, null)).toBe(0);
    expect(db.manualRefundTask.aggregate).not.toHaveBeenCalled();
    expect(await openNonCancellationHandBackCents(db as never, "pay-1")).toBe(0);
  });

  it("comes off the refundable cash, never below zero", async () => {
    expect(await refundableCashNetOfOpenHandBacks(store(20000) as never, ibPayment())).toBe(10000);
    expect(await refundableCashNetOfOpenHandBacks(store(40000) as never, ibPayment())).toBe(0);
    expect(
      await refundableCashNetOfOpenHandBacks(store(5000) as never, ibPayment({ refundedAmountCents: 10000 })),
    ).toBe(15000);
  });
});

describe("a later edit sizes its refund net of an open task (scenario B: $300 -> $100 -> $250 -> $50)", () => {
  // $300 paid; the first edit to $100 left a $200 task open; the booking went
  // back up to $250 (collected on a supplementary invoice, which does not move
  // the payment's captured amount), and now drops to $50. Only $100 of the $300
  // taken is not already promised back.
  it("the policy-tiered options cap the basis at $100, not $200", async () => {
    policy.loadCancellationPolicy.mockResolvedValue(FULL_REFUND);
    const options = await calculateModificationSettlementOptions({
      booking: paidBooking(25000) as never,
      netChargeCents: -20000,
      db: store(20000) as never,
      todayAtClub: TODAY,
    });
    expect(options).toMatchObject({ basisAmountCents: 10000, cardRefundAmountCents: 10000 });
  });

  it("applyPaymentAdjustments' untiered arm refunds $100, not $200", async () => {
    const result = await applyPaymentAdjustments(store(20000) as never, {
      booking: paidBooking(25000) as never,
      priceDiffCents: -20000,
      changeFeeCents: 0,
    });
    expect(result.refundAmountCents).toBe(10000);
    expect(result.hasSucceededPayment).toBe(false);
  });

  it("nothing is offered back once the open tasks cover all the cash", async () => {
    policy.loadCancellationPolicy.mockResolvedValue(FULL_REFUND);
    const options = await calculateModificationSettlementOptions({
      booking: paidBooking(25000) as never,
      netChargeCents: -20000,
      db: store(30000) as never,
      todayAtClub: TODAY,
    });
    expect(options).toBeNull();
  });
});

describe("a cancellation after an open task refunds or credits only the rest (scenario C)", () => {
  // $300 = $200 internet banking + $100 credit, edited to $250 with a $50 task
  // open. Cancelled at a 100% tier: the cash the cancel may return is $150 —
  // with the $50 task and the $100 credit restored, $300 in all.
  const payment = { amountCents: 20000, refundedAmountCents: 0, changeFeeCents: 0, creditAppliedCents: 10000 };

  it("the executed cancel's refundable base is $150, not $200", () => {
    const money = paidCancellationMoney({
      payment,
      openNonCancellationHandBackCents: 5000,
      finalPriceCents: 25000,
      appliedCreditCents: 10000,
      restoresToMemberLedger: true,
      days: 31,
      policy: FULL_REFUND,
      refundMethod: "credit",
    });
    expect(money.paidAmountCents).toBe(15000);
    expect(money.refundableBaseCents).toBe(15000);
    expect(money.refundAmountCents).toBe(15000);
    expect(money.retainedAmountCents).toBe(0);
  });

  it("the preview a member sees agrees", () => {
    const preview = calculateCancellationPreview({
      payment,
      openNonCancellationHandBackCents: 5000,
      finalPriceCents: 25000,
      checkIn: new Date("2026-08-01T00:00:00.000Z"),
      policyRules: FULL_REFUND,
      todayAtClub: TODAY,
    });
    expect(preview).toMatchObject({ refundAmountCents: 15000, creditRefundAmountCents: 15000, totalPaidCents: 15000 });
  });
});
