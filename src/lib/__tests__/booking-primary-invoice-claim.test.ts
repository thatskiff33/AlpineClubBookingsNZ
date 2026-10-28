import { PaymentSource, PaymentStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdditionalAskChangedDuringReductionError } from "@/lib/additional-ask-reduction-error";
import { noReductionAgainstUnpaidAsk } from "@/lib/additional-ask-reduction";
import type { LoadedBookingForModify } from "@/lib/booking-modify-validation";
import { applyPaymentAdjustments } from "@/lib/booking-modify-settlement";
import {
  claimPrimaryInvoiceStillUnlinked,
  PRIMARY_INVOICE_RAISED_DURING_EDIT_MESSAGE,
  PrimaryInvoiceRaisedDuringEditError,
  primaryInvoiceSettlementHistory,
  recordedPrimaryInvoiceSettlement,
  SETTLED_AGAINST_PRIMARY_INVOICE_PATH,
  settlesAgainstPrimaryInvoice,
  writeEditOnPayment,
} from "@/lib/booking-primary-invoice-claim";
import type { CalendarDate } from "@/lib/club-time";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

/**
 * #3980 (`INV-PAY-136`, owner decision 21 Oct 2026: "refuse, and bill the
 * gap"): an edit that read no primary invoice link confirms it with one guarded
 * write on the payment row, carrying its fee, or is refused whole with a
 * transient 409; its history row records that it settled against the primary
 * invoice. An edit that read a link writes as before and claims nothing.
 */
const payment = {
  update: vi.fn(async () => ({})),
  updateMany: vi.fn(async () => ({ count: 1 })),
};
const groupBookingFindUnique = vi.fn();
const tx = {
  groupBooking: { findUnique: groupBookingFindUnique },
  payment,
  manualRefundTask: { aggregate: vi.fn(async () => ({ _sum: { amountCents: null } })) },
  paymentRecoveryOperation: { findMany: vi.fn(async () => []) },
} as unknown as Parameters<typeof applyPaymentAdjustments>[0];

function paidBooking(xeroInvoiceId: string | null): LoadedBookingForModify {
  return {
    id: "booking_1",
    status: "PAID",
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    lodgeId: "lodge_1",
    memberId: "member_1",
    finalPriceCents: 20_000,
    organiserSettled: false,
    parentBookingId: null,
    payment: {
      id: "payment_1",
      status: PaymentStatus.SUCCEEDED,
      source: PaymentSource.STRIPE,
      amountCents: 20_000,
      refundedAmountCents: 0,
      creditAppliedCents: 0,
      changeFeeCents: 0,
      stripePaymentIntentId: "pi_1",
      additionalAmountCents: 0,
      additionalPaymentStatus: null,
      xeroInvoiceId,
    },
  } as unknown as LoadedBookingForModify;
}

const adjust = (
  booking: LoadedBookingForModify,
  priceDiffCents: number,
  changeFeeCents = 0,
  extra: Partial<Parameters<typeof applyPaymentAdjustments>[1]> = {},
) =>
  applyPaymentAdjustments(tx, {
    booking,
    priceDiffCents,
    changeFeeCents,
    reduction: noReductionAgainstUnpaidAsk(priceDiffCents + changeFeeCents),
    todayAtClub: "2026-07-01" as CalendarDate,
    format: CLUB_FORMAT_TEST,
    ...extra,
  });

beforeEach(() => {
  vi.clearAllMocks();
  payment.updateMany.mockResolvedValue({ count: 1 });
});

