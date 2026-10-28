import { describe, expect, it } from "vitest";
import { planOrganiserExtraNetting } from "@/lib/organiser-extra-netting";
import { effectiveOrganiserPaidChangeFeeCents, organiserExtraPaidPriceCents, organiserExtraUnpaidCents, type OrganiserExtraInvoice } from "@/lib/organiser-extra-state";
import { readOrganiserExtraAdjustmentPayload, XERO_OUTBOX_ORGANISER_EXTRA_ADJUSTMENT_TYPE } from "@/lib/organiser-extra-adjustment-payload";

const invoice = (overrides: Partial<OrganiserExtraInvoice> = {}): OrganiserExtraInvoice => ({ modificationId: "increase", invoiceId: "extra", priceCents: 5_000, feeCents: 1_000, cashCents: 2_000, waivedCents: 0, refundedCents: 0, releasedPriceCents: 0, ...overrides });
const state = (extra = invoice()) => ({ bookingId: "child", invoices: [extra] });

describe("organiser bank-transfer extra netting (N1–N4)", () => {
  it("N4 cancellation waives 40, refunds 150 from share and 5 from extra", () => {
    const result = planOrganiserExtraNetting(state(), { reductionCents: 0, cancel: true, refundAmountCents: 15_500, refundBasisCents: 31_000 });
    expect(result.waivers.map((p) => p.amountCents)).toEqual([4_000]);
    expect(result.refunds.map((p) => p.amountCents)).toEqual([500]);
    expect(result.combinedRefundCents).toBe(15_000);
    expect(effectiveOrganiserPaidChangeFeeCents(1_000, state())).toBe(1_000);
  });
  it("N4 reduction 30 credits 30 and leaves 10 due, refund zero", () => {
    const result = planOrganiserExtraNetting(state(), { reductionCents: 3_000, refundAmountCents: 0, refundBasisCents: 0 });
    expect(result.waivers[0]?.amountCents).toBe(3_000);
    expect(result.refunds).toEqual([]);
    expect(organiserExtraUnpaidCents(invoice({ waivedCents: 3_000 }))).toBe(1_000);
  });
  it("N4 reduction 50 credits 40 and refunds 5 at 50%", () => {
    const result = planOrganiserExtraNetting(state(), { reductionCents: 5_000, refundAmountCents: 500, refundBasisCents: 1_000 });
    expect(result.waivers[0]?.amountCents).toBe(4_000);
    expect(result.refunds[0]?.amountCents).toBe(500);
    expect(result.combinedRefundCents).toBe(0);
  });
  it("N1/N2 includes unpaid fee in the whole invoice and excludes it from paid share fees", () => {
    const unpaid = state(invoice({ cashCents: 0 }));
    const result = planOrganiserExtraNetting(unpaid, { cancel: true, reductionCents: 0, refundAmountCents: 15_000, refundBasisCents: 30_000 });
    expect(result.waivers[0]?.amountCents).toBe(6_000);
    expect(result.refunds).toEqual([]);
    expect(result.combinedRefundCents).toBe(15_000);
    expect(effectiveOrganiserPaidChangeFeeCents(1_000, unpaid)).toBe(0);
  });
  it("N3 a fully paid extra joins the tier but its fee does not", () => {
    const paid = state(invoice({ cashCents: 6_000 }));
    const result = planOrganiserExtraNetting(paid, { cancel: true, reductionCents: 0, refundAmountCents: 17_500, refundBasisCents: 35_000 });
    expect(result.waivers).toEqual([]);
    expect(result.refunds[0]?.amountCents).toBe(2_500);
    expect(result.combinedRefundCents).toBe(15_000);
  });
  it("N4 part payments pay the fee first, including cash below the fee", () => {
    expect(organiserExtraPaidPriceCents(invoice({ cashCents: 500 }))).toBe(0);
    expect(organiserExtraPaidPriceCents(invoice({ cashCents: 1_000 }))).toBe(0);
    expect(organiserExtraPaidPriceCents(invoice({ cashCents: 1_500 }))).toBe(500);
    expect(effectiveOrganiserPaidChangeFeeCents(1_000, state(invoice({ cashCents: 500 })))).toBe(500);
  });
  it("reservations prevent later edits from waiving or refunding the same extra twice", () => {
    const extra = invoice({ waivedCents: 4_000, refundedCents: 1_000, releasedPriceCents: 1_000 });
    const result = planOrganiserExtraNetting(state(extra), { reductionCents: 1_000, refundAmountCents: 500, refundBasisCents: 1_000 });
    expect(result.waivers).toEqual([]);
    expect(result.refunds).toEqual([]);
    expect(result.combinedRefundCents).toBe(500);
  });
  it("tracks paid price consumed before the policy percentage, so a later cancellation cannot refund it again", () => {
    const reduced = state(invoice({ waivedCents: 4_000, refundedCents: 500, releasedPriceCents: 1_000 }));
    const result = planOrganiserExtraNetting(reduced, { cancel: true, reductionCents: 0, refundAmountCents: 15_000, refundBasisCents: 30_000 });
    expect(result.refunds).toEqual([]);
    expect(result.combinedRefundCents).toBe(15_000);
  });
  it("records consumed extra price even when a zero-percent tier refunds nothing", () => {
    const result = planOrganiserExtraNetting(state(), { reductionCents: 5_000, refundAmountCents: 0, refundBasisCents: 1_000 });
    expect(result.refunds).toMatchObject([{ amountCents: 0, basisCents: 1_000 }]);
  });
  it("distributes the already-tiered refund exactly once, retaining odd cents on the combined share", () => {
    const result = planOrganiserExtraNetting(state(invoice({ cashCents: 2_001 })), { cancel: true, reductionCents: 0, refundAmountCents: 15_499, refundBasisCents: 31_001 });
    expect(result.refunds.reduce((s, p) => s + p.amountCents, result.combinedRefundCents)).toBe(15_499);
  });
});

describe("organiser extra adjustment queue payload", () => {
  const payload = { queueType: XERO_OUTBOX_ORGANISER_EXTRA_ADJUSTMENT_TYPE, bookingId: "child", scopeId: "edit", modificationId: "increase", invoiceId: null, amountCents: 4_000, purpose: "waive", cashAtPlanCents: 2_000, refundPercentage: 50 };
  it("retains the frozen cash, scope and policy across retry", () => expect(readOrganiserExtraAdjustmentPayload(payload)).toEqual(payload));
  it.each([{ amountCents: 0 }, { amountCents: 1.1 }, { amountCents: NaN }, { cashAtPlanCents: -1 }, { refundPercentage: 101 }, { modificationId: null }, { purpose: "anything" }])("refuses malformed money or identity %j", (change) => expect(readOrganiserExtraAdjustmentPayload({ ...payload, ...change })).toBeNull());
});
