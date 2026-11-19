import { describe, expect, it, vi } from "vitest";

// `xero-sync` loads the client; the planner never queries it.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { planCaptureReceipt, type CaptureReceiptPlanInput } from "@/lib/member-money/internal/capture-receipt-plan";

/** #4525 (Ledger M13): a capture receipt covers only cents its capture's live receipt still holds. */

const INTENT = "pi_m13_capture";
const CAPTURE = `capture:${INTENT}`;

function input(overrides: Partial<CaptureReceiptPlanInput> = {}): CaptureReceiptPlanInput {
  return {
    paymentIntentId: INTENT,
    paymentKey: "payment:first:v1",
    amountCents: 5000,
    invoiceId: "INV-1",
    reference: `Stripe ${INTENT}`,
    bankCode: "606",
    captureDebitCents: 8000,
    alreadyCoveredCents: 0,
    ...overrides,
  };
}

describe("planCaptureReceipt (#4525)", () => {
  it("covers part of a capture, then the rest under another key, from the STRIPE_CLEARING receipt", () => {
    const first = planCaptureReceipt(input());
    expect(first).toMatchObject({
      outcome: "COVERED",
      legacyKey: "payment:first:v1",
      lineTotalCents: 5000,
      coverage: [{ account: "STRIPE_CLEARING", chargeIdentity: CAPTURE, coveredCents: 5000, taxCode: null, sliceKey: "payment:first:v1" }],
    });
    const rest = planCaptureReceipt(input({ paymentKey: "payment:second:v1", amountCents: 3000, alreadyCoveredCents: 5000 }));
    expect(rest).toMatchObject({ outcome: "COVERED", lineTotalCents: 3000, coverage: [{ chargeIdentity: CAPTURE, coveredCents: 3000 }] });
  });

  it("refuses one cent more than the capture has left, and covers nothing", () => {
    const over = planCaptureReceipt(input({ paymentKey: "payment:second:v1", amountCents: 3001, alreadyCoveredCents: 5000 }));
    expect(over).toMatchObject({ outcome: "CONFLICT", reason: "CAPTURE_CENTS", lineTotalCents: 0 });
    expect(over).not.toHaveProperty("coverage");
  });

  it("is NOT_JOURNALLED when the payment names no capture, or the capture has no live receipt", () => {
    expect(planCaptureReceipt(input({ paymentIntentId: null }))).toMatchObject({ outcome: "CONFLICT", reason: "CAPTURE_NOT_JOURNALLED", lineTotalCents: 0 });
    expect(planCaptureReceipt(input({ captureDebitCents: null }))).toMatchObject({ outcome: "CONFLICT", reason: "CAPTURE_NOT_JOURNALLED" });
  });

  it("hashes what was sent, so a conflict and a match of the same payment hash alike, and any sent field moves it", () => {
    const covered = planCaptureReceipt(input());
    expect(planCaptureReceipt(input({ captureDebitCents: null })).payloadHash).toBe(covered.payloadHash);
    for (const changed of [{ amountCents: 4999 }, { invoiceId: "INV-2" }, { reference: "other" }, { bankCode: null }, { paymentKey: "payment:other:v1" }]) {
      expect(planCaptureReceipt(input(changed)).payloadHash, JSON.stringify(changed)).not.toBe(covered.payloadHash);
    }
    expect(covered.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses to plan a payment of no cents", () => {
    expect(() => planCaptureReceipt(input({ amountCents: 0 }))).toThrow(RangeError);
  });
});
