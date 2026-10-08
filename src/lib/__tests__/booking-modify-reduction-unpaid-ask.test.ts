import { PaymentSource, PaymentStatus, PaymentTransactionKind } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LoadedBookingForModify } from "@/lib/booking-modify-validation";
import type { CancellationRule } from "@/lib/cancellation";
import type { CalendarDate } from "@/lib/club-time";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/*
  #3954 (owner decision, 8 Oct 2026): a price reduction first cancels or shrinks
  the unpaid card ask an earlier increase raised, and only what is left is
  refunded, credited or given back. The worked example from the issue: a $100
  paid booking grows to $150 and asks $50 by card; before the member pays, a
  guest is removed and the price returns to $100. Before #3954 the reduction
  refunded (or kept) money AND left the $50 ask live, so paying it left the club
  holding $150 for a $100 booking.

  These pin the shared machinery (`applyPaymentAdjustments`, the settlement
  options, the minter's gate); the real-PostgreSQL proofs, the race included,
  are `additional-ask-reduction.realdb.test.ts`.
*/

// The module client is read only by the minter's supersede query, after this
// suite's reduction has already FAILED the one ask row - so, honestly, nothing
// is left pending for it to find.
vi.mock("@/lib/prisma", () => ({ prisma: { paymentTransaction: { findMany: async () => [] } } }));

const mocks = vi.hoisted(() => ({
  policy: [] as CancellationRule[],
  enqueueCancel: vi.fn(),
  runNow: vi.fn(),
  giveBack: vi.fn(),
  derive: vi.fn(),
  createIntent: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@/lib/stripe", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  createPaymentIntent: mocks.createIntent,
  findOrCreateCustomer: vi.fn(async () => ({ id: "cus_1" })),
}));


vi.mock("@/lib/cancellation", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  loadCancellationPolicy: vi.fn(async () => mocks.policy),
}));

vi.mock("@/lib/member-credit", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  deriveBookingAppliedCreditCents: mocks.derive,
  giveBackAppliedCredit: mocks.giveBack,
}));

vi.mock("@/lib/payment-recovery", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  enqueuePaymentIntentCancellationRecovery: mocks.enqueueCancel,
  runPaymentRecoveryOperationNow: mocks.runNow,
}));

vi.mock("@/lib/payment-transactions", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  upsertPaymentIntentTransaction: mocks.upsert,
}));

const { applyPaymentAdjustments, calculateModificationSettlementOptions } = await import(
  "@/lib/booking-modify-settlement"
);
const {
  bookingLedgerResidualCents,
  reissueUnpaidAdditionalAsk,
  setReductionAgainstUnpaidAsk,
  NO_ADDITIONAL_ASK,
} = await import("@/lib/additional-payment-ask");
const { ApiError } = await import("@/lib/api-error");
const { createModificationAdditionalPaymentIntent } = await import("@/lib/booking-modification-settlement");
const { ADDITIONAL_ASK_RETIRED_BY_REDUCTION_XERO_ERROR_CODE } = await import("@/lib/unpaid-ask-offset-marker");

const TODAY = "2026-07-01" as CalendarDate;
const ASK_ROW_ID = "txn_ask";
const ASK_INTENT = "pi_ask_50";

type Row = {
  id: string;
  kind: PaymentTransactionKind;
  source: PaymentSource;
  status: PaymentStatus;
  reason: string | null;
  amountCents: number;
  stripePaymentIntentId: string | null;
  createdAt: Date;
};

const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  modifications: [] as { id: string }[],
  stampCount: 1,
}));

