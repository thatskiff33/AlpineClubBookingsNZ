import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Invoice, type CreditNote } from "xero-node";
import type { Prisma } from "@prisma/client";
const mocks = vi.hoisted(() => ({
  operation: { xeroObjectId: null as string | null, correlationKey: "scope" },
  invoice: {} as Invoice,
  note: {} as CreditNote,
  getInvoice: vi.fn(), getCreditNote: vi.fn(), createCreditNotes: vi.fn(), createCreditNoteAllocation: vi.fn(), updateInvoice: vi.fn(),
  complete: vi.fn(), save: vi.fn(), start: vi.fn(), settle: vi.fn(),
  updateCreditNote: vi.fn(), task: vi.fn(),
  plans: [] as { requestPayload: unknown }[],
  // N1 fix delta: each extra's own change (default: +$50 with a $10 fee).
  modifications: {} as Record<string, { priceDiffCents: number; changeFeeCents: number }>,
}));
const transactionStore = {
  $executeRaw: vi.fn(),
  manualRefundTask: { findUnique: vi.fn(async () => null), create: mocks.task },
  payment: { findUniqueOrThrow: vi.fn(async () => ({ id: "child-payment" })) },
  xeroSyncOperation: {
    findMany: vi.fn(async () => mocks.plans), findFirst: vi.fn(async () => null),
    update: vi.fn(),
  },
};
vi.mock("@/lib/prisma", () => ({ prisma: {
  xeroSyncOperation: { findUniqueOrThrow: vi.fn(async () => mocks.operation), updateMany: mocks.save },
  xeroObjectLink: { findMany: vi.fn(async () => []) },
  payment: { findUniqueOrThrow: vi.fn(async () => ({ id: "child-payment" })) },
  manualRefundTask: { findUniqueOrThrow: mocks.task },
  bookingModification: { findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => mocks.modifications[where.id] ?? { priceDiffCents: 5_000, changeFeeCents: 1_000 }) },
  $transaction: vi.fn(async (run: (tx: Prisma.TransactionClient) => Promise<unknown>) => run(transactionStore as unknown as Prisma.TransactionClient)),
} }));
vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: vi.fn(async () => ({ xero: { accountingApi: mocks }, tenantId: "fake-tenant" })),
  callXeroApi: vi.fn(async (call: () => Promise<unknown>) => call()),
}));
vi.mock("@/lib/xero-sync", () => ({ completeXeroSyncOperation: mocks.complete, startXeroSyncOperation: mocks.start }));
vi.mock("@/lib/xero-refund-note-settlement", () => ({ settleRefundNoteFromXero: mocks.settle }));
vi.mock("@/lib/xero-mappings", () => ({ getResolvedAccountMapping: vi.fn(async () => ({ code: "219" })) }));
vi.mock("@/lib/club-time-zone-runtime", () => ({ readClubTimeZoneOutsideRequest: vi.fn(async () => "Pacific/Auckland") }));

import { executeOrganiserExtraAdjustment } from "@/lib/organiser-extra-adjustment";
import { XERO_OUTBOX_ORGANISER_EXTRA_ADJUSTMENT_TYPE, type OrganiserExtraAdjustmentPayload } from "@/lib/organiser-extra-adjustment-payload";

const payload = (overrides: Partial<OrganiserExtraAdjustmentPayload> = {}): OrganiserExtraAdjustmentPayload => ({ queueType: XERO_OUTBOX_ORGANISER_EXTRA_ADJUSTMENT_TYPE, bookingId: "child", scopeId: "cut", modificationId: "increase", invoiceId: "extra", amountCents: 4_000, purpose: "waive", cashAtPlanCents: 2_000, refundPercentage: 50, ...overrides });
const claim = { id: "operation", startedAt: new Date("2026-07-01T00:00:00.000Z") };

