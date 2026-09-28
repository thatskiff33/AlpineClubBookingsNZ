import { beforeEach, describe, expect, it, vi } from "vitest";

// Issue #818 / #1162: surface refunds whose Xero credit-note follow-up never
// completed. Refunds can settle across several per-delta credit notes, so a
// payment is flagged when its refunded amount still exceeds the cents already
// covered by active refund credit notes (not merely when xeroRefundCreditNoteId
// is null).

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  sumCovered: vi.fn(),
  resolveEvidence: vi.fn(),
  findResolvedRefundCreditNoteCreate: vi.fn(),
}));

vi.mock("@/lib/xero-resolved-in-xero-fences", () => ({
  findResolvedRefundCreditNoteCreate: mocks.findResolvedRefundCreditNoteCreate,
  findResolvedBookingInvoiceCreate: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: { findMany: mocks.findMany },
  },
}));

vi.mock("@/lib/xero-sync", () => ({
  sumCoveredRefundCreditNoteCents: mocks.sumCovered,
}));

// #2902: the flagged amount is the provider-backed cash refund evidence, not
// the refundedAmountCents mirror. Resolution rules are unit-tested in
// stripe-cash-refund-evidence.test.ts; here it defaults to cash === mirror so
// the pre-#2902 scenarios keep their meaning.
vi.mock("@/lib/stripe-cash-refund-evidence", () => ({
  resolveStripeCashRefundEvidence: mocks.resolveEvidence,
}));

import {
  REFUND_CREDIT_NOTE_GRACE_HOURS,
  getRefundsMissingXeroCreditNotes,
} from "@/lib/xero-admin-health";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sumCovered.mockResolvedValue(0);
  mocks.findResolvedRefundCreditNoteCreate.mockResolvedValue(null);
  mocks.resolveEvidence.mockImplementation(
    async (payment: { refundedAmountCents: number }) => ({
      cashRefundCents: payment.refundedAmountCents,
      countedRefundCents: payment.refundedAmountCents,
      refundLedgerRowCount: 1,
      accountCreditCents: 0,
      source: "provider-ledger",
    })
  );
});