const paymentUpdate = vi.fn();
// The REAL `reconcilePaymentAggregates` runs on this client (INV-OPS-015). It
// finds no payment here, so it writes nothing: the mirror it derives from the
// retired rows is proved on real PostgreSQL (`additional-ask-reduction.realdb.test.ts`);
// this suite proves only that the retire asks it, on the edit's own client.
const paymentFindUnique = vi.fn(async () => null);
const transactionUpdateMany = vi.fn();
const xeroUpdateMany = vi.fn();
const tx = {
  payment: { update: paymentUpdate, findUnique: paymentFindUnique },
  manualRefundTask: { aggregate: vi.fn(async () => ({ _sum: { amountCents: null } })) },
  paymentTransaction: {
    findMany: vi.fn(async () => state.rows),
    updateMany: transactionUpdateMany,
  },
  bookingModification: { findMany: vi.fn(async () => state.modifications) },
  xeroSyncOperation: { updateMany: xeroUpdateMany },
} as unknown as Parameters<typeof applyPaymentAdjustments>[0];

function askRow(overrides: Partial<Row> = {}): Row {
  return {
    id: ASK_ROW_ID,
    kind: PaymentTransactionKind.ADDITIONAL,
    source: PaymentSource.STRIPE,
    status: PaymentStatus.PENDING,
    reason: "guest_add_price_increase",
    amountCents: 5_000,
    stripePaymentIntentId: ASK_INTENT,
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    ...overrides,
  };
}

/**
 * The issue's worked example after the increase: $150, $100 captured by card,
 * a $50 card ask unpaid. `creditPaid` is the #3502 shape: $100 paid wholly with
 * account credit, the same $50 asked of the card.
 */
function grownBooking({ creditPaid = false, xeroInvoiceId = null as string | null } = {}) {
  return {
    id: "booking_3954",
    status: "PAID",
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    lodgeId: "lodge_1",
    memberId: "member_1",
    finalPriceCents: 15_000,
    organiserSettled: false,
    parentBookingId: null,
    payment: {
      id: "payment_1",
      status: PaymentStatus.SUCCEEDED,
      source: PaymentSource.STRIPE,
      amountCents: creditPaid ? 0 : 10_000,
      refundedAmountCents: 0,
      creditAppliedCents: creditPaid ? 10_000 : 0,
      changeFeeCents: 0,
      stripePaymentIntentId: creditPaid ? null : "pi_primary",
      stripeCustomerId: "cus_1",
      additionalAmountCents: 5_000,
      additionalPaymentStatus: PaymentStatus.PENDING,
      additionalPaymentIntentId: ASK_INTENT,
      xeroInvoiceId,
    },
  } as unknown as LoadedBookingForModify;
}

async function adjust(
  booking: LoadedBookingForModify,
  priceDiffCents: number,
  { changeFeeCents = 0, settlementMethod }: { changeFeeCents?: number; settlementMethod?: "card" | "credit" } = {},
) {
  const settlementOptions = await calculateModificationSettlementOptions({
    booking,
    netChargeCents: priceDiffCents + changeFeeCents,
    db: tx as never,
    todayAtClub: TODAY,
  });
  return applyPaymentAdjustments(tx, {
    booking,
    priceDiffCents,
    changeFeeCents,
    settlementOptions,
    settlementMethod: settlementMethod ?? (settlementOptions?.requiresSettlementMethod ? "card" : undefined),
    todayAtClub: TODAY,
    format: CLUB_FORMAT_TEST,
  });
}

