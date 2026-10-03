import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3835: a captured payment's review share on a booking cancelled before the
 * review completed gives back only what the cancellation's refund left owed
 * (owner decision 2 on #3791). The issue's worked example - $200, a $50 share -
 * by card and by credit plus card ($100 each), at 100%, at 50% with a $20 fee
 * and at 0%.
 *
 * The cancellation's figures are the cancel path's own: `paidCancellationMoney`
 * computes what is frozen on the CANCELLED event, and the review-first total is
 * that same function on the booking with the share already refunded. Only the
 * policy READ and the rows are stubbed.
 */

const h = vi.hoisted(() => ({ loadCancellationPolicy: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/cancellation", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/cancellation")),
  loadCancellationPolicy: (...a: unknown[]) => h.loadCancellationPolicy(...a),
}));
vi.mock("@/lib/payment-reconciliation", () => ({
  ManualBookingPaymentError: class ManualBookingPaymentError extends Error {
    constructor(message: string, readonly status = 400) {
      super(message);
    }
  },
}));

import { requireClubTimeZone } from "@/lib/club-time";
import {
  capturedShareOwedAfterCancellationCents,
  shareOwedAfterCancellationCents,
} from "@/lib/edit-financial-review-cancel-netting";
import { REVIEW_CANCELLATION_REFUND_UNREPRODUCIBLE_MESSAGE } from "@/lib/edit-financial-review-refund-refusals";
import { paidCancellationMoney } from "@/lib/paid-cancellation-money";
import { buildEditFinancialReviewRefundRecoveryIdempotencyKey } from "@/lib/payment-recovery-keys";

const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CANCELLED_AT = new Date("2026-07-01T00:00:00.000Z");
/** Days from the cancellation to the stay, as the cancel path counts them. */
const DAYS = 31;
const TIERS = [
  { tier: "100%", rule: { daysBeforeStay: 0, refundPercentage: 100, fixedFeeCents: 0 }, owedCents: 0, totalBackCents: 20_000 },
  { tier: "50% with a $20 fee", rule: { daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 2_000 }, owedCents: 2_500, totalBackCents: 10_500 },
  { tier: "0%", rule: { daysBeforeStay: 0, refundPercentage: 0, fixedFeeCents: 0 }, owedCents: 5_000, totalBackCents: 5_000 },
];
const PAYMENTS = [
  { paid: "card", cardCents: 20_000, appliedCents: 0 },
  { paid: "credit plus card", cardCents: 10_000, appliedCents: 10_000 },
];
type Rule = (typeof TIERS)[number]["rule"];

/** The cancel path's money on a booking of `priceCents` with that card and credit behind it. */
const cancelMoney = (cardCents: number, appliedCents: number, priceCents: number, rule: Rule) =>
  paidCancellationMoney({
    payment: { amountCents: cardCents, refundedAmountCents: 0, changeFeeCents: 0, creditAppliedCents: appliedCents },
    finalPriceCents: priceCents,
    appliedCreditCents: appliedCents,
    restoresToMemberLedger: true,
    days: DAYS,
    policy: [rule],
    refundMethod: "card",
  });

const rows = {
  cancelled: null as unknown,
  siblings: [] as Array<{ id: string; amountCents: number }>,
  refundedBySiblingsCents: 0,
  mintedBySiblingsCents: 0,
};
const store = {
  bookingEvent: { findFirst: vi.fn(async () => rows.cancelled) },
  manualRefundTask: { findMany: vi.fn(async () => rows.siblings) },
  paymentRecoveryOperation: { aggregate: vi.fn(async () => ({ _sum: { amountCents: rows.refundedBySiblingsCents || null } })) },
  memberCredit: { aggregate: vi.fn(async () => ({ _sum: { amountCents: rows.mintedBySiblingsCents || null } })) },
};

/** The CANCELLED event `writePaidCancellationEvent` writes for that cancellation. */
function cancelledAt(cardCents: number, appliedCents: number, rule: Rule) {
  const money = cancelMoney(cardCents, appliedCents, 20_000, rule);
  rows.cancelled = {
    occurredAt: CANCELLED_AT,
    snapshot: {
      refundMethod: "card",
      paidAmountCents: money.paidAmountCents,
      settledAmountCents: money.refundAmountCents,
      changeFeeCents: 0,
      ledger: { appliedCreditCents: appliedCents, creditRestoredCents: money.creditRestoredCents },
    },
  };
  h.loadCancellationPolicy.mockResolvedValue([rule]);
  return money.refundAmountCents + money.creditRestoredCents;
}

const owed = (shareCents = 5_000, taskId = "task-2") =>
  capturedShareOwedAfterCancellationCents({
    bookingId: "booking-1",
    taskId,
    booking: { checkIn: CHECK_IN, lodgeId: "lodge-1" },
    shareCents,
    clubZone: requireClubTimeZone("Pacific/Auckland"),
    store: store as never,
  });

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(rows, { cancelled: null, siblings: [], refundedBySiblingsCents: 0, mintedBySiblingsCents: 0 });
});

describe("the worked example: $200 paid, a $50 share, the booking cancelled first", () => {
  for (const payment of PAYMENTS) {
    it.each(TIERS)(`MUTATION: ${payment.paid}, at $tier: $owedCents cents still owed, $totalBackCents in all - what the review first then the cancel returns`, async ({ rule, owedCents, totalBackCents }) => {
      const returnedCents = cancelledAt(payment.cardCents, payment.appliedCents, rule);

      const stillOwedCents = await owed();

      expect(stillOwedCents).toBe(owedCents);
      expect(returnedCents + stillOwedCents).toBe(totalBackCents);
      // Review first: the share refunded off the card, then the $150 booking
      // cancelled - the same total either way.
      const reviewFirst = cancelMoney(payment.cardCents - 5_000, payment.appliedCents, 15_000, rule);
      expect(5_000 + reviewFirst.refundAmountCents + reviewFirst.creditRestoredCents).toBe(totalBackCents);
    });
  }

  it("MUTATION: before the fix the share went back on top - $130 at 50% with a $20 fee", async () => {
    const returnedCents = cancelledAt(20_000, 0, TIERS[1]!.rule);
    expect(returnedCents + 5_000).toBe(13_000);
    expect(returnedCents + (await owed())).toBe(10_500);
  });
});