describe("getRefundsMissingXeroCreditNotes (issue #818/#1162)", () => {
  it("queries refunded, invoiced Stripe payments past the grace window without the credit-note flag", async () => {
    mocks.findMany.mockResolvedValue([]);
    const now = new Date("2026-06-21T12:00:00.000Z");

    const result = await getRefundsMissingXeroCreditNotes({ now });

    expect(result).toEqual({ count: 0, payments: [] });
    const where = mocks.findMany.mock.calls[0][0].where;
    expect(where.source).toBe("STRIPE");
    expect(where.refundedAmountCents).toEqual({ gt: 0 });
    // The single-note xeroRefundCreditNoteId filter is dropped: coverage is now
    // computed per payment so multi-note refunds are handled.
    expect(where.xeroRefundCreditNoteId).toBeUndefined();
    expect(where.xeroInvoiceId).toEqual({ not: null });
    expect(where.updatedAt.lt).toEqual(
      new Date(now.getTime() - REFUND_CREDIT_NOTE_GRACE_HOURS * 60 * 60 * 1000),
    );
  });

  it("formats divergent payments with member context and honours the limit", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "pay_1",
        bookingId: "book_1",
        refundedAmountCents: 4200,
        updatedAt: new Date("2026-06-19T00:00:00.000Z"),
        booking: {
          member: {
            firstName: "Sam",
            lastName: "Lee",
            email: "sam@example.com",
          },
        },
      },
    ]);
    mocks.sumCovered.mockResolvedValue(0);

    const result = await getRefundsMissingXeroCreditNotes({ limit: 1 });

    expect(result.count).toBe(1);
    expect(result.payments[0]).toEqual({
      paymentId: "pay_1",
      bookingId: "book_1",
      memberName: "Sam Lee",
      memberEmail: "sam@example.com",
      refundedAmountCents: 4200,
      cashRefundedCents: 4200,
      uncoveredCents: 4200,
      refundedAt: "2026-06-19T00:00:00.000Z",
    });
  });

  it("leaves out a payment whose refund note an officer resolved by hand in Xero (#3635)", async () => {
    const row = (id: string) => ({
      id,
      bookingId: `book_${id}`,
      refundedAmountCents: 4200,
      updatedAt: new Date("2026-06-19T00:00:00.000Z"),
      booking: { member: { firstName: "Sam", lastName: "Lee", email: "sam@example.com" } },
    });
    mocks.findMany.mockResolvedValue([row("pay_resolved"), row("pay_open")]);
    mocks.findResolvedRefundCreditNoteCreate.mockImplementation(async (paymentId: string) =>
      paymentId === "pay_resolved"
        ? { id: "op_note", manuallyResolvedAt: new Date("2026-06-20T00:00:00.000Z") }
        : null
    );

    const result = await getRefundsMissingXeroCreditNotes();

    // The nightly self-heal reads this list: it must not re-mint the note.
    expect(result.payments.map((payment) => payment.paymentId)).toEqual(["pay_open"]);
  });

  it("flags only the still-uncovered remainder and drops fully-covered refunds", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "pay_partial",
        bookingId: "book_1",
        refundedAmountCents: 8000,
        updatedAt: new Date("2026-06-19T00:00:00.000Z"),
        booking: {
          member: { firstName: "Sam", lastName: "Lee", email: "sam@example.com" },
        },
      },
      {
        id: "pay_covered",
        bookingId: "book_2",
        refundedAmountCents: 5000,
        updatedAt: new Date("2026-06-19T00:00:00.000Z"),
        booking: {
          member: { firstName: "Jo", lastName: "Ng", email: "jo@example.com" },
        },
      },
    ]);
    mocks.sumCovered.mockImplementation(async (paymentId: string) =>
      paymentId === "pay_partial" ? 5000 : 5000,
    );

    const result = await getRefundsMissingXeroCreditNotes();

    expect(result.count).toBe(1);
    expect(result.payments).toEqual([
      {
        paymentId: "pay_partial",
        bookingId: "book_1",
        memberName: "Sam Lee",
        memberEmail: "sam@example.com",
        refundedAmountCents: 8000,
        cashRefundedCents: 8000,
        uncoveredCents: 3000,
        refundedAt: "2026-06-19T00:00:00.000Z",
      },
    ]);
  });

  it("excludes account-credit-only cancellations and flags only the cash-uncovered remainder (#2902)", async () => {
    mocks.findMany.mockResolvedValue([
      {
        // Account-credit-only cancellation: mirror > 0, cash evidence 0.
        id: "pay_credit_only",
        bookingId: "book_credit",
        refundedAmountCents: 34100,
        updatedAt: new Date("2026-06-19T00:00:00.000Z"),
        booking: {
          member: { firstName: "Ana", lastName: "Ito", email: "ana@example.com" },
        },
      },
      {
        // Mixed disposition: 9000 mirror of which only 4000 was Stripe cash.
        id: "pay_mixed",
        bookingId: "book_mixed",
        refundedAmountCents: 9000,
        updatedAt: new Date("2026-06-19T00:00:00.000Z"),
        booking: {
          member: { firstName: "Sam", lastName: "Lee", email: "sam@example.com" },
        },
      },
    ]);
    mocks.resolveEvidence.mockImplementation(async (payment: { id: string }) =>
      payment.id === "pay_credit_only"
        ? {
            cashRefundCents: 0,
            countedRefundCents: 0,
            refundLedgerRowCount: 0,
            accountCreditCents: 34100,
            source: "legacy-mirror",
          }
        : {
            cashRefundCents: 4000,
            countedRefundCents: 4000,
            refundLedgerRowCount: 1,
            accountCreditCents: 0,
            source: "provider-ledger",
          }
    );
    mocks.sumCovered.mockResolvedValue(1000);

    const result = await getRefundsMissingXeroCreditNotes();

    // The credit-only payment never reaches the coverage query at all.
    expect(mocks.sumCovered).toHaveBeenCalledTimes(1);
    expect(mocks.sumCovered).toHaveBeenCalledWith("pay_mixed");
    expect(result.count).toBe(1);
    expect(result.payments).toEqual([
      {
        paymentId: "pay_mixed",
        bookingId: "book_mixed",
        memberName: "Sam Lee",
        memberEmail: "sam@example.com",
        refundedAmountCents: 9000,
        cashRefundedCents: 4000,
        uncoveredCents: 3000,
        refundedAt: "2026-06-19T00:00:00.000Z",
      },
    ]);
  });
});
