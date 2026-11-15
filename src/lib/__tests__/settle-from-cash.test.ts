import { describe, expect, it, vi } from "vitest";

// Pure units: no database. The modules' Prisma import is stubbed so this file
// loads without a DATABASE_URL.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import {
  paidInvoiceFacts,
  planInternetBankingCashSettlement,
  type CashSettlementTransaction,
} from "@/lib/xero-inbound/settle-from-cash";
import { receiptCountsInvoiceCorrections } from "@/lib/xero-inbound/ib-receipt-reasons";
import { readCashSettlementNotice } from "@/lib/xero-inbound/settle-from-cash-notice";
import { ibSettlementFigureParagraph } from "@/lib/ib-settlement-figure-note";
import { adminBankTransferSettlementFigureTemplate } from "@/lib/email-templates/admin-bank-transfer-settlement";

/**
 * #3979 (`INV-PAY-125`): the one decision on whether a bank transfer's settle
 * records the cash its invoice collected. The reconcile's own suite
 * (`xero-inbound-reconciliation.test.ts`) drives it through the settle; this
 * pins every arm on its own.
 */
const primary = (overrides: Partial<CashSettlementTransaction> = {}): CashSettlementTransaction => ({
  kind: "PRIMARY",
  source: "INTERNET_BANKING",
  status: "PENDING",
  amountCents: 30_000,
  refundedAmountCents: 0,
  ...overrides,
});

const base = {
  refundedAmountCents: 0,
  transactions: [primary()],
  cash: { knownCents: 20_000, complete: true },
  matchedPayments: 1,
  secondInstrument: false,
  appliedNotes: { refundWordedCents: 0, noCashCents: 0 },
};

const rewrite = (receiptCents: number, paymentAmountCents = receiptCents, refundedAmountCents = 0, status = "SUCCEEDED") => ({
  kind: "rewrite",
  receiptCents,
  paymentAmountCents,
  refundedAmountCents,
  status,
});

