/**
 * #3827, owner decision D-3813-5 (#3492): when a guest's acceptance lowers a
 * paid booking, the FULL reduction goes back — no cancellation-policy tier —
 * the way the booking was paid, and nobody is asked to choose. A code's free
 * nights are used up only for what is actually returned.
 *
 * The pricing engine and the write-side helpers are stubbed: what is under test
 * is the decision `repriceBookingAfterGuestAcceptance` makes about the money,
 * through the REAL `applyPaymentAdjustments` and the real full-reduction
 * settlement options, and what its after-commit half sends.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  priceStoredBookingPromotions: vi.fn(),
  persistRepricedPromotions: vi.fn(),
  applyLifecycleTransitions: vi.fn(),
  deriveBookingAppliedCreditCents: vi.fn(),
  clampAppliedCreditToBookingPrice: vi.fn(),
  lockMemberCreditLedger: vi.fn(),
  loadCancellationPolicy: vi.fn(),
  executeBookingModificationRefund: vi.fn(),
  queueXeroBookingEditSettlement: vi.fn(),
  sendBookingModifiedEmail: vi.fn(),
  logAudit: vi.fn(),
  giveBackPaidReductionCredit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/booking-promotions", () => ({
  priceStoredBookingPromotions: h.priceStoredBookingPromotions,
  persistRepricedPromotions: h.persistRepricedPromotions,
}));
vi.mock("@/lib/booking-modify", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/booking-modify")),
  applyLifecycleTransitions: h.applyLifecycleTransitions,
  isQuotePricedBooking: vi.fn(async () => false),
}));
// D-3813-5: no policy tier. Reading the cancellation policy at all is a failure.
vi.mock("@/lib/cancellation", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/cancellation")),
  loadCancellationPolicy: h.loadCancellationPolicy,
}));
vi.mock("@/lib/edit-financial-review", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/edit-financial-review")),
  assertNoPendingEditFinancialReview: vi.fn(async () => undefined),
}));
vi.mock("@/lib/night-adjustment-write", () => ({ recordBookingNightAdjustments: vi.fn() }));
vi.mock("@/lib/booking-ledger-modification-sync", () => ({ postModificationLedgerLines: vi.fn() }));
vi.mock("@/lib/booking-modification-pricing", () => ({
  computeModificationPricing: vi.fn(async () => ({ priceLines: null, sides: null })),
}));
vi.mock("@/lib/member-credit", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/member-credit")),
  deriveBookingAppliedCreditCents: h.deriveBookingAppliedCreditCents,
  clampAppliedCreditToBookingPrice: h.clampAppliedCreditToBookingPrice,
  lockMemberCreditLedger: h.lockMemberCreditLedger,
}));
vi.mock("@/lib/booking-modification-settlement", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/booking-modification-settlement")),
  executeBookingModificationRefund: h.executeBookingModificationRefund,
  drainSupersededPrimaryIntents: vi.fn(),
}));
vi.mock("@/lib/xero-booking-edit-settlement", () => ({
  queueXeroBookingEditSettlement: h.queueXeroBookingEditSettlement,
}));
vi.mock("@/lib/email/booking", () => ({ sendBookingModifiedEmail: h.sendBookingModifiedEmail }));
vi.mock("@/lib/audit", () => ({ logAudit: h.logAudit }));
// #3829: #3809's tiered give-back, observed but still real unless a test says otherwise.
vi.mock("@/lib/booking-modify-credit-give-back", async (importOriginal) => {
  const original = (await importOriginal()) as typeof import("@/lib/booking-modify-credit-give-back");
  h.giveBackPaidReductionCredit.mockImplementation(original.giveBackPaidReductionCredit);
  return { ...original, giveBackPaidReductionCredit: h.giveBackPaidReductionCredit };
});
vi.mock("@/lib/booking-modification-lines", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/booking-modification-lines")),
  loadModificationLinesAuditFields: vi.fn(async () => ({})),
}));

import {
  repriceBookingAfterGuestAcceptance,
  settleGuestAcceptanceRepriceAfterCommit,
} from "@/lib/booking-guest-acceptance-reprice";
import { applyPaymentAdjustments } from "@/lib/booking-modify-settlement";
import { requireCalendarDate } from "@/lib/club-time";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const TODAY = requireCalendarDate("2026-07-01");
const N1 = new Date("2026-08-01T00:00:00.000Z");
const N2 = new Date("2026-08-02T00:00:00.000Z");

/** Ann (two $100 nights) and Cara, who just accepted (two $60 nights): $320. */
function booking(overrides: Record<string, unknown> = {}) {
  const night = (stayDate: Date, priceCents: number) => ({ stayDate, priceCents, priceSource: "SOLD" });
  return {
    id: "booking-1",
    status: "PAID",
    deletedAt: null,
    lodgeId: "lodge-1",
    checkIn: N1,
    checkOut: new Date("2026-08-03T00:00:00.000Z"),
    totalPriceCents: 32000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 32000,
    nonMemberHoldUntil: null,
    memberId: "ann",
    member: { id: "ann", email: "ann@example.test", firstName: "Ann", lastName: "Owner" },
    organisation: null,
    guests: [
      { id: "g-ann", memberId: "ann", isMember: true, consentStatus: null, priceCents: 20000, nights: [night(N1, 10000), night(N2, 10000)] },
      { id: "g-cara", memberId: "cara", isMember: true, consentStatus: "CONFIRMED", priceCents: 12000, nights: [night(N1, 6000), night(N2, 6000)] },
    ],
    payment: {
      id: "pay-1",
      source: "STRIPE",
      status: "SUCCEEDED",
      amountCents: 32000,
      refundedAmountCents: 0,
      creditAppliedCents: 0,
      xeroInvoiceId: null,
    },
    promoRedemptions: [
      { id: "r1", promoCodeId: "p1", applicationOrder: 0, promoCode: { id: "p1", code: "CARA" }, guestTargets: [] },
    ],
    ...overrides,
  };
}

