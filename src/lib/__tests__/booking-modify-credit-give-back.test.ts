import { PaymentSource, PaymentStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LoadedBookingForModify } from "@/lib/booking-modify-validation";
import type { CancellationRule } from "@/lib/cancellation";
import type { CalendarDate } from "@/lib/club-time";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/*
  #3809 (owner decision A): a price reduction on a booking paid ENTIRELY with
  account credit gives back what a card-paid booking's would - `min(reduction,
  applied credit)` tiered by the card tier - through the one give-back.

  `giveBackAppliedCredit` is replaced by a stand-in that does what it does to the
  figures (asks the callback with the applied credit, caps the answer at it), so
  these pin the base, the tier, the mirror and the Xero figures. The real
  give-back, its lock and its Xero step are proven on PostgreSQL in
  `credit-paid-reduction.realdb.test.ts`.
*/

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

const credit = vi.hoisted(() => ({
  applied: 0,
  derive: vi.fn(),
  giveBack: vi.fn(),
  policy: [] as CancellationRule[],
}));

vi.mock("@/lib/member-credit", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  deriveBookingAppliedCreditCents: credit.derive,
  giveBackAppliedCredit: credit.giveBack,
}));

vi.mock("@/lib/cancellation", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  loadCancellationPolicy: vi.fn(async () => credit.policy),
}));

const { applyPaymentAdjustments, calculateModificationSettlementOptions } = await import("@/lib/booking-modify-settlement");
const { calculateDualRefundAmounts } = await import("@/lib/cancellation");
const { previewPaidReductionCreditGiveBackCents } = await import("@/lib/booking-modify-credit-give-back");
const { calculateCancellationPreview } = await import("@/lib/policies/booking-route-decisions");
const { cancelAppliedCreditBaseCents } = await import("@/lib/booking-payment-state");
const { classifyXeroBookingEditSettlement } = await import("@/lib/xero-booking-edit-settlement");
const { paidCancellationMoney } = await import("@/lib/paid-cancellation-money");

const TODAY = "2026-07-01" as CalendarDate;
const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");

const TIERS = {
  "100%": [{ daysBeforeStay: 0, refundPercentage: 100, fixedFeeCents: 0 }],
  "50% with a $20 fee": [{ daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 2_000 }],
  "0%": [{ daysBeforeStay: 0, refundPercentage: 0, fixedFeeCents: 0 }],
} satisfies Record<string, CancellationRule[]>;

const paymentUpdate = vi.fn();
// #3827 (composed by #3829): no open by-hand refund task on file, so the
// refundable cash is the payment's own.
const NO_HAND_BACKS = { manualRefundTask: { aggregate: vi.fn(async () => ({ _sum: { amountCents: null } })) } };
const tx = { payment: { update: paymentUpdate }, ...NO_HAND_BACKS } as unknown as Parameters<typeof applyPaymentAdjustments>[0];

/** $200, paid entirely by account credit: nothing captured, PAID. */
function creditPaidBooking(overrides: { status?: string; payment?: Record<string, unknown>; memberId?: string | null } = {}) {
  return {
    id: "booking_3809",
    status: overrides.status ?? "PAID",
    checkIn: CHECK_IN,
    lodgeId: "lodge_1",
    memberId: overrides.memberId === undefined ? "member_1" : overrides.memberId,
    finalPriceCents: 20_000,
    payment: {
      id: "payment_1",
      status: PaymentStatus.SUCCEEDED,
      source: PaymentSource.INTERNET_BANKING,
      amountCents: 0,
      refundedAmountCents: 0,
      creditAppliedCents: 20_000,
      changeFeeCents: 0,
      additionalAmountCents: 0,
      additionalPaymentStatus: null,
      xeroInvoiceId: "INV-3809",
      ...overrides.payment,
    },
  } as unknown as LoadedBookingForModify;
}

const reduce = (booking: LoadedBookingForModify, priceDiffCents = -5_000) =>
  applyPaymentAdjustments(tx, {
    booking,
    priceDiffCents,
    changeFeeCents: 0,
    todayAtClub: TODAY,
    format: CLUB_FORMAT_TEST,
  });