describe("planInternetBankingCashSettlement (#3979, INV-PAY-125)", () => {
  it("rewrites to the cash at the transition", () => {
    expect(planInternetBankingCashSettlement(base)).toEqual(rewrite(20_000));
  });

  it("rewrites when no PRIMARY row exists yet (the settle mints one)", () => {
    expect(planInternetBankingCashSettlement({ ...base, transactions: [] })).toEqual(rewrite(20_000));
  });

  it("rewrites a FAILED PRIMARY row (a cancelled booking's never-captured payment)", () => {
    expect(planInternetBankingCashSettlement({ ...base, transactions: [primary({ status: "FAILED" })] })).toEqual(
      rewrite(20_000),
    );
  });

  it.each(["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"] as const)(
    "decides nothing again once the PRIMARY row is %s (a replay)",
    (status) => {
      expect(planInternetBankingCashSettlement({ ...base, transactions: [primary({ status })] })).toEqual({ kind: "replay" });
    },
  );

  it("a card capture refunded before the switch (#1765): the receipt is the cash, the payment the cash plus the card, part refunded", () => {
    const card: CashSettlementTransaction = {
      kind: "PRIMARY",
      source: "STRIPE",
      status: "REFUNDED",
      amountCents: 30_000,
      refundedAmountCents: 30_000,
    };
    expect(
      planInternetBankingCashSettlement({ ...base, refundedAmountCents: 30_000, transactions: [card, primary()] }),
    ).toEqual(rewrite(20_000, 50_000, 30_000, "PARTIALLY_REFUNDED"));
  });

  it("arithmetic pin (#4177): a captured, unrefunded card row beside the bank receipt counts towards the payment's figure, never the receipt", () => {
    // A pin of the plan's arithmetic only, not a proof of #4177's behaviour:
    // that a paid booking whose only card capture is one the superseded-intent
    // machinery holds reaches this plan with `secondInstrument: false` is
    // proven through the settle in `issue-3638-second-instrument-conflict.test.ts`.
    const cardCapture: CashSettlementTransaction = {
      kind: "PRIMARY",
      source: "STRIPE",
      status: "SUCCEEDED",
      amountCents: 30_000,
      refundedAmountCents: 0,
    };
    expect(
      planInternetBankingCashSettlement({ ...base, transactions: [cardCapture, primary()], secondInstrument: false }),
    ).toEqual(rewrite(20_000, 50_000));
  });

  it("a captured addition counts towards the payment's figure, never the receipt", () => {
    const addition: CashSettlementTransaction = {
      kind: "ADDITIONAL",
      source: "STRIPE",
      status: "SUCCEEDED",
      amountCents: 500,
      refundedAmountCents: 0,
    };
    expect(planInternetBankingCashSettlement({ ...base, transactions: [primary(), addition] })).toEqual(
      rewrite(20_000, 20_500),
    );
  });

  it.each([
    ["second-instrument", { secondInstrument: true }],
    ["cash-incomplete", { cash: { knownCents: 20_000, complete: false } }],
    ["cash-zero", { cash: { knownCents: 0, complete: true } }],
    ["several-payments", { matchedPayments: 2 }],
    ["refund-note-applied", { appliedNotes: { refundWordedCents: 1, noCashCents: 0 } }],
    ["folded-refund", { refundedAmountCents: 1 }],
    ["several-primary-rows", { transactions: [primary(), primary()] }],
  ] as const)("keeps the stored figure: %s", (reason, overrides) => {
    expect(planInternetBankingCashSettlement({ ...base, ...overrides })).toEqual({ kind: "keep", reason });
  });

  it("a refund-worded note applied to the invoice keeps the figure even with its fold already in (review D)", () => {
    expect(
      planInternetBankingCashSettlement({
        ...base,
        refundedAmountCents: 10_000,
        appliedNotes: { refundWordedCents: 10_000, noCashCents: 0 },
      }),
    ).toEqual({ kind: "keep", reason: "refund-note-applied" });
  });

  it("clears a fold the invoice's no-cash notes exactly explain, and only then (review A)", () => {
    expect(
      planInternetBankingCashSettlement({
        ...base,
        refundedAmountCents: 10_000,
        appliedNotes: { refundWordedCents: 0, noCashCents: 10_000 },
      }),
    ).toEqual(rewrite(20_000));
    expect(
      planInternetBankingCashSettlement({
        ...base,
        refundedAmountCents: 10_000,
        appliedNotes: { refundWordedCents: 0, noCashCents: 9_999 },
      }),
    ).toEqual({ kind: "keep", reason: "folded-refund" });
  });

  it("a refunded total a row records is not a fold", () => {
    const card: CashSettlementTransaction = {
      kind: "PRIMARY",
      source: "STRIPE",
      status: "PARTIALLY_REFUNDED",
      amountCents: 30_000,
      refundedAmountCents: 10_000,
    };
    expect(
      planInternetBankingCashSettlement({ ...base, refundedAmountCents: 15_000, transactions: [card, primary()] }),
    ).toEqual({ kind: "keep", reason: "folded-refund" });
    expect(
      planInternetBankingCashSettlement({ ...base, refundedAmountCents: 10_000, transactions: [card, primary()] }),
    ).toEqual(rewrite(20_000, 50_000, 10_000, "PARTIALLY_REFUNDED"));
  });

  it("an uncaptured card row does not refuse the rewrite", () => {
    const plan = planInternetBankingCashSettlement({
      ...base,
      transactions: [primary(), { kind: "PRIMARY", source: "STRIPE", status: "FAILED", amountCents: 30_000, refundedAmountCents: 0 }],
    });
    expect(plan).toEqual(rewrite(20_000));
  });
});

describe("receiptCountsInvoiceCorrections (#3979 review A)", () => {
  const receipt = (status: CashSettlementTransaction["status"], reason: string | null) => ({
    kind: "PRIMARY" as const,
    source: "INTERNET_BANKING" as const,
    status,
    reason,
  });

  it("counts a correction against a receipt recorded at the stored figure", () => {
    expect(receiptCountsInvoiceCorrections([receipt("SUCCEEDED", "xero_invoice_paid_reconciliation")])).toBe(true);
    expect(receiptCountsInvoiceCorrections([receipt("SUCCEEDED", null)])).toBe(true);
  });

  it.each(["internet_banking_booking_payment", "internet_banking_switch_at_pay", "legacy_primary_backfill"])(
    "counts it against a receipt still carrying its birth reason %s",
    (reason) => {
      expect(receiptCountsInvoiceCorrections([receipt("SUCCEEDED", reason)])).toBe(true);
    },
  );

  it.each(["xero_part_payment_recognised_at_cancel", "manual_mark_paid", "something_new"])(
    "MUTATION: never against a cash-sized receipt (%s) - the stored-figure reasons are an allowlist (#3979 final review)",
    (reason) => {
      expect(receiptCountsInvoiceCorrections([receipt("PARTIALLY_REFUNDED", reason)])).toBe(false);
    },
  );

  it("never against a receipt recorded from cash, or one not captured", () => {
    expect(receiptCountsInvoiceCorrections([receipt("SUCCEEDED", "xero_invoice_paid_cash")])).toBe(false);
    expect(receiptCountsInvoiceCorrections([receipt("PENDING", null)])).toBe(false);
    expect(receiptCountsInvoiceCorrections([])).toBe(false);
  });
});