function tx(loaded: ReturnType<typeof booking>) {
  return {
    booking: {
      findUnique: vi.fn(async () => loaded),
      update: vi.fn(async () => loaded),
    },
    bookingModification: { create: vi.fn(async () => ({ id: "mod-1" })) },
    payment: { update: vi.fn() },
    manualRefundTask: { aggregate: vi.fn(async () => ({ _sum: { amountCents: null } })), createMany: vi.fn(async () => ({ count: 1 })) },
  };
}

/** The engine's answer: Cara's code now takes $60 off. */
function decides(priceAdjustmentCents: number) {
  h.priceStoredBookingPromotions.mockResolvedValue({ params: {}, priced: { priceAdjustmentCents } });
  h.persistRepricedPromotions.mockResolvedValue({
    newDiscountCents: Math.max(0, -priceAdjustmentCents),
    newPromoAdjustmentCents: priceAdjustmentCents,
    promoRemoved: false,
    releasedPromoCodes: [],
    promoCoverage: null,
    adjustmentTargets: [],
    remainingPromoCodeLabel: "CARA",
  });
}

async function accept(loaded: ReturnType<typeof booking>) {
  return repriceBookingAfterGuestAcceptance(tx(loaded) as never, {
    bookingId: "booking-1",
    acceptedGuestId: "g-cara",
    actorMemberId: "cara",
    todayAtClub: TODAY,
    format: CLUB_FORMAT_TEST,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.loadCancellationPolicy.mockRejectedValue(new Error("D-3813-5: no cancellation-policy tier applies"));
  h.applyLifecycleTransitions.mockImplementation(async (_tx: unknown, args: { booking: { status: string } }) => ({
    hasNonMembers: false,
    newNonMemberHoldUntil: null,
    newStatus: args.booking.status,
    zeroDollarAutoPaid: false,
    supersededPrimaryPaymentIntents: [],
    appliedCreditCents: 0,
    refundedExcessCreditCents: 0,
    clearDraftExpiresAt: false,
  }));
  h.deriveBookingAppliedCreditCents.mockResolvedValue(0);
  decides(-6000);
});

describe("the full reduction goes back the way it was paid (D-3813-5)", () => {
  it("a card payment: the whole $60 refunded to the card, nothing kept under a policy", async () => {
    const result = await accept(booking());
    expect(result).toMatchObject({
      repriced: true,
      priceDiffCents: -6000,
      refundAmountCents: 6000,
      pendingRefundAmountCents: 6000,
      accountCreditAmountCents: 0,
      settlementMethod: "card",
      hasSucceededPayment: true,
    });
    expect(h.loadCancellationPolicy).not.toHaveBeenCalled();
    expect(h.clampAppliedCreditToBookingPrice).not.toHaveBeenCalled();
  });

  it("internet banking: the whole $60 goes back by the bank-transfer refund, not to a card", async () => {
    const result = await accept(
      booking({
        payment: { ...booking().payment, source: "INTERNET_BANKING", xeroInvoiceId: "inv-1" },
      }),
    );
    expect(result).toMatchObject({
      repriced: true,
      refundAmountCents: 6000,
      // No Stripe refund: the club returns the money itself.
      pendingRefundAmountCents: 0,
      hasSucceededPayment: false,
      settlementMethod: "card",
      xeroRefundAmountCents: 6000,
    });
  });

  it("account credit: the whole $60 goes back as credit, the applied credit netted down", async () => {
    h.deriveBookingAppliedCreditCents.mockResolvedValue(32000);
    h.clampAppliedCreditToBookingPrice.mockResolvedValue({ appliedCreditCents: 26000, refundedExcessCents: 6000 });
    const loaded = booking({ payment: { ...booking().payment, amountCents: 0, creditAppliedCents: 32000 } });
    const client = tx(loaded);
    const result = await repriceBookingAfterGuestAcceptance(client as never, {
      bookingId: "booking-1",
      acceptedGuestId: "g-cara",
      actorMemberId: "cara",
      todayAtClub: TODAY,
      format: CLUB_FORMAT_TEST,
    });
    expect(result).toMatchObject({
      repriced: true,
      refundAmountCents: 0,
      accountCreditAmountCents: 6000,
      creditReturnedAsApplied: true,
    });
    // Read under the member's ledger lock, then returned by the edit's own clamp.
    expect(h.lockMemberCreditLedger).toHaveBeenCalledWith("ann", expect.anything());
    expect(h.clampAppliedCreditToBookingPrice).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: "ann", bookingId: "booking-1", newWorthCents: 26000 }),
      expect.anything(),
    );
    // The payment's mirror follows the ledger (INV-PAY-024).
    expect(client.payment.update).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      data: { creditAppliedCents: 26000 },
    });
  });

  it("an organisation is refunded the way it paid, never refused for having no credit account", async () => {
    const result = await accept(
      booking({
        memberId: null,
        member: null,
        organisation: { name: "Tokoroa High", email: "office@example.test" },
        payment: { ...booking().payment, source: "INTERNET_BANKING", xeroInvoiceId: "inv-1" },
      }),
    );
    expect(result).toMatchObject({ repriced: true, refundAmountCents: 6000, accountCreditAmountCents: 0 });
  });

  it("a booking not yet paid simply costs less: nothing to return", async () => {
    const result = await accept(
      booking({ status: "PAYMENT_PENDING", payment: { ...booking().payment, status: "PENDING" } }),
    );
    expect(result).toMatchObject({ repriced: true, priceDiffCents: -6000, refundAmountCents: 0, accountCreditAmountCents: 0 });
  });
});