beforeEach(() => {
  vi.clearAllMocks();
  credit.applied = 20_000;
  credit.derive.mockImplementation(async () => credit.applied);
  credit.giveBack.mockImplementation(async ({ giveBackCentsOf }) => {
    const payment = { id: "payment_1", source: PaymentSource.INTERNET_BANKING, xeroInvoiceId: "INV-3809", creditAppliedCents: 20_000 };
    const asked = await giveBackCentsOf(credit.applied, payment);
    return { appliedCreditCents: credit.applied, givenBackCents: Math.max(0, Math.min(credit.applied, asked)), payment };
  });
});

describe("#3809: a credit-paid booking's $50 reduction, tiered like a card refund", () => {
  it.each([
    { tier: "100%" as const, givenBackCents: 5_000, retainedCents: 0 },
    { tier: "50% with a $20 fee" as const, givenBackCents: 500, retainedCents: 4_500 },
    { tier: "0%" as const, givenBackCents: 0, retainedCents: 5_000 },
  ])("MUTATION: at $tier the member gets $givenBackCents cents back as applied credit, and the invoice note is that much", async ({ tier, givenBackCents, retainedCents }) => {
    credit.policy = TIERS[tier];

    const result = await reduce(creditPaidBooking());

    expect(result.appliedCreditGivenBackCents).toBe(givenBackCents);
    expect(result.policyRetainedAmountCents).toBe(retainedCents);
    // Neither a refund nor minted credit: nothing downstream pays it again.
    expect(result.refundAmountCents).toBe(0);
    expect(result.accountCreditAmountCents).toBe(0);
    expect(result.pendingRefundAmountCents).toBe(0);
    // Xero: no refund note - the give-back is its own figure, which the Xero
    // leg takes as an invoice-allocated note (below), not the whole $50.
    expect(result.xeroRefundAmountCents).toBe(0);
    // The mirror a later cancellation tiers comes down to the ledger's figure.
    if (givenBackCents > 0) {
      expect(paymentUpdate).toHaveBeenCalledWith({
        where: { id: "payment_1" },
        data: { creditAppliedCents: 20_000 - givenBackCents },
      });
    } else {
      expect(paymentUpdate).not.toHaveBeenCalled();
    }
    expect(credit.giveBack).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: "member_1", bookingId: "booking_3809", format: CLUB_FORMAT_TEST }),
      tx,
    );
  });

  it("MUTATION: the base is min(reduction, applied credit) - $30 applied on a $50 reduction is tiered from $30: $15 back at 50%", async () => {
    credit.policy = [{ daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 0 }];
    credit.applied = 3_000;

    const result = await reduce(creditPaidBooking());

    expect(result.appliedCreditGivenBackCents).toBe(1_500);
    expect(result.policyRetainedAmountCents).toBe(1_500);
  });

  it("a change fee folds into the reduction exactly as on the card path", async () => {
    credit.policy = TIERS["100%"];

    const result = await applyPaymentAdjustments(tx, {
      booking: creditPaidBooking(),
      priceDiffCents: -5_000,
      changeFeeCents: 1_000,
      todayAtClub: TODAY,
      format: CLUB_FORMAT_TEST,
    });

    expect(result.appliedCreditGivenBackCents).toBe(4_000);
  });

  it("Xero classifies the give-back as the ordinary invoice-allocated reduction note, worded as account credit - never the unallocated account-credit note", async () => {
    credit.policy = TIERS["100%"];
    const result = await reduce(creditPaidBooking());

    const decision = classifyXeroBookingEditSettlement({
      hasIssuedXeroInvoice: result.hasIssuedXeroInvoice,
      priceDiffCents: -5_000,
      settlementMethod: result.settlementMethod,
      settlementAmountCents: result.xeroRefundAmountCents,
      refundedThroughStripe: result.hasSucceededPayment,
      appliedCreditGiveBackCents: result.appliedCreditGivenBackCents,
    });

    // No refund, so no note of the edit's own: the give-back is its own
    // allocated note, always under its own scope (review of #3809).
    expect(decision.financialAction).toEqual(expect.objectContaining({
      type: "modification-credit-note",
      refundAmountCents: 0,
      allocatedGiveBackCents: 5_000,
    }));
  });

  it("at 0% no note is raised at all, where the whole $50 used to be noted against an invoice with nothing due", async () => {
    credit.policy = TIERS["0%"];
    const result = await reduce(creditPaidBooking());

    const decision = classifyXeroBookingEditSettlement({
      hasIssuedXeroInvoice: result.hasIssuedXeroInvoice,
      priceDiffCents: -5_000,
      settlementMethod: result.settlementMethod,
      settlementAmountCents: result.xeroRefundAmountCents,
      appliedCreditGiveBackCents: result.appliedCreditGivenBackCents,
    });

    expect(decision.financialAction.type).toBe("none");
  });

  it("the issue's worked example: $50 back at 100%, then a cancel at 50% less $20 tiers the $150 still applied - $105 in all, what a card-paid booking gets", async () => {
    credit.policy = TIERS["100%"];
    const reduced = await reduce(creditPaidBooking());
    const mirror = 20_000 - reduced.appliedCreditGivenBackCents;

    const cancel = paidCancellationMoney({
      payment: { amountCents: 0, refundedAmountCents: 0, changeFeeCents: 0, creditAppliedCents: mirror },
      openNonCancellationHandBackCents: 0,
      finalPriceCents: 15_000,
      appliedCreditCents: mirror,
      restoresToMemberLedger: true,
      days: 31,
      policy: TIERS["50% with a $20 fee"],
      refundMethod: "card",
      capAppliedCredit: true,
    });

    expect(reduced.appliedCreditGivenBackCents + cancel.creditRestoredCents).toBe(10_500);
    // A card-paid $200 booking: $50 refunded at 100%, then the cancel tiers $150.
    const card = paidCancellationMoney({
      payment: { amountCents: 20_000, refundedAmountCents: 5_000, changeFeeCents: 0, creditAppliedCents: 0 },
      openNonCancellationHandBackCents: 0,
      finalPriceCents: 15_000,
      appliedCreditCents: 0,
      restoresToMemberLedger: true,
      days: 31,
      policy: TIERS["50% with a $20 fee"],
      refundMethod: "card",
      capAppliedCredit: false,
    });
    expect(5_000 + card.refundAmountCents).toBe(10_500);
  });
});