describe("organiser extra adjustment provider execution", () => {
  // The executor loads the Xero inbound graph on demand. Load it once here, so
  // no case's own budget pays for a cold import (the one flaky cold run).
  beforeAll(async () => {
    await import("@/lib/xero-inbound/invoice-paid-effects");
    await import("@/lib/xero-group-settlement-invoice-voids");
  }, 60_000);
  beforeEach(() => {
    vi.clearAllMocks();
    // Drop any once-queued answer a failed case left behind, so cases cannot leak into each other.
    for (const fn of Object.values(mocks)) if (vi.isMockFunction(fn)) fn.mockReset();
    mocks.operation = { xeroObjectId: null, correlationKey: "scope" };
    mocks.plans = [];
    mocks.modifications = {};
    mocks.start.mockImplementation(async (input: { requestPayload: unknown }) => { mocks.plans.push(input); return { id: "raced-refund" }; });
    mocks.task.mockResolvedValue({ id: "hand-back", status: "COMPLETED" });
    mocks.settle.mockResolvedValue({ outcome: { refundPaymentErr: null, refundPaymentResponseBody: { paymentID: "bank-refund" }, refundPaymentSkipReason: null } });
    mocks.invoice = { invoiceID: "extra", invoiceNumber: "EXTRA-1", contact: { contactID: "organiser" }, amountPaid: 20, amountDue: 40, total: 60, status: Invoice.StatusEnum.AUTHORISED };
    mocks.note = { creditNoteID: "waiver", total: 40, allocations: [] };
    mocks.getInvoice.mockImplementation(async () => ({ body: { invoices: [mocks.invoice] } }));
    mocks.getCreditNote.mockImplementation(async () => ({ body: { creditNotes: [mocks.note] } }));
    mocks.createCreditNotes.mockImplementation(async () => ({ body: { creditNotes: [mocks.note] } }));
    mocks.save.mockImplementation(async (input: { data: { xeroObjectId: string } }) => { mocks.operation.xeroObjectId = input.data.xeroObjectId; return { count: 1 }; });
    mocks.createCreditNoteAllocation.mockImplementation(async () => { mocks.note.allocations = [{ invoice: { invoiceID: "extra" }, amount: 40, date: "2026-07-01" }]; return { body: {} }; });
    mocks.updateInvoice.mockResolvedValue({ body: {} });
    mocks.updateCreditNote.mockResolvedValue({ body: {} });
  });
  it("N4 never voids a partly-paid invoice; credits its unpaid remainder against organiser contact", async () => {
    await executeOrganiserExtraAdjustment(payload(), claim);
    expect(mocks.updateInvoice).not.toHaveBeenCalled();
    expect(mocks.createCreditNotes.mock.calls[0]?.[1]).toMatchObject({ creditNotes: [{ contact: { contactID: "organiser" }, lineItems: [{ unitAmount: 40, accountCode: "219" }] }] });
    expect(mocks.createCreditNoteAllocation.mock.calls[0]?.[2]).toEqual({ allocations: [{ invoice: { invoiceID: "extra" }, amount: 40, date: "2026-07-01" }] });
  });
  it("N2 voids a wholly unpaid extra instead of raising a credit", async () => {
    mocks.invoice.amountPaid = 0;
    mocks.invoice.amountDue = 60;
    await executeOrganiserExtraAdjustment(payload({ cashAtPlanCents: 0, amountCents: 6_000 }), claim);
    expect(mocks.updateInvoice).toHaveBeenCalledOnce();
    expect(mocks.updateInvoice.mock.calls[0]?.[2]).toMatchObject({ invoices: [{ invoiceID: "extra", status: "VOIDED" }] });
    expect(mocks.createCreditNotes).not.toHaveBeenCalled();
  });
  it("F3: a second waiver of an invoice an earlier waiver credited is a credit note, never a void Xero refuses", async () => {
    // The first waiver credited $30 of the unpaid $60; the second covers the other $30.
    mocks.invoice = { ...mocks.invoice, amountPaid: 0, amountCredited: 30, amountDue: 30, total: 60 };
    mocks.note = { creditNoteID: "second-waiver", total: 30, allocations: [] };
    mocks.createCreditNoteAllocation.mockImplementation(async () => ({ body: {} }));
    await executeOrganiserExtraAdjustment(payload({ scopeId: "second-cut", cashAtPlanCents: 0, amountCents: 3_000 }), claim);
    expect(mocks.updateInvoice).not.toHaveBeenCalled();
    expect(mocks.createCreditNotes.mock.calls[0]?.[1]).toMatchObject({ creditNotes: [{ lineItems: [{ unitAmount: 30 }] }] });
    expect(mocks.createCreditNoteAllocation.mock.calls[0]?.[2]).toMatchObject({ allocations: [{ invoice: { invoiceID: "extra" }, amount: 30 }] });
  });
  it("a retry after allocation recovers its recorded note and records no second document or allocation", async () => {
    await executeOrganiserExtraAdjustment(payload(), claim);
    await executeOrganiserExtraAdjustment(payload(), claim);
    expect(mocks.createCreditNotes).toHaveBeenCalledOnce();
    expect(mocks.createCreditNoteAllocation).toHaveBeenCalledOnce();
  });
  it("a provider failure after note creation leaves its identity recorded for retry", async () => {
    mocks.createCreditNoteAllocation.mockRejectedValueOnce(new Error("connection lost"));
    await expect(executeOrganiserExtraAdjustment(payload(), claim)).rejects.toThrow("connection lost");
    expect(mocks.operation.xeroObjectId).toBe("waiver");
    await executeOrganiserExtraAdjustment(payload(), claim);
    expect(mocks.createCreditNotes).toHaveBeenCalledOnce();
  });
  it("refuses to act on an unreadable live cash figure", async () => {
    mocks.invoice.amountPaid = undefined;
    await expect(executeOrganiserExtraAdjustment(payload(), claim)).rejects.toThrow("unreadable");
    expect(mocks.createCreditNotes).not.toHaveBeenCalled();
    expect(mocks.updateInvoice).not.toHaveBeenCalled();
  });
  it("re-reads cash after creating a waiver, shrinks it, and reserves only the new paid price at policy", async () => {
    mocks.getInvoice.mockResolvedValueOnce({ body: { invoices: [{ ...mocks.invoice }] } });
    mocks.invoice = { ...mocks.invoice, amountPaid: 30, amountDue: 30 };
    await executeOrganiserExtraAdjustment(payload(), claim);
    expect(mocks.updateCreditNote.mock.calls[0]?.[2]).toMatchObject({ creditNotes: [{ lineItems: [{ unitAmount: 30 }] }] });
    expect(mocks.createCreditNoteAllocation.mock.calls[0]?.[2]).toMatchObject({ allocations: [{ amount: 30 }] });
    expect(mocks.task).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ amountCents: 500, reason: expect.stringContaining("the organiser paid an extra invoice") }) }));
    expect(mocks.plans[0]?.requestPayload).toMatchObject({ purpose: "refund", amountCents: 500, priceBasisCents: 1_000, modificationId: "increase" });
  });
  it("N-c: a raced payment's refund rounds as the cancel's policy does, never down", async () => {
    // $10.01 of newly paid price at 50% is $5.005: the policy rounds it to $5.01.
    mocks.getInvoice.mockResolvedValueOnce({ body: { invoices: [{ ...mocks.invoice }] } });
    mocks.invoice = { ...mocks.invoice, amountPaid: 30.01, amountDue: 29.99 };
    await executeOrganiserExtraAdjustment(payload(), claim);
    expect(mocks.task).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ amountCents: 501 }) }));
  });
  it("S2: a $30 waiver of a $60 extra ($50 + $10 fee, $20 paid) frozen at 50%: the organiser's raced $40 hands back $15.00", async () => {
    // The organiser paid the remaining $40 before the waiver ran.
    mocks.invoice = { ...mocks.invoice, amountPaid: 60, amountDue: 0 };
    await executeOrganiserExtraAdjustment(payload({ amountCents: 3_000, cashAtPlanCents: 2_000, refundPercentage: 50 }), claim).catch(() => undefined);
    expect(mocks.task).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ amountCents: 1_500 }) }));
    expect(mocks.plans[0]?.requestPayload).toMatchObject({ purpose: "refund", amountCents: 1_500, priceBasisCents: 3_000 });
  });
  it.each([
    { fixedFeeRemainderCents: 2_500, handBackCents: null },
    { fixedFeeRemainderCents: undefined, handBackCents: 1_250 },
  ])("N1: a 25% tier whose 5000c fee its 10000c basis left 2500c short: 5000c of raced paid price hands back $handBackCents (remainder $fixedFeeRemainderCents)", async ({ fixedFeeRemainderCents, handBackCents }) => {
    // The fee was paid at plan time; the organiser then paid the $50 price the waiver covered.
    mocks.invoice = { ...mocks.invoice, amountPaid: 60, amountDue: 0 };
    await executeOrganiserExtraAdjustment(payload({ amountCents: 5_000, cashAtPlanCents: 1_000, refundPercentage: 25, ...(fixedFeeRemainderCents ? { fixedFeeRemainderCents } : {}) }), claim).catch(() => undefined);
    if (handBackCents === null) expect(mocks.task).not.toHaveBeenCalled();
    else expect(mocks.task).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ amountCents: handBackCents }) }));
  });
  it.each([
    { extraCents: 20_000, handBacks: [2_500, 5_000] }, // policy: (10000 + 40000) x 25% - 5000 = 7500
    { extraCents: 8_000, handBacks: [1_500] }, // policy: (10000 + 16000) x 25% - 5000 = 1500
  ])("N1 fix delta: two raced extras of $extraCents under one plan pay its 2500c fee remainder once: hand-backs $handBacks", async ({ extraCents, handBacks }) => {
    // 25% tier, $50 fee, $100 basis: the plan refunded $0 and left $25 of its fee unabsorbed.
    const plan = { scopeId: "cancel", refundPercentage: 25, fixedFeeRemainderCents: 2_500, cashAtPlanCents: 0, amountCents: extraCents };
    for (const id of ["a", "b"]) mocks.modifications[`increase-${id}`] = { priceDiffCents: extraCents, changeFeeCents: 0 };
    for (const id of ["a", "b"]) {
      // Each extra was paid in full while its waiver was queued.
      mocks.invoice = { ...mocks.invoice, invoiceID: `extra-${id}`, amountPaid: extraCents / 100, amountDue: 0, total: extraCents / 100 };
      await executeOrganiserExtraAdjustment(payload({ ...plan, modificationId: `increase-${id}`, invoiceId: `extra-${id}` }), { ...claim, id: `waiver-${id}` }).catch(() => undefined);
    }
    expect(mocks.task.mock.calls.map(([input]) => (input as { data: { amountCents: number } }).data.amountCents)).toEqual(handBacks);
    // Every raced price is recorded against the plan, a $0 hand-back included.
    const raced = mocks.plans.map((row) => row.requestPayload as { racedPlanScopeId?: string; priceBasisCents?: number });
    expect(raced.every((row) => row.racedPlanScopeId === "cancel")).toBe(true);
    expect(raced.reduce((sum, row) => sum + (row.priceBasisCents ?? 0), 0)).toBe(2 * extraCents);
  });
  describe("item 5: one $60 extra ($50 + $10 fee) waived by a 50% reduction, then a 25% cancel, the organiser paying all $60 in between", () => {
    // Had the $60 arrived before the reduction, it pays the fee first: the reduction refunds its $30 at 50% ($15),
    // the cancel the $20 of price left at 25% ($5), and the $10 fee is kept. Cash is refunded once, never twice.
    const reduction = payload({ scopeId: "reduction", amountCents: 3_000, cashAtPlanCents: 0, refundPercentage: 50 });
    const cancel = payload({ scopeId: "cancel", amountCents: 3_000, cashAtPlanCents: 0, refundPercentage: 25 });
    const handBacks = () => mocks.task.mock.calls.map(([input]) => (input as { data: { amountCents: number } }).data.amountCents);
    const racedBasisCents = () => mocks.plans.reduce((sum, row) => sum + ((row.requestPayload as { priceBasisCents?: number }).priceBasisCents ?? 0), 0);
    beforeEach(() => { mocks.invoice = { ...mocks.invoice, amountPaid: 60, amountDue: 0, status: Invoice.StatusEnum.PAID }; });

    it("both waivers queued when the cash lands: $15 then $5, and only the $50 of paid price is released", async () => {
      await executeOrganiserExtraAdjustment(reduction, { ...claim, id: "reduction-waiver" });
      await executeOrganiserExtraAdjustment(cancel, { ...claim, id: "cancel-waiver" });
      expect(handBacks()).toEqual([1_500, 500]);
      expect(racedBasisCents()).toBe(5_000);
    });

    it("the cancel's waiver runs first: still only the $50 of paid price is released, the fee never refunded", async () => {
      await executeOrganiserExtraAdjustment(cancel, { ...claim, id: "cancel-waiver" });
      await executeOrganiserExtraAdjustment(reduction, { ...claim, id: "reduction-waiver" });
      expect(racedBasisCents()).toBe(5_000);
    });

    it("a waiver re-run on more raced cash counts its own earlier raced price once, never as another plan's release", async () => {
      // $40 of the $60 paid when the $40 waiver (planned at $20 paid) first runs; all $60 when it runs again.
      mocks.invoice = { ...mocks.invoice, amountPaid: 40, amountDue: 0, status: Invoice.StatusEnum.AUTHORISED };
      await executeOrganiserExtraAdjustment(payload(), claim);
      mocks.invoice = { ...mocks.invoice, amountPaid: 60, amountDue: 0, status: Invoice.StatusEnum.PAID };
      await executeOrganiserExtraAdjustment(payload(), claim);
      // $20 of newly paid price at 50%, then the other $20: $40 of the $50 (the $10 the plan saw paid is not raced).
      expect(handBacks()).toEqual([1_000, 1_000]);
      expect(racedBasisCents()).toBe(4_000);
    });

    it("the cancel saw the cash and refunded all $50 of paid price itself: the reduction's waiver refunds nothing more", async () => {
      mocks.plans.push({ requestPayload: { ...payload({ scopeId: "cancel", purpose: "refund", amountCents: 1_250, priceBasisCents: 5_000, cashAtPlanCents: 6_000, refundPercentage: 25 }) } });
      await executeOrganiserExtraAdjustment(reduction, { ...claim, id: "reduction-waiver" });
      expect(mocks.task).not.toHaveBeenCalled();
      expect(mocks.plans).toHaveLength(1);
    });
  });
  it("refuses an unreadable refreshed invoice before allocating a waiver", async () => {
    mocks.getInvoice.mockResolvedValueOnce({ body: { invoices: [mocks.invoice] } }).mockResolvedValueOnce({ body: { invoices: [] } });
    await expect(executeOrganiserExtraAdjustment(payload(), claim)).rejects.toThrow("unreadable");
    expect(mocks.createCreditNoteAllocation).not.toHaveBeenCalled();
    expect(mocks.operation.xeroObjectId).toBe("waiver");
  });
  it("a lost operation claim stops before any allocation", async () => {
    mocks.save.mockResolvedValueOnce({ count: 0 });
    await expect(executeOrganiserExtraAdjustment(payload(), claim)).rejects.toThrow("lost its operation claim");
    expect(mocks.createCreditNoteAllocation).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("holds a refund until the organiser's bank-transfer hand-back completes", async () => {
    mocks.invoice = { ...mocks.invoice, amountDue: 0, amountCredited: 40 };
    mocks.task.mockResolvedValue({ status: "PENDING" });
    await expect(executeOrganiserExtraAdjustment(payload({ purpose: "refund", amountCents: 500, handBackTaskId: "hand-back" }), claim)).rejects.toThrow("awaits its bank-transfer hand-back");
    expect(mocks.createCreditNotes).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
  });
  it("waits for a failed or delayed waiver before paying the refund note", async () => {
    const refund = payload({ purpose: "refund", amountCents: 500, handBackTaskId: "hand-back" });
    await expect(executeOrganiserExtraAdjustment(refund, claim)).rejects.toThrow("awaits its unpaid-balance waiver");
    expect(mocks.createCreditNotes).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();

    mocks.invoice = { ...mocks.invoice, amountDue: 0, amountCredited: 40 };
    await executeOrganiserExtraAdjustment(refund, claim);
    expect(mocks.createCreditNotes).toHaveBeenCalledOnce();
    expect(mocks.settle).toHaveBeenCalledOnce();
  });
  it("pays out a settled invoice's refund note using the completed bank-transfer record", async () => {
    mocks.invoice = { ...mocks.invoice, amountPaid: 60, amountDue: 0, status: Invoice.StatusEnum.PAID };
    await executeOrganiserExtraAdjustment(payload({ purpose: "refund", amountCents: 500, cashAtPlanCents: 6_000, handBackTaskId: "hand-back" }), claim);
    expect(mocks.createCreditNotes.mock.calls[0]?.[1]).toMatchObject({ creditNotes: [{ reference: expect.stringContaining("EXTRA-1"), lineItems: [{ unitAmount: 5 }] }] });
    expect(mocks.createCreditNoteAllocation).not.toHaveBeenCalled();
    expect(mocks.settle).toHaveBeenCalledWith(expect.objectContaining({ creditNoteId: "waiver", refundMethod: "internet-banking", refundMethodRecorded: true }));
    expect(mocks.complete).toHaveBeenCalledWith(claim, expect.objectContaining({ responsePayload: expect.objectContaining({ invoiceId: "extra", amountCents: 500 }) }));
  });
  it("does not mark a failed refund-note payout complete, and retries its recorded note", async () => {
    mocks.invoice = { ...mocks.invoice, amountDue: 0, amountCredited: 40 };
    mocks.settle.mockResolvedValueOnce({ outcome: { refundPaymentErr: new Error("bank unavailable") } });
    const refund = payload({ purpose: "refund", amountCents: 500, handBackTaskId: "hand-back" });
    await expect(executeOrganiserExtraAdjustment(refund, claim)).rejects.toThrow("bank unavailable");
    expect(mocks.complete).not.toHaveBeenCalled();
    await executeOrganiserExtraAdjustment(refund, claim);
    expect(mocks.createCreditNotes).toHaveBeenCalledOnce();
    expect(mocks.complete).toHaveBeenCalledOnce();
  });
});
