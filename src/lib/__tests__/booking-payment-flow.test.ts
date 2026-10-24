import { describe, expect, it } from "vitest";
import {
  canCreateImmediatePaymentIntent,
  getBookingPaymentMode,
  isUnpaidConfirmedWholeLodge,
  buildUnpaidConfirmedWholeLodgeWhere,
} from "@/lib/booking-payment-flow";

describe("getBookingPaymentMode", () => {
  it("uses setup mode only for pending bookings", () => {
    expect(getBookingPaymentMode("PENDING")).toBe("setup");
  });

  it("uses payment mode for payment-pending bookings with lifecycle already decided", () => {
    expect(getBookingPaymentMode("PAYMENT_PENDING")).toBe("payment");
    expect(getBookingPaymentMode("CONFIRMED")).toBe("payment");
    expect(getBookingPaymentMode("DRAFT")).toBe("payment");
    expect(getBookingPaymentMode("PAID")).toBe("payment");
  });
});

describe("canCreateImmediatePaymentIntent", () => {
  it("allows a normal payment-pending booking", () => {
    expect(
      canCreateImmediatePaymentIntent({
        status: "PAYMENT_PENDING",
        hasNonMembers: false,
      })
    ).toBe(true);
  });

  it("blocks an organiser-settled booking so the joiner cannot self-pay", () => {
    // ORGANISER_PAYS: the organiser settles the group total, so the joiner who
    // owns this child booking must never get a self-pay flow even though the
    // status would otherwise be payable.
    expect(
      canCreateImmediatePaymentIntent({
        status: "PAYMENT_PENDING",
        hasNonMembers: false,
        organiserSettled: true,
      })
    ).toBe(false);
  });
});


describe("INV-PAY-140: an abandoned whole-lodge card attempt stays unpaid", () => {
  const transaction = { kind: "PRIMARY", source: "STRIPE", status: "PROCESSING", stripePaymentIntentId: "pi_attempt", xeroInvoiceId: null, refundedAmountCents: 0 } as const;
  const payment = { source: "STRIPE", status: "PROCESSING", stripePaymentIntentId: "pi_attempt", xeroInvoiceId: null, refundedAmountCents: 0, settledByTransactionId: null, manuallyMarkedPaidAt: null, transactions: [transaction] } as const;
  const booking = { status: "CONFIRMED", wholeLodgeHold: true, payment };

  it.each(["PENDING", "PROCESSING", "FAILED"] as const)("admits a proven %s card attempt", (status) => {
    expect(isUnpaidConfirmedWholeLodge({ ...booking, payment: { ...payment, status, transactions: [{ ...transaction, status }] } })).toBe(true);
  });
  it("admits absent payment but refuses missing transaction evidence", () => {
    expect(isUnpaidConfirmedWholeLodge({ ...booking, payment: null })).toBe(true);
    expect(isUnpaidConfirmedWholeLodge({ ...booking, payment: { ...payment, transactions: undefined } })).toBe(false);
    expect(isUnpaidConfirmedWholeLodge({ ...booking, payment: { ...payment, transactions: [] } })).toBe(false);
  });
  it.each([
    { status: "SUCCEEDED" }, { status: "REFUNDED" }, { status: "PARTIALLY_REFUNDED" },
    { source: "INTERNET_BANKING" }, { xeroInvoiceId: "invoice" },
    { refundedAmountCents: 100 }, { settledByTransactionId: "settler" },
    { manuallyMarkedPaidAt: new Date("2026-06-01") }, { stripePaymentIntentId: null },
    { transactions: [{ ...transaction, status: "SUCCEEDED" }] },
    { transactions: [{ ...transaction, status: "REFUNDED" }] },
    { transactions: [{ ...transaction, xeroInvoiceId: "invoice" }] },
    { transactions: [{ ...transaction, refundedAmountCents: 100 }] },
    { transactions: [transaction, { ...transaction, kind: "ADDITIONAL" }] },
  ])("excludes received, invoiced or unverified money: %j", (overrides) => {
    expect(isUnpaidConfirmedWholeLodge({ ...booking, payment: { ...payment, ...overrides } } as Parameters<typeof isUnpaidConfirmedWholeLodge>[0])).toBe(false);
  });
  it("does not broaden ordinary confirmed bookings or stopped lifecycles", () => {
    expect(isUnpaidConfirmedWholeLodge({ ...booking, wholeLodgeHold: false })).toBe(false);
    expect(isUnpaidConfirmedWholeLodge({ ...booking, status: "PAID" })).toBe(false);
    expect(isUnpaidConfirmedWholeLodge({ ...booking, status: "CANCELLED" })).toBe(false);
  });
  it("runtime and query forms classify the same persisted facts", async () => {
    const { matchesWhere } = await import("./support/prisma-where");
    const variants = [null, payment, { ...payment, status: "SUCCEEDED" }, { ...payment, transactions: [] }, { ...payment, source: "INTERNET_BANKING" }, { ...payment, xeroInvoiceId: "invoice" }, { ...payment, transactions: [transaction, { ...transaction, kind: "ADDITIONAL", status: "REFUNDED" }] }];
    for (const variant of variants) {
      const row = { ...booking, payment: variant };
      expect(matchesWhere(row, buildUnpaidConfirmedWholeLodgeWhere())).toBe(isUnpaidConfirmedWholeLodge(row as Parameters<typeof isUnpaidConfirmedWholeLodge>[0]));
    }
  });
});