describe("free nights are used only for what is returned", () => {
  it("a card payment with less left to refund than the reduction is not re-priced at all", async () => {
    // $300 of the $320 was already refunded by an earlier change.
    const result = await accept(booking({ payment: { ...booking().payment, refundedAmountCents: 30000 } }));
    expect(result).toEqual({ repriced: false, reason: "REDUCTION_NOT_FULLY_RETURNABLE" });
    expect(h.persistRepricedPromotions).not.toHaveBeenCalled();
  });

  it("a booking with no captured cash not paid wholly with credit is not re-priced", async () => {
    h.deriveBookingAppliedCreditCents.mockResolvedValue(2000);
    const result = await accept(
      booking({ payment: { ...booking().payment, amountCents: 0, creditAppliedCents: 2000 } }),
    );
    expect(result).toEqual({ repriced: false, reason: "REDUCTION_NOT_FULLY_RETURNABLE" });
    expect(h.persistRepricedPromotions).not.toHaveBeenCalled();
  });
});

describe("a settled booking's price is never raised by an acceptance (A3)", () => {
  it.each([
    ["captured cash", {}],
    ["paid with credit", { payment: { ...booking().payment, amountCents: 0, creditAppliedCents: 32000 } }],
    ["settled at $0", { payment: { ...booking().payment, amountCents: 0 }, finalPriceCents: 0 }],
  ])("%s", async (_label, overrides) => {
    decides(2000);
    const result = await accept(booking(overrides));
    expect(result).toEqual({ repriced: false, reason: "INCREASE_NEEDS_COLLECTION" });
    expect(h.persistRepricedPromotions).not.toHaveBeenCalled();
  });
});

