import { describe, expect, it } from "vitest";
import {
  auditCardAppliedCreditDoublePays,
  deriveCardAppliedCreditDoublePayFinding,
  deriveIbAppliedCreditStrandFinding,
  type CardAppliedCreditDoublePayRow,
  type IbAppliedCreditStrandRow,
} from "@/lib/ib-hold-clearing-audit";
import {
  auditIbHoldClearingUnderclears,
  deriveIbHoldClearingFinding,
  formatIbHoldClearingAuditReport,
  resolveIbHoldClearingNotes,
  type IbHoldClearingNote,
  type IbHoldClearingRow,
} from "@/lib/ib-hold-clearing-underclear-audit";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

function makeNote(overrides: Partial<IbHoldClearingNote> = {}): IbHoldClearingNote {
  return {
    kind: "allocated-clearing-note",
    creditNoteId: "cn_1",
    amountCents: 15000,
    operationStatus: "SUCCEEDED",
    allocatedCents: 15000,
    ...overrides,
  };
}

function makeRow(overrides: Partial<IbHoldClearingRow> = {}): IbHoldClearingRow {
  return {
    paymentId: "pay_1",
    bookingId: "booking_1",
    bookingStatus: "CANCELLED",
    changeFeeCents: 0,
    xeroInvoiceId: "inv_1",
    xeroInvoiceNumber: "INV-001",
    finalPriceCents: 15000,
    xeroAllocatedAppliedCreditCents: 0,
    clearingNotes: [makeNote()],
    ...overrides,
  };
}

describe("deriveIbHoldClearingFinding (INV-PAY-017 audit sizing)", () => {
  it("accepts a clearing note whose allocation covers the INV-PAY-017 size", () => {
    expect(deriveIbHoldClearingFinding(makeRow())).toBeNull();
  });

  it("returns null for a released hold with no issued invoice", () => {
    expect(
      deriveIbHoldClearingFinding(makeRow({ xeroInvoiceId: null, xeroInvoiceNumber: null })),
    ).toBeNull();
  });

  it("flags a pre-#1597 note allocated only up to the credit-reduced amount", () => {
    const finding = deriveIbHoldClearingFinding(
      makeRow({
        clearingNotes: [
          makeNote({ kind: "refund-note", amountCents: 12345, allocatedCents: 12345 }),
        ],
      }),
    );
    expect(finding?.expectedClearingCents).toBe(15000);
    expect(finding?.allocatedClearingCents).toBe(12345);
    expect(finding?.deltaCents).toBe(2655);
    expect(finding?.invoiceRef).toBe("INV-001");
  });

  it("subtracts only credit allocated to the invoice as a Xero credit note", () => {
    expect(
      deriveIbHoldClearingFinding(
        makeRow({
          xeroAllocatedAppliedCreditCents: 5000,
          clearingNotes: [makeNote({ amountCents: 10000, allocatedCents: 10000 })],
        }),
      ),
    ).toBeNull();
  });

  it("floors expected clearing at zero when Xero credit notes exceed the invoice", () => {
    expect(
      deriveIbHoldClearingFinding(
        makeRow({ xeroAllocatedAppliedCreditCents: 20000, clearingNotes: [] }),
      ),
    ).toBeNull();
  });

  it("includes any billed change fee in the expected outstanding", () => {
    const finding = deriveIbHoldClearingFinding(makeRow({ changeFeeCents: 1000 }));
    expect(finding?.expectedClearingCents).toBe(16000);
    expect(finding?.deltaCents).toBe(1000);
  });

  // #3535 review: a FAILED operation created nothing, so it clears nothing.
  it("counts nothing for a FAILED newest clearing operation, and reports the invoice fully open", () => {
    const finding = deriveIbHoldClearingFinding(
      makeRow({
        clearingNotes: [
          makeNote({ creditNoteId: null, operationStatus: "FAILED", allocatedCents: 0 }),
        ],
      }),
    );
    expect(finding?.allocatedClearingCents).toBe(0);
    expect(finding?.deltaCents).toBe(15000);
  });

  // #3535 review: a legacy refund note was never allocated by the system.
  it("reports a legacy refund note that nobody allocated as issued but not clearing", () => {
    const finding = deriveIbHoldClearingFinding(
      makeRow({
        clearingNotes: [
          makeNote({ kind: "refund-note", amountCents: 15000, allocatedCents: 0 }),
        ],
      }),
    );
    expect(finding?.deltaCents).toBe(15000);
    const report = formatIbHoldClearingAuditReport(
      {
        scannedReleasedHolds: 1,
        invoiceBearingHolds: 1,
        noInvoiceReleasedHolds: 0,
        underCleared: [finding!],
        totalDeltaCents: 15000,
      },
      CLUB_FORMAT_TEST,
    );
    expect(report).toContain(
      "refund note (before #3535) issued, invoice NOT cleared unless allocated by hand ($150.00, SUCCEEDED; $0.00 allocated)",
    );
    expect(report).not.toContain("Nothing to repair");
  });

  it("counts a legacy refund note as far as someone allocated it by hand", () => {
    expect(
      deriveIbHoldClearingFinding(
        makeRow({
          clearingNotes: [makeNote({ kind: "refund-note", allocatedCents: 15000 })],
        }),
      ),
    ).toBeNull();
  });

  it("reports a hold with no clearing note at all as fully open", () => {
    const finding = deriveIbHoldClearingFinding(makeRow({ clearingNotes: [] }));
    expect(finding?.allocatedClearingCents).toBe(0);
    expect(finding?.deltaCents).toBe(15000);
    expect(finding?.clearingNotes).toEqual([]);
  });
});