describe("#3809: every other booking settles exactly as before", () => {
  beforeEach(() => {
    credit.policy = TIERS["100%"];
  });

  it.each(["CONFIRMED", "PAYMENT_PENDING"])("MUTATION: a %s booking with nothing captured is still owing - the reduction lowers the invoice by the whole $50 and gives nothing back", async (status) => {
    const result = await reduce(creditPaidBooking({ status }));

    expect(credit.giveBack).not.toHaveBeenCalled();
    expect(result.appliedCreditGivenBackCents).toBe(0);
    expect(result.xeroRefundAmountCents).toBe(5_000);
  });

  it("MUTATION: a booking with no applied credit never takes the member's ledger key", async () => {
    credit.applied = 0;

    const result = await reduce(creditPaidBooking());

    expect(credit.derive).toHaveBeenCalledTimes(1);
    expect(credit.giveBack).not.toHaveBeenCalled();
    expect(result.xeroRefundAmountCents).toBe(5_000);
  });

  it("an organisation-owned booking holds no member credit to give back", async () => {
    const result = await reduce(creditPaidBooking({ memberId: null }));

    expect(credit.derive).not.toHaveBeenCalled();
    expect(credit.giveBack).not.toHaveBeenCalled();
    expect(result.appliedCreditGivenBackCents).toBe(0);
  });

  it("MUTATION: a card payment that covers the whole reduction keeps the card path - the member key is never taken, but the history records the booking's credit", async () => {
    const result = await reduce(creditPaidBooking({ payment: { amountCents: 20_000, source: PaymentSource.STRIPE } }));

    expect(credit.giveBack).not.toHaveBeenCalled();
    expect(result.appliedCreditGivenBackCents).toBe(0);
    // Owner decision of 4 Oct 2026: a later cancellation caps this booking's
    // credit, as it caps an all-card booking's paid money (INV-PAY-115).
    expect(result.appliedCreditGiveBack).toEqual({ basisCents: 0, givenBackCents: 0 });
  });

  it("a booking with no applied credit records nothing for the cancellation to cap by", async () => {
    credit.applied = 0;
    expect((await reduce(creditPaidBooking())).appliedCreditGiveBack).toBeNull();
  });

  it("a price increase gives nothing back", async () => {
    const result = await reduce(creditPaidBooking(), 5_000);

    expect(credit.derive).not.toHaveBeenCalled();
    expect(result.appliedCreditGivenBackCents).toBe(0);
  });
});