describe("only the member edit door for a stay yet to start re-prices (A4)", () => {
  it.each([["AWAITING_REVIEW"], ["WAITLISTED"], ["WAITLIST_OFFERED"]])("%s is left alone", async (status) => {
    expect(await accept(booking({ status }))).toEqual({ repriced: false, reason: "BOOKING_STATUS" });
  });

  it("a stay that has started is left alone", async () => {
    expect(await accept(booking({ checkIn: new Date("2026-07-01T00:00:00.000Z") }))).toEqual({
      repriced: false,
      reason: "BOOKING_STATUS",
    });
  });
});

describe("after commit: the card refund, the Xero correction, the email and the audit row (A2)", () => {
  it("does what an ordinary edit's reduction does", async () => {
    const reprice = await accept(booking());
    if (!reprice.repriced) throw new Error("expected a re-price");
    h.executeBookingModificationRefund.mockResolvedValue("re_1");
    h.sendBookingModifiedEmail.mockResolvedValue(undefined);

    await settleGuestAcceptanceRepriceAfterCommit({
      bookingId: "booking-1",
      actorMemberId: "cara",
      reprice,
      format: CLUB_FORMAT_TEST,
    });

    expect(h.executeBookingModificationRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        result: expect.objectContaining({ pendingRefundAmountCents: 6000, paymentId: "pay-1", bookingModificationId: "mod-1" }),
      }),
    );
    expect(h.queueXeroBookingEditSettlement).toHaveBeenCalledWith(
      expect.objectContaining({ settlementAmountCents: 0, settlementMethod: "card", refundedThroughStripe: true }),
    );
    expect(h.sendBookingModifiedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientMemberId: "ann",
        email: "ann@example.test",
        oldFinalPriceCents: 32000,
        newFinalPriceCents: 26000,
        refundAmountCents: 6000,
        accountCreditAmountCents: 0,
      }),
      CLUB_FORMAT_TEST,
    );
    expect(h.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.modify.promo_reprice",
        category: "booking",
        entityId: "mod-1",
        subjectMemberId: "ann",
      }),
    );
  });
});

describe("a credit return is worded as account credit in Xero", () => {
  it("never as a bank refund", async () => {
    h.deriveBookingAppliedCreditCents.mockResolvedValue(32000);
    h.clampAppliedCreditToBookingPrice.mockResolvedValue({ appliedCreditCents: 26000, refundedExcessCents: 6000 });
    const reprice = await accept(
      booking({ payment: { ...booking().payment, amountCents: 0, creditAppliedCents: 32000, xeroInvoiceId: "inv-1" } }),
    );
    if (!reprice.repriced) throw new Error("expected a re-price");
    h.sendBookingModifiedEmail.mockResolvedValue(undefined);
    await settleGuestAcceptanceRepriceAfterCommit({
      bookingId: "booking-1",
      actorMemberId: "cara",
      reprice,
      format: CLUB_FORMAT_TEST,
    });
    expect(h.queueXeroBookingEditSettlement).toHaveBeenCalledWith(
      expect.objectContaining({ refundMethod: "account-credit", settlementAmountCents: 6000 }),
    );
    expect(h.sendBookingModifiedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ refundAmountCents: 0, accountCreditAmountCents: 6000 }),
      CLUB_FORMAT_TEST,
    );
  });
});