/** The ledger row the edit leaves, with the projection `reconcilePaymentAggregates` derives. */
function ledgerAfter(
  booking: LoadedBookingForModify,
  priceDiffCents: number,
  result: Awaited<ReturnType<typeof adjust>>,
) {
  const payment = booking.payment!;
  const feeRecorded = paymentUpdate.mock.calls
    .map(([call]) => call.data.changeFeeCents?.increment ?? 0)
    .reduce((sum: number, cents: number) => sum + cents, 0);
  // The retired ask projects nothing; a re-issued one is the new live ask.
  const askCents = result.retiredAdditionalAsks.length > 0 ? result.additionalAsk.amountCents : payment.additionalAmountCents;
  return {
    finalPriceCents: booking.finalPriceCents + priceDiffCents,
    changeFeeCents: feeRecorded,
    amountCents: payment.amountCents,
    refundedAmountCents: result.refundAmountCents,
    creditAppliedCents: payment.creditAppliedCents - result.appliedCreditGivenBackCents,
    additionalAmountCents: askCents,
    additionalPaymentStatus: askCents > 0 ? "PENDING" : null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.policy = [{ daysBeforeStay: 0, refundPercentage: 100, fixedFeeCents: 0 }];
  state.rows = [askRow()];
  state.modifications = [{ id: "mod_increase" }];
  state.stampCount = 1;
  transactionUpdateMany.mockImplementation(async () => ({ count: state.stampCount }));
  xeroUpdateMany.mockImplementation(async () => ({ count: 1 }));
  mocks.enqueueCancel.mockImplementation(async ({ paymentTransactionId }) => ({
    id: `op_cancel_${paymentTransactionId}`,
    status: "PENDING",
  }));
  mocks.runNow.mockImplementation(async () => "succeeded");
  mocks.derive.mockImplementation(async () => 10_000);
  mocks.createIntent.mockImplementation(async ({ amountCents }) => ({ id: `pi_reissued_${amountCents}`, client_secret: "secret" }));
  mocks.giveBack.mockImplementation(async ({ giveBackCentsOf }) => {
    const payment = { id: "payment_1", source: PaymentSource.STRIPE, xeroInvoiceId: null, creditAppliedCents: 10_000 };
    const asked = await giveBackCentsOf(10_000, payment);
    return { appliedCreditCents: 10_000, givenBackCents: Math.max(0, Math.min(10_000, asked)), payment };
  });
});

describe("#3954: the arithmetic's one home", () => {
  it.each([
    ["a reduction smaller than the ask shrinks it", -2_000, 5_000, { offsetCents: 2_000, netChargeLeftCents: 0, askLeftCents: 3_000 }],
    ["a reduction equal to the ask cancels it", -5_000, 5_000, { offsetCents: 5_000, netChargeLeftCents: 0, askLeftCents: 0 }],
    ["a reduction larger than the ask cancels it and leaves the rest", -8_000, 5_000, { offsetCents: 5_000, netChargeLeftCents: -3_000, askLeftCents: 0 }],
    ["an increase passes through", 2_000, 5_000, { offsetCents: 0, netChargeLeftCents: 2_000, askLeftCents: 5_000 }],
    ["no ask, no offset", -2_000, 0, { offsetCents: 0, netChargeLeftCents: -2_000, askLeftCents: 0 }],
  ])("%s", (_label, netChargeCents, unpaidAskCents, expected) => {
    expect(setReductionAgainstUnpaidAsk({ netChargeCents, unpaidAskCents })).toEqual(expected);
  });

  it("re-issues what is left as a wholly carried ask the minter may mint on a credit-paid booking", () => {
    const ask = reissueUnpaidAdditionalAsk({ askLeftCents: 3_000 });
    expect(ask.amountCents).toBe(3_000);
    expect(ask.carriedCents).toBe(3_000);
    expect(ask.reissuesUnpaidAsk).toBe(true);
    expect(reissueUnpaidAdditionalAsk({ askLeftCents: 0 })).toBe(NO_ADDITIONAL_ASK);
  });
});

