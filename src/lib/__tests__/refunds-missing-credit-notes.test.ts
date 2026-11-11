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
  readResolvedRefundCreditNoteCoverage: vi.fn(),
  readPaidAnotherWayUncoveredCents: vi.fn(),
  linkFindMany: vi.fn(),
}));

// #3924 round 8: the closes' bank cash their own notes do not cover. Its
// counting is `card-refund-paid-another-way.realdb.test.ts`'s.
vi.mock("@/lib/card-refund-paid-another-way-cash", () => ({
  readPaidAnotherWayUncoveredCents: (...a: unknown[]) => mocks.readPaidAnotherWayUncoveredCents(...a),
}));

vi.mock("@/lib/xero-resolved-in-xero-fences", () => ({
  readResolvedRefundCreditNoteCoverage: mocks.readResolvedRefundCreditNoteCoverage,
  // The real composition, over the two mocked halves.
  sumRefundCreditNoteCoverageCents: async (
    paymentId: string,
    resolved: { coveredCents: number },
  ) => (await mocks.sumCovered(paymentId)) + resolved.coveredCents,
  findResolvedBookingInvoiceCreate: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: { findMany: mocks.findMany },
    // #4936: the pre-filter's one read of the candidates' active refund-note links.
    xeroObjectLink: { findMany: mocks.linkFindMany },
    // #3635 round-3 R1: no refund row names a late capture unless a test says so.
    paymentRefund: { findMany: async () => [] },
  },
}));

// #4936: the pre-filter's bulk link read is the real one, over `linkFindMany`.
vi.mock("@/lib/xero-sync", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-sync")),
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
  mocks.linkFindMany.mockResolvedValue([]);
  mocks.readPaidAnotherWayUncoveredCents.mockResolvedValue(0);
  mocks.readResolvedRefundCreditNoteCoverage.mockResolvedValue({
    coveredCents: 0,
    correlationKeys: [],
    operationIds: [],
    unreadableOperationIds: [],
  });
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
      paidAnotherWayUncoveredCents: 0,
      refundedAt: "2026-06-19T00:00:00.000Z",
    });
  });

  // #3924 round 8 (money review, `INV-PAY-122`): the part of the gap a card
  // note must not fill - never more than the gap itself.
  it("MUTATION: says how much of the gap is a paid-another-way close's bank cash its own notes do not cover", async () => {
    const row = (id: string, refundedAmountCents: number) => ({
      id,
      bookingId: `book_${id}`,
      refundedAmountCents,
      updatedAt: new Date("2026-06-19T00:00:00.000Z"),
      booking: { member: { firstName: "Sam", lastName: "Lee", email: "sam@example.com" } },
    });
    mocks.findMany.mockResolvedValue([row("pay_close", 8000), row("pay_capped", 3000)]);
    mocks.sumCovered.mockImplementation(async (paymentId: string) => (paymentId === "pay_capped" ? 1000 : 0));
    mocks.readPaidAnotherWayUncoveredCents.mockResolvedValue(3000);

    const result = await getRefundsMissingXeroCreditNotes();

    expect(mocks.readPaidAnotherWayUncoveredCents).toHaveBeenCalledWith(expect.anything(), "pay_close");
    expect(result.payments.map((payment) => [payment.uncoveredCents, payment.paidAnotherWayUncoveredCents])).toEqual([
      [8000, 3000],
      [2000, 2000],
    ]);
  });

  it("counts a hand-resolved note's amount as covered, and still lists a later refund beyond it (#3635 round 4)", async () => {
    // $50 refunded, its note raised by hand and resolved; then $30 more.
    const row = (id: string, refundedAmountCents: number) => ({
      id,
      bookingId: `book_${id}`,
      refundedAmountCents,
      updatedAt: new Date("2026-06-19T00:00:00.000Z"),
      booking: { member: { firstName: "Sam", lastName: "Lee", email: "sam@example.com" } },
    });
    mocks.findMany.mockResolvedValue([row("pay_only_resolved", 5000), row("pay_second_refund", 8000)]);
    mocks.readResolvedRefundCreditNoteCoverage.mockResolvedValue({
      coveredCents: 5000,
      correlationKeys: ["payment:x:refund-credit-note:5000:v2"],
      operationIds: ["op_note"],
      unreadableOperationIds: [],
    });

    const result = await getRefundsMissingXeroCreditNotes();

    // The first is covered by the hand-made note, so the self-heal leaves it;
    // the second is listed for exactly the $30 no note covers.
    expect(result.payments).toEqual([
      expect.objectContaining({ paymentId: "pay_second_refund", uncoveredCents: 3000 }),
    ]);
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
        paidAnotherWayUncoveredCents: 0,
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
        paidAnotherWayUncoveredCents: 0,
        refundedAt: "2026-06-19T00:00:00.000Z",
      },
    ]);
  });
});

