import { describe, expect, it } from "vitest";
import {
  auditCardAppliedCreditDoublePays,
  deriveCardAppliedCreditDoublePayFinding,
  deriveIbAppliedCreditStrandFinding,
  deriveIbHoldClearingFinding,
  type CardAppliedCreditDoublePayRow,
  type IbAppliedCreditStrandRow,
  type IbHoldClearingRow,
} from "@/lib/ib-hold-clearing-audit";

function makeRow(overrides: Partial<IbHoldClearingRow> = {}): IbHoldClearingRow {
  return {
    paymentId: "pay_1",
    bookingId: "booking_1",
    bookingStatus: "CANCELLED",
    // effectivePriceCents: finalPrice (15000) − 2655 applied credit.
    enqueuedClearingCents: 12345,
    changeFeeCents: 0,
    xeroInvoiceId: "inv_1",
    xeroInvoiceNumber: "INV-001",
    xeroRefundCreditNoteId: "cn_1",
    finalPriceCents: 15000,
    xeroAllocatedCreditSumCents: 0,
    ...overrides,
  };
}

describe("deriveIbHoldClearingFinding (#1597 audit sizing)", () => {
  it("flags a credit-carrying invoice cleared at the credit-reduced amount", () => {
    const finding = deriveIbHoldClearingFinding(makeRow());
    expect(finding).not.toBeNull();
    // Expected = full finalPrice (no Xero credit note allocated); actual = the
    // credit-reduced 12345; open delta = the 2655 applied-credit slice.
    expect(finding?.expectedClearingCents).toBe(15000);
    expect(finding?.enqueuedClearingCents).toBe(12345);
    expect(finding?.deltaCents).toBe(2655);
    expect(finding?.invoiceRef).toBe("INV-001");
    expect(finding?.refundNoteIssued).toBe(true);
  });

  it("returns null for a released hold with no issued invoice", () => {
    const finding = deriveIbHoldClearingFinding(
      makeRow({ xeroInvoiceId: null, xeroInvoiceNumber: null }),
    );
    expect(finding).toBeNull();
  });

  it("returns null for the switch-to-IB shape cleared at full finalPrice", () => {
    // amountCents = finalPrice (no credit reduction): expected == actual, so no
    // under-clear.
    const finding = deriveIbHoldClearingFinding(
      makeRow({ enqueuedClearingCents: 15000 }),
    );
    expect(finding).toBeNull();
  });

  it("subtracts only credit allocated to the invoice as a Xero credit note", () => {
    // A NZ$50 credit note (stored negative) already reduced the invoice's Xero
    // balance to 10000; the note was still sized at 12345, so the invoice is now
    // OVER-cleared — expected (10000) < actual (12345), delta <= 0, no finding.
    const finding = deriveIbHoldClearingFinding(
      makeRow({ xeroAllocatedCreditSumCents: -5000 }),
    );
    expect(finding).toBeNull();
  });

  it("floors expected clearing at zero when Xero credit notes exceed the invoice", () => {
    const finding = deriveIbHoldClearingFinding(
      makeRow({
        xeroAllocatedCreditSumCents: -20000,
        enqueuedClearingCents: 0,
      }),
    );
    expect(finding).toBeNull();
  });

  it("includes any billed change fee in the expected outstanding", () => {
    const finding = deriveIbHoldClearingFinding(
      makeRow({ changeFeeCents: 1000, enqueuedClearingCents: 12345 }),
    );
    // expected = 15000 + 1000 − 0 = 16000; delta = 16000 − 12345 = 3655.
    expect(finding?.expectedClearingCents).toBe(16000);
    expect(finding?.deltaCents).toBe(3655);
  });
});

function makeStrandRow(
  overrides: Partial<IbAppliedCreditStrandRow> = {},
): IbAppliedCreditStrandRow {
  return {
    paymentId: "pay_1",
    bookingId: "booking_1",
    bookingStatus: "PAYMENT_PENDING",
    paymentStatus: "PENDING",
    amountCents: 10000,
    creditAppliedCents: 3000,
    finalPriceCents: 10000,
    ledgerAppliedCents: 3000,
    ...overrides,
  };
}

describe("deriveIbAppliedCreditStrandFinding (#1620 enumeration)", () => {
  it("returns null when the booking carries no applied credit", () => {
    expect(
      deriveIbAppliedCreditStrandFinding(
        makeStrandRow({ ledgerAppliedCents: 0, creditAppliedCents: 0 }),
      ),
    ).toBeNull();
  });

  it("flags a not-yet-paid IB booking as a PENDING (unrealized) strand", () => {
    const finding = deriveIbAppliedCreditStrandFinding(makeStrandRow());
    expect(finding).not.toBeNull();
    expect(finding?.realized).toBe(false);
    expect(finding?.strandExposureCents).toBe(3000);
  });

  it("flags a paid IB booking as a REALIZED double-pay", () => {
    const finding = deriveIbAppliedCreditStrandFinding(
      makeStrandRow({ paymentStatus: "SUCCEEDED", bookingStatus: "PAID" }),
    );
    expect(finding?.realized).toBe(true);
    expect(finding?.strandExposureCents).toBe(3000);
  });

  it("surfaces the stale mirror on a switched (card-origin) payment", () => {
    // Switch overwrote amountCents → finalPrice and never set creditAppliedCents,
    // yet the BOOKING_APPLIED ledger consumed 3000. Mirror is stale by 3000; the
    // internal payment invariant (amount + credit − final) still nets to 0.
    const finding = deriveIbAppliedCreditStrandFinding(
      makeStrandRow({
        creditAppliedCents: 0,
        amountCents: 10000,
        ledgerAppliedCents: 3000,
      }),
    );
    expect(finding?.mirrorLedgerMismatchCents).toBe(3000);
    expect(finding?.mirrorInvariantDeltaCents).toBe(0);
    expect(finding?.strandExposureCents).toBe(3000);
  });

  it("shows a consistent mirror on a create-time IB booking", () => {
    // amountCents = effective (7000), creditApplied mirror = ledger = 3000.
    const finding = deriveIbAppliedCreditStrandFinding(
      makeStrandRow({ amountCents: 7000, creditAppliedCents: 3000 }),
    );
    expect(finding?.mirrorLedgerMismatchCents).toBe(0);
    expect(finding?.mirrorInvariantDeltaCents).toBe(0);
  });
});

