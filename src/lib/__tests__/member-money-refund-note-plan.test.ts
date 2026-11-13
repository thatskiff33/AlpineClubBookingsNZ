import { describe, expect, it, vi } from "vitest";

// The builders' modules load the client; the planners never query it.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { parseCalendarDate, type CalendarDate } from "@/lib/club-time";
import { buildRefundCreditNotePayment } from "@/lib/xero-invoice-payments";
import { refundDocumentLineItem } from "@/lib/xero-modification-line-items";
import { stableDigest } from "@/lib/stable-digest";
import { sanitizeForJson } from "@/lib/xero-sync";
import { planRefundNote } from "@/lib/member-money/internal/refund-note-plan";
import { planRefundNotePayment } from "@/lib/member-money/internal/refund-payment-plan";
import {
  failedLaterRefundReversalDate,
  failedLaterRefundReversalKey,
  planFailedLaterRefundReversal,
  type FailedLaterRefundReversalInput,
} from "@/lib/member-money/internal/refund-reversal-plan";

/** #4525 (Ledger M13): the refund note, its payment and the failed-later reversal, planned. */

const mapping = { code: "260", itemCode: null, codeExplicitlyConfigured: true };
const debt = { account: "REFUND_PAYABLE" as const, chargeIdentity: "refund-obligation|cancellation|c-1", cents: 5000 };
const line = refundDocumentLineItem("Refund - booking b-1", 5000, mapping);
const date = (text: string): CalendarDate => parseCalendarDate(text)!;

describe("planRefundNote", () => {
  it("covers only the live refund debt, whole, and hashes the lines it sent", () => {
    const plan = planRefundNote({ lines: [line], legacyKey: "key-1", source: "BUILT", obligation: debt });
    expect(plan).toMatchObject({
      outcome: "COVERED",
      legacyKey: "key-1",
      lineTotalCents: 5000,
      payloadHash: stableDigest(sanitizeForJson([line])),
      coverage: [{ account: "REFUND_PAYABLE", chargeIdentity: debt.chargeIdentity, coveredCents: 5000, taxCode: null }],
      frozenMapping: { source: "BUILT", lineCodes: [{ accountCode: "260", itemCode: null, taxType: "OUTPUT2" }] },
    });
  });

  it("is a CENTS conflict with no rows when the note is not the debt's whole gross", () => {
    const plan = planRefundNote({ lines: [line], legacyKey: "key-1", source: "BUILT", obligation: { ...debt, cents: 6000 } });
    expect(plan).toMatchObject({ outcome: "CONFLICT", reason: "CENTS" });
    expect(plan).not.toHaveProperty("coverage");
  });

  it("never covers revenue, and a watermark note naming no debt is unusable", () => {
    expect(planRefundNote({ lines: [line], legacyKey: "k", source: "BUILT", obligation: { ...debt, account: "BOOKING_REVENUE" } }))
      .toMatchObject({ outcome: "CONFLICT", reason: "COMPONENT_UNUSABLE" });
    expect(planRefundNote({ lines: [line], legacyKey: "k", source: "STORED_REQUEST", obligation: { problem: "no one debt" } }))
      .toMatchObject({ outcome: "CONFLICT", reason: "COMPONENT_UNUSABLE", problem: "no one debt", frozenMapping: { source: "STORED_REQUEST" } });
  });
});

