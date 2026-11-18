import { describe, expect, it } from "vitest";

import { bookingInvoiceSummary, type BookingInvoiceSummaryBooking } from "@/lib/booking-invoice-summary";

/**
 * #5066 (owner decision on PR #5201, 17 Nov 2026): the summary beside the
 * booking's Xero invoice is the page's own figures, in integer cents.
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

describe("bookingInvoiceSummary", () => {
  it("shows a paid booking as paid in full, nothing still to pay", () => {
    expect(bookingInvoiceSummary(booking(), owed(60_000))).toEqual({
      totalCents: 60_000,
      creditAppliedCents: 0,
      paidCents: 60_000,
      balanceCents: 0,
    });
  });

  it("counts the recorded change fee in the total, and applied account credit from the ledger read", () => {
    const b = booking({ finalPriceCents: 50_000 }, { amountCents: 45_000, changeFeeCents: 2_500 });
    expect(bookingInvoiceSummary(b, owed(42_500, 10_000))).toMatchObject({
      totalCents: 52_500,
      creditAppliedCents: 10_000,
      paidCents: 45_000,
    });
  });

  it("shows money refunded after a reduction as no longer paid", () => {
    const reduced = booking({ finalPriceCents: 45_000 }, { status: "PARTIALLY_REFUNDED", amountCents: 60_000, refundedAmountCents: 15_000 });
    expect(bookingInvoiceSummary(reduced, owed(45_000))).toEqual({
      totalCents: 45_000,
      creditAppliedCents: 0,
      paidCents: 45_000,
      balanceCents: 0,
    });
  });

  it("shows an unpaid internet-banking booking as owing its amount due, with nothing paid", () => {
    const unpaid = booking({ status: "CONFIRMED" }, { status: "PENDING", source: "INTERNET_BANKING", _count: { transactions: 0 } });
    expect(bookingInvoiceSummary(unpaid, owed(55_000, 5_000))).toEqual({
      totalCents: 60_000,
      creditAppliedCents: 5_000,
      paidCents: 0,
      balanceCents: 55_000,
    });
  });

  it("never counts a credit note folded into a never-paid bank-transfer payment as money received (#3924)", () => {
    const folded = booking(
      { status: "PAYMENT_PENDING", finalPriceCents: 45_000 },
      { status: "PARTIALLY_REFUNDED", source: "INTERNET_BANKING", refundedAmountCents: 15_000, _count: { transactions: 0 } },
    );
    expect(bookingInvoiceSummary(folded, owed(45_000))).toMatchObject({ paidCents: 0, balanceCents: 45_000 });
  });

  it("is the page's own retained figure: what Net Collected's cash rule says the payment still holds", async () => {
    const { getNetCollectedCashParts } = await import("@/lib/payment-net-collected");
    const b = booking({ finalPriceCents: 45_000 }, { status: "PARTIALLY_REFUNDED", amountCents: 60_000, refundedAmountCents: 15_000 });
    expect(bookingInvoiceSummary(b, owed(45_000)).paidCents).toBe(getNetCollectedCashParts({ ...b.payment!, booking: b }).heldCashCents);
  });

  it("reports zero paid and the full amount owed when no payment row exists", () => {
    expect(bookingInvoiceSummary(booking({ status: "PAYMENT_PENDING", payment: null }), owed(60_000))).toEqual({
      totalCents: 60_000,
      creditAppliedCents: 0,
      paidCents: 0,
      balanceCents: 60_000,
    });
  });
});