describe("the edit's claim on the unlinked primary invoice (#3980)", () => {
  it("MUTATION: guards on the link being still unset, on this payment, carrying the fee - one write", async () => {
    await claimPrimaryInvoiceStillUnlinked(tx, { paymentId: "payment_1", changeFeeIncrementCents: 500 });
    expect(payment.updateMany).toHaveBeenCalledTimes(1);
    expect(payment.updateMany).toHaveBeenCalledWith({
      where: { id: "payment_1", xeroInvoiceId: null },
      data: { changeFeeCents: { increment: 500 } },
    });
    // No fee: the claim still writes the row, so it still takes its lock.
    await claimPrimaryInvoiceStillUnlinked(tx, { paymentId: "payment_1", changeFeeIncrementCents: 0 });
    expect(payment.updateMany).toHaveBeenLastCalledWith({
      where: { id: "payment_1", xeroInvoiceId: null },
      data: { changeFeeCents: { increment: 0 } },
    });
  });

  it("MUTATION: a link saved since the edit read none refuses the edit with the transient 409", async () => {
    payment.updateMany.mockResolvedValue({ count: 0 });
    const refusal = claimPrimaryInvoiceStillUnlinked(tx, { paymentId: "payment_1", changeFeeIncrementCents: 0 });
    await expect(refusal).rejects.toBeInstanceOf(PrimaryInvoiceRaisedDuringEditError);
    // The consent decline/expiry and the consent route already treat this family as "try again".
    await expect(refusal).rejects.toBeInstanceOf(AdditionalAskChangedDuringReductionError);
    await expect(refusal).rejects.toMatchObject({ status: 409, message: PRIMARY_INVOICE_RAISED_DURING_EDIT_MESSAGE });
    await expect(
      claimPrimaryInvoiceStillUnlinked(tx, { paymentId: "payment_1", changeFeeIncrementCents: 0, refusalMessage: "approve it again" }),
    ).rejects.toMatchObject({ status: 409, message: "approve it again" });
  });

  it("the marker: written only for an edit that read no invoice link, at the path the gap check reads", () => {
    expect(settlesAgainstPrimaryInvoice({ xeroInvoiceId: null })).toBe(true);
    expect(settlesAgainstPrimaryInvoice(null)).toBe(true);
    expect(settlesAgainstPrimaryInvoice({ xeroInvoiceId: "inv_1" })).toBe(false);
    // #3980 review M5: with how the edit settled its own money, for the treasurer.
    const marker = primaryInvoiceSettlementHistory({
      settledAgainstPrimaryInvoice: true,
      refundAmountCents: 4_000,
      accountCreditAmountCents: 0,
      appliedCreditGivenBackCents: 1_000,
      unpaidAskOffsetCents: 2_500,
    });
    expect(marker).toEqual({
      primaryInvoiceSettlement: {
        settledAgainstPrimaryInvoice: true,
        refundAmountCents: 4_000,
        accountCreditAmountCents: 0,
        appliedCreditGivenBackCents: 1_000,
        unpaidAskOffsetCents: 2_500,
      },
    });
    expect(recordedPrimaryInvoiceSettlement(marker)).toEqual({
      refundAmountCents: 4_000,
      accountCreditAmountCents: 0,
      appliedCreditGivenBackCents: 1_000,
      unpaidAskOffsetCents: 2_500,
    });
    expect(primaryInvoiceSettlementHistory({ settledAgainstPrimaryInvoice: false, refundAmountCents: 4_000 })).toEqual({});
    expect(recordedPrimaryInvoiceSettlement({})).toBeNull();
    expect(SETTLED_AGAINST_PRIMARY_INVOICE_PATH).toEqual(["primaryInvoiceSettlement", "settledAgainstPrimaryInvoice"]);
  });
});