// #4936: the refunded-payment list only grows, so payments its active links
// already cover up to the refunded mirror are dropped in one query before the
// per-payment exact reader. The reader's first read is the cash evidence, so
// `resolveEvidence`'s calls say which payments reached it.
describe("getRefundsMissingXeroCreditNotes link-coverage pre-filter (#4936)", () => {
  const row = (id: string, refundedAmountCents: number) => ({
    id,
    bookingId: `book_${id}`,
    refundedAmountCents,
    updatedAt: new Date("2026-06-19T00:00:00.000Z"),
    booking: { member: { firstName: "Sam", lastName: "Lee", email: "sam@example.com" } },
  });
  const link = (paymentId: string, metadata: Record<string, unknown>) => ({ localId: paymentId, metadata });
  const reachedExactReader = () => mocks.resolveEvidence.mock.calls.map(([payment]) => payment.id);

  it("never asks the exact reader about a payment its links' recorded amounts fully cover", async () => {
    mocks.findMany.mockResolvedValue([row("pay_covered", 5000), row("pay_over", 3000), row("pay_split", 6000)]);
    mocks.linkFindMany.mockResolvedValue([
      link("pay_covered", { amountCents: 5000 }),
      link("pay_over", { amountCents: 3500 }),
      link("pay_split", { amountCents: 2500 }),
      link("pay_split", { amountCents: 3500 }),
    ]);

    const result = await getRefundsMissingXeroCreditNotes();

    expect(reachedExactReader()).toEqual([]);
    expect(result).toEqual({ count: 0, payments: [] });
  });

  it("MUTATION: still reports a payment its links cover by even one cent less than refunded", async () => {
    mocks.findMany.mockResolvedValue([row("pay_short", 5000), row("pay_unlinked", 2000)]);
    mocks.linkFindMany.mockResolvedValue([link("pay_short", { amountCents: 4999 })]);
    mocks.sumCovered.mockImplementation(async (paymentId: string) => (paymentId === "pay_short" ? 4999 : 0));

    const result = await getRefundsMissingXeroCreditNotes();

    expect(reachedExactReader()).toEqual(["pay_short", "pay_unlinked"]);
    expect(result.payments.map((payment) => [payment.paymentId, payment.uncoveredCents])).toEqual([
      ["pay_short", 1],
      ["pay_unlinked", 2000],
    ]);
  });

  it("does not skip on a legacy link with no recorded amount, nor on a link Xero voided", async () => {
    // The exact reader recovers a legacy link's amount from its create payload;
    // the pre-filter may not, so it counts 0 and lets the exact reader judge.
    mocks.findMany.mockResolvedValue([row("pay_legacy", 5000), row("pay_voided", 5000)]);
    mocks.linkFindMany.mockResolvedValue([
      link("pay_legacy", { status: "AUTHORISED" }),
      link("pay_voided", { amountCents: 5000, status: "VOIDED" }),
    ]);
    mocks.sumCovered.mockImplementation(async (paymentId: string) => (paymentId === "pay_legacy" ? 2000 : 0));

    const result = await getRefundsMissingXeroCreditNotes();

    expect(reachedExactReader()).toEqual(["pay_legacy", "pay_voided"]);
    expect(result.payments.map((payment) => [payment.paymentId, payment.uncoveredCents])).toEqual([
      ["pay_legacy", 3000],
      ["pay_voided", 5000],
    ]);
  });

  it("reads every candidate's links in one query and keeps count and order with limit 1", async () => {
    mocks.findMany.mockResolvedValue([row("pay_a", 4000), row("pay_covered", 5000), row("pay_b", 3000)]);
    mocks.linkFindMany.mockResolvedValue([link("pay_covered", { amountCents: 5000 })]);

    const result = await getRefundsMissingXeroCreditNotes({ limit: 1 });

    expect(mocks.linkFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.linkFindMany.mock.calls[0][0].where).toEqual({
      localModel: "Payment",
      localId: { in: ["pay_a", "pay_covered", "pay_b"] },
      xeroObjectType: "CREDIT_NOTE",
      role: "REFUND_CREDIT_NOTE",
      active: true,
    });
    expect(result.count).toBe(2);
    expect(result.payments.map((payment) => payment.paymentId)).toEqual(["pay_a"]);
  });
});
