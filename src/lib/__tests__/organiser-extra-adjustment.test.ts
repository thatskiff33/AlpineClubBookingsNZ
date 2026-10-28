import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreditNote, Invoice } from "xero-node";
const mocks = vi.hoisted(() => ({
  operation: { xeroObjectId: null as string | null, correlationKey: "scope" },
  invoice: {} as Invoice,
  note: {} as CreditNote,
  getInvoice: vi.fn(), getCreditNote: vi.fn(), createCreditNotes: vi.fn(), createCreditNoteAllocation: vi.fn(), updateInvoice: vi.fn(),
  complete: vi.fn(), save: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {
  xeroSyncOperation: { findUniqueOrThrow: vi.fn(async () => mocks.operation), updateMany: mocks.save },
  xeroObjectLink: { findMany: vi.fn(async () => []) },
  payment: { findUniqueOrThrow: vi.fn(async () => ({ id: "child-payment" })) },
} }));
vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: vi.fn(async () => ({ xero: { accountingApi: mocks }, tenantId: "fake-tenant" })),
  callXeroApi: vi.fn(async (call: () => Promise<unknown>) => call()),
}));
vi.mock("@/lib/xero-sync", () => ({ completeXeroSyncOperation: mocks.complete }));
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
    mocks.invoice = { invoiceID: "extra", invoiceNumber: "EXTRA-1", contact: { contactID: "organiser" }, amountPaid: 20, amountDue: 40, total: 60, status: "AUTHORISED" as Invoice.StatusEnum };
    mocks.note = { creditNoteID: "waiver", total: 40, allocations: [] };
    mocks.getInvoice.mockImplementation(async () => ({ body: { invoices: [mocks.invoice] } }));
    mocks.getCreditNote.mockImplementation(async () => ({ body: { creditNotes: [mocks.note] } }));
    mocks.createCreditNotes.mockImplementation(async () => ({ body: { creditNotes: [mocks.note] } }));
    mocks.save.mockImplementation(async (input: { data: { xeroObjectId: string } }) => { mocks.operation.xeroObjectId = input.data.xeroObjectId; return { count: 1 }; });
    mocks.createCreditNoteAllocation.mockImplementation(async () => { mocks.note.allocations = [{ invoice: { invoiceID: "extra" }, amount: 40 }]; return { body: {} }; });
    mocks.updateInvoice.mockResolvedValue({ body: {} });
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
});
