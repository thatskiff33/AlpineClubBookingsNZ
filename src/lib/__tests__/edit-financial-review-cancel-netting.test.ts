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

const h = vi.hoisted(() => ({ loadCancellationPolicy: vi.fn(), appliedNowCents: null as number | null }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/cancellation", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/cancellation")),
  loadCancellationPolicy: (...a: unknown[]) => h.loadCancellationPolicy(...a),
}));
// What the booking's applied rows hold now; the frozen figure unless a case moves it.
vi.mock("@/lib/member-credit", () => ({ deriveBookingAppliedCreditCents: async () => h.appliedNowCents ?? 0 }));
vi.mock("@/lib/payment-reconciliation", () => ({
  ManualBookingPaymentError: class ManualBookingPaymentError extends Error {
    constructor(message: string, readonly status = 400) {
      super(message);
    }
  },
}));

import { requireClubTimeZone } from "@/lib/club-time";
import {
  capturedShareOwedAfterCancellation,
  shareOwedAfterCancellationCents,
} from "@/lib/edit-financial-review-cancel-netting";
import {
  REVIEW_CANCELLATION_ORGANISER_PAID_MESSAGE,
  REVIEW_CANCELLATION_REFUND_UNREPRODUCIBLE_MESSAGE,
} from "@/lib/edit-financial-review-refund-refusals";
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
/**
 * By card the cancellation refunds to the card; by internet banking it returns
 * account credit (programme #3527 decision D2), and the share is then handed
 * back by bank transfer - the third captured route.
 */
const PAYMENTS = [
  { paid: "card", cardCents: 20_000, appliedCents: 0, method: "card" as const },
  { paid: "credit plus card", cardCents: 10_000, appliedCents: 10_000, method: "card" as const },
  { paid: "internet banking", cardCents: 20_000, appliedCents: 0, method: "credit" as const },
  { paid: "credit plus internet banking", cardCents: 10_000, appliedCents: 10_000, method: "credit" as const },
];
type Rule = { daysBeforeStay: number; refundPercentage: number; fixedFeeCents: number; creditRefundPercentage?: number };
type Method = "card" | "credit";

/** The cancel path's money on a booking of `priceCents` with that capture and credit behind it. */
const cancelMoney = (
  cardCents: number, appliedCents: number, priceCents: number, rule: Rule, method: Method = "card",
  { cap = false, changeFeeCents = 0 }: { cap?: boolean; changeFeeCents?: number } = {},
) =>
  paidCancellationMoney({
    payment: { amountCents: cardCents, refundedAmountCents: 0, changeFeeCents, creditAppliedCents: appliedCents },
    finalPriceCents: priceCents,
    appliedCreditCents: appliedCents,
    restoresToMemberLedger: true,
    days: DAYS,
    policy: [rule],
    refundMethod: method,
    capAppliedCredit: cap,
  });

const rows = {
  cancelled: null as unknown,
  siblings: [] as Array<{ id: string; amountCents: number; reviewContext?: unknown }>,
  refundedBySiblingsCents: 0,
  mintedBySiblingsCents: 0,
  handedBackBySiblingsCents: 0,
  owner: { organiserSettled: false, parentBookingId: null as string | null, payment: { source: "STRIPE" } },
  capped: false,
};
const store = {
  // #3653: an ordinary booking unless a case makes it a joiner the organiser paid for.
  booking: { findUniqueOrThrow: vi.fn(async () => rows.owner) },
  // #3809's marker (`bookingReducedThroughCreditGiveBack`).
  bookingModification: { findFirst: vi.fn(async () => (rows.capped ? { id: "mod-give-back" } : null)) },
  bookingEvent: { findFirst: vi.fn(async () => rows.cancelled) },
  manualRefundTask: { findMany: vi.fn(async () => rows.siblings) },
  paymentRecoveryOperation: { aggregate: vi.fn(async () => ({ _sum: { amountCents: rows.refundedBySiblingsCents || null } })) },
  memberCredit: { aggregate: vi.fn(async () => ({ _sum: { amountCents: rows.mintedBySiblingsCents || null } })) },
  bookingLedgerLine: { aggregate: vi.fn(async () => ({ _sum: { unitCents: rows.handedBackBySiblingsCents || null } })) },
};