describe("resolveIbHoldClearingNotes (#3535: both note shapes)", () => {
  it("reads the clearing note's allocations off the booking's allocation links, once each", () => {
    expect(
      resolveIbHoldClearingNotes({
        operations: [
          {
            localModel: "Booking",
            status: "SUCCEEDED",
            xeroObjectId: "cn_clear",
            requestPayload: { invoiceId: "inv_1", refundAmountCents: 41000, clearsUnpaidInvoice: true },
          },
        ],
        allocationLinks: [
          { localModel: "Booking", metadata: { creditNoteId: "cn_clear", invoiceId: "inv_1", amountCents: 30000 } },
          { localModel: "Booking", metadata: { creditNoteId: "cn_clear", invoiceId: "inv_supp", amountCents: 11000 } },
          // The inbound reconcile's copy of the first allocation.
          { localModel: "Booking", metadata: { creditNoteId: "cn_clear", invoiceId: "inv_1", amountCents: 30000 } },
          // Another note's allocation does not count.
          { localModel: "Booking", metadata: { creditNoteId: "cn_other", invoiceId: "inv_1", amountCents: 999 } },
        ],
        xeroRefundCreditNoteId: null,
      }),
    ).toEqual([
      {
        kind: "allocated-clearing-note",
        creditNoteId: "cn_clear",
        amountCents: 41000,
        operationStatus: "SUCCEEDED",
        allocatedCents: 41000,
      },
    ]);
  });

  it("gives a FAILED clearing operation no note and no allocation", () => {
    expect(
      resolveIbHoldClearingNotes({
        operations: [
          {
            localModel: "Booking",
            status: "FAILED",
            xeroObjectId: null,
            requestPayload: { queueType: "MODIFICATION_CREDIT_NOTE", refundAmountCents: 15000 },
          },
        ],
        allocationLinks: [],
        xeroRefundCreditNoteId: null,
      }),
    ).toEqual([
      {
        kind: "allocated-clearing-note",
        creditNoteId: null,
        amountCents: 15000,
        operationStatus: "FAILED",
        allocatedCents: 0,
      },
    ]);
  });

  it("reads an older refund note's size and any hand allocation on the payment", () => {
    expect(
      resolveIbHoldClearingNotes({
        operations: [
          {
            localModel: "Payment",
            status: "SUCCEEDED",
            xeroObjectId: "cn_refund",
            requestPayload: { allocation: { invoiceId: "inv_1", amount: 150 } },
          },
        ],
        allocationLinks: [
          { localModel: "Payment", metadata: { creditNoteId: "cn_refund", invoiceId: "inv_1", amountCents: 5000 } },
        ],
        xeroRefundCreditNoteId: "cn_refund",
      }),
    ).toEqual([
      {
        kind: "refund-note",
        creditNoteId: "cn_refund",
        amountCents: 15000,
        operationStatus: "SUCCEEDED",
        allocatedCents: 5000,
      },
    ]);
  });

  it("keeps a refund note known only from the payment's link field, size unknown", () => {
    expect(
      resolveIbHoldClearingNotes({ operations: [], allocationLinks: [], xeroRefundCreditNoteId: "cn_1" }),
    ).toEqual([
      { kind: "refund-note", creditNoteId: "cn_1", amountCents: null, operationStatus: null, allocatedCents: 0 },
    ]);
  });

  it("takes the newest operation per shape and reports both shapes when both exist", () => {
    const notes = resolveIbHoldClearingNotes({
      operations: [
        { localModel: "Booking", status: "FAILED", xeroObjectId: null, requestPayload: { refundAmountCents: 2655 } },
        { localModel: "Booking", status: "SUCCEEDED", xeroObjectId: "cn_old", requestPayload: { refundAmountCents: 999 } },
        { localModel: "Payment", status: "SUCCEEDED", xeroObjectId: "cn_1", requestPayload: { refundAmountCents: 12345 } },
      ],
      allocationLinks: [],
      xeroRefundCreditNoteId: "cn_1",
    });
    expect(notes.map((note) => [note.kind, note.operationStatus, note.amountCents])).toEqual([
      ["allocated-clearing-note", "FAILED", 2655],
      ["refund-note", "SUCCEEDED", 12345],
    ]);
  });
});

