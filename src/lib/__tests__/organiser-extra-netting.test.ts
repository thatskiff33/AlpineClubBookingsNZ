import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

const start = vi.hoisted(() => vi.fn());
vi.mock("@/lib/xero-sync", () => ({ startXeroSyncOperation: start }));

import { planOrganiserExtraNetting, reserveOrganiserExtraNetting } from "@/lib/organiser-extra-netting";
import { effectiveOrganiserPaidChangeFeeCents, organiserExtraPaidPriceCents, organiserExtraUnpaidCents, readOrganiserExtraState, type OrganiserExtraInvoice } from "@/lib/organiser-extra-state";
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

describe("F4: a waiver of a still-queued extra invoice", () => {
  /** A queued (never raised) invoice: no Xero id, no cash, one operation in `status`. */
  function store(status: string, startedAt: Date | null = null) {
    const operation = { status, startedAt, xeroObjectId: null as string | null };
    const tx = {
      xeroSyncOperation: {
        findFirst: vi.fn(async () => null),
        updateMany: vi.fn(async ({ where, data }: { where: { status: { in: string[] }; startedAt: null; xeroObjectId: null }; data: { status: string } }) => {
          if (!where.status.in.includes(operation.status) || operation.xeroObjectId !== null) return { count: 0 };
          if (where.startedAt !== null || operation.startedAt !== null) return { count: 0 };
          operation.status = data.status;
          return { count: 1 };
        }),
        count: vi.fn(async ({ where }: { where: { status: { notIn: string[] } } }) => (where.status.notIn.includes(operation.status) ? 0 : 1)),
      },
    };
    return { tx: tx as unknown as Prisma.TransactionClient, operation, updateMany: tx.xeroSyncOperation.updateMany };
  }
  const queued = state(invoice({ invoiceId: null, cashCents: 0 }));
  const cancel = { scopeId: "cancel", reductionCents: 0, refundAmountCents: 0, refundBasisCents: 0, refundPercentage: 50, cancel: true };

  it.each(["PENDING", "WAITING_PAYMENT"])("covered in full: the never-attempted %s invoice is SKIPPED and no waiver is reserved, so the organiser is never emailed", async (status) => {
    start.mockClear();
    const { tx, operation } = store(status);
    await reserveOrganiserExtraNetting(tx, { ...cancel, state: queued });
    expect(operation.status).toBe("SKIPPED");
    expect(start).not.toHaveBeenCalled();
  });
  it.each([
    ["FAILED", null],
    ["PENDING", new Date("2026-07-01T00:00:00.000Z")],
  ] as const)("S1: an attempted %s invoice (startedAt %s) may exist in Xero, so it is kept and the waiver is reserved", async (status, startedAt) => {
    start.mockClear();
    const { tx, operation } = store(status, startedAt);
    await reserveOrganiserExtraNetting(tx, { ...cancel, state: queued });
    expect(operation.status).toBe(status);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ requestPayload: expect.objectContaining({ purpose: "waive", amountCents: 6_000 }) }));
  });
  it("a create already under way keeps its invoice, and the waiver is reserved to void it", async () => {
    start.mockClear();
    const { tx, operation } = store("RUNNING");
    await reserveOrganiserExtraNetting(tx, { ...cancel, state: queued });
    expect(operation.status).toBe("RUNNING");
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ requestPayload: expect.objectContaining({ purpose: "waive", amountCents: 6_000 }) }));
  });
  it("a part waiver leaves the invoice queued and reserves the waiver (the notice is sized after it)", async () => {
    start.mockClear();
    const { tx, operation, updateMany } = store("PENDING");
    await reserveOrganiserExtraNetting(tx, { ...cancel, cancel: false, reductionCents: 2_000, state: queued });
    expect(operation.status).toBe("PENDING");
    expect(updateMany).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ requestPayload: expect.objectContaining({ purpose: "waive", amountCents: 2_000 }) }));
  });
});

describe("F4: an extra invoice a waiver retired before it was raised", () => {
  it("reads as waived whole: nothing owed, nothing paid, and its fee never kept", async () => {
    const db = {
      bookingModification: { findMany: vi.fn(async () => [{ id: "increase", priceDiffCents: 5_000, changeFeeCents: 1_000 }]) },
      xeroObjectLink: { findMany: vi.fn(async () => []) },
      xeroSyncOperation: { findMany: vi.fn(async ({ where }: { where: { queueType: string } }) =>
        where.queueType === "SUPPLEMENTARY_INVOICE" ? [{ localId: "increase", requestPayload: { priceDiffCents: 5_000, changeFeeCents: 1_000 }, status: "SKIPPED" }] : []) },
      paymentTransaction: { findMany: vi.fn(async () => []) },
    };
    const state = await readOrganiserExtraState(db as never, "child");
    expect(state.invoices).toMatchObject([{ invoiceId: null, waivedCents: 6_000, cashCents: 0 }]);
    expect(organiserExtraUnpaidCents(state.invoices[0]!)).toBe(0);
    expect(organiserExtraPaidPriceCents(state.invoices[0]!)).toBe(0);
    // The $10 recorded fee was never collected, so a later cancel keeps none of it.
    expect(effectiveOrganiserPaidChangeFeeCents(1_000, state)).toBe(0);
    // A later reduction finds nothing left to waive on it.
    expect(planOrganiserExtraNetting(state, { reductionCents: 3_000, refundAmountCents: 0, refundBasisCents: 0 }).waivers).toEqual([]);
  });

  it("S1 (c): reads one row deterministically - oldest first, an authorised row before a skipped one", async () => {
    const rows = [
      { id: "a-skipped", localId: "increase", requestPayload: { priceDiffCents: 5_000, changeFeeCents: 1_000 }, status: "SKIPPED", xeroObjectId: null },
      { id: "b-raised", localId: "increase", requestPayload: { priceDiffCents: 5_000, changeFeeCents: 1_000 }, status: "SUCCEEDED", xeroObjectId: null },
    ];
    const findMany = vi.fn(async ({ where }: { where: { queueType: string } }) => (where.queueType === "SUPPLEMENTARY_INVOICE" ? rows : []));
    const db = {
      bookingModification: { findMany: vi.fn(async () => [{ id: "increase", priceDiffCents: 5_000, changeFeeCents: 1_000 }]) },
      xeroObjectLink: { findMany: vi.fn(async () => []) },
      xeroSyncOperation: { findMany },
      paymentTransaction: { findMany: vi.fn(async () => []) },
    };
    const read = await readOrganiserExtraState(db as never, "child");
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ queueType: "SUPPLEMENTARY_INVOICE" }), orderBy: [{ createdAt: "asc" }, { id: "asc" }] }));
    // The authorised row wins over the older skipped one: the extra is still owed.
    expect(read.invoices).toMatchObject([{ waivedCents: 0 }]);
    expect(organiserExtraUnpaidCents(read.invoices[0]!)).toBe(6_000);
  });
});