describe("planRefundNotePayment", () => {
  const input = {
    paymentId: "pay-1", creditNoteId: "cn-1", amountCents: 5000, bankCode: "090", paymentDate: "2026-07-01",
    refundMethod: "card" as const, legacyKey: "payment-key",
  };

  it("covers the whole R12 on clearing, hashing the body the sender builds", () => {
    const plan = planRefundNotePayment({ ...input, cash: { account: "STRIPE_CLEARING", chargeIdentity: "refund:re_1", cents: 5000 } });
    const body = buildRefundCreditNotePayment({ ...input, refundAmountCents: 5000 });
    expect(plan).toMatchObject({
      outcome: "COVERED",
      payloadHash: stableDigest(sanitizeForJson([body])),
      coverage: [{ account: "STRIPE_CLEARING", chargeIdentity: "refund:re_1", coveredCents: 5000 }],
    });
  });

  it("covers a bank close's R14 on BANK, and never the refund debt", () => {
    expect(planRefundNotePayment({ ...input, refundMethod: "bank-transfer", cash: { account: "BANK", chargeIdentity: "paid-another-way:t", cents: 5000 } }))
      .toMatchObject({ outcome: "COVERED" });
    expect(planRefundNotePayment({ ...input, cash: debt })).toMatchObject({ outcome: "CONFLICT", reason: "COMPONENT_UNUSABLE" });
    expect(planRefundNotePayment({ ...input, cash: { account: "BANK", chargeIdentity: "x", cents: 4999 } })).toMatchObject({ outcome: "CONFLICT", reason: "CENTS" });
  });
});

describe("planFailedLaterRefundReversal", () => {
  const input: FailedLaterRefundReversalInput = {
    paymentId: "pay-1", bookingId: "b-1", stripeRefundId: "re_1", contactId: "contact-1",
    failureDate: date("2026-06-20"), lockDate: null, firstOpenDate: date("2026-07-01"),
    refundMapping: mapping, stripeBankCode: "090",
    reversal: { account: "STRIPE_CLEARING", chargeIdentity: "reversal:journal-1", cents: 5000 },
  };

  it("is one ACCREC invoice coded like the note and a Stripe payment, on the failure day", () => {
    const plan = planFailedLaterRefundReversal(input);
    expect(plan.date).toBe("2026-06-20");
    expect(plan.invoice).toMatchObject({ type: "ACCREC", status: "AUTHORISED", lineAmountTypes: "Inclusive", dueDate: "2026-06-20" });
    expect(plan.invoice.lineItems).toEqual([expect.objectContaining({ accountCode: "260", taxType: "OUTPUT2", unitAmount: 50 })]);
    expect(plan.payment).toMatchObject({ account: { code: "090" }, amount: 50, date: "2026-06-20", isReconciled: false });
    expect(plan.invoice.reference).toContain("refund failed 2026-06-20");
    expect(plan.manifest).toMatchObject({ outcome: "COVERED", coverage: [{ account: "STRIPE_CLEARING", chargeIdentity: "reversal:journal-1", coveredCents: 5000 }] });
  });

  it("steps off a lock date to the first open day, keeping the failure day in its reference", () => {
    const plan = planFailedLaterRefundReversal({ ...input, lockDate: date("2026-06-30") });
    expect(plan.date).toBe("2026-07-01");
    expect(plan.invoice.reference).toContain("refund failed 2026-06-20");
    expect(failedLaterRefundReversalDate(date("2026-06-30"), date("2026-06-30"), date("2026-07-01"))).toBe("2026-07-01");
    expect(failedLaterRefundReversalDate(date("2026-07-02"), date("2026-06-30"), date("2026-07-01"))).toBe("2026-07-02");
  });

  it("keys on the payment and the Stripe refund alone: no watermark or cents", () => {
    const plan = planFailedLaterRefundReversal({ ...input, reversal: { ...input.reversal, cents: 7000 } });
    expect(plan.idempotencyKey).toBe(planFailedLaterRefundReversal(input).idempotencyKey);
    expect(plan.idempotencyKey).toBe(failedLaterRefundReversalKey("pay-1", "re_1"));
    expect(plan.idempotencyKey).not.toMatch(/5000|7000/);
  });

  it("is a conflict when the R13 is missing", () => {
    expect(planFailedLaterRefundReversal({ ...input, reversal: { problem: "no R13" } }).manifest)
      .toMatchObject({ outcome: "CONFLICT", reason: "COMPONENT_UNUSABLE", lineTotalCents: 0 });
  });
});
