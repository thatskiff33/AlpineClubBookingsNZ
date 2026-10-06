import { PaymentSource, PaymentStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LoadedBookingForModify } from "@/lib/booking-modify-validation";
import type { CancellationRule } from "@/lib/cancellation";
import type { CalendarDate } from "@/lib/club-time";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/*
  #3502 (owner decision, 6 Oct 2026: "Ask for card payment"). A booking paid
  wholly with account credit or a 100% promotion carries
  `{ amountCents: 0, status: SUCCEEDED, source: STRIPE }`. When an edit RAISES
  its price, the three doors that settle through `applyPaymentAdjustments`
  used to read `hasCapturedPayment` (which needs `amountCents > 0`), conclude
  there was no card, and fall to the Xero arm - which bills only when a primary
  invoice has been issued. With the Xero module off (the schema default), or
  before `confirm-draft`'s outbox raised the invoice, the increase was asked of
  nobody. These pin the shared machinery's answer; the per-door route tests in
  `fix-mod-payment.test.ts`, `batch-modify-payment.test.ts` and
  `guest-removal-zero-dollar-increase.test.ts` pin that each door mints it.

  "Xero off" here is a payment with no `xeroInvoiceId`: the doors consult no
  module flag, so a club without Xero is exactly a booking whose primary
  invoice never exists.

  Reductions are deliberately unchanged (#3809's give-back keeps `cardBasis 0`):
  the last describe proves a $0 card-source reduction still reads as nothing
  captured.
*/

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