/*
  Finding 4 of the #3809 fix round: $100 by card and $100 by credit, a $150
  reduction. The card basis returns what money paid can ($100); the rest comes
  back from the applied credit, tiered by the same card tier with the fixed fee
  once, card-first - so the member gets what a $200 card-paid booking would.
*/
describe("#3809: a booking paid by card AND credit gets back what an all-card one would", () => {
  const MIXED = { amountCents: 10_000, source: PaymentSource.STRIPE, creditAppliedCents: 10_000 };

  async function reduceMixed(rule: CancellationRule[], settlementMethod: "card" | "credit") {
    credit.policy = rule;
    credit.applied = 10_000;
    const booking = creditPaidBooking({ payment: MIXED });
    const settlementOptions = await calculateModificationSettlementOptions({
      booking,
      netChargeCents: -15_000,
      db: NO_HAND_BACKS as never,
      todayAtClub: TODAY,
    });
    return applyPaymentAdjustments(tx, {
      booking,
      priceDiffCents: -15_000,
      changeFeeCents: 0,
      settlementOptions,
      settlementMethod,
      todayAtClub: TODAY,
      format: CLUB_FORMAT_TEST,
    });
  }

  it.each([
    { tier: "100%" as const, cardCents: 10_000, givenBackCents: 5_000, allCardCents: 15_000 },
    { tier: "50% with a $20 fee" as const, cardCents: 3_000, givenBackCents: 2_500, allCardCents: 5_500 },
  ])("MUTATION: at $tier, $cardCents cents to the card and $givenBackCents cents of credit back - $allCardCents cents, the all-card figure", async ({ tier, cardCents, givenBackCents, allCardCents }) => {
    const result = await reduceMixed(TIERS[tier], "card");

    expect(result.refundAmountCents).toBe(cardCents);
    expect(result.appliedCreditGivenBackCents).toBe(givenBackCents);
    expect(result.refundAmountCents + result.appliedCreditGivenBackCents).toBe(allCardCents);
    // The same tier on a $200 card payment, for the comparison.
    const { cardRefundAmountCents } = calculateDualRefundAmounts(15_000, 31, TIERS[tier]);
    expect(cardRefundAmountCents).toBe(allCardCents);
    // The member key and the mirror come before the Payment row's other writes.
    expect(paymentUpdate).toHaveBeenCalledWith({ where: { id: "payment_1" }, data: { creditAppliedCents: 10_000 - givenBackCents } });
  });

  it("MUTATION: Xero, card election: the card refund's note and an allocated account-credit note of its own - one note names one method", async () => {
    const result = await reduceMixed(TIERS["100%"], "card");

    const decision = classifyXeroBookingEditSettlement({
      hasIssuedXeroInvoice: true,
      priceDiffCents: -15_000,
      settlementMethod: result.settlementMethod,
      settlementAmountCents: result.xeroRefundAmountCents,
      refundedThroughStripe: result.hasSucceededPayment,
      appliedCreditGiveBackCents: result.appliedCreditGivenBackCents,
    });

    expect(decision.financialAction).toEqual(expect.objectContaining({
      type: "modification-credit-note",
      refundAmountCents: 10_000,
      refundMethod: "card",
      allocatedGiveBackCents: 5_000,
    }));
  });

  it("MUTATION (#3809 delta H1): the fee absorbs the card's share - one $40 give-back note, scoped, and nothing else", async () => {
    // $5 by card, $45 by credit left on a $50 reduction: 100% less a $10 fee.
    credit.policy = [{ daysBeforeStay: 0, refundPercentage: 100, fixedFeeCents: 1_000 }];
    credit.applied = 4_500;
    const booking = creditPaidBooking({ payment: { amountCents: 500, source: PaymentSource.STRIPE, creditAppliedCents: 4_500 } });
    const settlementOptions = await calculateModificationSettlementOptions({ booking, netChargeCents: -5_000, db: NO_HAND_BACKS as never, todayAtClub: TODAY });
    const result = await applyPaymentAdjustments(tx, {
      booking, priceDiffCents: -5_000, changeFeeCents: 0, settlementOptions, settlementMethod: "card", todayAtClub: TODAY, format: CLUB_FORMAT_TEST,
    });
    expect(result.refundAmountCents).toBe(0);
    expect(result.appliedCreditGivenBackCents).toBe(4_000);

    const decision = classifyXeroBookingEditSettlement({
      hasIssuedXeroInvoice: true,
      priceDiffCents: -5_000,
      settlementMethod: result.settlementMethod,
      settlementAmountCents: result.xeroRefundAmountCents,
      refundedThroughStripe: result.hasSucceededPayment,
      appliedCreditGiveBackCents: result.appliedCreditGivenBackCents,
    });
    expect(decision.financialAction).toEqual(expect.objectContaining({ type: "modification-credit-note", refundAmountCents: 0, allocatedGiveBackCents: 4_000 }));
  });

  it("MUTATION: Xero, credit election: the minted credit's unallocated note AND an invoice-allocated note for the give-back", async () => {
    const result = await reduceMixed(TIERS["100%"], "credit");
    expect(result.accountCreditAmountCents).toBe(10_000);

    const decision = classifyXeroBookingEditSettlement({
      hasIssuedXeroInvoice: true,
      priceDiffCents: -15_000,
      settlementMethod: result.settlementMethod,
      settlementAmountCents: result.xeroRefundAmountCents,
      appliedCreditGiveBackCents: result.appliedCreditGivenBackCents,
    });

    expect(decision.financialAction).toEqual(expect.objectContaining({
      type: "modification-account-credit-note",
      refundAmountCents: 10_000,
      allocatedGiveBackCents: 5_000,
    }));
  });
});