/** The CANCELLED event `writePaidCancellationEvent` writes for that cancellation. */
function cancelledAt(
  cardCents: number, appliedCents: number, rule: Rule, method: Method = "card", priceCents = 20_000,
  options: { cap?: boolean; changeFeeCents?: number } = {},
) {
  const money = cancelMoney(cardCents, appliedCents, priceCents, rule, method, options);
  rows.capped = options.cap ?? false;
  h.appliedNowCents = appliedCents;
  rows.cancelled = {
    occurredAt: CANCELLED_AT,
    snapshot: {
      refundMethod: money.refundAmountCents > 0 ? method : "card",
      paidAmountCents: money.paidAmountCents,
      settledAmountCents: money.refundAmountCents,
      changeFeeCents: options.changeFeeCents ?? 0,
      ledger: {
        appliedCreditCents: appliedCents,
        creditRestoredCents: money.creditRestoredCents,
        // #3809: the base its cap tiered, where it ran.
        ...(options.cap ? { appliedCreditBaseCents: money.appliedCreditBaseCents } : {}),
      },
      // #3835: what the tier ran on, and the reviews settled before it.
      tierRefundMethod: method,
      refundableBaseCents: money.refundableBaseCents,
      completedReviewTaskIds: [],
    },
  };
  h.loadCancellationPolicy.mockResolvedValue([rule]);
  return money.refundAmountCents + money.creditRestoredCents;
}

const split = (shareCents = 5_000, taskId = "task-2") =>
  capturedShareOwedAfterCancellation({
    bookingId: "booking-1",
    taskId,
    booking: { checkIn: CHECK_IN, lodgeId: "lodge-1" },
    shareCents,
    clubZone: requireClubTimeZone("Pacific/Auckland"),
    store: store as never,
  });
/** The whole still owed, both parts. */
const owed = async (shareCents = 5_000, taskId = "task-2") => {
  const { captureCents, creditCents } = await split(shareCents, taskId);
  return captureCents + creditCents;
};
const snapshotOf = () => (rows.cancelled as { snapshot: Record<string, unknown> }).snapshot;

beforeEach(() => {
  vi.clearAllMocks();
  h.appliedNowCents = null;
  Object.assign(rows, {
    cancelled: null, siblings: [], refundedBySiblingsCents: 0, mintedBySiblingsCents: 0, handedBackBySiblingsCents: 0,
    owner: { organiserSettled: false, parentBookingId: null, payment: { source: "STRIPE" } },
    capped: false,
  });
});

