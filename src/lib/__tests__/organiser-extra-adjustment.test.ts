import { beforeEach, describe, expect, it, vi } from "vitest";
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
  bookingModification: { findUniqueOrThrow: vi.fn(async () => ({ priceDiffCents: 5_000, changeFeeCents: 1_000 })) },
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
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.operation = { xeroObjectId: null, correlationKey: "scope" };
    mocks.plans = [];
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
    expect(mocks.task).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ amountCents: 500 }) }));
    expect(mocks.plans[0]?.requestPayload).toMatchObject({ purpose: "refund", amountCents: 500, priceBasisCents: 1_000, modificationId: "increase" });
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