/*
  Finding 1 of the #3809 fix round: the cancellation tiers the applied credit
  capped, with the money paid, at what the booking is now worth - exactly as it
  caps paid money (`cancelRefundableBaseCents`) - in the executed cancel and in
  the preview the member sees first.
*/
describe("#3809: a cancellation tiers applied credit capped at what the booking is worth", () => {
  const cancelCredit = (mirror: number, finalPriceCents: number, policy: CancellationRule[], cap = true) =>
    paidCancellationMoney({
      payment: { amountCents: 0, refundedAmountCents: 0, changeFeeCents: 0, creditAppliedCents: mirror },
      openNonCancellationHandBackCents: 0,
      finalPriceCents,
      appliedCreditCents: mirror,
      restoresToMemberLedger: true,
      days: 31,
      policy,
      refundMethod: "card",
      capAppliedCredit: cap,
    });

  it("MUTATION: $5 back at 50% less $20, then a cancel at 50% less $20 tiers $150, not the $195 still applied - $60 in all, the card-paid figure", async () => {
    credit.policy = TIERS["50% with a $20 fee"];
    const reduced = await reduce(creditPaidBooking());
    const mirror = 20_000 - reduced.appliedCreditGivenBackCents;

    const cancel = cancelCredit(mirror, 15_000, TIERS["50% with a $20 fee"]);

    expect(cancel.appliedCreditBaseCents).toBe(15_000);
    expect(reduced.appliedCreditGivenBackCents + cancel.creditRestoredCents).toBe(6_000);
    // The $45 the reduction's policy kept is not called a cancellation fee.
    expect(cancel.appliedCreditAboveRefundableCents).toBe(4_500);
    expect(cancel.ledgerKeptCents - cancel.policyKeptCents).toBe(4_500);
    // A card-paid $200 booking: $5 refunded, then the cancel tiers $150.
    const card = paidCancellationMoney({
      payment: { amountCents: 20_000, refundedAmountCents: 500, changeFeeCents: 0, creditAppliedCents: 0 },
      openNonCancellationHandBackCents: 0,
      finalPriceCents: 15_000,
      appliedCreditCents: 0,
      restoresToMemberLedger: true,
      days: 31,
      policy: TIERS["50% with a $20 fee"],
      refundMethod: "card",
      capAppliedCredit: false,
    });
    expect(500 + card.refundAmountCents).toBe(6_000);
  });

  it("MUTATION: the preview a member is shown names the same restore as the cancel", () => {
    const preview = calculateCancellationPreview({
      payment: { amountCents: 0, refundedAmountCents: 0, changeFeeCents: 0, creditAppliedCents: 19_500 },
      openNonCancellationHandBackCents: 0,
      finalPriceCents: 15_000,
      checkIn: CHECK_IN,
      policyRules: TIERS["50% with a $20 fee"],
      todayAtClub: TODAY,
      capAppliedCredit: true,
    });

    expect(preview.creditRestoredCents).toBe(cancelCredit(19_500, 15_000, TIERS["50% with a $20 fee"]).creditRestoredCents);
    expect(preview.creditRestoredCents).toBe(5_500);
  });

  it("credit no higher than the price is tiered whole, as before", () => {
    expect(cancelCredit(15_000, 15_000, TIERS["50% with a $20 fee"]).creditRestoredCents).toBe(5_500);
    expect(cancelCredit(20_000, 20_000, TIERS["50% with a $20 fee"]).creditRestoredCents).toBe(8_000);
  });

  it("money paid counts first: $100 paid and $150 applied on a $150 booking tiers $100 of money and $50 of credit", () => {
    expect(
      cancelAppliedCreditBaseCents({ amountCents: 10_000, refundedAmountCents: 0, openNonCancellationHandBackCents: 0, finalPriceCents: 15_000, changeFeeCents: 0, creditAppliedCents: 15_000, capAtWorth: true }),
    ).toBe(5_000);
  });

  it.each([
    { tier: "100%" as const, totalCents: 20_000 },
    { tier: "50% with a $20 fee" as const, totalCents: 8_000 },
  ])("MUTATION (owner decision, 4 Oct 2026): a booking reduced BEFORE this release is not capped - $200 still applied on a $150 price restores $totalCents cents at $tier, as on main", ({ tier, totalCents }) => {
    expect(cancelCredit(20_000, 15_000, TIERS[tier], false).creditRestoredCents).toBe(totalCents);
    expect(
      calculateCancellationPreview({
        payment: { amountCents: 0, refundedAmountCents: 0, changeFeeCents: 0, creditAppliedCents: 20_000 },
        openNonCancellationHandBackCents: 0,
        finalPriceCents: 15_000,
        checkIn: CHECK_IN,
        policyRules: TIERS[tier],
        todayAtClub: TODAY,
        capAppliedCredit: false,
      }).creditRestoredCents,
    ).toBe(totalCents);
  });
});