describe("paidInvoiceFacts (#3979)", () => {
  it("reads the total and the applied notes in cents, dropping unreadable or empty ones", () => {
    expect(
      paidInvoiceFacts({
        total: 123.45,
        creditNotes: [
          { creditNoteID: "cn-1", appliedAmount: 20 },
          { creditNoteID: "cn-2", appliedAmount: 0 },
          { appliedAmount: 5 },
        ],
      }),
    ).toEqual({ totalCents: 12_345, appliedCreditNotes: [{ id: "cn-1", appliedCents: 2_000 }] });
    expect(paidInvoiceFacts({})).toEqual({ totalCents: null, appliedCreditNotes: [] });
  });
});

describe("readCashSettlementNotice (#3979)", () => {
  // Any read through this client fails the test: these plans ask nothing.
  const untouchable = new Proxy({}, {
    get: (_target, property) => {
      throw new Error(`unexpected read of tx.${String(property)}`);
    },
  }) as never;
  const input = {
    recordedCents: 30_000,
    cash: { knownCents: 20_000, complete: true },
    matchedPayments: 1,
    booking: { id: "b-1", finalPriceCents: 25_000, cancelled: false },
    changeFeeCents: null,
  };

  it.each([
    ["a replay", { kind: "replay" } as const],
    ["a second instrument (#3638 alerts on its own)", { kind: "keep", reason: "second-instrument" } as const],
  ])("says nothing, and reads nothing, for %s", async (_label, plan) => {
    expect(await readCashSettlementNotice(untouchable, { ...input, plan })).toBeNull();
  });

  it("does not cross-check a cancelled booking: its late-cash arm alerts on its own", async () => {
    expect(
      await readCashSettlementNotice(untouchable, {
        ...input,
        plan: rewrite(20_000) as never,
        booking: { ...input.booking, cancelled: true },
      }),
    ).toBeNull();
  });
});

describe("the alert's words (#3979)", () => {
  it("names the kept figure's reason and who corrects it", () => {
    const text = ibSettlementFigureParagraph({ keptReason: "several-payments", owed: null, hasSupplementaryInvoice: false });
    expect(text).toContain("kept the amount it had recorded instead of the cash, because the invoice matched more than one payment");
    expect(text).toContain("the owner or a developer");
    expect(text).toContain("recorded and refunded amounts together");
  });

  it("says which way the member is out when the cash disagrees with what is owed", () => {
    expect(ibSettlementFigureParagraph({ keptReason: null, owed: "overpaid", hasSupplementaryInvoice: false })).toBe(
      "The member paid more than the booking owes: refund or credit the difference.",
    );
    expect(ibSettlementFigureParagraph({ keptReason: null, owed: "underpaid", hasSupplementaryInvoice: true })).toBe(
      "The member paid less than the booking owes, by more than its supplementary invoice bills: collect the rest.",
    );
  });

  it("renders the figures through the club's format", () => {
    const html = adminBankTransferSettlementFigureTemplate(
      {
        memberName: "Ada",
        checkIn: new Date("2026-08-01T00:00:00.000Z"),
        checkOut: new Date("2026-08-02T00:00:00.000Z"),
        bookingId: "b-1",
        keptReason: "folded-refund",
        owed: null,
        hasSupplementaryInvoice: false,
        recordedCents: 30_000,
        cashCents: 20_000,
        owedCents: null,
        xeroInvoiceNumber: "INV-1",
        xeroInvoiceUrl: null,
        bookingUrl: "https://club.test/bookings/b-1",
        reviewUrl: "https://club.test/admin/payments",
      },
      CLUB_FORMAT_TEST,
    );
    expect(html).toContain("Bank Transfer Amount Needs Checking");
    expect(html).toContain("$300.00");
    expect(html).toContain("$200.00");
  });
});