describe("#3954: a card-paid booking's reduction is set against its unpaid ask first", () => {
  it("MUTATION: the worked example - removing the $50 guest cancels the $50 ask and refunds nothing", async () => {
    const booking = grownBooking();
    const result = await adjust(booking, -5_000);

    expect(result.unpaidAskOffsetCents).toBe(5_000);
    expect(result.refundAmountCents).toBe(0);
    expect(result.pendingRefundAmountCents).toBe(0);
    expect(result.accountCreditAmountCents).toBe(0);
    expect(result.additionalAsk.amountCents).toBe(0);
    expect(result.additionalAmountCents).toBe(0);
    // Retired in the transaction: the row FAILED and stamped, its cancellation
    // queued on the same client, any parked Xero invoice retired, the mirror
    // reconciled.
    expect(transactionUpdateMany).toHaveBeenCalledWith({
      where: { id: ASK_ROW_ID, withdrawnAt: null, status: { notIn: expect.arrayContaining([PaymentStatus.SUCCEEDED]) } },
      data: { status: PaymentStatus.FAILED, withdrawnAt: expect.any(Date) },
    });
    expect(mocks.enqueueCancel).toHaveBeenCalledWith(
      expect.objectContaining({ paymentTransactionId: ASK_ROW_ID, paymentIntentId: ASK_INTENT, store: tx }),
    );
    expect(result.retiredAdditionalAsks).toEqual([
      { paymentTransactionId: ASK_ROW_ID, paymentIntentId: ASK_INTENT, cancelOperationId: `op_cancel_${ASK_ROW_ID}` },
    ]);
    expect(xeroUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "WAITING_PAYMENT" }),
        data: expect.objectContaining({ status: "CANCELLED", lastErrorCode: ADDITIONAL_ASK_RETIRED_BY_REDUCTION_XERO_ERROR_CODE }),
      }),
    );
    expect(paymentFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "payment_1" } }));
    // INV-PAY-047: $100 price, $100 captured, nothing asked.
    expect(bookingLedgerResidualCents(ledgerAfter(booking, -5_000, result))).toBe(0);
  });

  it("MUTATION: a reduction smaller than the ask re-issues it smaller and refunds nothing", async () => {
    const booking = grownBooking();
    const result = await adjust(booking, -2_000);

    expect(result.unpaidAskOffsetCents).toBe(2_000);
    expect(result.refundAmountCents).toBe(0);
    expect(result.additionalAsk.amountCents).toBe(3_000);
    expect(result.additionalAsk.carriedCents).toBe(3_000);
    expect(result.additionalAmountCents).toBe(3_000);
    expect(result.hasSucceededPayment).toBe(true);
    expect(result.retiredAdditionalAsks).toHaveLength(1);
    expect(bookingLedgerResidualCents(ledgerAfter(booking, -2_000, result))).toBe(0);
  });

  it("a reduction larger than the ask cancels it and refunds only the rest, by the policy tier", async () => {
    mocks.policy = [{ daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 0 }];
    const booking = grownBooking();
    const result = await adjust(booking, -8_000);

    expect(result.unpaidAskOffsetCents).toBe(5_000);
    // $30 left after the $50 ask; the tier returns half of it.
    expect(result.refundAmountCents).toBe(1_500);
    expect(result.pendingRefundAmountCents).toBe(1_500);
    expect(result.policyRetainedAmountCents).toBe(1_500);
    expect(result.additionalAsk.amountCents).toBe(0);
    // The club keeps exactly the policy's slice and nothing more.
    expect(bookingLedgerResidualCents(ledgerAfter(booking, -8_000, result))).toBe(-1_500);
  });

  it("a fee on the reduction edit is collected out of the ask and recorded beside it", async () => {
    const booking = grownBooking();
    const result = await adjust(booking, -2_000, { changeFeeCents: 500 });

    expect(result.unpaidAskOffsetCents).toBe(1_500);
    expect(result.additionalAsk.amountCents).toBe(3_500);
    expect(paymentUpdate).toHaveBeenCalledTimes(1);
    expect(paymentUpdate).toHaveBeenCalledWith({ where: { id: "payment_1" }, data: { changeFeeCents: { increment: 500 } } });
    expect(bookingLedgerResidualCents(ledgerAfter(booking, -2_000, result))).toBe(0);
  });

  it("a fully absorbed reduction needs no card-or-credit choice and raises no Xero note", async () => {
    const booking = grownBooking({ xeroInvoiceId: "INV-3954" });
    const options = await calculateModificationSettlementOptions({
      booking,
      netChargeCents: -5_000,
      db: tx as never,
      todayAtClub: TODAY,
    });
    expect(options).toBeNull();
    const result = await adjust(booking, -5_000);
    expect(result.xeroRefundAmountCents).toBe(0);
    expect(result.xeroAdditionalAmountCents).toBe(0);
  });
});

