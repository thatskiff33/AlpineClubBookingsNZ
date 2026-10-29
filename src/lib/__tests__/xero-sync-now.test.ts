import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
const h = vi.hoisted(() => ({
  member: vi.fn(), booking: vi.fn(), bookings: vi.fn(), payments: vi.fn(), credits: vi.fn(), slices: vi.fn(), links: vi.fn(),
  contact: vi.fn(), invoice: vi.fn(), note: vi.fn(), connected: vi.fn(), enabled: vi.fn(), cron: vi.fn(),
  getInvoices: vi.fn(), getCreditNotes: vi.fn(), getInvoice: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {
  member: { findUnique: h.member }, booking: { findUnique: h.booking, findMany: h.bookings },
  payment: { findMany: h.payments }, memberCredit: { findMany: h.credits }, memberCreditNoteAllocation: { findMany: h.slices },
  bookingModification: { findMany: async () => [] }, manualRefundTask: { findMany: async () => [] }, xeroObjectLink: { findMany: h.links },
} }));
vi.mock("@/lib/admin-modules", () => ({ isEffectiveModuleEnabled: h.enabled }));
vi.mock("@/lib/xero-token-store", () => ({ isXeroConnected: h.connected }));
vi.mock("@/lib/club-format-server", () => ({ clubFormatValues: async () => CLUB_FORMAT_TEST }));
vi.mock("@/lib/xero-api-client", () => ({ callXeroApi: (fn: () => unknown) => fn(), getAuthenticatedXeroClient: async () => ({ tenantId: "test", xero: { accountingApi: { getInvoices: h.getInvoices, getCreditNotes: h.getCreditNotes, getInvoice: h.getInvoice } } }) }));
vi.mock("@/lib/xero-inbound/contact", () => ({ reconcileXeroContact: h.contact }));
vi.mock("@/lib/xero-inbound/invoice", () => ({ reconcileXeroInvoice: h.invoice }));
vi.mock("@/lib/xero-inbound/credit-note", () => ({ reconcileXeroCreditNote: h.note }));
vi.mock("@/lib/xero-cron-runner", () => ({ runXeroInboundCronCycle: h.cron }));
import { syncBookingFromXeroNow, syncMemberFromXeroNow, syncClubFromXeroNow } from "@/lib/xero-sync-now";
const CONTACT = "44320000-0000-4000-8000-000000000001";
describe("sync-now uses only the existing inbound entry points", () => {
  beforeEach(() => {
    h.enabled.mockResolvedValue(true); h.connected.mockResolvedValue(true);
    h.member.mockResolvedValue({ xeroContactId: CONTACT });
    h.booking.mockResolvedValue({ memberId: "member", payment: { id: "payment", xeroInvoiceId: "booking-invoice" } });
    for (const query of [h.bookings, h.payments, h.credits, h.slices, h.links]) query.mockResolvedValue([]);
    h.contact.mockResolvedValue({ backfilledFields: 0 }); h.invoice.mockResolvedValue({ handled: true }); h.note.mockResolvedValue({ mirrorFailed: false });
    h.getInvoices.mockResolvedValue({ body: { invoices: [{ invoiceID: "invoice" }] } });
    h.getCreditNotes.mockResolvedValue({ body: { creditNotes: [{ creditNoteID: "note" }] } });
    h.getInvoice.mockResolvedValue({ body: { invoices: [{ creditNotes: [{ creditNoteID: "current-note" }] }] } });
  });
  it("reads the contact's full documents and invokes the scheduled handlers without a club cycle", async () => {
    await syncMemberFromXeroNow("member");
    expect(h.contact).toHaveBeenCalledWith(CONTACT);
    expect(h.getInvoices.mock.calls[0]?.[6]).toEqual([CONTACT]);
    expect(h.getCreditNotes.mock.calls[0]?.[2]).toContain(CONTACT);
    expect(h.invoice).toHaveBeenCalledWith("invoice", CLUB_FORMAT_TEST);
    expect(h.note).toHaveBeenCalledWith("note"); expect(h.cron).not.toHaveBeenCalled();
  });
  it("paginates contact documents rather than stopping at Xero's first page", async () => {
    h.getInvoices.mockResolvedValueOnce({ body: { invoices: Array.from({ length: 100 }, (_, index) => ({ invoiceID: `i${index}` })) } });
    await syncMemberFromXeroNow("member");
    expect(h.getInvoices).toHaveBeenCalledTimes(2);
    expect(h.getInvoices.mock.calls[1]?.[8]).toBe(2);
    expect(h.invoice).toHaveBeenCalledWith("i99", CLUB_FORMAT_TEST);
  });
  it("includes previously linked notes when Xero omits a removed invoice allocation", async () => {
    h.links.mockResolvedValueOnce([]).mockResolvedValueOnce([{ metadata: { creditNoteId: "historical-note" } }]);
    await syncBookingFromXeroNow("booking");
    expect(h.getInvoice).toHaveBeenCalledWith("test", "booking-invoice");
    expect(h.invoice).toHaveBeenCalledWith("booking-invoice", CLUB_FORMAT_TEST);
    expect(h.note.mock.calls.map((call) => call[0])).toEqual(["current-note", "historical-note"]);
    expect(h.contact).not.toHaveBeenCalled(); expect(h.getInvoices).not.toHaveBeenCalled();
  });
  it("refreshes an unallocated refund note that the invoice does not list", async () => {
    h.booking.mockResolvedValue({ memberId: "member", payment: { id: "payment", xeroInvoiceId: null, xeroRefundCreditNoteId: "refund-note" } });
    h.links.mockResolvedValueOnce([{ xeroObjectId: "linked-note", xeroObjectType: "CREDIT_NOTE" }]).mockResolvedValueOnce([]);
    await syncBookingFromXeroNow("booking");
    expect(h.note.mock.calls.map((call) => call[0])).toEqual(["linked-note", "refund-note"]);
    expect(h.invoice).not.toHaveBeenCalled();
  });
  it("does not report already-in-step after a mirror failure", async () => {
    h.note.mockResolvedValue({ mirrorFailed: true });
    await expect(syncMemberFromXeroNow("member")).rejects.toThrow("mirror could not finish");
  });
  it("fails without provider work when disconnected", async () => {
    h.connected.mockResolvedValue(false);
    await expect(syncMemberFromXeroNow("member")).rejects.toThrow("not connected");
    expect(h.contact).not.toHaveBeenCalled();
  });
  it("reports incremental invoice repairs even when no webhook events were pending", async () => {
    h.cron.mockResolvedValue({ inboundReconciliation: { invoiceReconciliation: { succeeded: 1 } } });
    const result = await syncClubFromXeroNow();
    expect(result.message).toContain("checked 1 invoice(s)");
    expect(result.message).not.toBe("Already in step.");
  });
  it("whole-club sync uses the shared runner and preserves its overlap refusal", async () => {
    h.cron.mockResolvedValue({ skipped: true, message: "A sync is already running." });
    expect(await syncClubFromXeroNow()).toMatchObject({ message: "A sync is already running." });
    expect(h.cron).toHaveBeenCalledWith();
  });
});