const credit = vi.hoisted(() => ({
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

const { applyPaymentAdjustments, organiserChildChargeRefusal } = await import("@/lib/booking-modify-settlement");
const { canAskCardForIncrease, hasCapturedPayment } = await import("@/lib/booking-payment-state");
const { classifyXeroBookingEditSettlement } = await import("@/lib/xero-booking-edit-settlement");
const { bookingLedgerResidualCents, bookingLedgerVerdict } = await import("@/lib/additional-payment-ask");
const { OrganiserChildRefundRefusedError } = await import("@/lib/organiser-child-refund");

const TODAY = "2026-07-01" as CalendarDate;

const paymentUpdate = vi.fn();
const NO_HAND_BACKS = { manualRefundTask: { aggregate: vi.fn(async () => ({ _sum: { amountCents: null } })) } };
const tx = { payment: { update: paymentUpdate }, ...NO_HAND_BACKS } as unknown as Parameters<typeof applyPaymentAdjustments>[0];

/** $200, paid entirely by account credit: a $0 SUCCEEDED card-source payment, PAID. */
function zeroDollarBooking(overrides: {
  status?: string;
  payment?: Record<string, unknown>;
  organiserSettled?: boolean;
  parentBookingId?: string | null;
} = {}) {
  return {
    id: "booking_3502",
    status: overrides.status ?? "PAID",
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    lodgeId: "lodge_1",
    memberId: "member_1",
    finalPriceCents: 20_000,
    organiserSettled: overrides.organiserSettled ?? false,
    parentBookingId: overrides.parentBookingId ?? null,
    payment: {
      id: "payment_1",
      status: PaymentStatus.SUCCEEDED,
      // The schema default: the zero-dollar settle (`applyLifecycleTransitions`,
      // `confirm-draft`) never sets a source.
      source: PaymentSource.STRIPE,
      amountCents: 0,
      refundedAmountCents: 0,
      creditAppliedCents: 20_000,
      changeFeeCents: 0,
      stripePaymentIntentId: null,
      additionalAmountCents: 0,
      additionalPaymentStatus: null,
      // Xero off: no primary invoice, ever.
      xeroInvoiceId: null,
      ...overrides.payment,
    },
  } as unknown as LoadedBookingForModify;
}

const adjust = (booking: LoadedBookingForModify, priceDiffCents: number, changeFeeCents = 0) =>
  applyPaymentAdjustments(tx, {
    booking,
    priceDiffCents,
    changeFeeCents,
    todayAtClub: TODAY,
    format: CLUB_FORMAT_TEST,
  });

beforeEach(() => {
  vi.clearAllMocks();
  credit.policy = [{ daysBeforeStay: 0, refundPercentage: 100, fixedFeeCents: 0 }];
  credit.derive.mockImplementation(async () => 20_000);
  credit.giveBack.mockImplementation(async ({ giveBackCentsOf }) => {
    const payment = { id: "payment_1", source: PaymentSource.STRIPE, xeroInvoiceId: null, creditAppliedCents: 20_000 };
    const asked = await giveBackCentsOf(20_000, payment);
    return { appliedCreditCents: 20_000, givenBackCents: Math.max(0, Math.min(20_000, asked)), payment };
  });
});

describe("#3502: canAskCardForIncrease, the one increase question", () => {
  it("is the status half: a $0 SUCCEEDED card-source payment can be asked, though nothing was captured", () => {
    const booking = zeroDollarBooking();
    expect(hasCapturedPayment(booking.payment)).toBe(false);
    expect(canAskCardForIncrease(booking)).toBe(true);
  });

  it.each([
    ["an Internet-Banking payment", { payment: { source: PaymentSource.INTERNET_BANKING } }],
    ["a payment that never captured", { payment: { status: PaymentStatus.PENDING } }],
    ["a booking outside its payment lifecycle", { status: "DRAFT" }],
  ])("refuses %s", (_label, overrides) => {
    expect(canAskCardForIncrease(zeroDollarBooking(overrides))).toBe(false);
  });

  it("refuses a booking with no payment row", () => {
    expect(canAskCardForIncrease({ status: "PAID", payment: null })).toBe(false);
  });
});

describe("#3502: a credit-paid ($0) booking that grows is asked by card", () => {
  it("MUTATION: with Xero off, the increase plus change fee is asked of the card, and the fee is recorded on the payment", async () => {
    const result = await adjust(zeroDollarBooking(), 5_000, 500);

    // The mint gate (`createModificationAdditionalPaymentIntent`) and the
    // email wording both read this flag.
    expect(result.hasSucceededPayment).toBe(true);
    expect(result.additionalAsk.amountCents).toBe(5_500);
    expect(result.additionalAmountCents).toBe(5_500);
    expect(result.hasIssuedXeroInvoice).toBe(false);
    expect(result.xeroAdditionalAmountCents).toBe(0);
    // Nothing comes back on an increase.
    expect(result.refundAmountCents).toBe(0);
    expect(result.pendingRefundAmountCents).toBe(0);
    expect(result.appliedCreditGivenBackCents).toBe(0);
    expect(credit.giveBack).not.toHaveBeenCalled();
    // In the transaction, on the same row the locks already cover.
    expect(paymentUpdate).toHaveBeenCalledWith({
      where: { id: "payment_1" },
      data: { changeFeeCents: { increment: 500 } },
    });
  });

  it("MUTATION: with an issued invoice, the supplementary invoice waits for the card payment and records it - never billed twice", async () => {
    const result = await adjust(zeroDollarBooking({ payment: { xeroInvoiceId: "INV-3502" } }), 5_000);

    expect(result.hasSucceededPayment).toBe(true);
    expect(result.hasIssuedXeroInvoice).toBe(true);
    expect(result.additionalAsk.amountCents).toBe(5_000);
    expect(result.xeroAdditionalAmountCents).toBe(5_000);

    // What every door hands the Xero leg (`requiresAdditionalStripePayment`).
    const requiresAdditionalStripePayment = result.xeroAdditionalAmountCents > 0 && result.hasSucceededPayment;
    expect(requiresAdditionalStripePayment).toBe(true);
    const decision = classifyXeroBookingEditSettlement({
      hasIssuedXeroInvoice: result.hasIssuedXeroInvoice,
      priceDiffCents: 5_000,
      changeFeeCents: 0,
      requiresAdditionalStripePayment,
      additionalPaymentIntentId: "pi_additional",
    });
    expect(decision.financialAction).toEqual(expect.objectContaining({
      type: "supplementary-invoice",
      recordPayment: true,
      waitForPaymentIntentId: "pi_additional",
    }));
  });

  it("carries an earlier unpaid ask into the new one (INV-PAY-098), exactly as on a card-paid booking", async () => {
    const result = await adjust(
      zeroDollarBooking({ payment: { additionalAmountCents: 3_000, additionalPaymentStatus: PaymentStatus.PENDING } }),
      5_000,
    );

    expect(result.additionalAsk.amountCents).toBe(8_000);
    expect(result.additionalAsk.carriedCents).toBe(3_000);
  });

  it("does not ask a $0 Internet-Banking payment's card - there is none; the Xero arm keeps it", async () => {
    const result = await adjust(
      zeroDollarBooking({ payment: { source: PaymentSource.INTERNET_BANKING, xeroInvoiceId: "INV-3502" } }),
      5_000,
    );

    expect(result.hasSucceededPayment).toBe(false);
    expect(result.additionalAsk.amountCents).toBe(0);
    expect(result.additionalAmountCents).toBe(5_000);
  });

  it("refuses the increase on a $0 child the organiser settled by card (INV-PAY-114), at the save and the quote alike", async () => {
    const booking = zeroDollarBooking({ organiserSettled: true, parentBookingId: "parent_1" });

    await expect(adjust(booking, 5_000)).rejects.toBeInstanceOf(OrganiserChildRefundRefusedError);
    expect(organiserChildChargeRefusal({ booking, netChargeCents: 5_000 })).not.toBeNull();
    expect(paymentUpdate).not.toHaveBeenCalled();
  });
});

describe("#3502: the census reads the grown $0 booking (INV-PAY-047)", () => {
  /** The booking's ledger row once the edit commits and its ask is minted. */
  function ledgerAfter(params: { askCents: number; changeFeeRecordedCents: number }) {
    return {
      finalPriceCents: 25_000,
      changeFeeCents: params.changeFeeRecordedCents,
      amountCents: 0,
      refundedAmountCents: 0,
      creditAppliedCents: 20_000,
      additionalAmountCents: params.askCents,
      additionalPaymentStatus: params.askCents > 0 ? "PENDING" : null,
    };
  }

  it("was `unasked` before #3502: the $50 was owed by nobody", () => {
    const residual = bookingLedgerResidualCents(ledgerAfter({ askCents: 0, changeFeeRecordedCents: 0 }));
    expect(residual).toBe(5_000);
    expect(bookingLedgerVerdict(residual)).toBe("unasked");
  });

  it("MUTATION: is `balanced` once the door's own ask and fee are on the row", async () => {
    const result = await adjust(zeroDollarBooking(), 5_000, 500);
    const feeRecorded = paymentUpdate.mock.calls
      .map(([call]) => call.data.changeFeeCents?.increment ?? 0)
      .reduce((sum: number, cents: number) => sum + cents, 0);

    const residual = bookingLedgerResidualCents(
      ledgerAfter({ askCents: result.additionalAsk.amountCents, changeFeeRecordedCents: feeRecorded }),
    );
    expect(bookingLedgerVerdict(residual)).toBe("balanced");
  });
});

describe("#3502 leaves every reduction exactly as it was (#3809)", () => {
  it("MUTATION: a $0 card-source reduction still reads as nothing captured - no card refund, the give-back on cardBasis 0", async () => {
    const result = await adjust(zeroDollarBooking({ payment: { xeroInvoiceId: "INV-3502" } }), -5_000);

    expect(result.hasSucceededPayment).toBe(false);
    expect(result.refundAmountCents).toBe(0);
    expect(result.pendingRefundAmountCents).toBe(0);
    expect(result.appliedCreditGivenBackCents).toBe(5_000);
    expect(result.xeroRefundAmountCents).toBe(0);
    expect(result.additionalAsk.amountCents).toBe(0);
    // The Xero leg would otherwise word the give-back as a card refund.
    const decision = classifyXeroBookingEditSettlement({
      hasIssuedXeroInvoice: result.hasIssuedXeroInvoice,
      priceDiffCents: -5_000,
      settlementMethod: result.settlementMethod,
      settlementAmountCents: result.xeroRefundAmountCents,
      refundedThroughStripe: result.hasSucceededPayment,
      appliedCreditGiveBackCents: result.appliedCreditGivenBackCents,
    });
    expect(decision.financialAction).toEqual(expect.objectContaining({
      type: "modification-credit-note",
      refundAmountCents: 0,
      allocatedGiveBackCents: 5_000,
    }));
  });

  it("a change-fee-only edit with no price change is an increase too, and is asked", async () => {
    const result = await adjust(zeroDollarBooking(), 0, 1_000);
    expect(result.hasSucceededPayment).toBe(true);
    expect(result.additionalAsk.amountCents).toBe(1_000);
  });

  it("a zero-net edit asks nothing and writes nothing", async () => {
    const result = await adjust(zeroDollarBooking(), 0, 0);
    expect(result.hasSucceededPayment).toBe(false);
    expect(result.additionalAsk.amountCents).toBe(0);
    expect(paymentUpdate).not.toHaveBeenCalled();
  });
});
