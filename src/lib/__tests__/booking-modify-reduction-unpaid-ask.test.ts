import { PaymentSource, PaymentStatus, PaymentTransactionKind } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LoadedBookingForModify } from "@/lib/booking-modify-validation";
import { REISSUED_ASK_REASON } from "@/lib/payment-recovery-keys";
import { REISSUED_ASK_KEY_METADATA } from "@/lib/reissued-ask-mint";
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

// The module client is read only by the minter, after commit: its supersede
// query, after this suite's reduction has already FAILED the one ask row - so,
// honestly, nothing is left pending for it to find - and (#3954 round 4) the
// re-issue's own recovery, written in the edit's transaction, which the mint
// completes in one transaction with its row.
const PAYMENT_CUSTOMER = vi.hoisted(() => ({
  stripeCustomerId: "cus_1",
  booking: { organisationId: null, member: { id: "member_1", email: "m@example.test", firstName: "M", lastName: "Ember" }, organisation: null },
}));
const minterDb = vi.hoisted(() => {
  const db = {
    reissueRecovery: null as null | Record<string, unknown>,
    // #3954 round 6: the `Payment` the door re-reads before minting a re-issue.
    // Round 7: with the stored customer the door now resolves exactly as the runner does.
    currentPayment: { additionalAmountCents: 0, additionalPaymentStatus: null as string | null, ...PAYMENT_CUSTOMER },
    completeCount: 1,
    recoveryFindUnique: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
    recoveryUpdateMany: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
    executeRaw: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
  };
  return db;
});
vi.mock("@/lib/prisma", async () => {
  const { vi: hoistedVi } = await import("vitest");
  minterDb.recoveryFindUnique = hoistedVi.fn(async () => minterDb.reissueRecovery);
  minterDb.recoveryUpdateMany = hoistedVi.fn(async () => ({ count: minterDb.completeCount }));
  minterDb.executeRaw = hoistedVi.fn(async () => 0);
  const prisma = {
    // #4217: the door's write under its recovery locks the Payment row first.
    $executeRaw: (...args: unknown[]) => (minterDb.executeRaw as unknown as (...a: unknown[]) => Promise<number>)(...args),
    payment: { findUnique: async () => minterDb.currentPayment },
    paymentTransaction: { findMany: async () => [] },
    paymentRecoveryOperation: {
      findUnique: minterDb.recoveryFindUnique,
      updateMany: minterDb.recoveryUpdateMany,
      upsert: async () => ({ id: "op_upserted" }),
    },
  };
  return { prisma: { ...prisma, $transaction: (fn: (tx: typeof prisma) => unknown) => fn(prisma) } };
});

const mocks = vi.hoisted(() => ({
  policy: [] as CancellationRule[],
  enqueueCancel: vi.fn(),
  runNow: vi.fn(),
  giveBack: vi.fn(),
  derive: vi.fn(),
  createIntent: vi.fn(),
  findMinted: vi.fn(),
  upsert: vi.fn(),
}));

// #3954 decision A: the re-issue's own invoice, queued after its mint
// (`reissued-ask-invoice.test.ts` owns what it queues).
// Round 7: each answers whether the minted intent is still the live ask.
const queueReissueInvoice = vi.hoisted(() => vi.fn(async (params: Record<string, unknown>) => { void params; return true; }));
const queueFoldedInvoices = vi.hoisted(() => vi.fn(async (params: Record<string, unknown>) => { void params; return true; }));
vi.mock("@/lib/reissued-ask-invoice", () => ({
  queueReissuedAskSupplementaryInvoice: queueReissueInvoice,
  queueFoldedReissuedAskInvoices: queueFoldedInvoices,
}));

vi.mock("@/lib/stripe", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  createPaymentIntent: mocks.createIntent,
  findRecentPaymentIntentByMetadata: mocks.findMinted,
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
const { isRecoveryOvertakenByLaterAsk, isRecoveryReplaySettled, recoveryAskBeyondPaymentAskCents, sizeRecoveryReplayAsk } = await import(
  "@/lib/additional-ask-recovery-replay"
);
const {
  buildAdditionalIntentRecoveryIdempotencyKey,
  buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey,
} = await import("@/lib/payment-recovery-keys");
const { ApiError } = await import("@/lib/api-error");
const { noReductionAgainstUnpaidAsk, readReductionAgainstUnpaidAsk, reductionLeftAfterAskCents } = await import("@/lib/additional-ask-reduction");
const { WAITING_REISSUE_FOLDED_BY_INCREASE_NOTE } = await import("@/lib/additional-ask-reissue");
const { PENDING_ASK_NETTED_BY_REDUCTION_NOTE } = await import("@/lib/additional-ask-recovery-close");
const { ADDITIONAL_ASK_BEING_RAISED_MESSAGE, AdditionalAskChangedDuringReductionError } = await import(
  "@/lib/additional-ask-reduction-error"
);
const { createModificationAdditionalPaymentIntent } = await import("@/lib/booking-modification-settlement");
const { ADDITIONAL_ASK_RETIRED_BY_REDUCTION_XERO_ERROR_CODE, unpaidAskOffsetHistory } = await import("@/lib/unpaid-ask-offset-marker");

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
  carriedAskCents: number;
  stripePaymentIntentId: string | null;
  createdAt: Date;
  hadIssuedXeroInvoice?: boolean | null;
  bookingModificationId?: string | null;
};

const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  modifications: [] as { id: string; priceDiffCents?: number; changeFeeCents?: number; newData?: unknown }[],
  stampCount: 1,
  recoveries: [] as unknown[],
  recoveryCloseCount: 1,
  parkedInvoices: [] as unknown[],
}));

const paymentUpdate = vi.fn();
// #3980: an edit that read no invoice link claims the payment row, carrying its fee.
const paymentUpdateMany = vi.fn(async () => ({ count: 1 }));
/** Every change-fee increment the edit wrote on the payment, through either write. */
function feeIncrements(): number[] {
  return [...paymentUpdate.mock.calls, ...(paymentUpdateMany.mock.calls as unknown as unknown[][])]
    .map(([call]) => (call as { data: { changeFeeCents?: { increment: number } } }).data.changeFeeCents?.increment ?? 0)
    .filter((cents) => cents > 0);
}
// The REAL `reconcilePaymentAggregates` runs on this client (INV-OPS-015). It
// finds no payment here, so it writes nothing: the mirror it derives from the
// retired rows is proved on real PostgreSQL (`additional-ask-reduction.realdb.test.ts`);
// this suite proves only that the retire asks it, on the edit's own client.
const paymentFindUnique = vi.fn(async () => null);
const transactionUpdateMany = vi.fn();
const xeroUpdateMany = vi.fn();
const recoveryUpdateMany = vi.fn();
// #4217: the Payment row lock (`lockPaymentForRefundedTotal`), the retire's and the reconcile's.
const executeRaw = vi.fn(async () => 0);
const tx = {
  $executeRaw: executeRaw,
  payment: { update: paymentUpdate, updateMany: paymentUpdateMany, findUnique: paymentFindUnique },
  manualRefundTask: { aggregate: vi.fn(async () => ({ _sum: { amountCents: null } })) },
  paymentTransaction: {
    findMany: vi.fn(async () => state.rows),
    updateMany: transactionUpdateMany,
  },
  bookingModification: { findMany: vi.fn(async () => state.modifications) },
  paymentRecoveryOperation: {
    findMany: vi.fn(async () => state.recoveries),
    updateMany: recoveryUpdateMany,
  },
  // #3954 decision A: the parked invoices the retire cancels are read first,
  // for what they would have billed.
  xeroSyncOperation: { updateMany: xeroUpdateMany, findMany: vi.fn(async () => state.parkedInvoices) },
} as unknown as Parameters<typeof applyPaymentAdjustments>[0];

