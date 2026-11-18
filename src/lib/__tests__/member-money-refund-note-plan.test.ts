import { describe, expect, it, vi } from "vitest";

// The builders' modules load the client; the planners never query it.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { buildRefundCreditNotePayment } from "@/lib/xero-invoice-payments";
import { hutFeeRefundLine } from "@/lib/xero-hut-fee-line-codes";
import { stableDigest } from "@/lib/stable-digest";
import { sanitizeForJson } from "@/lib/xero-sync";
import { planRefundNote } from "@/lib/member-money/internal/refund-note-plan";
import { planRefundNotePayment } from "@/lib/member-money/internal/refund-payment-plan";

/** #4525 (Ledger M13): the refund note and its payment, planned. */

const mapping = { code: "260", itemCode: null, codeExplicitlyConfigured: true };
const debt = { account: "REFUND_PAYABLE" as const, chargeIdentity: "refund-obligation|cancellation|c-1", cents: 5000 };
const line = hutFeeRefundLine("Refund - booking b-1", 5000, mapping);

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
    expect(planRefundNotePayment({ ...input, refundMethod: "internet-banking", cash: { account: "BANK", chargeIdentity: "paid-another-way:t", cents: 5000 } }))
      .toMatchObject({ outcome: "COVERED" });
    expect(planRefundNotePayment({ ...input, cash: debt })).toMatchObject({ outcome: "CONFLICT", reason: "COMPONENT_UNUSABLE" });
    expect(planRefundNotePayment({ ...input, cash: { account: "BANK", chargeIdentity: "x", cents: 4999 } })).toMatchObject({ outcome: "CONFLICT", reason: "CENTS" });
  });
});
