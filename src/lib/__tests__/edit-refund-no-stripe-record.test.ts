import { PaymentSource, PaymentStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { editDoorBooking, type EditDoorBookingOverrides } from "./support/edit-door-booking";

import type { CalendarDate } from "@/lib/club-time";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/*
  #5212 (`INV-PAY-160`, owner decision of 18 Nov 2026): an edit that lowers the
  price of a card-paid booking Stripe holds no record of sends the refund to
  the treasurer, as an Internet Banking payment's goes, and promises the card
  nothing. These pin the one read both the settlement and the debt's writer
  answer from, and the settlement's gate. Each door, its journal and its debt
  row are proved on PostgreSQL in `modification-refund-prepersist.realdb.test.ts`.
*/

// No capture here is disputed; the edit's hold is proved in
// `stripe-dispute-edit.realdb.test.ts`.
vi.mock("@/lib/stripe-dispute-hold", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/stripe-dispute-hold")),
  paymentDisputedCaptureCents: async () => ({ cents: 0, disputes: [] }),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/member-credit", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  deriveBookingAppliedCreditCents: vi.fn(async () => 0),
}));
vi.mock("@/lib/cancellation", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  loadCancellationPolicy: vi.fn(async () => [{ daysBeforeStay: 0, refundPercentage: 100, fixedFeeCents: 0 }]),
}));

const { applyPaymentAdjustments } = await import("@/lib/booking-modify-settlement");
const { calculateFullReductionSettlementOptions, calculateModificationSettlementOptions, editRefundHasCardToReturnTo, fullReductionLockedReads } = await import("@/lib/booking-modify-settlement-options");
const { noReductionAgainstUnpaidAsk } = await import("@/lib/additional-ask-reduction");
const { editRefundBankTransferPayee, editRefundGoesBackByHand } = await import("@/lib/edit-refund-hand-back");
const { paymentHasRefundableCardIntent, readRefundableCardIntentId } = await import("@/lib/refundable-card-intent");
const { editRefundHandBackReason } = await import("@/lib/manual-refund-task-copy");
const { bookingModifiedRefundSentence } = await import("@/lib/booking-modified-email-copy");

const TODAY = "2026-07-01" as CalendarDate;

type LedgerRow = { source: PaymentSource; stripePaymentIntentId: string | null; status: PaymentStatus };

/** What Stripe-facing rows the database holds for the payment. */
const stored = vi.hoisted(() => ({ paymentIntentId: null as string | null, transactions: [] as unknown[] }));
const paymentFindUnique = vi.fn(async () => ({
  id: "payment_1",
  stripePaymentIntentId: stored.paymentIntentId,
  transactions: stored.transactions as LedgerRow[],
}));
const tx = {
  // #3980: an edit that read no invoice link claims the payment row.
  payment: { update: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })), findUnique: paymentFindUnique },
  manualRefundTask: { aggregate: vi.fn(async () => ({ _sum: { amountCents: null } })) },
  paymentRecoveryOperation: { findMany: vi.fn(async () => []) },
} as unknown as Parameters<typeof applyPaymentAdjustments>[0];

/** $200 paid by card, in full. */
function cardPaidBooking(payment: NonNullable<EditDoorBookingOverrides["payment"]> = {}, overrides: EditDoorBookingOverrides = {}) {
  return editDoorBooking({
    id: "booking_5212",
    status: "PAID",
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    lodgeId: "lodge_1",
    finalPriceCents: 20_000,
    payment: {
      id: "payment_1",
      status: PaymentStatus.SUCCEEDED,
      source: PaymentSource.STRIPE,
      amountCents: 20_000,
      refundedAmountCents: 0,
      creditAppliedCents: 0,
      changeFeeCents: 0,
      additionalAmountCents: 0,
      additionalPaymentStatus: null,
      stripePaymentIntentId: null,
      ...payment,
    },
    ...overrides,
  });
}

const adjust = (booking: ReturnType<typeof cardPaidBooking>, priceDiffCents: number) =>
  applyPaymentAdjustments(tx, {
    reduction: noReductionAgainstUnpaidAsk(priceDiffCents),
    booking,
    priceDiffCents,
    changeFeeCents: 0,
    todayAtClub: TODAY,
    format: CLUB_FORMAT_TEST,
  });

beforeEach(() => {
  vi.clearAllMocks();
  stored.paymentIntentId = null;
  stored.transactions = [];
});

