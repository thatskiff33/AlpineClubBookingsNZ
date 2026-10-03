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

const { applyPaymentAdjustments } = await import("@/lib/booking-modify-settlement");
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
const tx = { payment: { update: paymentUpdate } } as unknown as Parameters<typeof applyPaymentAdjustments>[0];

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
    // Xero: the invoice-allocated note is the give-back, as a card refund's
    // note is the refund - not the whole $50 reduction.
    expect(result.xeroRefundAmountCents).toBe(givenBackCents);
    expect(result.xeroRefundMethod).toBe("account-credit");
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
      refundMethod: result.xeroRefundMethod,
    });

    expect(decision.financialAction).toEqual(expect.objectContaining({
      type: "modification-credit-note",
      refundAmountCents: 5_000,
      refundMethod: "account-credit",
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
      refundMethod: result.xeroRefundMethod,
    });

    expect(decision.financialAction.type).toBe("none");
  });

  it("the issue's worked example: $50 back at 100%, then a cancel at 50% less $20 tiers the $150 still applied - $105 in all, what a card-paid booking gets", async () => {
    credit.policy = TIERS["100%"];
    const reduced = await reduce(creditPaidBooking());
    const mirror = 20_000 - reduced.appliedCreditGivenBackCents;

    const cancel = paidCancellationMoney({
      payment: { amountCents: 0, refundedAmountCents: 0, changeFeeCents: 0, creditAppliedCents: mirror },
      finalPriceCents: 15_000,
      appliedCreditCents: mirror,
      restoresToMemberLedger: true,
      days: 31,
      policy: TIERS["50% with a $20 fee"],
      refundMethod: "card",
    });

    expect(reduced.appliedCreditGivenBackCents + cancel.creditRestoredCents).toBe(10_500);
    // A card-paid $200 booking: $50 refunded at 100%, then the cancel tiers $150.
    const card = paidCancellationMoney({
      payment: { amountCents: 20_000, refundedAmountCents: 5_000, changeFeeCents: 0, creditAppliedCents: 0 },
      finalPriceCents: 15_000,
      appliedCreditCents: 0,
      restoresToMemberLedger: true,
      days: 31,
      policy: TIERS["50% with a $20 fee"],
      refundMethod: "card",
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
    expect(result.xeroRefundMethod).toBeNull();
  });

  it("MUTATION: a booking with no applied credit never takes the member's ledger key", async () => {
    credit.applied = 0;

    const result = await reduce(creditPaidBooking());

    expect(credit.derive).toHaveBeenCalledTimes(1);
    expect(credit.giveBack).not.toHaveBeenCalled();
    expect(result.xeroRefundAmountCents).toBe(5_000);
    expect(result.xeroRefundMethod).toBeNull();
  });

  it("an organisation-owned booking holds no member credit to give back", async () => {
    const result = await reduce(creditPaidBooking({ memberId: null }));

    expect(credit.derive).not.toHaveBeenCalled();
    expect(credit.giveBack).not.toHaveBeenCalled();
    expect(result.appliedCreditGivenBackCents).toBe(0);
  });

  it("MUTATION: a captured payment keeps the card path - no give-back of the credit beside it", async () => {
    const result = await reduce(creditPaidBooking({ payment: { amountCents: 20_000, source: PaymentSource.STRIPE } }));

    expect(credit.derive).not.toHaveBeenCalled();
    expect(credit.giveBack).not.toHaveBeenCalled();
    expect(result.appliedCreditGivenBackCents).toBe(0);
    expect(result.xeroRefundMethod).toBeNull();
  });

  it("a price increase gives nothing back", async () => {
    const result = await reduce(creditPaidBooking(), 5_000);

    expect(credit.derive).not.toHaveBeenCalled();
    expect(result.appliedCreditGivenBackCents).toBe(0);
  });
});