describe("#3954: a credit-paid ($0) booking's reduction is set against its unpaid ask first", () => {
  it("MUTATION: cancels the ask and gives back only the rest of the reduction as credit", async () => {
    const booking = grownBooking({ creditPaid: true });
    const result = await adjust(booking, -8_000);

    expect(result.unpaidAskOffsetCents).toBe(5_000);
    expect(result.appliedCreditGivenBackCents).toBe(3_000);
    expect(result.refundAmountCents).toBe(0);
    expect(result.additionalAsk.amountCents).toBe(0);
    // A credit-paid reduction still reads as nothing captured (#3809).
    expect(result.hasSucceededPayment).toBe(false);
    expect(bookingLedgerResidualCents(ledgerAfter(booking, -8_000, result))).toBe(0);
  });

  it("shrinks the ask and marks it a re-issue, so the minter mints it though nothing was captured", async () => {
    const booking = grownBooking({ creditPaid: true });
    const result = await adjust(booking, -2_000, { changeFeeCents: 500 });

    expect(result.hasSucceededPayment).toBe(false);
    expect(result.additionalAsk.amountCents).toBe(3_500);
    expect(result.additionalAsk.reissuesUnpaidAsk).toBe(true);
    expect(result.appliedCreditGivenBackCents).toBe(0);
    // The settled arm never reaches a credit-paid reduction, so the fee is
    // recorded by the ask's own branch - once.
    expect(paymentUpdate).toHaveBeenCalledTimes(1);
    expect(bookingLedgerResidualCents(ledgerAfter(booking, -2_000, result))).toBe(0);
  });
});

describe("#3954: what a reduction is never set against", () => {
  it("MUTATION: a review-raised request is an officer's money, not the price - the reduction settles as before", async () => {
    state.modifications = [{ id: "mod_review" }];
    state.rows = [askRow({ reason: "edit_financial_review_charge_mod_review" })];
    const result = await adjust(grownBooking(), -5_000);

    expect(result.unpaidAskOffsetCents).toBe(0);
    expect(result.refundAmountCents).toBe(5_000);
    expect(transactionUpdateMany).not.toHaveBeenCalled();
    expect(result.retiredAdditionalAsks).toEqual([]);
  });

  it("an ask whose row disagrees with the mirror is not guessed at", async () => {
    state.rows = [askRow({ amountCents: 4_000 })];
    const result = await adjust(grownBooking(), -5_000);
    expect(result.unpaidAskOffsetCents).toBe(0);
    expect(transactionUpdateMany).not.toHaveBeenCalled();
  });

  it("a paid ask is not an unpaid one", async () => {
    const booking = grownBooking();
    (booking.payment as { additionalPaymentStatus: string }).additionalPaymentStatus = "SUCCEEDED";
    const result = await adjust(booking, -5_000);
    expect(result.unpaidAskOffsetCents).toBe(0);
    expect(tx.paymentTransaction.findMany).not.toHaveBeenCalled();
  });

  it("an increase reads no ask at all", async () => {
    await adjust(grownBooking(), 2_000);
    expect(tx.paymentTransaction.findMany).not.toHaveBeenCalled();
  });

  it("retires every unpaid row since the last paid ask, so the mirror cannot fall back to a superseded one", async () => {
    state.rows = [
      askRow({ id: "txn_paid", status: PaymentStatus.SUCCEEDED, amountCents: 1_000, stripePaymentIntentId: "pi_paid" }),
      askRow({ id: "txn_superseded", status: PaymentStatus.FAILED, amountCents: 2_000, stripePaymentIntentId: "pi_old" }),
      askRow(),
    ];
    const result = await adjust(grownBooking(), -5_000);
    expect(transactionUpdateMany.mock.calls.map(([call]) => call.where.id)).toEqual(["txn_superseded", ASK_ROW_ID]);
    expect(result.retiredAdditionalAsks.map((entry) => entry.paymentTransactionId)).toEqual(["txn_superseded", ASK_ROW_ID]);
  });
});