function askRow(overrides: Partial<Row> = {}): Row {
  return {
    id: ASK_ROW_ID,
    kind: PaymentTransactionKind.ADDITIONAL,
    source: PaymentSource.STRIPE,
    status: PaymentStatus.PENDING,
    reason: "guest_add_price_increase",
    amountCents: 5_000,
    carriedAskCents: 0,
    stripePaymentIntentId: ASK_INTENT,
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    // #3954 round 7: the asking edit's own invoice answer, stamped on its row.
    hadIssuedXeroInvoice: false,
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
  // #3954 round 4: the ask is read ONCE and handed to both, as every door does.
  const reduction = await readReductionAgainstUnpaidAsk(tx, booking, priceDiffCents + changeFeeCents);
  const settlementOptions = await calculateModificationSettlementOptions({
    booking,
    netChargeCents: priceDiffCents + changeFeeCents,
    reduction,
    db: tx as never,
    todayAtClub: TODAY,
  });
  return applyPaymentAdjustments(tx, {
    booking,
    priceDiffCents,
    changeFeeCents,
    reduction,
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
  const feeRecorded = feeIncrements().reduce((sum: number, cents: number) => sum + cents, 0);
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
  state.recoveries = [];
  state.recoveryCloseCount = 1;
  state.parkedInvoices = [];
  transactionUpdateMany.mockImplementation(async () => ({ count: state.stampCount }));
  recoveryUpdateMany.mockImplementation(async () => ({ count: state.recoveryCloseCount }));
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
    expect(feeIncrements()).toEqual([500]);
    // #3980: read no invoice link, so the fee rides the edit's claim on the row.
    expect(paymentUpdateMany).toHaveBeenCalledWith({
      where: { id: "payment_1", xeroInvoiceId: null },
      data: { changeFeeCents: { increment: 500 } },
    });
    expect(bookingLedgerResidualCents(ledgerAfter(booking, -2_000, result))).toBe(0);
  });

  it("MUTATION (#3954 x #3750): on a credit-paid booking the fee is recorded once - not again when the caller records it on the amount owed", async () => {
    const booking = grownBooking({ creditPaid: true });
    const reduction = await readReductionAgainstUnpaidAsk(tx, booking, -1_500);
    await applyPaymentAdjustments(tx, {
      booking, priceDiffCents: -2_000, changeFeeCents: 500, reduction,
      todayAtClub: TODAY, format: CLUB_FORMAT_TEST, changeFeeRecordedByCaller: true,
    });
    expect(feeIncrements()).not.toContain(500);

    paymentUpdate.mockClear();
    paymentUpdateMany.mockClear();
    await applyPaymentAdjustments(tx, {
      booking, priceDiffCents: -2_000, changeFeeCents: 500, reduction: await readReductionAgainstUnpaidAsk(tx, booking, -1_500),
      todayAtClub: TODAY, format: CLUB_FORMAT_TEST,
    });
    expect(feeIncrements()).toContain(500);
  });

  it("MUTATION (round 6, F4): an INCREASE whose fee the caller records on the amount owed records it once too - a credit-paid finished-stay swap", async () => {
    const booking = grownBooking({ creditPaid: true });
    paymentUpdate.mockClear();
    paymentUpdateMany.mockClear();
    const result = await applyPaymentAdjustments(tx, {
      booking, priceDiffCents: 1_000, changeFeeCents: 500, reduction: noReductionAgainstUnpaidAsk(1_500),
      todayAtClub: TODAY, format: CLUB_FORMAT_TEST, changeFeeRecordedByCaller: true,
    });
    expect(result.additionalAsk.amountCents).toBe(6_500);
    expect(feeIncrements()).not.toContain(500);

    await applyPaymentAdjustments(tx, {
      booking, priceDiffCents: 1_000, changeFeeCents: 500, reduction: noReductionAgainstUnpaidAsk(1_500),
      todayAtClub: TODAY, format: CLUB_FORMAT_TEST,
    });
    expect(feeIncrements()).toContain(500);
  });

  it("a fully absorbed reduction needs no card-or-credit choice and raises no Xero note", async () => {
    const booking = grownBooking({ xeroInvoiceId: "INV-3954" });
    const options = await calculateModificationSettlementOptions({
      booking,
      netChargeCents: -5_000,
      reduction: await readReductionAgainstUnpaidAsk(tx, booking, -5_000),
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
    expect(feeIncrements()).toEqual([500]);
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
  // #4217 (`INV-LOCK-002`): the capture webhook takes the Payment row and then
  // the ask's row, so the retire must take them in that order too: stamping a
  // row first and reaching the Payment row at the reconcile is a deadlock.
  it("MUTATION (#4217): the retire locks the Payment row before it stamps the first ask row", async () => {
    await adjust(grownBooking(), -5_000);
    const paymentLocks = executeRaw.mock.calls
      .map((call, index) => ({ call: call as unknown[], order: executeRaw.mock.invocationCallOrder[index]! }))
      .filter(({ call }) => {
        const [strings, ...values] = call;
        const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
        return sql.includes('FROM "Payment"') && sql.includes("FOR NO KEY UPDATE") && values[0] === "payment_1";
      });
    expect(paymentLocks.length).toBeGreaterThanOrEqual(1);
    expect(transactionUpdateMany).toHaveBeenCalled();
    expect(paymentLocks[0]!.order).toBeLessThan(transactionUpdateMany.mock.invocationCallOrder[0]!);
  });

  it("MUTATION: a capture that landed after the read fails the fence and rolls the whole edit back (409)", async () => {
    state.stampCount = 0;
    await expect(adjust(grownBooking(), -5_000)).rejects.toSatisfy(
      (err: unknown) => err instanceof ApiError && err.status === 409,
    );
    expect(mocks.enqueueCancel).not.toHaveBeenCalled();
    expect(paymentFindUnique).not.toHaveBeenCalled();
  });

  it("MUTATION: one read for the options and the save - a capture between them is the fence's 409, never an untiered refund or a 500", async () => {
    mocks.policy = [{ daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 0 }];
    const booking = grownBooking();
    const reduction = await readReductionAgainstUnpaidAsk(tx, booking, -8_000);
    const reads = (tx.paymentTransaction.findMany as ReturnType<typeof vi.fn>).mock.calls.length;
    const settlementOptions = await calculateModificationSettlementOptions({
      booking, netChargeCents: -8_000, reduction, db: tx as never, todayAtClub: TODAY,
    });
    expect(settlementOptions?.basisAmountCents).toBe(3_000);
    // The member pays the $50 ask on another connection: a second read would
    // now see no ask and settle the whole $80 on options sized for $30.
    state.rows = [askRow({ status: PaymentStatus.SUCCEEDED })];
    state.stampCount = 0;
    await expect(
      applyPaymentAdjustments(tx, {
        booking, priceDiffCents: -8_000, changeFeeCents: 0, reduction, settlementOptions,
        settlementMethod: "card", todayAtClub: TODAY, format: CLUB_FORMAT_TEST,
      }),
    ).rejects.toSatisfy((err: unknown) => err instanceof ApiError && err.status === 409);
    // Neither the options nor the save read the ask again.
    expect((tx.paymentTransaction.findMany as ReturnType<typeof vi.fn>).mock.calls.length).toBe(reads);
    expect(mocks.enqueueCancel).not.toHaveBeenCalled();
  });

  it("MUTATION: a read taken for another net is refused, in the options and in the save", async () => {
    const booking = grownBooking();
    const reduction = await readReductionAgainstUnpaidAsk(tx, booking, -2_000);
    await expect(
      calculateModificationSettlementOptions({ booking, netChargeCents: -8_000, reduction, db: tx as never, todayAtClub: TODAY }),
    ).rejects.toThrow(/INV-PAY-120 \(#3954\).*read it once/);
    await expect(
      applyPaymentAdjustments(tx, {
        booking, priceDiffCents: 1_000, changeFeeCents: 0, reduction: noReductionAgainstUnpaidAsk(-2_000),
        todayAtClub: TODAY, format: CLUB_FORMAT_TEST,
      }),
    ).rejects.toThrow(/INV-PAY-120 \(#3954\)/);
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
        reduction: await readReductionAgainstUnpaidAsk(tx, booking, -5_000),
        settlementOptions: {
          basisAmountCents: 5_000,
          cardRefundAmountCents: 5_000,
          cardRefundPercentage: 100,
          accountCreditAmountCents: 5_000,
          accountCreditPercentage: 100,
          daysUntilCheckIn: 31,
          requiresSettlementMethod: true,
          returnsToOrganiser: false,
          organiserRefundByBankTransfer: false,
        },
        settlementMethod: "card",
        todayAtClub: TODAY,
        format: CLUB_FORMAT_TEST,
      }),
    ).rejects.toThrow(/INV-PAY-120 \/ INV-PAY-047 \(#3954\)/);
  });
});

describe("#3954: after commit, the minter cancels what the reduction retired, then re-issues what is left", () => {
  // The door wrote the re-issue's recovery in its transaction (round 4).
  const REISSUE_RECOVERY = {
    id: "op_reissue",
    paymentId: "payment_1",
    status: "PENDING",
    attempts: 0,
    processingStartedAt: null,
    paymentIntentId: "mod_reissued_ask_mod_reduction",
    amountCents: 3_000,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
  };
  beforeEach(() => {
    minterDb.reissueRecovery = { ...REISSUE_RECOVERY };
    minterDb.currentPayment = { additionalAmountCents: 0, additionalPaymentStatus: null, ...PAYMENT_CUSTOMER };
    minterDb.completeCount = 1;
    mocks.findMinted.mockReset();
  });

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
      door: "guestRemoval",
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
    expect(minted.additionalAskRetired).toBe(false);
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 3_000, carriedAskCents: 3_000, status: PaymentStatus.PENDING }),
    );
  });

  it("MUTATION (round 4): mints under the recovery's own Stripe key and completes that recovery in one write with the row", async () => {
    const result = await adjust(grownBooking({ creditPaid: true }), -2_000);
    await mintAfter(result);

    expect(minterDb.recoveryFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { idempotencyKey: buildAdditionalIntentRecoveryIdempotencyKey("mod_reduction") } }),
    );
    expect(mocks.createIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 3_000, idempotencyKey: "mod_reissued_ask_mod_reduction" }),
    );
    expect(minterDb.recoveryUpdateMany).toHaveBeenCalledWith({
      where: { id: "op_reissue", status: "PENDING", attempts: 0, processingStartedAt: null },
      data: expect.objectContaining({ status: "SUCCEEDED", paymentIntentId: "pi_reissued_3000" }),
    });
    // The row is written on the completing transaction's client.
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ store: expect.anything() }));
    // Decision A: then the smaller ask's own invoice, waiting on the intent.
    expect(queueReissueInvoice).toHaveBeenCalledWith({
      bookingId: "booking_3954",
      bookingModificationId: "mod_reduction",
      paymentIntentId: "pi_reissued_3000",
    });
  });

  // #4217 review (F1): Payment, then the recovery row - the order the runner's
  // claim hold and a reduction netting this re-issue off take them in.
  it("MUTATION (#4217): the door's write under its recovery locks the Payment row before it completes the recovery", async () => {
    const result = await adjust(grownBooking({ creditPaid: true }), -2_000);
    minterDb.executeRaw.mockClear();
    await mintAfter(result);

    const lockAt = minterDb.executeRaw.mock.calls.findIndex((call) => {
      const [strings, ...values] = call as unknown[];
      const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
      return sql.includes('FROM "Payment"') && sql.includes("FOR NO KEY UPDATE") && values[0] === "payment_1";
    });
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(minterDb.recoveryUpdateMany).toHaveBeenCalled();
    expect(minterDb.executeRaw.mock.invocationCallOrder[lockAt]!).toBeLessThan(minterDb.recoveryUpdateMany.mock.invocationCallOrder[0]!);
  });

  // Final review: whoever moved the recovery decides whether the re-issue is
  // still owed. Only a later reduction's net-off retires it; a runner's claim
  // or an increase's fold still asks the member for that money.
  const MOVED_RECOVERIES = [
    ["claimed by the runner after its grace", { status: "PROCESSING", attempts: 1, lastError: null }, false],
    ["folded in by a later increase", { status: "SUCCEEDED", lastError: WAITING_REISSUE_FOLDED_BY_INCREASE_NOTE }, false],
    ["netted off by a later reduction", { status: "SUCCEEDED", lastError: PENDING_ASK_NETTED_BY_REDUCTION_NOTE }, true],
  ] as const;

  it.each(MOVED_RECOVERIES)(
    "MUTATION (round 4; final review): a re-issue whose recovery was already %s is not minted by the door, and is named as due only while still owed",
    async (_label, moved, retired) => {
      minterDb.reissueRecovery = { ...REISSUE_RECOVERY, ...moved };
      const result = await adjust(grownBooking({ creditPaid: true }), -2_000);
      const { minted } = await mintAfter(result);

      expect(mocks.createIntent).not.toHaveBeenCalled();
      expect(minted).toEqual({ additionalPaymentClientSecret: undefined, additionalPaymentIntentId: undefined, additionalAskRetired: retired });
    },
  );

  it("MUTATION (round 4): a recovery that moved while the door minted gets no row and hands out no secret", async () => {
    minterDb.completeCount = 0;
    const result = await adjust(grownBooking({ creditPaid: true }), -2_000);
    // Final review (R1/R2): a later reduction netted the waiting re-issue off
    // between the door's read and its write - the re-read says so.
    minterDb.recoveryFindUnique
      .mockResolvedValueOnce({ ...REISSUE_RECOVERY, lastError: null })
      .mockResolvedValueOnce({ ...REISSUE_RECOVERY, status: "SUCCEEDED", lastError: PENDING_ASK_NETTED_BY_REDUCTION_NOTE });
    const { minted } = await mintAfter(result);

    expect(mocks.createIntent).toHaveBeenCalledTimes(1);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(queueReissueInvoice).not.toHaveBeenCalled();
    expect(minterDb.recoveryFindUnique).toHaveBeenCalledTimes(2);
    expect(minted).toEqual({ additionalPaymentClientSecret: undefined, additionalPaymentIntentId: undefined, additionalAskRetired: true });
  });

  it.each(MOVED_RECOVERIES)(
    "MUTATION (final review): a recovery %s while the door minted is named as due only while still owed",
    async (_label, moved, retired) => {
      minterDb.completeCount = 0;
      const result = await adjust(grownBooking({ creditPaid: true }), -2_000);
      minterDb.recoveryFindUnique
        .mockResolvedValueOnce({ ...REISSUE_RECOVERY, lastError: null })
        .mockResolvedValueOnce({ ...REISSUE_RECOVERY, ...moved });
      const { minted } = await mintAfter(result);

      expect(mocks.createIntent).toHaveBeenCalledTimes(1);
      expect(mocks.upsert).not.toHaveBeenCalled();
      expect(minted).toEqual({ additionalPaymentClientSecret: undefined, additionalPaymentIntentId: undefined, additionalAskRetired: retired });
    },
  );

  it("final review: a re-read that fails after the recovery moved names the re-issue, as before", async () => {
    minterDb.completeCount = 0;
    const result = await adjust(grownBooking({ creditPaid: true }), -2_000);
    minterDb.recoveryFindUnique
      .mockResolvedValueOnce({ ...REISSUE_RECOVERY, lastError: null })
      .mockRejectedValueOnce(new Error("connection reset"));
    const { minted } = await mintAfter(result);

    expect(minted).toEqual({ additionalPaymentClientSecret: undefined, additionalPaymentIntentId: undefined, additionalAskRetired: false });
  });

  it("MUTATION (round 6): the door sends the one request the runner sends - the fixed reason and the key in its metadata, never the door's own wording", async () => {
    const result = await adjust(grownBooking({ creditPaid: true }), -2_000);
    await mintAfter(result);

    expect(mocks.createIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 3_000,
        idempotencyKey: "mod_reissued_ask_mod_reduction",
        metadata: {
          bookingId: "booking_3954",
          type: "modification_additional",
          reason: REISSUED_ASK_REASON,
          [REISSUED_ASK_KEY_METADATA]: "mod_reissued_ask_mod_reduction",
        },
      }),
    );
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ reason: REISSUED_ASK_REASON }));
  });

  it("MUTATION (round 6): an ask minted since the reduction (an officer's review charge) is carried by the door's re-issue, under a key naming the amount, not superseded away", async () => {
    minterDb.currentPayment = { additionalAmountCents: 4_000, additionalPaymentStatus: "PENDING", ...PAYMENT_CUSTOMER };
    const result = await adjust(grownBooking({ creditPaid: true }), -2_000);
    await mintAfter(result);

    expect(mocks.createIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 7_000, idempotencyKey: "mod_reissued_ask_mod_reduction_7000" }),
    );
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 7_000, carriedAskCents: 7_000 }),
    );
  });

  it("MUTATION (round 6): Stripe's idempotency_error on the re-issue's key is answered with the intent that key already minted, which the door then writes", async () => {
    mocks.createIntent.mockRejectedValueOnce(Object.assign(new Error("Keys for idempotent requests can only be used with the same parameters"), { rawType: "idempotency_error" }));
    mocks.findMinted.mockResolvedValueOnce({ id: "pi_minted_by_runner", amount: 3_000, client_secret: "secret_runner" });
    const result = await adjust(grownBooking({ creditPaid: true }), -2_000);
    const { minted } = await mintAfter(result);

    expect(mocks.findMinted).toHaveBeenCalledWith(
      expect.objectContaining({ metadataKey: REISSUED_ASK_KEY_METADATA, metadataValue: "mod_reissued_ask_mod_reduction" }),
    );
    expect(minted.additionalPaymentIntentId).toBe("pi_minted_by_runner");
    expect(minterDb.recoveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ paymentIntentId: "pi_minted_by_runner" }) }),
    );
  });

  it("MUTATION (round 7): the lookup is scoped to the customer resolved as the runner resolves it, and the row records the intent's OWN customer", async () => {
    mocks.createIntent.mockRejectedValueOnce(Object.assign(new Error("Keys for idempotent requests can only be used with the same parameters"), { rawType: "idempotency_error" }));
    mocks.findMinted.mockResolvedValueOnce({ id: "pi_minted_by_runner", amount: 3_000, client_secret: "secret_runner", customer: "cus_minted" });
    const result = await adjust(grownBooking({ creditPaid: true }), -2_000);
    await mintAfter(result);

    expect(mocks.findMinted).toHaveBeenCalledWith(expect.objectContaining({ customerId: "cus_1" }));
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: "pi_minted_by_runner", stripeCustomerId: "cus_minted" }),
    );
  });

  // Round 8 (F1): only the secret is withheld. The minted intent's id still
  // goes back, so the edit's Xero leg parks the increase's own invoice on the
  // retired intent instead of raising it unpaid.
  it("MUTATION (round 7, F7; round 8): a re-issue a later reduction withdrew during the door's cancels offers no secret, but its intent is still handed back", async () => {
    const result = await adjust(grownBooking({ creditPaid: true }), -2_000);
    queueReissueInvoice.mockResolvedValueOnce(false);
    const { minted } = await mintAfter(result);
    expect(queueReissueInvoice).toHaveBeenCalledTimes(1);
    expect(minted.additionalPaymentClientSecret).toBeUndefined();
    expect(minted.additionalPaymentIntentId).toMatch(/^pi_/);
    // Round 9: and says so, so no member-facing message names it as due.
    expect(minted.additionalAskRetired).toBe(true);
  });

  it("MUTATION (round 7, F7; round 8): an increase's ask a reduction withdrew during the door's cancels offers no secret, but its intent is still handed back", async () => {
    const result = await adjust(grownBooking(), 1_000);
    queueFoldedInvoices.mockResolvedValueOnce(false);
    const { minted } = await mintAfter(result);
    expect(minted.additionalPaymentClientSecret).toBeUndefined();
    expect(minted.additionalPaymentIntentId).toBe("pi_reissued_6000");
    expect(minted.additionalAskRetired).toBe(true);
  });

  it("MUTATION (round 6): an increase's own mint queues the invoices of the re-issues it folded in, waiting on its intent", async () => {
    const result = await adjust(grownBooking(), 1_000);
    expect(result.additionalAsk.amountCents).toBe(6_000);
    await mintAfter(result);

    expect(queueFoldedInvoices).toHaveBeenCalledWith({
      bookingId: "booking_3954",
      increaseModificationId: "mod_reduction",
      paymentIntentId: "pi_reissued_6000",
    });
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

/*
  #3954 "retry nets it off" (owner decision, 9 Oct 2026): the increase's mint
  FAILED, so its ask is a CREATE_ADDITIONAL_PAYMENT_INTENT recovery row waiting
  on the cron - no ledger row, no mirror. A reduction saved in that window nets
  the waiting ask off as it would a minted one, closing the recovery so its
  retry cannot mint the old $50, and asks afresh for only what is left.
*/
describe("#3954 retry nets it off: an ask whose mint failed and waits on its recovery", () => {
  const RECOVERY_ID = "op_mint_increase";
  const RECOVERED_AT = new Date("2026-06-21T00:00:00.000Z");

  function recoveryRow(overrides: Record<string, unknown> = {}) {
    return {
      id: RECOVERY_ID,
      status: "FAILED",
      attempts: 1,
      nextRetryAt: RECOVERED_AT,
      idempotencyKey: buildAdditionalIntentRecoveryIdempotencyKey("mod_increase"),
      amountCents: 5_000,
      createdAt: RECOVERED_AT,
      processingStartedAt: null,
      ...overrides,
    };
  }

  /** $150, $100 paid, the $50 ask still a recovery row: nothing on the mirror. */
  function awaitingRetryBooking({ creditPaid = false } = {}) {
    const booking = grownBooking({ creditPaid });
    Object.assign(booking.payment!, { additionalAmountCents: 0, additionalPaymentStatus: null, additionalPaymentIntentId: null });
    return booking;
  }

  beforeEach(() => {
    state.rows = [];
    state.modifications = [{ id: "mod_increase", priceDiffCents: 5_000, changeFeeCents: 0 }];
    state.recoveries = [recoveryRow()];
  });

  it.each([false, true])(
    "MUTATION: removing $20 (credit-paid: %s) nets against the waiting $50 - nothing refunded, the recovery closed from the state it was read in, $30 re-issued",
    async (creditPaid) => {
      const result = await adjust(awaitingRetryBooking({ creditPaid }), -2_000);

      expect(result.unpaidAskOffsetCents).toBe(2_000);
      expect(result.refundAmountCents).toBe(0);
      expect(result.accountCreditAmountCents).toBe(0);
      expect(result.appliedCreditGivenBackCents).toBe(0);
      expect(result.additionalAsk.amountCents).toBe(3_000);
      expect(result.additionalAsk.carriedCents).toBe(3_000);
      expect(result.additionalAsk.reissuesUnpaidAsk).toBe(true);
      expect(result.retiredAdditionalAsks).toEqual([]);
      expect(result.retiredAskModificationIds).toEqual(["mod_increase"]);
      expect(recoveryUpdateMany).toHaveBeenCalledTimes(1);
      expect(recoveryUpdateMany).toHaveBeenCalledWith({
        where: { id: RECOVERY_ID, status: "FAILED", attempts: 1, processingStartedAt: null },
        data: expect.objectContaining({ status: "SUCCEEDED", nextRetryAt: null }),
      });
      // A parked invoice waits on the edit, not on an intent that never existed.
      expect(xeroUpdateMany.mock.calls[0]?.[0].where.OR).toEqual([
        expect.objectContaining({ requestPayload: { path: ["bookingModificationId"], equals: "mod_increase" } }),
      ]);
    },
  );

  // #4217 review (F1): the Payment row before the waiting recovery - the order
  // the runner's claim hold and the re-issue door take (Payment, then the
  // recovery), and the one a give-back that already wrote the Payment row
  // forces. The recovery first is a deadlock with either.
  it("MUTATION (#4217): the retire locks the Payment row before it closes the waiting recovery", async () => {
    await adjust(awaitingRetryBooking({ creditPaid: false }), -2_000);
    const paymentLocks = executeRaw.mock.calls
      .map((call, index) => ({ call: call as unknown[], order: executeRaw.mock.invocationCallOrder[index]! }))
      .filter(({ call }) => {
        const [strings, ...values] = call;
        const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
        return sql.includes('FROM "Payment"') && sql.includes("FOR NO KEY UPDATE") && values[0] === "payment_1";
      });
    expect(recoveryUpdateMany).toHaveBeenCalledTimes(1);
    expect(paymentLocks.length).toBeGreaterThanOrEqual(1);
    expect(paymentLocks[0]!.order).toBeLessThan(recoveryUpdateMany.mock.invocationCallOrder[0]!);
  });

  it("an $80 reduction nets the whole waiting $50 off and refunds only the $30 left, by the tier", async () => {
    mocks.policy = [{ daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 0 }];
    const result = await adjust(awaitingRetryBooking(), -8_000);

    expect(result.unpaidAskOffsetCents).toBe(5_000);
    expect(result.refundAmountCents).toBe(1_500);
    expect(result.additionalAsk.amountCents).toBe(0);
    expect(recoveryUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("the waiting ask joins a minted one it would supersede: the ask is both, counted once, and both retire", async () => {
    // A minted $50 ask is live; the next increase (+$50) failed to mint, and its
    // retry would ask $100 (its own $50 plus the $50 it supersedes).
    const booking = grownBooking();
    state.rows = [askRow()];
    state.recoveries = [recoveryRow({ amountCents: 10_000, createdAt: new Date("2026-06-22T00:00:00.000Z") })];
    const result = await adjust(booking, -8_000);

    expect(result.unpaidAskOffsetCents).toBe(8_000);
    expect(result.refundAmountCents).toBe(0);
    expect(result.additionalAsk.amountCents).toBe(2_000);
    expect(transactionUpdateMany.mock.calls.map(([call]) => call.where.id)).toEqual([ASK_ROW_ID]);
    expect(recoveryUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("the settlement options are sized on what the waiting ask leaves, as the save is", async () => {
    const booking = awaitingRetryBooking();
    const options = await calculateModificationSettlementOptions({
      booking,
      netChargeCents: -8_000,
      reduction: await readReductionAgainstUnpaidAsk(tx, booking, -8_000),
      db: tx as never,
      todayAtClub: TODAY,
    });
    expect(options?.basisAmountCents).toBe(3_000);
  });

  it.each([
    ["dead - no retry left", { nextRetryAt: null }],
    ["dead - attempts spent", { attempts: 5 }],
    ["overtaken by a later ask", { createdAt: new Date("2026-06-19T00:00:00.000Z") }],
  ])("MUTATION: a recovery %s mints nothing, so nothing is netted against it", async (_label, overrides) => {
    if ("createdAt" in overrides) {
      state.rows = [askRow({ status: PaymentStatus.FAILED, withdrawnAt: new Date("2026-06-20T00:00:00.000Z") } as Partial<Row>)];
    }
    state.recoveries = [recoveryRow(overrides)];
    const result = await adjust(awaitingRetryBooking(), -2_000);

    expect(result.unpaidAskOffsetCents).toBe(0);
    expect(result.refundAmountCents).toBe(2_000);
    expect(recoveryUpdateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["a recovery whose edit cannot be read", { idempotencyKey: buildAdditionalIntentRecoveryIdempotencyKey("mod_elsewhere") }],
  ])("%s is not guessed at - the reduction settles as before", async (_label, overrides) => {
    state.recoveries = [recoveryRow(overrides)];
    const result = await adjust(awaitingRetryBooking(), -2_000);

    expect(result.unpaidAskOffsetCents).toBe(0);
    expect(result.refundAmountCents).toBe(2_000);
    expect(recoveryUpdateMany).not.toHaveBeenCalled();
  });

  it("MUTATION (decision B, 9 Oct): an officer's waiting review charge is left exactly as set - the reduction nets only against the member's own price ask beside it", async () => {
    // The member's own $50 price ask is a live row; an officer's review charge
    // for the same booking waits on its mint's retry.
    state.rows = [askRow()];
    state.recoveries = [
      recoveryRow({ id: "op_review_charge", idempotencyKey: buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey("mod_increase") }),
    ];
    const result = await adjust(grownBooking(), -2_000);

    expect(result.unpaidAskOffsetCents).toBe(2_000);
    expect(result.refundAmountCents).toBe(0);
    expect(result.additionalAsk.amountCents).toBe(3_000);
    expect(transactionUpdateMany.mock.calls.map(([call]) => call.where.id)).toEqual([ASK_ROW_ID]);
    // Not counted, not closed: the officer's charge mints as set.
    expect(recoveryUpdateMany).not.toHaveBeenCalled();
    expect(result.retiredAskModificationIds).toEqual([]);
  });

  it("decision B: with only a review charge waiting there is no price ask to net, and the reduction settles as before", async () => {
    state.recoveries = [
      recoveryRow({ idempotencyKey: buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey("mod_increase") }),
    ];
    const result = await adjust(awaitingRetryBooking(), -2_000);

    expect(result.unpaidAskOffsetCents).toBe(0);
    expect(result.refundAmountCents).toBe(2_000);
    expect(recoveryUpdateMany).not.toHaveBeenCalled();
  });

  it("MUTATION (round 6): an increase's waiting mint that folded a re-issue in is owed for both, and their invoices are counted - the folded one's was never parked", async () => {
    state.modifications = [
      { id: "mod_increase", priceDiffCents: 5_000, changeFeeCents: 0, newData: { foldedReissuedAskCents: 3_000, foldedReissuedAskInvoiceCents: 1_000 } },
    ];
    state.recoveries = [recoveryRow({ amountCents: 8_000, hadIssuedXeroInvoice: true })];
    const result = await adjust(awaitingRetryBooking(), -2_000);

    expect(result.unpaidAskOffsetCents).toBe(2_000);
    expect(result.additionalAsk.amountCents).toBe(6_000);
    // Its own $50 invoice and the folded re-issue's $10, less the $20 offset.
    expect(result.reissuedAskInvoiceCents).toBe(4_000);
  });

  describe("round 8 (F2): a re-issue its reduction was unsure of stays unsure when a later reduction retires it", () => {
    function invoicedBooking() {
      const booking = grownBooking({ xeroInvoiceId: "INV-3954" });
      Object.assign(booking.payment!, { additionalAmountCents: 0, additionalPaymentStatus: null, additionalPaymentIntentId: null });
      return booking;
    }
    const UNSURE_REDUCTION = {
      id: "mod_reduction",
      priceDiffCents: -2_000,
      changeFeeCents: 0,
      newData: { reissuedAskInvoiceCents: 1_000, reissuedAskInvoiceUnsureCents: 2_000 },
    };

    it("MUTATION: a waiting re-issue recorded unsure - nothing is credit-noted on its figure as if it were certain", async () => {
      state.modifications = [UNSURE_REDUCTION];
      state.recoveries = [
        recoveryRow({
          idempotencyKey: buildAdditionalIntentRecoveryIdempotencyKey("mod_reduction"),
          amountCents: 3_000,
          paymentIntentId: "mod_reissued_ask_mod_reduction",
          hadIssuedXeroInvoice: true,
        }),
      ];
      const result = await adjust(invoicedBooking(), -2_500);

      expect(result.unpaidAskOffsetCents).toBe(2_500);
      expect(result.unpaidAskBilledOffsetCents).toBe(0);
      expect(result.unpaidAskBilledOffsetUnsureCents).toBeGreaterThan(0);
    });

    it("MUTATION: an increase's waiting mint that folded in a re-issue recorded unsure is unsure too", async () => {
      state.modifications = [
        {
          id: "mod_increase",
          priceDiffCents: 5_000,
          changeFeeCents: 0,
          newData: {
            foldedReissuedAskCents: 3_000,
            foldedReissuedAskModificationIds: ["mod_reduction"],
            foldedReissuedAskInvoiceCents: 1_000,
          },
        },
        UNSURE_REDUCTION,
      ];
      state.recoveries = [recoveryRow({ amountCents: 8_000, hadIssuedXeroInvoice: true })];
      const result = await adjust(invoicedBooking(), -7_000);

      expect(result.unpaidAskOffsetCents).toBe(7_000);
      expect(result.unpaidAskBilledOffsetCents).toBe(0);
      expect(result.unpaidAskBilledOffsetUnsureCents).toBeGreaterThan(0);
    });
  });

  it("MUTATION (round 4): a waiting re-issue a later minter overtook without folding it in is still owed, all of it", async () => {
    // A reduction re-issued $30 (its mint failed); a review charge later minted
    // $20 for its own money alone. The replay will carry that $20 and ask $50.
    state.modifications = [{ id: "mod_reduction", priceDiffCents: -2_000, changeFeeCents: 0 }];
    state.rows = [askRow({ amountCents: 2_000, createdAt: new Date("2026-06-22T00:00:00.000Z") })];
    state.recoveries = [
      recoveryRow({
        idempotencyKey: buildAdditionalIntentRecoveryIdempotencyKey("mod_reduction"),
        amountCents: 3_000,
        paymentIntentId: "mod_reissued_ask_mod_reduction",
      }),
    ];
    const booking = grownBooking();
    Object.assign(booking.payment!, { additionalAmountCents: 2_000 });
    const result = await adjust(booking, -1_000);

    expect(result.unpaidAskOffsetCents).toBe(1_000);
    expect(result.additionalAsk.amountCents).toBe(4_000);
    expect(recoveryUpdateMany).toHaveBeenCalledTimes(1);
  });

  describe("round 4: a later increase folds a waiting re-issue into its own ask", () => {
    function waitingReissue(overrides: Record<string, unknown> = {}) {
      state.rows = [];
      state.modifications = [{ id: "mod_reduction", priceDiffCents: -2_000, changeFeeCents: 0 }];
      state.recoveries = [
        recoveryRow({
          id: "op_reissue",
          idempotencyKey: buildAdditionalIntentRecoveryIdempotencyKey("mod_reduction"),
          amountCents: 3_000,
          paymentIntentId: "mod_reissued_ask_mod_reduction",
          ...overrides,
        }),
      ];
    }

    it("MUTATION: asks for its own $10 and the waiting $30 on one fresh ask, carried, and closes the re-issue's recovery", async () => {
      waitingReissue();
      const result = await adjust(awaitingRetryBooking(), 1_000);

      expect(result.additionalAsk.amountCents).toBe(4_000);
      expect(result.additionalAsk.carriedCents).toBe(3_000);
      expect(recoveryUpdateMany).toHaveBeenCalledWith({
        where: { id: "op_reissue", status: "FAILED", attempts: 1, processingStartedAt: null },
        data: expect.objectContaining({ status: "SUCCEEDED", lastError: WAITING_REISSUE_FOLDED_BY_INCREASE_NOTE }),
      });
    });

    // #4217 review (F1): Payment, then the recovery it closes.
    it("MUTATION (#4217): the fold locks the Payment row before it closes the waiting re-issue's recovery", async () => {
      waitingReissue();
      await adjust(awaitingRetryBooking(), 1_000);

      const lockAt = executeRaw.mock.calls.findIndex((call) => {
        const [strings, ...values] = call as unknown[];
        const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
        return sql.includes('FROM "Payment"') && sql.includes("FOR NO KEY UPDATE") && values[0] === "payment_1";
      });
      expect(lockAt).toBeGreaterThanOrEqual(0);
      expect(recoveryUpdateMany).toHaveBeenCalledTimes(1);
      expect(executeRaw.mock.invocationCallOrder[lockAt]!).toBeLessThan(recoveryUpdateMany.mock.invocationCallOrder[0]!);
    });

    it("MUTATION (round 6): records what it folded - the re-issue's money, its reducing edit and that edit's own invoice - on the increase's history", async () => {
      waitingReissue();
      state.modifications = [{ id: "mod_reduction", priceDiffCents: -2_000, changeFeeCents: 0, newData: { reissuedAskInvoiceCents: 1_000 } }];
      const result = await adjust(awaitingRetryBooking(), 1_000);

      expect(result.foldedReissuedAsks).toEqual({ cents: 3_000, modificationIds: ["mod_reduction"], invoiceCents: 1_000 });
      expect(unpaidAskOffsetHistory(result)).toEqual({
        foldedReissuedAskCents: 3_000,
        foldedReissuedAskModificationIds: ["mod_reduction"],
        foldedReissuedAskInvoiceCents: 1_000,
      });
    });

    it("folds nothing for an increase's own failed mint - #3340's overtake rule is unchanged", async () => {
      state.rows = [];
      state.recoveries = [recoveryRow()];
      const result = await adjust(awaitingRetryBooking(), 1_000);

      expect(result.additionalAsk.amountCents).toBe(1_000);
      expect(recoveryUpdateMany).not.toHaveBeenCalled();
    });

    it("MUTATION: a re-issue claimed moments ago refuses the increase for a moment rather than mint beside it", async () => {
      waitingReissue({ status: "PROCESSING", attempts: 1, processingStartedAt: new Date("2026-06-30T23:59:30.000Z") });
      await expect(adjust(awaitingRetryBooking(), 1_000)).rejects.toBeInstanceOf(AdditionalAskChangedDuringReductionError);
    });
  });

  it("MUTATION: a retry that claimed the row since it was read fails the fence and rolls the whole edit back (409)", async () => {
    state.recoveryCloseCount = 0;
    await expect(adjust(awaitingRetryBooking(), -2_000)).rejects.toSatisfy(
      (err: unknown) => err instanceof ApiError && err.status === 409,
    );
    expect(paymentFindUnique).not.toHaveBeenCalled();
  });

  // The frozen clock is 2026-07-01T00:00:00Z.
  const CLAIMED_MOMENTS_AGO = new Date("2026-06-30T23:59:30.000Z");
  const CLAIMED_LONG_AGO = new Date("2026-06-30T23:55:00.000Z");

  it("MUTATION: a retry claimed moments ago is minting right now - the save is refused for a moment (409), never closed under it with its old figure live", async () => {
    state.recoveries = [recoveryRow({ status: "PROCESSING", attempts: 2, processingStartedAt: CLAIMED_MOMENTS_AGO })];
    await expect(adjust(awaitingRetryBooking(), -2_000)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AdditionalAskChangedDuringReductionError &&
        err.status === 409 &&
        err.message === ADDITIONAL_ASK_BEING_RAISED_MESSAGE,
    );
    expect(recoveryUpdateMany).not.toHaveBeenCalled();
  });

  it("MUTATION (round 4): a retry claimed more than two minutes ago is a stalled worker - netted off and closed under its attempt AND claim time, so it cannot write afterwards", async () => {
    state.recoveries = [recoveryRow({ status: "PROCESSING", attempts: 2, processingStartedAt: CLAIMED_LONG_AGO })];
    const result = await adjust(awaitingRetryBooking(), -2_000);

    expect(result.unpaidAskOffsetCents).toBe(2_000);
    expect(result.additionalAsk.amountCents).toBe(3_000);
    expect(recoveryUpdateMany).toHaveBeenCalledWith({
      where: { id: RECOVERY_ID, status: "PROCESSING", attempts: 2, processingStartedAt: CLAIMED_LONG_AGO },
      data: expect.objectContaining({ status: "SUCCEEDED" }),
    });
  });

  it("MUTATION (round 4): a claimed retry that already wrote its own row is not skipped as overtaken - its row is the ask, and the retry is still fenced", async () => {
    // The retry minted $50 and wrote its row (later than its recovery), then
    // stalled before completing; the row mirrors as the live ask.
    state.rows = [askRow({ createdAt: new Date("2026-06-22T00:00:00.000Z") })];
    state.recoveries = [recoveryRow({ status: "PROCESSING", attempts: 2, processingStartedAt: CLAIMED_MOMENTS_AGO })];
    // Within the window: refused, not netted beside a retry still finishing.
    await expect(adjust(grownBooking(), -2_000)).rejects.toBeInstanceOf(AdditionalAskChangedDuringReductionError);
    // Round 6: the waiting recovery is closed (or refuses) before any row is stamped.
    expect(transactionUpdateMany).not.toHaveBeenCalled();

    // After it: netted against the row, counted once, and the retry closed.
    vi.clearAllMocks();
    transactionUpdateMany.mockImplementation(async () => ({ count: 1 }));
    recoveryUpdateMany.mockImplementation(async () => ({ count: 1 }));
    xeroUpdateMany.mockImplementation(async () => ({ count: 1 }));
    mocks.enqueueCancel.mockImplementation(async ({ paymentTransactionId }) => ({ id: `op_cancel_${paymentTransactionId}`, status: "PENDING" }));
    state.recoveries = [recoveryRow({ status: "PROCESSING", attempts: 2, processingStartedAt: CLAIMED_LONG_AGO })];
    const result = await adjust(grownBooking(), -2_000);
    expect(result.unpaidAskOffsetCents).toBe(2_000);
    expect(result.additionalAsk.amountCents).toBe(3_000);
    expect(recoveryUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("MUTATION (round 6, F8): closes the waiting recovery BEFORE stamping the rows - the runner's own order - so the two cannot deadlock", async () => {
    state.rows = [askRow({ createdAt: new Date("2026-06-22T00:00:00.000Z") })];
    state.recoveries = [recoveryRow({ status: "PROCESSING", attempts: 2, processingStartedAt: CLAIMED_LONG_AGO })];
    await adjust(grownBooking(), -2_000);
    expect(recoveryUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(transactionUpdateMany.mock.invocationCallOrder[0]!);
  });

  it.each([
    ["Prisma's write-conflict code", Object.assign(new Error("Transaction failed due to a write conflict or a deadlock"), { code: "P2034" })],
    ["the database's own deadlock", new Error('deadlock detected (SQLSTATE 40P01)')],
  ])("MUTATION (round 6, F8): %s while retiring is the 409 try-again, never a 500", async (_label, conflict) => {
    state.rows = [askRow()];
    state.recoveries = [];
    transactionUpdateMany.mockRejectedValueOnce(conflict);
    const refused = await adjust(grownBooking(), -2_000).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(AdditionalAskChangedDuringReductionError);
    // Round 7 (F9): the database's own error is kept as the 409's cause.
    expect((refused as Error).cause).toBe(conflict);
  });

  it("after commit the minter re-issues the $30 on a credit-paid booking with nothing to cancel first", async () => {
    const result = await adjust(awaitingRetryBooking({ creditPaid: true }), -2_000);
    mocks.createIntent.mockImplementation(async ({ amountCents }) => ({ id: `pi_reissued_${amountCents}`, client_secret: "secret" }));
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
      door: "guestRemoval",
      failureMessage: "test",
    });
    expect(mocks.runNow).not.toHaveBeenCalled();
    expect(minted.additionalPaymentIntentId).toBe("pi_reissued_3000");
  });
});

describe("#3954: one sizing for a failed mint's replay and the reduction that may net it off", () => {
  const unpaid = { additionalAmountCents: 7_000, additionalPaymentStatus: "PENDING" };

  it("an increase re-derives its own net plus the ask it supersedes, and adds only its own net beyond that ask", () => {
    const replay = sizeRecoveryReplayAsk({ frozenAmountCents: 14_000, modification: { priceDiffCents: 6_000, changeFeeCents: 1_000, newData: null }, payment: unpaid });
    expect(replay.kind).toBe("increase");
    expect(replay.kind !== "frozen" && replay.ask.amountCents).toBe(14_000);
    expect(recoveryAskBeyondPaymentAskCents(replay)).toBe(7_000);
  });

  it("MUTATION (round 4): a reduction's re-issue carries its frozen figure plus any later ask it will supersede, and only the frozen figure is beyond that ask", () => {
    const replay = sizeRecoveryReplayAsk({ frozenAmountCents: 3_000, modification: { priceDiffCents: -2_000, changeFeeCents: 0, newData: null }, payment: unpaid });
    expect(replay.kind).toBe("reissue");
    expect(replay.kind !== "frozen" && [replay.ask.amountCents, replay.ask.carriedCents]).toEqual([10_000, 10_000]);
    expect(recoveryAskBeyondPaymentAskCents(replay)).toBe(3_000);
    // With no later ask - the reduction retired every ask before it - it is the frozen figure alone.
    const alone = sizeRecoveryReplayAsk({ frozenAmountCents: 3_000, modification: { priceDiffCents: -2_000, changeFeeCents: 0, newData: null }, payment: null });
    expect(alone.kind !== "frozen" && alone.ask.amountCents).toBe(3_000);
  });

  it("MUTATION (round 4): a re-issue is settled only by its own row; an increase by any later ask", () => {
    const operation = { createdAt: new Date("2026-06-21T00:00:00.000Z"), paymentIntentId: "pi_own" };
    const later = { kind: "ADDITIONAL", createdAt: new Date("2026-06-22T00:00:00.000Z") };
    const reissue = sizeRecoveryReplayAsk({ frozenAmountCents: 3_000, modification: { priceDiffCents: -2_000, changeFeeCents: 0, newData: null }, payment: null });
    const increase = sizeRecoveryReplayAsk({ frozenAmountCents: 3_000, modification: { priceDiffCents: 3_000, changeFeeCents: 0, newData: null }, payment: null });
    const foreign = [{ ...later, stripePaymentIntentId: "pi_later_edit" }];
    const own = [{ ...later, stripePaymentIntentId: "pi_own" }];
    expect(isRecoveryReplaySettled(reissue, operation, foreign)).toBe(false);
    expect(isRecoveryReplaySettled(reissue, operation, own)).toBe(true);
    expect(isRecoveryReplaySettled(increase, operation, foreign)).toBe(true);
  });

  it("round 7 (F15): what a read's reduction leaves after the ask - one home, 0 for an increase", () => {
    const read = (netChargeCents: number, unpaidAskCents: number) => ({ netChargeCents, ...setReductionAgainstUnpaidAsk({ netChargeCents, unpaidAskCents }) });
    expect(reductionLeftAfterAskCents(read(-8_000, 5_000))).toBe(3_000);
    expect(reductionLeftAfterAskCents(read(-2_000, 5_000))).toBe(0);
    expect(reductionLeftAfterAskCents(read(3_000, 5_000))).toBe(0);
  });

  it("MUTATION (round 7): an increase that folded re-issues in is settled only by its own row - a later ask never overtakes the money it folded", () => {
    const operation = { createdAt: new Date("2026-06-21T00:00:00.000Z"), paymentIntentId: "pi_own" };
    const later = { kind: "ADDITIONAL", createdAt: new Date("2026-06-22T00:00:00.000Z") };
    const folding = sizeRecoveryReplayAsk({
      frozenAmountCents: 4_000,
      modification: { priceDiffCents: 1_000, changeFeeCents: 0, newData: { foldedReissuedAskCents: 3_000 } },
      payment: null,
    });
    expect(isRecoveryReplaySettled(folding, operation, [{ ...later, stripePaymentIntentId: "pi_later_edit" }])).toBe(false);
    expect(isRecoveryReplaySettled(folding, operation, [{ ...later, stripePaymentIntentId: "pi_own" }])).toBe(true);
  });

  it("MUTATION (round 6): an increase that folded waiting re-issues in asks for them again on its replay, and counts them beyond the Payment's ask", () => {
    const replay = sizeRecoveryReplayAsk({
      frozenAmountCents: 11_000,
      modification: { priceDiffCents: 1_000, changeFeeCents: 0, newData: { foldedReissuedAskCents: 3_000 } },
      payment: unpaid,
    });
    expect(replay.kind !== "frozen" && [replay.ask.amountCents, replay.ask.carriedCents]).toEqual([11_000, 10_000]);
    expect(recoveryAskBeyondPaymentAskCents(replay)).toBe(4_000);
  });

  it.each([null, { priceDiffCents: 0, changeFeeCents: 0, newData: null }])("no readable net (%o) replays the frozen figure, which nothing nets against", (modification) => {
    const replay = sizeRecoveryReplayAsk({ frozenAmountCents: 5_000, modification, payment: unpaid });
    expect(replay).toEqual({ kind: "frozen", amountCents: 5_000 });
    expect(recoveryAskBeyondPaymentAskCents(replay)).toBeNull();
  });

  it("a later ADDITIONAL row, of any status, overtakes a recovery; an earlier one does not", () => {
    const operation = { createdAt: new Date("2026-06-21T00:00:00.000Z") };
    expect(isRecoveryOvertakenByLaterAsk(operation, [{ kind: "ADDITIONAL", createdAt: new Date("2026-06-22T00:00:00.000Z") }])).toBe(true);
    expect(isRecoveryOvertakenByLaterAsk(operation, [{ kind: "ADDITIONAL", createdAt: new Date("2026-06-20T00:00:00.000Z") }])).toBe(false);
    expect(isRecoveryOvertakenByLaterAsk(operation, [{ kind: "PRIMARY", createdAt: new Date("2026-06-22T00:00:00.000Z") }])).toBe(false);
  });
});

const { queueReissuedAskRecovery, REISSUED_ASK_INLINE_MINT_GRACE_MS } = await import("@/lib/additional-ask-reissue");

describe("#3954 round 4: a re-issued ask is durable from the edit's commit", () => {
  const upsert = vi.fn(async (args: unknown) => { void args; return { id: "op_reissue" }; });
  const store = { paymentRecoveryOperation: { upsert } } as unknown as Parameters<typeof queueReissuedAskRecovery>[0];
  const NOW = new Date("2026-07-01T00:00:00.000Z");

  it("MUTATION: writes a PENDING recovery in the edit's transaction, under the edit-scoped Stripe key, claimable only after the door's grace", async () => {
    await queueReissuedAskRecovery(store, {
      bookingId: "booking_3954",
      paymentId: "payment_1",
      bookingModificationId: "mod_reduction",
      settled: { additionalAsk: reissueUnpaidAdditionalAsk({ askLeftCents: 3_000 }), hasIssuedXeroInvoice: true },
      now: NOW,
    });

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]?.[0]).toMatchObject({
      where: { idempotencyKey: buildAdditionalIntentRecoveryIdempotencyKey("mod_reduction") },
      create: {
        type: "CREATE_ADDITIONAL_PAYMENT_INTENT",
        status: "PENDING",
        amountCents: 3_000,
        paymentIntentId: "mod_reissued_ask_mod_reduction",
        hadIssuedXeroInvoice: true,
        nextRetryAt: new Date(NOW.getTime() + REISSUED_ASK_INLINE_MINT_GRACE_MS),
      },
    });
  });

  it.each([
    ["a cancelled ask", NO_ADDITIONAL_ASK],
  ])("writes nothing for %s", async (_label, additionalAsk) => {
    upsert.mockClear();
    await queueReissuedAskRecovery(store, {
      bookingId: "booking_3954",
      paymentId: "payment_1",
      bookingModificationId: "mod_reduction",
      settled: { additionalAsk, hasIssuedXeroInvoice: true },
      now: NOW,
    });
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("#3954 decision A: the smaller re-issued ask's own invoice bills what the retired invoices left", () => {
  beforeEach(() => {
    state.recoveries = [];
    // The increase saw no primary invoice (`askRow`), so the one raised after it billed it.
  });
  function parkedSupplementary(priceDiffCents: number, changeFeeCents = 0) {
    return { localModel: "BookingModification", localId: "mod_increase", requestPayload: { priceDiffCents, changeFeeCents, paymentIntentId: ASK_INTENT } };
  }

  it("MUTATION: the increase's parked $50 invoice is retired and the $30 re-issue records a $30 invoice of its own", async () => {
    state.parkedInvoices = [parkedSupplementary(5_000)];
    const result = await adjust(grownBooking({ xeroInvoiceId: "INV-3954" }), -2_000);

    expect(result.additionalAsk.amountCents).toBe(3_000);
    expect(result.reissuedAskInvoiceCents).toBe(3_000);
    expect(result.unpaidAskBilledOffsetCents).toBe(0);
    expect(result.retiredAskModificationIds).toEqual(["mod_increase"]);
  });

  it("MUTATION (round 5): only the offset beyond the retired invoices is the primary invoice's to credit - the two paths never double up", async () => {
    // $50 asked: $30 billed by a primary invoice raised after the first
    // increase, $20 on a later increase's parked invoice. A $40 reduction
    // retires the $20 invoice and leaves $20 for the primary invoice's note.
    state.parkedInvoices = [parkedSupplementary(2_000)];
    const result = await adjust(grownBooking({ xeroInvoiceId: "INV-3954" }), -4_000);

    expect(result.additionalAsk.amountCents).toBe(1_000);
    expect(result.reissuedAskInvoiceCents).toBe(0);
    expect(result.unpaidAskBilledOffsetCents).toBe(2_000);
  });

  it("MUTATION: an ask the primary invoice already billed raises no second invoice - the offset Xero billed is recorded for its own credit note instead", async () => {
    // The primary invoice was raised after the increase, so it bills the $50;
    // no supplementary invoice was ever parked.
    state.parkedInvoices = [];
    const result = await adjust(grownBooking({ xeroInvoiceId: "INV-3954" }), -2_000);

    expect(result.additionalAsk.amountCents).toBe(3_000);
    expect(result.reissuedAskInvoiceCents).toBe(0);
    expect(result.unpaidAskBilledOffsetCents).toBe(2_000);
  });

  it("MUTATION (round 6, F6; round 7): an increase whose invoice is not parked YET - its edit saw the primary invoice - is billed by that invoice still to come, never credit-noted", async () => {
    state.parkedInvoices = [];
    state.rows = [askRow({ hadIssuedXeroInvoice: true })];
    const result = await adjust(grownBooking({ xeroInvoiceId: "INV-3954" }), -2_000);

    expect(result.unpaidAskBilledOffsetCents).toBe(0);
    expect(result.unpaidAskBilledOffsetUnsureCents).toBe(0);
    // Its $50 would have billed the ask; the $30 left is the re-issue's own.
    expect(result.reissuedAskInvoiceCents).toBe(3_000);
  });

  it("MUTATION (round 8, F1): a door-minted row whose edit has queued no invoice yet is retired by name - the edit stamped on it", async () => {
    state.parkedInvoices = [];
    state.rows = [askRow({ hadIssuedXeroInvoice: true, bookingModificationId: "mod_increase" })];
    const result = await adjust(grownBooking({ xeroInvoiceId: "INV-3954" }), -300);

    expect(result.retiredAskModificationIds).toEqual(["mod_increase"]);
    expect(unpaidAskOffsetHistory(result)).toMatchObject({ unpaidAskRetiredModificationIds: ["mod_increase"] });
  });

  it("MUTATION (round 6, F6; round 7, F3): with no answer recorded on the ask, what the invoice billed is not guessed - the offset and the re-issue's invoice are reported for a person, never credit-noted", async () => {
    state.parkedInvoices = [];
    state.rows = [askRow({ hadIssuedXeroInvoice: null })];
    const result = await adjust(grownBooking({ xeroInvoiceId: "INV-3954" }), -2_000);

    expect(result.unpaidAskBilledOffsetCents).toBe(0);
    expect(result.unpaidAskBilledOffsetUnsureCents).toBe(2_000);
    expect(result.reissuedAskInvoiceCents).toBe(0);
    expect(result.reissuedAskInvoiceUnsureCents).toBe(3_000);
    expect(unpaidAskOffsetHistory(result)).toMatchObject({ unpaidAskBilledOffsetUnsureCents: 2_000, reissuedAskInvoiceUnsureCents: 3_000 });
  });

  it("a cancelled ask has no re-issue to invoice; with no issued primary invoice nothing was billed either", async () => {
    state.parkedInvoices = [parkedSupplementary(5_000)];
    const cancelled = await adjust(grownBooking({ xeroInvoiceId: "INV-3954" }), -5_000);
    expect([cancelled.reissuedAskInvoiceCents, cancelled.unpaidAskBilledOffsetCents]).toEqual([0, 0]);

    state.parkedInvoices = [];
    const noInvoice = await adjust(grownBooking(), -2_000);
    expect([noInvoice.reissuedAskInvoiceCents, noInvoice.unpaidAskBilledOffsetCents]).toEqual([0, 0]);
  });
});