describe("the intent a card refund is owed against", () => {
  const captured = (intent: string | null, source: PaymentSource = PaymentSource.STRIPE): LedgerRow => ({
    source,
    stripePaymentIntentId: intent,
    status: PaymentStatus.SUCCEEDED,
  });

  it("is the newest captured Stripe charge's, else the payment's own, else none", async () => {
    stored.paymentIntentId = "pi_payment";
    stored.transactions = [captured("pi_newest"), captured("pi_older")];
    expect(await readRefundableCardIntentId(tx, "payment_1")).toBe("pi_newest");

    stored.transactions = [];
    expect(await readRefundableCardIntentId(tx, "payment_1")).toBe("pi_payment");

    stored.paymentIntentId = null;
    expect(await readRefundableCardIntentId(tx, "payment_1")).toBeNull();
  });

  it("never a charge that was not captured, was not Stripe's, or names no intent", async () => {
    stored.transactions = [
      { ...captured("pi_pending"), status: PaymentStatus.PENDING },
      captured("pi_bank", PaymentSource.INTERNET_BANKING),
      captured(null),
    ];
    expect(await readRefundableCardIntentId(tx, "payment_1")).toBeNull();
  });

  it("is none for a payment that is not there", async () => {
    paymentFindUnique.mockResolvedValueOnce(null as never);
    expect(await readRefundableCardIntentId(tx, "missing")).toBeNull();
  });

  it("a payment row that names its own intent answers without a read", async () => {
    expect(await paymentHasRefundableCardIntent(tx, { id: "payment_1", stripePaymentIntentId: "pi_payment" })).toBe(true);
    expect(paymentFindUnique).not.toHaveBeenCalled();
  });

  it.each<[string, LedgerRow[]]>([
    ["no ledger rows", []],
    ["a PENDING charge", [{ ...captured("pi_pending"), status: PaymentStatus.PENDING }]],
    ["a captured Internet Banking payment", [captured("pi_bank", PaymentSource.INTERNET_BANKING)]],
    ["a captured charge naming no intent", [captured(null)]],
    ["a captured charge naming an intent", [captured("pi_capture")]],
  ])("MUTATION: a payment naming its own intent, with %s, gets the same answer from both", async (_ledger, transactions) => {
    // #5303: the shortcut answers true without reading, so the read must too.
    // Tighten `readRefundableCardIntentId` to a captured charge only and every
    // ledger without one goes red: the edit would promise the card a refund
    // the debt's writer then refuses (`NoRefundPaymentIntentError`).
    stored.paymentIntentId = "pi_payment";
    stored.transactions = transactions;

    const shortcut = await paymentHasRefundableCardIntent(tx, { id: "payment_1", stripePaymentIntentId: "pi_payment" });
    const read = await readRefundableCardIntentId(tx, "payment_1");

    expect(shortcut).toBe(true);
    expect(read !== null).toBe(shortcut);
  });

  it("a payment row without one is answered by its captured charges", async () => {
    expect(await paymentHasRefundableCardIntent(tx, { id: "payment_1", stripePaymentIntentId: null })).toBe(false);
    stored.transactions = [captured("pi_capture")];
    expect(await paymentHasRefundableCardIntent(tx, { id: "payment_1", stripePaymentIntentId: null })).toBe(true);
  });
});

describe("whether an edit's reduction has a card to go back to", () => {
  it("no payment row: no", async () => {
    expect(await editRefundHasCardToReturnTo(tx, { payment: null, organiserSettled: false, parentBookingId: null })).toBe(false);
  });

  it("a joiner the organiser paid for by card: yes, without asking after the joiner's own mirror", async () => {
    const child = cardPaidBooking({}, { organiserSettled: true, parentBookingId: "organiser_booking" });
    expect(await editRefundHasCardToReturnTo(tx, child)).toBe(true);
    expect(paymentFindUnique).not.toHaveBeenCalled();
  });
});