function makeCardRow(
  overrides: Partial<CardAppliedCreditDoublePayRow> = {},
): CardAppliedCreditDoublePayRow {
  return {
    paymentId: "pay_card_1",
    bookingId: "booking_card_1",
    bookingStatus: "PAID",
    paymentStatus: "SUCCEEDED",
    paymentSource: "STRIPE",
    // Pre-fix double-pay: full charge, no mirror, unallocated ledger credit.
    amountCents: 10000,
    creditAppliedCents: 0,
    finalPriceCents: 10000,
    ledgerAppliedCents: 3000,
    ...overrides,
  };
}

describe("deriveCardAppliedCreditDoublePayFinding (#1641 card double-pay)", () => {
  it("flags a full-price card capture that consumed unallocated applied credit", () => {
    const finding = deriveCardAppliedCreditDoublePayFinding(makeCardRow());
    expect(finding).not.toBeNull();
    expect(finding?.strandExposureCents).toBe(3000);
  });

  it("returns null when the booking carries no unallocated applied credit", () => {
    expect(
      deriveCardAppliedCreditDoublePayFinding(
        makeCardRow({ ledgerAppliedCents: 0 }),
      ),
    ).toBeNull();
  });

  it("does NOT flag a #1641-fixed booking (positive mirror, effective charge)", () => {
    // A fixed card booking: charged the effective 7000, mirror = applied 3000, and
    // its BOOKING_APPLIED rows are stamped so the unallocated ledger sum is 0.
    // Every discriminating clause fails, so it never appears.
    expect(
      deriveCardAppliedCreditDoublePayFinding(
        makeCardRow({
          amountCents: 7000,
          creditAppliedCents: 3000,
          ledgerAppliedCents: 0,
        }),
      ),
    ).toBeNull();
    // Even if a fixed booking still had an unallocated row transiently, the
    // positive mirror + effective amount exclude it.
    expect(
      deriveCardAppliedCreditDoublePayFinding(
        makeCardRow({
          amountCents: 7000,
          creditAppliedCents: 3000,
          ledgerAppliedCents: 3000,
        }),
      ),
    ).toBeNull();
  });
});

describe("auditCardAppliedCreditDoublePays (#1641 card scan)", () => {
  it("enumerates only the realized card double-pays and sizes the restore", async () => {
    const payments = [
      // A pre-fix double-pay (should be flagged).
      {
        id: "pay_bad",
        bookingId: "booking_bad",
        source: "STRIPE",
        amountCents: 10000,
        creditAppliedCents: 0,
        status: "SUCCEEDED",
        booking: { finalPriceCents: 10000, status: "PAID" },
      },
      // A no-credit card payment (ledger sum 0 -> not flagged).
      {
        id: "pay_nocredit",
        bookingId: "booking_nocredit",
        source: "STRIPE",
        amountCents: 8000,
        creditAppliedCents: 0,
        status: "SUCCEEDED",
        booking: { finalPriceCents: 8000, status: "PAID" },
      },
      // A #1641-fixed booking (effective charge + positive mirror -> not flagged).
      {
        id: "pay_fixed",
        bookingId: "booking_fixed",
        source: "STRIPE",
        amountCents: 7000,
        creditAppliedCents: 3000,
        status: "SUCCEEDED",
        booking: { finalPriceCents: 10000, status: "PAID" },
      },
    ];
    const ledgerByBooking: Record<string, number> = {
      // stored negative; the pre-fix booking has 3000 unallocated applied credit
      booking_bad: -3000,
      booking_nocredit: 0,
      // the fixed booking's rows are stamped -> unallocated sum is 0
      booking_fixed: 0,
    };

    const fakeDb = {
      payment: {
        findMany: async () => payments,
      },
      memberCredit: {
        aggregate: async ({
          where,
        }: {
          where: { appliedToBookingId: string };
        }) => ({
          _sum: {
            amountCents: ledgerByBooking[where.appliedToBookingId] ?? 0,
          },
        }),
      },
    };

    const result = await auditCardAppliedCreditDoublePays({
      db: fakeDb as never,
    });

    expect(result.scannedCardPayments).toBe(3);
    expect(result.doublePays).toHaveLength(1);
    expect(result.doublePays[0].bookingId).toBe("booking_bad");
    expect(result.doublePaidCents).toBe(3000);
  });
});