describe("an internet-banking reduction asks the treasurer to send it back (D-3813-6, INV-PAY-117)", () => {
  it("raises exactly one officer refund task for the modification, and the email promises a bank transfer", async () => {
    const loaded = booking({
      payment: { ...booking().payment, source: "INTERNET_BANKING", xeroInvoiceId: "inv-1" },
    });
    const client = tx(loaded);
    const reprice = await repriceBookingAfterGuestAcceptance(client as never, {
      bookingId: "booking-1",
      acceptedGuestId: "g-cara",
      actorMemberId: "cara",
      todayAtClub: TODAY,
      format: CLUB_FORMAT_TEST,
    });
    expect(client.manualRefundTask.createMany).toHaveBeenCalledTimes(1);
    expect(client.manualRefundTask.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          bookingId: "booking-1",
          paymentId: "pay-1",
          amountCents: 6000,
          kind: "CANCELLED_BOOKING_HAND_BACK",
          occurrenceKey: "edit-refund-hand-back:mod-1",
        }),
      ],
      skipDuplicates: true,
    });
    if (!reprice.repriced) throw new Error("expected a re-price");
    h.sendBookingModifiedEmail.mockResolvedValue(undefined);
    await settleGuestAcceptanceRepriceAfterCommit({ bookingId: "booking-1", actorMemberId: "cara", reprice, format: CLUB_FORMAT_TEST });
    expect(h.sendBookingModifiedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ refundAmountCents: 6000, refundByBankTransfer: true }),
      CLUB_FORMAT_TEST,
    );
  });

  it("a card reduction raises no task and keeps the card wording", async () => {
    const client = tx(booking());
    const reprice = await repriceBookingAfterGuestAcceptance(client as never, {
      bookingId: "booking-1",
      acceptedGuestId: "g-cara",
      actorMemberId: "cara",
      todayAtClub: TODAY,
      format: CLUB_FORMAT_TEST,
    });
    expect(client.manualRefundTask.createMany).not.toHaveBeenCalled();
    if (!reprice.repriced) throw new Error("expected a re-price");
    h.sendBookingModifiedEmail.mockResolvedValue(undefined);
    await settleGuestAcceptanceRepriceAfterCommit({ bookingId: "booking-1", actorMemberId: "cara", reprice, format: CLUB_FORMAT_TEST });
    expect(h.sendBookingModifiedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ refundByBankTransfer: false }),
      CLUB_FORMAT_TEST,
    );
  });
});