describe("what the edit quote names as the money-back route", () => {
  // #5303: the quote's label is the settlement's own answer, so it never
  // promises the card a refund the save sends to the treasurer.
  const quoteOptions = (booking: ReturnType<typeof cardPaidBooking>) =>
    calculateModificationSettlementOptions({
      booking,
      netChargeCents: -5_000,
      reduction: noReductionAgainstUnpaidAsk(-5_000),
      db: tx as never,
      todayAtClub: TODAY,
    });

  it("a card payment Stripe holds no record of: a bank transfer, as the save sends it", async () => {
    const booking = cardPaidBooking();
    expect(await quoteOptions(booking)).toMatchObject({ requiresSettlementMethod: true, refundByBankTransfer: true });
    expect(editRefundGoesBackByHand(await adjust(booking, -5_000))).toBe(true);
  });

  it("an Internet Banking payment: a bank transfer, with no read of Stripe's record", async () => {
    // Even one carrying a stale intent: there is no card to return to.
    const booking = cardPaidBooking({ source: PaymentSource.INTERNET_BANKING, stripePaymentIntentId: "pi_stale" });
    expect(await quoteOptions(booking)).toMatchObject({ requiresSettlementMethod: true, refundByBankTransfer: true });
    expect(await editRefundHasCardToReturnTo(tx, booking)).toBe(false);
    expect(paymentFindUnique).not.toHaveBeenCalled();
  });

  it("control: a card payment naming its intent is still the card's", async () => {
    const booking = cardPaidBooking({ stripePaymentIntentId: "pi_payment" });
    expect(await quoteOptions(booking)).toMatchObject({ requiresSettlementMethod: true, refundByBankTransfer: false });
    expect(editRefundGoesBackByHand(await adjust(booking, -5_000))).toBe(false);
  });

  it.each([
    ["a card payment Stripe holds no record of", cardPaidBooking(), true],
    ["an Internet Banking payment", cardPaidBooking({ source: PaymentSource.INTERNET_BANKING, stripePaymentIntentId: "pi_stale" }), true],
    ["control: a card payment naming its intent", cardPaidBooking({ stripePaymentIntentId: "pi_payment" }), false],
  ] as const)("the full-reduction options (batch edit, guest acceptance) answer the same for %s", async (_case, booking, bankTransfer) => {
    const options = calculateFullReductionSettlementOptions({
      booking,
      netChargeCents: -5_000,
      refundableCashCents: 20_000,
      todayAtClub: TODAY,
      ...(await fullReductionLockedReads(tx as never, booking)),
    });
    expect(options).toMatchObject({ requiresSettlementMethod: true, refundByBankTransfer: bankTransfer });
  });
});

describe("a card-paid booking's $50 reduction", () => {
  it("MUTATION: with no Stripe record, promises the card nothing and is the treasurer's to send back", async () => {
    // Drop `editRefundHasCardToReturnTo` from `hasSucceededPayment` and this
    // owes the card $50 that no debt row can ever stand behind.
    const result = await adjust(cardPaidBooking(), -5_000);

    expect(result.hasSucceededPayment).toBe(false);
    expect(result.pendingRefundAmountCents).toBe(0);
    expect(result.refundAmountCents).toBe(5_000);
    expect(result.accountCreditAmountCents).toBe(0);
    expect(editRefundGoesBackByHand(result)).toBe(true);
    expect(editRefundBankTransferPayee(result, cardPaidBooking())).toBe("member");
  });

  it("with the payment's own intent, is the card's as before", async () => {
    const result = await adjust(cardPaidBooking({ stripePaymentIntentId: "pi_payment" }), -5_000);

    expect(result.hasSucceededPayment).toBe(true);
    expect(result.pendingRefundAmountCents).toBe(5_000);
    expect(result.refundAmountCents).toBe(5_000);
    expect(editRefundGoesBackByHand(result)).toBe(false);
  });

  it("with an intent only on a captured charge, is the card's too - the debt's writer would find it", async () => {
    stored.transactions = [{ source: PaymentSource.STRIPE, stripePaymentIntentId: "pi_capture", status: PaymentStatus.SUCCEEDED }];
    const result = await adjust(cardPaidBooking(), -5_000);

    expect(result.hasSucceededPayment).toBe(true);
    expect(result.pendingRefundAmountCents).toBe(5_000);
    expect(editRefundGoesBackByHand(result)).toBe(false);
  });
});

describe("a card-paid booking's $50 increase", () => {
  it("is unchanged by a missing Stripe record: the read is a reduction's alone", async () => {
    const result = await adjust(cardPaidBooking(), 5_000);

    expect(result.hasSucceededPayment).toBe(true);
    expect(result.additionalAmountCents).toBe(5_000);
    expect(paymentFindUnique).not.toHaveBeenCalled();
  });
});

describe("what the treasurer and the member are told", () => {
  it("the task's reason names a card payment with no Stripe record among the by-hand payments", () => {
    const reason = editRefundHandBackReason({ bookingId: "booking_5212", editLabel: "date change", payee: "member" });
    expect(reason).toContain("or by a card payment with no Stripe record");
    expect(reason).toContain("bank transfer");
  });

  it("the member's email promises a bank transfer, never a refund to the card", () => {
    const sentence = bookingModifiedRefundSentence("$50.00", "member", "own");
    expect(sentence).toBe("The club will refund $50.00 to you by bank transfer.");
    expect(sentence).not.toContain("original payment method");
  });
});