describe("sibling reviews of one cancelled booking", () => {
  it("MUTATION: two $20 shares after a card cancel at 50% less $20 net cumulatively: $10 each, $100 in all", async () => {
    const returnedCents = cancelledAt(20_000, 0, TIERS[1]!.rule);
    expect(returnedCents).toBe(8_000);

    const first = await owed(2_000, "task-1");
    expect(first).toBe(1_000);

    // The second sees the first's share and the refund it froze as its debt.
    rows.siblings = [{ id: "task-1", amountCents: 2_000 }];
    rows.refundedBySiblingsCents = first;
    const second = await owed(2_000, "task-2");

    expect(second).toBe(1_000);
    expect(returnedCents + first + second).toBe(10_000);
    expect(store.paymentRecoveryOperation.aggregate).toHaveBeenCalledWith({
      where: { idempotencyKey: { in: [buildEditFinancialReviewRefundRecoveryIdempotencyKey("task-1")] } },
      _sum: { amountCents: true },
    });
  });

  it("MUTATION: a sibling's minted credit counts as returned, as its card refund does", async () => {
    cancelledAt(10_000, 10_000, TIERS[1]!.rule);
    rows.siblings = [{ id: "task-1", amountCents: 2_000 }];
    rows.mintedBySiblingsCents = 1_000;

    expect(await owed(2_000)).toBe(1_000);
  });

  it("MUTATION: never more than the share typed, even where an earlier review returned too little", async () => {
    // $80 refunded; an earlier $50 share returned nothing (completed before #3835).
    cancelledAt(20_000, 0, TIERS[1]!.rule);
    rows.siblings = [{ id: "task-1", amountCents: 5_000 }];
    expect(await owed(2_000)).toBe(2_000);
    // And where the cancellation returned nothing at all.
    cancelledAt(20_000, 0, TIERS[2]!.rule);
    expect(await owed(2_000)).toBe(2_000);
  });
});

describe("what is not netted automatically", () => {
  it("MUTATION: refuses with the task OPEN where no frozen cancellation can be read", async () => {
    await expect(owed()).rejects.toMatchObject({ message: REVIEW_CANCELLATION_REFUND_UNREPRODUCIBLE_MESSAGE, status: 409 });
  });

  it("MUTATION: refuses where the policy in force no longer reproduces the refund", async () => {
    cancelledAt(20_000, 0, TIERS[1]!.rule);
    h.loadCancellationPolicy.mockResolvedValue([{ daysBeforeStay: 0, refundPercentage: 75, fixedFeeCents: 0 }]);

    await expect(owed()).rejects.toMatchObject({ message: REVIEW_CANCELLATION_REFUND_UNREPRODUCIBLE_MESSAGE, status: 409 });
  });

  it("MUTATION: refuses where the policy no longer reproduces the restore of a credit-plus-card booking", async () => {
    cancelledAt(10_000, 10_000, TIERS[1]!.rule);
    const cancelled = rows.cancelled as { snapshot: { ledger: { creditRestoredCents: number } } };
    cancelled.snapshot.ledger.creditRestoredCents += 1;

    await expect(owed()).rejects.toMatchObject({ status: 409 });
  });

  it("a cancellation that returned nothing is not re-tiered, and one that returned everything owes nothing", async () => {
    cancelledAt(20_000, 0, TIERS[2]!.rule);
    expect(await owed()).toBe(5_000);
    cancelledAt(20_000, 0, TIERS[0]!.rule);
    expect(await owed()).toBe(0);
    expect(h.loadCancellationPolicy).not.toHaveBeenCalled();
  });
});

describe("the one formula, shared with the credit-only route (#3791)", () => {
  const halfLessTwenty = (cardBaseCents: number, appliedCents: number) => {
    const cardGross = Math.round(cardBaseCents / 2);
    return Math.max(0, cardGross - 2_000) + Math.max(0, Math.round(appliedCents / 2) - Math.max(0, 2_000 - cardGross));
  };

  it("MUTATION: a share comes off the card base first, then the applied credit", () => {
    // $100 card, $100 credit, $80 returned; $150 left would return $55.
    expect(shareOwedAfterCancellationCents({
      sharesCents: 5_000, cardBaseCents: 10_000, appliedCents: 10_000,
      returnedByCancellationCents: 8_000, returnedSinceCents: 0, returnOf: halfLessTwenty,
    })).toBe(2_500);
  });

  it("MUTATION: with no card base it is #3791's credit-only netting", () => {
    expect(shareOwedAfterCancellationCents({
      sharesCents: 5_000, cardBaseCents: 0, appliedCents: 20_000,
      returnedByCancellationCents: 8_000, returnedSinceCents: 0, returnOf: halfLessTwenty,
    })).toBe(2_500);
  });

  it("MUTATION: floored at zero", () => {
    expect(shareOwedAfterCancellationCents({
      sharesCents: 5_000, cardBaseCents: 20_000, appliedCents: 0,
      returnedByCancellationCents: 20_000, returnedSinceCents: 1_000, returnOf: (base) => base,
    })).toBe(0);
  });
});