describe("applyPaymentAdjustments makes the claim for the edit doors (#3980)", () => {
  it("an edit that read no link records its fee through the claim, and says it settled against the primary invoice", async () => {
    const result = await adjust(paidBooking(null), 3_000, 500);
    expect(result.settledAgainstPrimaryInvoice).toBe(true);
    expect(result.hasIssuedXeroInvoice).toBe(false);
    expect(payment.updateMany).toHaveBeenCalledTimes(1);
    expect(payment.updateMany).toHaveBeenCalledWith({
      where: { id: "payment_1", xeroInvoiceId: null },
      data: { changeFeeCents: { increment: 500 } },
    });
    // Never the fee twice.
    expect(payment.update).not.toHaveBeenCalled();
  });

  it("MUTATION: an edit that read a link claims nothing and records its fee as before", async () => {
    const result = await adjust(paidBooking("inv_1"), 3_000, 500);
    expect(result.settledAgainstPrimaryInvoice).toBe(false);
    expect(result.hasIssuedXeroInvoice).toBe(true);
    expect(payment.updateMany).not.toHaveBeenCalled();
    expect(payment.update).toHaveBeenCalledWith({
      where: { id: "payment_1" },
      data: { changeFeeCents: { increment: 500 } },
    });
  });

  it("refuses the whole edit when the link was saved under it, in the caller's words where it gives them", async () => {
    payment.updateMany.mockResolvedValue({ count: 0 });
    await expect(adjust(paidBooking(null), 2_000)).rejects.toMatchObject({
      status: 409,
      message: PRIMARY_INVOICE_RAISED_DURING_EDIT_MESSAGE,
    });
    await expect(adjust(paidBooking(null), 2_000, 0, { primaryInvoiceRaisedMessage: "approve it again" })).rejects.toMatchObject({
      status: 409,
      message: "approve it again",
    });
  });

  it("a fee the caller records on the amount owed is not carried again: the claim writes 0", async () => {
    await adjust(paidBooking(null), 2_000, 500, { changeFeeRecordedByCaller: true });
    expect(payment.updateMany).toHaveBeenCalledWith({
      where: { id: "payment_1", xeroInvoiceId: null },
      data: { changeFeeCents: { increment: 0 } },
    });
    expect(payment.update).not.toHaveBeenCalled();
  });
});


it("an organiser combined invoice never claims or marks the joiner primary, but records its fee", async () => {
  expect(await writeEditOnPayment(tx, { payment: { id: "child-payment", xeroInvoiceId: null }, changeFeeCents: 1000, settledAgainstCombinedInvoice: true })).toBe(false);
  expect(payment.updateMany).not.toHaveBeenCalled();
  expect(payment.update).toHaveBeenCalledWith({ where: { id: "child-payment" }, data: { changeFeeCents: { increment: 1000 } } });
});


it("bills organiser extra price plus fee and never marks the child's missing primary as settled", async () => {
  const booking = paidBooking(null);
  booking.organiserSettled = true;
  booking.parentBookingId = "parent";
  booking.payment!.source = PaymentSource.INTERNET_BANKING;
  groupBookingFindUnique.mockResolvedValue({ status: "OPEN", organiserBookingId: "parent", organiserMemberId: "organiser", organiserMember: {},
    settlement: { id: "settlement", source: "INTERNET_BANKING", xeroInvoiceId: "combined" } });
  const result = await adjust(booking, 5000, 1000);
  expect(result).toMatchObject({ additionalAmountCents: 6000, xeroAdditionalAmountCents: 6000, hasIssuedXeroInvoice: true,
    hasSucceededPayment: false, settledAgainstPrimaryInvoice: false });
  expect(payment.updateMany).not.toHaveBeenCalled();
  expect(payment.update).toHaveBeenCalledWith({ where: { id: "payment_1" }, data: { changeFeeCents: { increment: 1000 } } });
});

it("refuses an organiser-paid edit before payment writes if its combined invoice is missing", async () => {
  const booking = paidBooking(null);
  booking.organiserSettled = true;
  booking.parentBookingId = "parent";
  booking.payment!.source = PaymentSource.INTERNET_BANKING;
  groupBookingFindUnique.mockResolvedValue({ status: "OPEN", settlement: { source: "INTERNET_BANKING", xeroInvoiceId: null } });
  await expect(adjust(booking, 5000, 1000)).rejects.toThrow("combined invoice is not on record");
  expect(payment.update).not.toHaveBeenCalled();
  expect(payment.updateMany).not.toHaveBeenCalled();
});