describe("a split payment gets the WHOLE reduction back: cash first, then credit (D-3813-5)", () => {
  async function acceptSplit(payment: Record<string, unknown>, appliedCreditCents: number) {
    h.deriveBookingAppliedCreditCents.mockResolvedValue(appliedCreditCents);
    h.clampAppliedCreditToBookingPrice.mockResolvedValue({ appliedCreditCents: 26000, refundedExcessCents: 4000 });
    const client = tx(booking({ payment: { ...booking().payment, ...payment } }));
    const result = await repriceBookingAfterGuestAcceptance(client as never, {
      bookingId: "booking-1",
      acceptedGuestId: "g-cara",
      actorMemberId: "cara",
      todayAtClub: TODAY,
      format: CLUB_FORMAT_TEST,
    });
    return { result, client };
  }

  it("card + credit: $20 back to the card, $40 back as credit", async () => {
    // $20 on the card, $300 of credit: the $60 reduction is more than the card holds.
    const { result, client } = await acceptSplit({ amountCents: 2000, creditAppliedCents: 30000 }, 30000);
    expect(result).toMatchObject({
      repriced: true,
      refundAmountCents: 2000,
      pendingRefundAmountCents: 2000,
      accountCreditAmountCents: 4000,
      settlementMethod: "card",
      creditReturnedAsApplied: false,
    });
    expect(h.lockMemberCreditLedger).toHaveBeenCalledWith("ann", expect.anything());
    expect(h.clampAppliedCreditToBookingPrice).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: "ann", newWorthCents: 26000 }),
      expect.anything(),
    );
    expect(client.payment.update).toHaveBeenCalledWith({ where: { id: "pay-1" }, data: { creditAppliedCents: 26000 } });
    expect(client.manualRefundTask.createMany).not.toHaveBeenCalled();
    expect(h.persistRepricedPromotions).toHaveBeenCalled();
  });

  it("internet banking + credit: the treasurer sends $20 back, $40 goes back as credit", async () => {
    const { result, client } = await acceptSplit(
      { source: "INTERNET_BANKING", xeroInvoiceId: "inv-1", amountCents: 2000, creditAppliedCents: 30000 },
      30000,
    );
    expect(result).toMatchObject({
      repriced: true,
      refundAmountCents: 2000,
      pendingRefundAmountCents: 0,
      accountCreditAmountCents: 4000,
    });
    expect(client.manualRefundTask.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ amountCents: 2000, occurrenceKey: "edit-refund-hand-back:mod-1" })],
      skipDuplicates: true,
    });
  });

  it("a partly refunded card + credit: what is left on the card, then credit", async () => {
    // $100 on the card, $80 already refunded by an earlier change: $20 left.
    const { result } = await acceptSplit({ amountCents: 10000, refundedAmountCents: 8000, creditAppliedCents: 30000 }, 30000);
    expect(result).toMatchObject({ repriced: true, refundAmountCents: 2000, accountCreditAmountCents: 4000 });
  });

  it("#3955 round 3: a change fee the card already paid keeps no credit back — the credit is netted to the PRICE", async () => {
    // $20 on the card plus $300 of credit pay the $320 price; an earlier edit's
    // $15 change fee was paid by an additional card charge and is recorded on
    // the payment. The credit pays none of that fee, so the clamp nets it to
    // the new price: the whole $40 credit share comes back.
    h.deriveBookingAppliedCreditCents.mockResolvedValue(30000);
    h.clampAppliedCreditToBookingPrice.mockImplementation(
      async ({ newWorthCents }: { newWorthCents: number }) => ({
        appliedCreditCents: newWorthCents,
        refundedExcessCents: 30000 - newWorthCents,
      }),
    );
    const client = tx(
      booking({
        payment: {
          ...booking().payment,
          amountCents: 2000,
          additionalAmountCents: 1500,
          changeFeeCents: 1500,
          creditAppliedCents: 30000,
        },
      }),
    );
    const result = await repriceBookingAfterGuestAcceptance(client as never, {
      bookingId: "booking-1",
      acceptedGuestId: "g-cara",
      actorMemberId: "cara",
      todayAtClub: TODAY,
      format: CLUB_FORMAT_TEST,
    });
    expect(result).toMatchObject({ repriced: true, refundAmountCents: 2000, accountCreditAmountCents: 4000 });
    expect(h.clampAppliedCreditToBookingPrice).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: "ann", newWorthCents: 26000 }),
      expect.anything(),
    );
  });

  it("is refused, moving no code, when the cash left and the credit do not make up the price", async () => {
    const { result } = await acceptSplit({ amountCents: 2000, creditAppliedCents: 20000 }, 20000);
    expect(result).toEqual({ repriced: false, reason: "REDUCTION_NOT_FULLY_RETURNABLE" });
    expect(h.persistRepricedPromotions).not.toHaveBeenCalled();
    expect(h.clampAppliedCreditToBookingPrice).not.toHaveBeenCalled();
  });
});