describe("#3954: the race with the member paying the ask", () => {
  it("MUTATION: a capture that landed after the read fails the fence and rolls the whole edit back (409)", async () => {
    state.stampCount = 0;
    await expect(adjust(grownBooking(), -5_000)).rejects.toSatisfy(
      (err: unknown) => err instanceof ApiError && err.status === 409,
    );
    expect(mocks.enqueueCancel).not.toHaveBeenCalled();
    expect(paymentFindUnique).not.toHaveBeenCalled();
  });
});

describe("#3954: the save refuses options sized before the offset", () => {
  it("MUTATION: options for the whole reduction beside an ask that absorbs it are an error, never a double settlement", async () => {
    const booking = grownBooking();
    await expect(
      applyPaymentAdjustments(tx, {
        booking,
        priceDiffCents: -5_000,
        changeFeeCents: 0,
        settlementOptions: {
          basisAmountCents: 5_000,
          cardRefundAmountCents: 5_000,
          cardRefundPercentage: 100,
          accountCreditAmountCents: 5_000,
          accountCreditPercentage: 100,
          daysUntilCheckIn: 31,
          requiresSettlementMethod: true,
          returnsToOrganiser: false,
        },
        settlementMethod: "card",
        todayAtClub: TODAY,
        format: CLUB_FORMAT_TEST,
      }),
    ).rejects.toThrow(/INV-PAY-047 \(#3954\)/);
  });
});

describe("#3954: after commit, the minter cancels what the reduction retired, then re-issues what is left", () => {
  async function mintAfter(result: Awaited<ReturnType<typeof adjust>>) {
    const order: string[] = [];
    mocks.runNow.mockImplementation(async (operationId: string) => {
      order.push(`cancel:${operationId}`);
      return "succeeded";
    });
    mocks.createIntent.mockImplementation(async ({ amountCents }) => {
      order.push(`mint:${amountCents}`);
      return { id: `pi_reissued_${amountCents}`, client_secret: "secret" };
    });
    const minted = await createModificationAdditionalPaymentIntent({
      format: CLUB_FORMAT_TEST,
      bookingId: "booking_3954",
      result: {
        ...result,
        paymentId: "payment_1",
        paymentCustomerId: "cus_1",
        memberEmail: "member@example.invalid",
        memberName: "Member One",
        memberFirstName: "Member",
        memberId: "member_1",
        bookingModificationId: "mod_reduction",
        priceLines: null,
      },
      reason: "guest_removal_price_increase",
      idempotencyKey: "mod_guest_remove_booking_3954_mod_reduction",
      failureMessage: "test",
    });
    return { minted, order };
  }

  it("MUTATION: a credit-paid booking's shrunk ask is minted though its reduction captured nothing", async () => {
    const result = await adjust(grownBooking({ creditPaid: true }), -2_000);
    expect(result.hasSucceededPayment).toBe(false);

    const { minted, order } = await mintAfter(result);

    expect(order).toEqual([`cancel:op_cancel_${ASK_ROW_ID}`, "mint:3000"]);
    expect(minted.additionalPaymentIntentId).toBe("pi_reissued_3000");
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 3_000, carriedAskCents: 3_000, status: PaymentStatus.PENDING }),
    );
  });

  it("a cancelled ask mints nothing, but its intent is still cancelled now", async () => {
    const result = await adjust(grownBooking(), -5_000);
    const { minted, order } = await mintAfter(result);
    expect(order).toEqual([`cancel:op_cancel_${ASK_ROW_ID}`]);
    expect(minted.additionalPaymentIntentId).toBeUndefined();
  });

  it("an ordinary reduction with no ask behind it mints nothing on a credit-paid booking", async () => {
    const booking = grownBooking({ creditPaid: true });
    Object.assign(booking.payment!, { additionalAmountCents: 0, additionalPaymentStatus: null, additionalPaymentIntentId: null });
    const result = await adjust(booking, -2_000);
    const { order } = await mintAfter(result);
    expect(order).toEqual([]);
  });
});
