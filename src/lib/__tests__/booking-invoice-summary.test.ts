import { describe, expect, it } from "vitest";

import { getNetCollectedCashParts } from "@/lib/payment-net-collected";
import { bookingInvoiceSummary, type BookingInvoiceSummary, type BookingInvoiceSummaryBooking } from "@/lib/booking-invoice-summary";

/**
 * #5066 (owner decision on PR #5201, 17 Nov 2026; review F3, F4): the summary
 * beside the booking's Xero invoice is the page's own figures, in integer
 * cents, and its rows reconcile.
 */
function booking(
  overrides: Partial<BookingInvoiceSummaryBooking> = {},
  payment: Partial<NonNullable<BookingInvoiceSummaryBooking["payment"]>> = {},
): BookingInvoiceSummaryBooking {
  return {
    // A paid booking is PAID; CONFIRMED and PAYMENT_PENDING still owe (`isBookingOwnAmountOwed`).
    status: "PAID",
    deletedAt: null,
    manualRefundTasks: [],
    creditsFromCancellation: [],
    organiserSettled: false,
    parentBookingId: null,
    finalPriceCents: 60_000,
    payment: {
      status: "SUCCEEDED",
      source: "STRIPE",
      amountCents: 60_000,
      refundedAmountCents: 0,
      changeFeeCents: 0,
      _count: { transactions: 1 },
      recoveryOperations: [],
      refunds: [],
      ...payment,
    },
    ...overrides,
  } as BookingInvoiceSummaryBooking;
}

const owed = (owedCents: number, appliedCreditCents = 0) => ({
  owedCents,
  dueCents: Math.max(0, owedCents),
  appliedCreditCents,
});

/** The identity the card's rows keep: paid = total + fees - credit - due + kept. */
function reconciles(summary: BookingInvoiceSummary): boolean {
  return (
    summary.paidCents ===
    summary.totalCents + summary.changeFeeCents - summary.creditAppliedCents - summary.balanceCents + summary.keptCents
  );
}

describe("bookingInvoiceSummary", () => {
  it("shows a paid booking as paid in full, nothing kept, nothing still to pay", () => {
    const summary = bookingInvoiceSummary(booking(), owed(60_000));
    expect(summary).toEqual({
      totalCents: 60_000,
      changeFeeCents: 0,
      creditAppliedCents: 0,
      paidCents: 60_000,
      keptCents: 0,
      balanceCents: 0,
      balanceWhen: "NOW",
    });
    expect(reconciles(summary)).toBe(true);
  });

  it("F3 example 1: a guest worth $150 removed at a 50% tier, $75 refunded, shows the $75 the terms kept", () => {
    const tiered = booking({ finalPriceCents: 45_000 }, { status: "PARTIALLY_REFUNDED", refundedAmountCents: 7_500 });
    const summary = bookingInvoiceSummary(tiered, owed(45_000));
    expect(summary).toMatchObject({ totalCents: 45_000, creditAppliedCents: 0, paidCents: 52_500, keptCents: 7_500, balanceCents: 0 });
    expect(reconciles(summary)).toBe(true);
  });

  it("F3 example 2: a date change to $450 with a $50 fee shows the price as the Payment card's Total and the fee as its own row", () => {
    const refundedInFull = booking({ finalPriceCents: 45_000 }, { status: "PARTIALLY_REFUNDED", refundedAmountCents: 10_000, changeFeeCents: 5_000 });
    const full = bookingInvoiceSummary(refundedInFull, owed(50_000));
    expect(full).toMatchObject({ totalCents: 45_000, changeFeeCents: 5_000, paidCents: 50_000, keptCents: 0, balanceCents: 0 });
    expect(reconciles(full)).toBe(true);

    const refundedInPart = booking({ finalPriceCents: 45_000 }, { status: "PARTIALLY_REFUNDED", refundedAmountCents: 5_000, changeFeeCents: 5_000 });
    const part = bookingInvoiceSummary(refundedInPart, owed(50_000));
    expect(part).toMatchObject({ totalCents: 45_000, changeFeeCents: 5_000, paidCents: 55_000, keptCents: 5_000 });
    expect(reconciles(part)).toBe(true);
  });

  it("counts applied account credit from the ledger read", () => {
    const summary = bookingInvoiceSummary(booking({}, { amountCents: 50_000 }), owed(50_000, 10_000));
    expect(summary).toMatchObject({ creditAppliedCents: 10_000, paidCents: 50_000, keptCents: 0 });
    expect(reconciles(summary)).toBe(true);
  });

  it("shows an unpaid internet-banking booking as owing its amount due, with nothing paid or kept", () => {
    const unpaid = booking({ status: "CONFIRMED" }, { status: "PENDING", source: "INTERNET_BANKING", _count: { transactions: 0 } });
    const summary = bookingInvoiceSummary(unpaid, owed(55_000, 5_000));
    expect(summary).toEqual({
      totalCents: 60_000,
      changeFeeCents: 0,
      creditAppliedCents: 5_000,
      paidCents: 0,
      keptCents: 0,
      balanceCents: 55_000,
      balanceWhen: "NOW",
    });
    expect(reconciles(summary)).toBe(true);
  });

  it("F4: a booking held for review or pending shows what will be due, not $0", () => {
    const ib = { status: "PENDING", source: "INTERNET_BANKING", _count: { transactions: 0 } };
    expect(bookingInvoiceSummary(booking({ status: "AWAITING_REVIEW" }, ib), owed(60_000))).toMatchObject({
      balanceCents: 60_000,
      balanceWhen: "AFTER_REVIEW",
    });
    expect(bookingInvoiceSummary(booking({ status: "PENDING" }, ib), owed(60_000))).toMatchObject({
      balanceCents: 60_000,
      balanceWhen: "AFTER_CONFIRMATION",
    });
  });

  it("never counts a credit note folded into a never-paid bank-transfer payment as money received (#3924)", () => {
    const folded = booking(
      { status: "PAYMENT_PENDING", finalPriceCents: 45_000 },
      { status: "PARTIALLY_REFUNDED", source: "INTERNET_BANKING", refundedAmountCents: 15_000, _count: { transactions: 0 } },
    );
    expect(bookingInvoiceSummary(folded, owed(45_000))).toMatchObject({ paidCents: 0, keptCents: 0, balanceCents: 45_000 });
  });

  it("is the page's own retained figure: what Net Collected's cash rule says the payment still holds", () => {
    const b = booking({ finalPriceCents: 45_000 }, { status: "PARTIALLY_REFUNDED", refundedAmountCents: 15_000 });
    expect(bookingInvoiceSummary(b, owed(45_000)).paidCents).toBe(getNetCollectedCashParts({ ...b.payment!, booking: b }).heldCashCents);
  });

  it("reports zero paid and the full amount owed when no payment row exists", () => {
    expect(bookingInvoiceSummary(booking({ status: "PAYMENT_PENDING", payment: null }), owed(60_000))).toMatchObject({
      totalCents: 60_000,
      changeFeeCents: 0,
      paidCents: 0,
      keptCents: 0,
      balanceCents: 60_000,
    });
  });
});