describe("cash an earlier edit already promised back is not refunded again (#3827, INV-PAY-117)", () => {
  it("$300 paid as $200 internet banking + $100 credit, edited to $250 (task $50 open), accepted to $50: $150 by hand, $50 as credit", async () => {
    // Without the netting the $200 captured would read as all refundable, the
    // whole $200 reduction would go to a second task, and $250 of tasks would
    // stand against $200 taken.
    decides(-20000);
    h.deriveBookingAppliedCreditCents.mockResolvedValue(10000);
    h.clampAppliedCreditToBookingPrice.mockResolvedValue({ appliedCreditCents: 5000, refundedExcessCents: 5000 });
    const night = (stayDate: Date, priceCents: number) => ({ stayDate, priceCents, priceSource: "SOLD" });
    const loaded = booking({
      totalPriceCents: 25000,
      finalPriceCents: 25000,
      guests: [
        { id: "g-ann", memberId: "ann", isMember: true, consentStatus: null, priceCents: 20000, nights: [night(N1, 10000), night(N2, 10000)] },
        { id: "g-cara", memberId: "cara", isMember: true, consentStatus: "CONFIRMED", priceCents: 5000, nights: [night(N1, 2500), night(N2, 2500)] },
      ],
      payment: {
        ...booking().payment,
        source: "INTERNET_BANKING",
        xeroInvoiceId: "inv-1",
        amountCents: 20000,
        creditAppliedCents: 10000,
      },
    });
    const client = tx(loaded);
    client.manualRefundTask.aggregate.mockResolvedValue({ _sum: { amountCents: 5000 } } as never);
    const result = await repriceBookingAfterGuestAcceptance(client as never, {
      bookingId: "booking-1",
      acceptedGuestId: "g-cara",
      actorMemberId: "cara",
      todayAtClub: TODAY,
      format: CLUB_FORMAT_TEST,
    });
    expect(client.manualRefundTask.aggregate).toHaveBeenCalledWith({
      where: expect.objectContaining({
        paymentId: "pay-1",
        status: "OPEN",
        kind: "CANCELLED_BOOKING_HAND_BACK",
        OR: [
          { occurrenceKey: { startsWith: "edit-refund-hand-back:" } },
          { occurrenceKey: { startsWith: "refund-request-hand-back:" } },
          { occurrenceKey: { startsWith: "card-refund-paid-another-way:" } },
        ],
      }),
      _sum: { amountCents: true },
    });
    expect(result).toMatchObject({ repriced: true, refundAmountCents: 15000, accountCreditAmountCents: 5000 });
    expect(client.manualRefundTask.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ amountCents: 15000, occurrenceKey: "edit-refund-hand-back:mod-1" })],
      skipDuplicates: true,
    });
  });
});

/*
  #3829 composed the acceptance with main's #3809 (a paid booking's reduction
  gives applied credit back, tiered) and #3653 (an organiser-paid child's refund
  goes back to the organiser's card). These pin both seams.
*/
describe("the credit share comes back once, untiered, on the acceptance only (#3809 composed, D-3813-5)", () => {
  it("card + credit acceptance: #3809's tiered give-back never runs; the clamp returns the $40 once", async () => {
    h.deriveBookingAppliedCreditCents.mockResolvedValue(30000);
    h.clampAppliedCreditToBookingPrice.mockResolvedValue({ appliedCreditCents: 26000, refundedExcessCents: 4000 });
    const result = await accept(booking({ payment: { ...booking().payment, amountCents: 2000, creditAppliedCents: 30000 } }));
    expect(result).toMatchObject({ repriced: true, refundAmountCents: 2000, accountCreditAmountCents: 4000 });
    expect(h.giveBackPaidReductionCredit).not.toHaveBeenCalled();
    expect(h.clampAppliedCreditToBookingPrice).toHaveBeenCalledTimes(1);
    expect(h.loadCancellationPolicy).not.toHaveBeenCalled();
  });

  it("an ordinary edit's reduction still takes #3809's give-back; only the caller's flag skips it", async () => {
    const creditPaid = booking({ payment: { ...booking().payment, amountCents: 0, creditAppliedCents: 32000 } });
    const args = { booking: creditPaid as never, priceDiffCents: -6000, changeFeeCents: 0, todayAtClub: TODAY, format: CLUB_FORMAT_TEST };
    h.giveBackPaidReductionCredit.mockResolvedValueOnce({ basisCents: 6000, givenBackCents: 3000 });
    const ordinary = await applyPaymentAdjustments(tx(creditPaid) as never, args);
    expect(h.giveBackPaidReductionCredit).toHaveBeenCalledTimes(1);
    expect(ordinary.appliedCreditGivenBackCents).toBe(3000);

    h.giveBackPaidReductionCredit.mockClear();
    const acceptance = await applyPaymentAdjustments(tx(creditPaid) as never, { ...args, appliedCreditReturnedByCaller: true });
    expect(h.giveBackPaidReductionCredit).not.toHaveBeenCalled();
    expect(acceptance.appliedCreditGivenBackCents).toBe(0);
  });
});