describe("auditIbHoldClearingUnderclears (#3535 scan)", () => {
  it("judges each released hold by the ledger the release reads and what its notes allocated", async () => {
    const payments = [
      // Released after #3535, applied credit allocated to the invoice: cleared
      // by the allocated note at 10000 — correct, not flagged.
      {
        id: "pay_new",
        bookingId: "booking_new",
        changeFeeCents: 0,
        xeroInvoiceId: "inv_new",
        xeroInvoiceNumber: "INV-NEW",
        xeroRefundCreditNoteId: null,
        booking: { finalPriceCents: 15000, status: "CANCELLED" },
      },
      // Released after #3535, but its clearing operation FAILED: fully open.
      {
        id: "pay_failed",
        bookingId: "booking_failed",
        changeFeeCents: 0,
        xeroInvoiceId: "inv_failed",
        xeroInvoiceNumber: "INV-FAILED",
        xeroRefundCreditNoteId: null,
        booking: { finalPriceCents: 15000, status: "CANCELLED" },
      },
      // Released before #3535: a refund note nobody allocated.
      {
        id: "pay_old",
        bookingId: "booking_old",
        changeFeeCents: 0,
        xeroInvoiceId: "inv_old",
        xeroInvoiceNumber: "INV-OLD",
        xeroRefundCreditNoteId: "cn_old",
        booking: { finalPriceCents: 15000, status: "CANCELLED" },
      },
      // No invoice: skipped.
      {
        id: "pay_none",
        bookingId: "booking_none",
        changeFeeCents: 0,
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        xeroRefundCreditNoteId: null,
        booking: { finalPriceCents: 5000, status: "CANCELLED" },
      },
    ];
    const allocatedByBooking: Record<string, number> = { booking_new: 5000 };
    const operations = [
      {
        localModel: "Booking",
        localId: "booking_new",
        status: "SUCCEEDED",
        xeroObjectId: "cn_new",
        requestPayload: { refundAmountCents: 10000, clearsUnpaidInvoice: true },
      },
      {
        localModel: "Booking",
        localId: "booking_failed",
        status: "FAILED",
        xeroObjectId: null,
        requestPayload: { queueType: "MODIFICATION_CREDIT_NOTE", refundAmountCents: 15000 },
      },
      {
        localModel: "Payment",
        localId: "pay_old",
        status: "SUCCEEDED",
        xeroObjectId: "cn_old",
        requestPayload: { refundAmountCents: 15000 },
      },
    ];
    const links = [
      {
        localModel: "Booking",
        localId: "booking_new",
        metadata: { creditNoteId: "cn_new", invoiceId: "inv_new", amountCents: 10000 },
      },
    ];
    const operationQueries: unknown[] = [];
    const matches = (
      arms: Array<{ localModel: string; localId: string }>,
      row: { localModel: string; localId: string },
    ) => arms.some((arm) => arm.localModel === row.localModel && arm.localId === row.localId);

    const fakeDb = {
      payment: { findMany: async () => payments },
      memberCreditNoteAllocation: {
        aggregate: async ({ where }: { where: { appliedToBookingId: string } }) => ({
          _sum: { amountCents: allocatedByBooking[where.appliedToBookingId] ?? 0 },
        }),
      },
      xeroSyncOperation: {
        findMany: async (query: { where: { OR: Array<{ localModel: string; localId: string }> } }) => {
          operationQueries.push(query);
          return operations.filter((op) => matches(query.where.OR, op));
        },
      },
      xeroObjectLink: {
        findMany: async (query: { where: { OR: Array<{ localModel: string; localId: string }> } }) =>
          links.filter((link) => matches(query.where.OR, link)),
      },
    };

    const result = await auditIbHoldClearingUnderclears({ db: fakeDb as never });

    expect(result.invoiceBearingHolds).toBe(3);
    expect(result.noInvoiceReleasedHolds).toBe(1);
    expect(result.underCleared.map((finding) => [finding.bookingId, finding.deltaCents])).toEqual([
      ["booking_failed", 15000],
      ["booking_old", 15000],
    ]);
    expect(result.totalDeltaCents).toBe(30000);
    // Both shapes are asked for: the booking's clearing note and the payment's
    // refund note.
    expect(operationQueries[0]).toMatchObject({
      where: {
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        OR: [
          { localModel: "Booking", localId: "booking_new", queueType: "MODIFICATION_CREDIT_NOTE" },
          { localModel: "Payment", localId: "pay_new", queueType: "REFUND_CREDIT_NOTE" },
        ],
      },
    });
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
    // #2397: no upward-modification delta on this payment — the ordinary shape,
    // where a mirror residual has no legitimate cause and IS drift.
    additionalAmountCents: 0,
    additionalPaymentStatus: null,
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

  it("names the uncollected addition that legitimately explains a negative residual (#2397)", () => {
    // A cash settlement the admin said did NOT cover a $21.00 addition: the
    // club recorded $79.00 against a $100.00 booking with $0 credit, so the
    // residual is −$21.00 and the generalised mirror
    // (amount + credit + uncollected = price) holds exactly. Without the extra
    // reported beside it, an operator reads −$21.00 with nothing naming its
    // cause and treats correct books as drift.
    const finding = deriveIbAppliedCreditStrandFinding(
      makeStrandRow({
        amountCents: 7900,
        creditAppliedCents: 0,
        finalPriceCents: 10000,
        ledgerAppliedCents: 3000,
        additionalAmountCents: 2100,
        additionalPaymentStatus: "PENDING",
      }),
    );
    expect(finding?.mirrorInvariantDeltaCents).toBe(-2100);
    expect(finding?.uncollectedAdditionalCents).toBe(2100);
  });

  it("reports a COLLECTED addition as no residual cause at all (#2397)", () => {
    const finding = deriveIbAppliedCreditStrandFinding(
      makeStrandRow({
        additionalAmountCents: 2100,
        additionalPaymentStatus: "SUCCEEDED",
      }),
    );
    expect(finding?.uncollectedAdditionalCents).toBe(0);
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

describe("formatIbHoldClearingAuditReport (#3302, #3325)", () => {
  // This report's amounts render through the shared `formatCents` (#3325);
  // under the default configuration (en-NZ, NZD) that is a plain "$". Pinned
  // so a future edit back to a hand-rolled prefix is a deliberate decision
  // rather than accidental drift.
  it("renders the total open delta in the club's configured currency", () => {
    const report = formatIbHoldClearingAuditReport({
      scannedReleasedHolds: 0,
      invoiceBearingHolds: 0,
      noInvoiceReleasedHolds: 0,
      underCleared: [],
      totalDeltaCents: 0,
    }, CLUB_FORMAT_TEST);

    expect(report).toContain("Total open delta:              $0.00");
    expect(report).toContain("No under-cleared invoices. Nothing to repair.");
  });

  // #3302 review (equivalence lens F6): the zero-cents fixture above cannot
  // distinguish the current rendering from mutations that would change a real
  // line — dropping thousands grouping, re-adding a hard-coded prefix, or
  // moving the sign — because all render identically to "$0.00" at zero. A
  // price in the thousands plus a negative delta catches each of them.
  it("groups a >=$1,000 price and puts a negative delta's sign before the currency symbol", () => {
    const finding = {
      bookingId: "booking_1",
      paymentId: "pay_1",
      bookingStatus: "CANCELLED",
      invoiceRef: "INV-001",
      clearingNotes: [],
      finalPriceCents: 123456,
      // Not a value #1597's own sizing can produce (the interface's own
      // comment says "always > 0"); the formatter must still render it as a
      // plain synthetic-but-instructive fixture value — this test is
      // exercising the FORMATTER's every arithmetic branch, not the finding's
      // domain derivation, which `deriveIbHoldClearingFinding` above already
      // covers.
      changeFeeCents: -500,
      xeroAllocatedAppliedCreditCents: 0,
      expectedClearingCents: 122956,
      allocatedClearingCents: 0,
      deltaCents: 122956,
    };
    const report = formatIbHoldClearingAuditReport({
      scannedReleasedHolds: 1,
      invoiceBearingHolds: 1,
      noInvoiceReleasedHolds: 0,
      underCleared: [finding],
      totalDeltaCents: 122956,
    }, CLUB_FORMAT_TEST);

    // Thousands grouping, as `formatCents` renders it everywhere else: catches
    // a swap back to a hand-rolled `toFixed(2)` (which would print "$1234.56").
    expect(report).toContain("final price:      $1,234.56");
    // The sign sits BEFORE the symbol: catches a mutation that dropped it or
    // rendered the absolute value.
    expect(report).toContain("change fee:       -$5.00");
    // The hard-coded prefix #3325 removed must not come back.
    expect(report).not.toContain("NZ$");
    expect(report).not.toContain("$1234.56");
    expect(report).toContain("clearing notes:   none - the invoice may be fully open");
  });

  // #3535: the operator reads which shape cleared the invoice, and when a size
  // was assumed rather than recorded.
  it("names each clearing note's shape, size and operation status", () => {
    const report = formatIbHoldClearingAuditReport({
      scannedReleasedHolds: 1,
      invoiceBearingHolds: 1,
      noInvoiceReleasedHolds: 0,
      underCleared: [
        {
          bookingId: "booking_1",
          paymentId: "pay_1",
          bookingStatus: "CANCELLED",
          invoiceRef: "INV-001",
          clearingNotes: [
            {
              kind: "allocated-clearing-note",
              creditNoteId: "cn_1",
              amountCents: 1000,
              operationStatus: "PARTIAL",
              allocatedCents: 0,
            },
            {
              kind: "allocated-clearing-note",
              creditNoteId: null,
              amountCents: 15000,
              operationStatus: "FAILED",
              allocatedCents: 0,
            },
            { kind: "refund-note", creditNoteId: "cn_2", amountCents: null, operationStatus: null, allocatedCents: 0 },
          ],
          finalPriceCents: 15000,
          changeFeeCents: 0,
          xeroAllocatedAppliedCreditCents: 0,
          expectedClearingCents: 15000,
          allocatedClearingCents: 0,
          deltaCents: 15000,
        },
      ],
      totalDeltaCents: 15000,
    }, CLUB_FORMAT_TEST);

    expect(report).toContain(
      "clearing notes:   allocated clearing note (#3535) ($10.00, PARTIAL; $0.00 allocated); clearing note (#3535) NOT created ($150.00, FAILED); refund note (before #3535) issued, invoice NOT cleared unless allocated by hand (size not recorded; $0.00 allocated)",
    );
  });
});