describe("the worked example: $200 paid, a $50 share, the booking cancelled first", () => {
  for (const payment of PAYMENTS) {
    it.each(TIERS)(`MUTATION: ${payment.paid}, at $tier: $owedCents cents still owed, $totalBackCents in all - what the review first then the cancel returns`, async ({ rule, owedCents, totalBackCents }) => {
      const returnedCents = cancelledAt(payment.cardCents, payment.appliedCents, rule, payment.method);

      const { captureCents, creditCents } = await split();
      const stillOwedCents = captureCents + creditCents;

      expect(stillOwedCents).toBe(owedCents);
      // The share came off the capture first, so all of it goes back that way.
      expect({ captureCents, creditCents }).toEqual({ captureCents: owedCents, creditCents: 0 });
      expect(returnedCents + stillOwedCents).toBe(totalBackCents);
      // Review first: the share refunded off the card, then the $150 booking
      // cancelled - the same total either way.
      const reviewFirst = cancelMoney(payment.cardCents - 5_000, payment.appliedCents, 15_000, rule, payment.method);
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

  it("MUTATION: a sibling's bank-transfer hand-back counts as returned", async () => {
    cancelledAt(20_000, 0, TIERS[1]!.rule, "credit");
    rows.siblings = [{ id: "task-1", amountCents: 2_000 }];
    rows.handedBackBySiblingsCents = 1_000;

    expect(await owed(2_000)).toBe(1_000);
  });

  it("MUTATION: an internet-banking cancellation is re-tiered by its CREDIT tier", async () => {
    // 50% to a card, 60% as credit, $20 fee: $100 credited; the $150 left would credit $70.
    const returnedCents = cancelledAt(20_000, 0, { daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 2_000, creditRefundPercentage: 60 }, "credit");
    expect(returnedCents).toBe(10_000);

    expect(await owed()).toBe(2_000);
  });

  it("MUTATION: a sibling's minted credit counts as returned, as its card refund does", async () => {
    cancelledAt(10_000, 10_000, TIERS[1]!.rule);
    rows.siblings = [{ id: "task-1", amountCents: 2_000, reviewContext: {
      version: 1,
      occurrence: {
        bookingId: "booking-1", bookingGuestId: "guest-1", cause: "NO_STORED_NIGHT_PRICES",
        surrenderedNightDates: ["2026-08-01"], addedNightDates: [], storedEvidence: { guestTotalCents: null, nightPrices: [] },
      },
      guestMemberId: "member-1", bookingCheckIn: "2026-08-01", bookingCheckOut: "2026-08-03", bookingModificationId: "mod-1",
    } }];
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

describe("#3835 review: it goes back the way it came in", () => {
  it("MUTATION: $150 credit + $50 card, a $100 share after a cancel at 50% (no fee): $25 to the card, $25 as credit - never $50 at a $50 capture with $25 already promised", async () => {
    const rule = { daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 0 };
    const returnedCents = cancelledAt(5_000, 15_000, rule);
    expect(returnedCents).toBe(10_000); // $25 card refund + $75 credit restored

    expect(await split(10_000)).toEqual({ captureCents: 2_500, creditCents: 2_500 });
    // And the review-first total: $100 back, then 50% of the $100 left.
    expect(returnedCents + 5_000).toBe(15_000);
  });

  it("MUTATION: credit an earlier review gave back since the cancel counts on the credit side", async () => {
    const rule = { daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 0 };
    cancelledAt(5_000, 15_000, rule);
    rows.siblings = [{ id: "task-1", amountCents: 10_000 }];
    rows.refundedBySiblingsCents = 2_500;
    h.appliedNowCents = 12_500; // the first review gave $25 of applied credit back

    // $100 + $100 more: what's left tiers to nothing more on the card; $50 of credit.
    expect(await split(10_000)).toEqual({ captureCents: 0, creditCents: 5_000 });
  });
});

describe("#3835 review: the cancellation's own frozen figures", () => {
  it("MUTATION: re-tiers by the refund method the tier actually ran on, not the branch's word for it (F2)", async () => {
    // A manually settled payment tiered on the CREDIT tier: 60%, $20 fee - $100 back.
    cancelledAt(20_000, 0, { daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 2_000, creditRefundPercentage: 60 }, "credit");
    snapshotOf().refundMethod = "manual";

    expect(await owed()).toBe(2_000);
  });

  it("MUTATION: reads the frozen refundable base, which the price capped below what was paid (F3)", async () => {
    // $250 paid against a $200 price: the tier ran on $200, so $80 came back at
    // 50% less $20, and the $50 above the price was left untiered. Read the
    // paid figure as the base and the tier would not reproduce: refused.
    cancelledAt(25_000, 0, TIERS[1]!.rule, "card", 20_000);
    expect(snapshotOf().refundableBaseCents).toBe(20_000);

    // The share comes out of the untiered $50 first, as it would have first.
    expect(await split()).toEqual({ captureCents: 5_000, creditCents: 0 });
  });

  it.each([
    ["100%", TIERS[0]!.rule, 10_000],
    ["50% less $20", TIERS[1]!.rule, 3_000],
  ])("MUTATION: review round 2 F1 - a sibling re-priced the booking to $100 before a cancel at %s with $150 paid: B's $50 comes out of the untiered $50, as B first would", async (_tier, rule, refundedCents) => {
    const returnedCents = cancelledAt(15_000, 0, rule, "card", 10_000);
    expect(returnedCents).toBe(refundedCents);
    expect(snapshotOf().refundableBaseCents).toBe(10_000);

    expect(await split()).toEqual({ captureCents: 5_000, creditCents: 0 });
    // B first: $50 back, then the cancel tiers the same $100 base.
    expect(5_000 + cancelMoney(10_000, 0, 10_000, rule).refundAmountCents).toBe(5_000 + returnedCents);
  });

  it("MUTATION: review round 2 F1 - beyond the untiered excess, the rest nets against the base as before", async () => {
    // $150 paid, $100 base, 50% less $20 ($30 back); an $80 share: $50 untiered + $30 off the base.
    cancelledAt(15_000, 0, TIERS[1]!.rule, "card", 10_000);

    // $80 + 50% of $70 less $20 ($15) - $30 = $65.
    expect(await split(8_000)).toEqual({ captureCents: 6_500, creditCents: 0 });
  });

  it("an event older than #3835 falls back to paid less change fee and the branch's method", async () => {
    cancelledAt(20_000, 0, TIERS[1]!.rule);
    delete snapshotOf().tierRefundMethod;
    delete snapshotOf().refundableBaseCents;

    expect(await owed()).toBe(2_500);
  });

  it("MUTATION: reads #3809's ledger.appliedCreditBaseCents: $50 card + $200 credit at $200, $150 tiered - at 100% the $50 share frees $50 of headroom", async () => {
    const rule = { daysBeforeStay: 0, refundPercentage: 100, fixedFeeCents: 0 };
    const returnedCents = cancelledAt(5_000, 20_000, rule, "card", 20_000, { cap: true });
    expect(returnedCents).toBe(20_000); // $50 card + $150 of the credit

    // Review first: $50 back to the card, then the cap leaves room for all $200 of the credit: $250 in all.
    expect(await split()).toEqual({ captureCents: 0, creditCents: 5_000 });
  });

  it("MUTATION: #3809 - a booking its give-back capped re-tiers on the cap, and one whose cancel froze no capped base is refused", async () => {
    // $100 card + $100 credit, cancelled at 50% less $20 under the cap.
    cancelledAt(10_000, 10_000, TIERS[1]!.rule, "card", 20_000, { cap: true });
    expect(await owed()).toBe(2_500);
    expect(store.bookingModification.findFirst).toHaveBeenCalled();

    delete (snapshotOf().ledger as Record<string, number>).appliedCreditBaseCents;
    await expect(owed()).rejects.toMatchObject({ message: REVIEW_CANCELLATION_REFUND_UNREPRODUCIBLE_MESSAGE, status: 409 });
  });

  it("MUTATION: #3809 - applied credit above the cap the cancel left untiered is taken before the credit it tiered", async () => {
    // $50 card + $200 applied, $150 of it tiered; 50% (no fee): $25 refunded, $75 restored.
    const rule = { daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 0 };
    // $50 card + $200 credit at a $200 price, capped: $150 of the credit tiered.
    const returnedCents = cancelledAt(5_000, 20_000, rule, "card", 20_000, { cap: true });
    expect((snapshotOf().ledger as Record<string, number>).appliedCreditBaseCents).toBe(15_000);
    expect(returnedCents).toBe(10_000);

    // A $100 share: $50 off the card, $50 off the untiered credit; the $150 tiered still returns $75.
    expect(await split(10_000)).toEqual({ captureCents: 2_500, creditCents: 5_000 });
  });

  it("MUTATION: #3653 - a cancelled joiner's booking the organiser paid by card is refused, task OPEN, never netted", async () => {
    cancelledAt(20_000, 0, TIERS[1]!.rule);
    rows.owner = { organiserSettled: true, parentBookingId: "parent-1", payment: { source: "STRIPE" } };

    await expect(owed()).rejects.toMatchObject({ message: REVIEW_CANCELLATION_ORGANISER_PAID_MESSAGE, status: 409 });
    expect(store.bookingEvent.findFirst).not.toHaveBeenCalled();
  });

  it("MUTATION: counts siblings settled AFTER the cancel by the ids it froze, not by the clock", async () => {
    cancelledAt(20_000, 0, TIERS[1]!.rule);
    snapshotOf().completedReviewTaskIds = ["task-before"];
    await owed(5_000, "task-2");

    expect(store.manualRefundTask.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.not.objectContaining({ completedAt: expect.anything() }),
    }));
    expect(store.manualRefundTask.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { notIn: ["task-2", "task-before"] } }),
    }));
  });
});

describe("#3835 integration review H: #3809's money-first cap, the review first", () => {
  /** What the member gets in all, the review first: the share off the card, then the cancel on what is left. */
  const reviewFirstTotal = (shape: { card: number; credit: number; price: number; fee: number; share: number }, rule: Rule) => {
    const toCard = Math.min(shape.share, shape.card - shape.fee);
    const money = cancelMoney(shape.card - toCard, shape.credit - (shape.share - toCard), shape.price, rule, "card", { cap: true, changeFeeCents: shape.fee });
    return shape.share + money.refundAmountCents + money.creditRestoredCents;
  };
  const SHAPES = [
    { name: "$100 card + $100 credit at $150, a $30 share", card: 10_000, credit: 10_000, price: 15_000, fee: 0, share: 3_000, full: 18_000, half: 8_500 },
    { name: "$50 card + $200 credit at $200, a $30 share", card: 5_000, credit: 20_000, price: 20_000, fee: 0, share: 3_000, full: 23_000, half: 11_000 },
    { name: "$200 card + $50 credit at $150, a $10 fee, a $60 share", card: 20_000, credit: 5_000, price: 15_000, fee: 1_000, share: 6_000, full: 21_000, half: 11_500 },
  ];
  for (const shape of SHAPES) {
    for (const [tier, rule, expectedCents] of [["100%", TIERS[0]!.rule, shape.full], ["50% less $20", TIERS[1]!.rule, shape.half]] as const) {
      it(`MUTATION: ${shape.name}, cancelled at ${tier}: the member gets ${expectedCents} cents in all, as the review first`, async () => {
        const returnedCents = cancelledAt(shape.card, shape.credit, rule, "card", shape.price, { cap: true, changeFeeCents: shape.fee });

        const { captureCents, creditCents } = await split(shape.share);

        expect(reviewFirstTotal(shape, rule)).toBe(expectedCents);
        expect(returnedCents + captureCents + creditCents).toBe(expectedCents);
      });
    }
  }

  it("an uncapped booking at 0% is exact either way: the share whole", async () => {
    cancelledAt(10_000, 10_000, TIERS[2]!.rule, "card", 15_000);
    expect(await owed(3_000)).toBe(3_000);
  });
});