describe("an organiser-paid child's reduction goes back to the organiser's card, or moves no code (#3653 composed)", () => {
  /** Cara's booking, a child of the organiser's group, paid out of one $50,000 combined card payment. */
  function organiserChild(settlement: Record<string, unknown> | null) {
    const loaded = booking({ organiserSettled: true, parentBookingId: "organiser-booking" });
    const client = {
      ...tx(loaded),
      groupBookingSettlement: { findFirst: vi.fn(async () => settlement) },
      paymentRefund: { aggregate: vi.fn(async () => ({ _sum: { amountCents: null } })) },
      paymentRecoveryOperation: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "debt-1", ...args.data })),
      },
    };
    return { loaded, client };
  }
  const SETTLEMENT = { id: "settlement-1", stripePaymentIntentId: "pi_combined", amountCents: 50000, status: "SUCCEEDED", refundPlan: null };

  async function acceptChild(client: unknown) {
    return repriceBookingAfterGuestAcceptance(client as never, {
      bookingId: "booking-1",
      acceptedGuestId: "g-cara",
      actorMemberId: "cara",
      todayAtClub: TODAY,
      format: CLUB_FORMAT_TEST,
    });
  }

  it("the whole $60 is reserved against the organiser's combined payment, and Xero leaves the note to that refund", async () => {
    const { client } = organiserChild(SETTLEMENT);
    const result = await acceptChild(client);
    expect(result).toMatchObject({ repriced: true, refundAmountCents: 6000, organiserChildRefund: { amountCents: 6000 } });
    expect(client.paymentRecoveryOperation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ amountCents: 6000, paymentIntentId: "pi_combined", paymentId: "pay-1" }),
    });
    expect(h.persistRepricedPromotions).toHaveBeenCalled();

    await settleGuestAcceptanceRepriceAfterCommit({
      bookingId: "booking-1",
      actorMemberId: "cara",
      reprice: result as Extract<typeof result, { repriced: true }>,
      format: CLUB_FORMAT_TEST,
    });
    expect(h.executeBookingModificationRefund).toHaveBeenCalledWith(
      expect.objectContaining({ result: expect.objectContaining({ organiserChildRefund: { amountCents: 6000 } }) }),
    );
    expect(h.queueXeroBookingEditSettlement).toHaveBeenCalledWith(
      expect.objectContaining({ organiserChildRefundOwnsCreditNote: true }),
    );
  });

  it.each([
    ["holds less than the reduction", { ...SETTLEMENT, amountCents: 3000 }],
    ["is gone", null],
    ["was refunded in full", { ...SETTLEMENT, status: "REFUNDED" }],
  ])("when the organiser's payment %s, nothing moves and the acceptance is not refused", async (_label, settlement) => {
    const { client } = organiserChild(settlement);
    const result = await acceptChild(client);
    expect(result).toEqual({ repriced: false, reason: "REDUCTION_NOT_FULLY_RETURNABLE" });
    expect(h.persistRepricedPromotions).not.toHaveBeenCalled();
    expect(client.paymentRecoveryOperation.create).not.toHaveBeenCalled();
    expect(client.bookingModification.create).not.toHaveBeenCalled();
  });
});