/*
  Finding 3 of the #3809 fix round: the edit's quote names what saving would
  give back, from the SAME figure the save computes under the lock.
*/
describe("#3809: the quote previews the give-back the save makes", () => {
  const preview = (booking: LoadedBookingForModify, reductionCents: number, cardBasisCents: number) =>
    previewPaidReductionCreditGiveBackCents({
      booking,
      ownerMemberId: "member_1",
      reductionCents,
      cardBasisCents,
      todayAtClub: TODAY,
      db: NO_HAND_BACKS as never,
    });

  it.each([
    { tier: "100%" as const, cents: 5_000 },
    { tier: "50% with a $20 fee" as const, cents: 500 },
    { tier: "0%" as const, cents: 0 },
  ])("MUTATION: a credit-paid booking at $tier previews $cents cents, what the save gives back", async ({ tier, cents }) => {
    credit.policy = TIERS[tier];

    expect(await preview(creditPaidBooking(), 5_000, 0)).toBe(cents);
    expect((await reduce(creditPaidBooking())).appliedCreditGivenBackCents).toBe(cents);
  });

  it("a card-and-credit booking previews the credit part beyond the card basis", async () => {
    credit.policy = TIERS["50% with a $20 fee"];
    credit.applied = 10_000;

    expect(await preview(creditPaidBooking({ payment: { amountCents: 10_000 } }), 15_000, 10_000)).toBe(2_500);
  });

  it("a booking still owing previews nothing", async () => {
    expect(await preview(creditPaidBooking({ status: "CONFIRMED" }), 5_000, 0)).toBe(0);
  });
});
