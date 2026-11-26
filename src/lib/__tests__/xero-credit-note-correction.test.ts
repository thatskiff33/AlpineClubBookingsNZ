import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreditNote, Invoice, LineAmountTypes, type XeroClient } from "xero-node";
import { XeroFake } from "@/test/providers/xero-fake";
import { xeroTransport } from "@/test/providers/xero-transport";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/xero-api-usage", async (original) => ({
  ...await original<typeof import("@/lib/xero-api-usage")>(),
  recordXeroApiUsage: vi.fn(async () => undefined),
  xeroDailyBudgetAllowsDeferrableCall: vi.fn(async () => true),
}));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const { setXeroClientForTests, resetXeroClientForTests } = await import("@/lib/xero-test-client-override");
const { resetXeroRateLimitStateForTests } = await import("@/lib/xero-api-client");
const { correctXeroCreditNote, assertXeroCreditNoteCorrectionUntouched } = await import("@/lib/xero-credit-note-correction");

let fake: XeroFake;
let session: ReturnType<typeof xeroTransport>;
let noteId: string;
let contactId: string;
const correction = (cents: number, mode: "VOID" | "INVOICE" = "INVOICE") => ({ noteId, cents, mode, reference: "Credit deduction request-1 / CN-1", keyBase: "deduction-request-1" });
const line = (unitAmount: number) => ({ description: "Original grant", quantity: 1, unitAmount, accountCode: "400", taxType: "OUTPUT2" });

beforeEach(async () => {
  fake = new XeroFake();
  session = xeroTransport(fake);
  setXeroClientForTests(session);
  contactId = fake.createContact("contact", "Member A").contactID;
  const response = await session.xero.accountingApi.createCreditNotes(session.tenantId, { creditNotes: [{
    type: CreditNote.TypeEnum.ACCRECCREDIT, status: CreditNote.StatusEnum.AUTHORISED,
    contact: { contactID: contactId }, lineAmountTypes: LineAmountTypes.Inclusive, lineItems: [line(100)],
  }] });
  noteId = response.body.creditNotes![0]!.creditNoteID!;
});
afterEach(() => { resetXeroClientForTests(); resetXeroRateLimitStateForTests(); });

describe("#5241 Xero credit deduction correction", () => {
  it("voids a whole unused note and a retry is already complete", async () => {
    await expect(correctXeroCreditNote(correction(10000, "VOID"))).resolves.toEqual({ xeroInvoiceId: null, xeroAllocationId: null });
    await correctXeroCreditNote(correction(10000, "VOID"));
    expect(fake.snapshot().creditNotes[0]!.status).toBe("VOIDED");
    expect(fake.snapshot().invoices).toHaveLength(0);
  });

  it("allocates a partial correction invoice with the original contact, account and tax without emailing", async () => {
    const result = await correctXeroCreditNote(correction(2501));
    const invoice = (await session.xero.accountingApi.getInvoice(session.tenantId, result.xeroInvoiceId!)).body.invoices![0]!;
    expect(invoice).toMatchObject({ type: Invoice.TypeEnum.ACCREC, status: Invoice.StatusEnum.PAID, reference: correction(2501).reference, contact: { contactID: contactId }, total: 25.01, sentToContact: false });
    expect(invoice.lineItems![0]).toMatchObject({ accountCode: "400", taxType: "OUTPUT2" });
    expect(fake.snapshot().creditNotes[0]!.remainingCreditCents).toBe(7499);
    expect(fake.snapshot().allocations).toHaveLength(1);
  });

  it("preserves earlier spending and takes only free cents", async () => {
    const earlier = fake.createInvoice("old-invoice", contactId, 4000);
    fake.allocate("earlier-spend", noteId, earlier.invoiceID, 4000);
    await correctXeroCreditNote(correction(3500));
    expect(fake.snapshot().allocations.map(a => a.amountCents)).toEqual([4000, 3500]);
    expect(fake.snapshot().creditNotes[0]!.remainingCreditCents).toBe(2500);
    await expect(correctXeroCreditNote({ ...correction(3000), reference: "other-request", keyBase: "other" })).rejects.toThrow("NOTE_CHANGED_IN_XERO");
    expect(fake.snapshot().invoices).toHaveLength(2);
  });

  it("refuses void after the note changes without any Xero write", async () => {
    fake.payCreditNote("refund", noteId, 1000);
    await expect(correctXeroCreditNote(correction(10000, "VOID"))).rejects.toThrow("NOTE_CHANGED_IN_XERO");
    expect(fake.snapshot().invoices).toHaveLength(0);
    expect(fake.snapshot().creditNotes[0]!.status).toBe("AUTHORISED");
  });

  it("finds an invoice by reference after a lost create reply and allocates it once", async () => {
    session.failAfterApply("createInvoices", { statusCode: 400, body: { Message: "Reply lost after write" } });
    await expect(correctXeroCreditNote(correction(2500))).rejects.toBeDefined();
    expect(fake.snapshot().invoices).toHaveLength(1);
    await expect(assertXeroCreditNoteCorrectionUntouched(correction(2500))).rejects.toThrow("CORRECTION_ALREADY_STARTED");
    await correctXeroCreditNote(correction(2500));
    await correctXeroCreditNote(correction(2500));
    expect(fake.snapshot().invoices).toHaveLength(1);
    expect(fake.snapshot().allocations).toHaveLength(1);
    expect(fake.snapshot().creditNotes[0]!.remainingCreditCents).toBe(7500);
  });

  it("recovers an allocation whose reply was lost without allocating twice", async () => {
    session.failAfterApply("createCreditNoteAllocation", { statusCode: 400, body: { Message: "Reply lost after allocation" } });
    await expect(correctXeroCreditNote(correction(10000))).rejects.toBeDefined();
    await correctXeroCreditNote(correction(10000));
    expect(fake.snapshot().allocations).toHaveLength(1);
    expect(fake.snapshot().creditNotes[0]!.remainingCreditCents).toBe(0);
  });

  it("cancellation reads Xero and refuses an already voided note", async () => {
    await expect(assertXeroCreditNoteCorrectionUntouched(correction(10000, "VOID"))).resolves.toBeUndefined();
    fake.voidCreditNote(noteId);
    await expect(assertXeroCreditNoteCorrectionUntouched(correction(10000, "VOID"))).rejects.toThrow("CORRECTION_ALREADY_STARTED");
  });

  it("refuses mixed account or tax lines before creating an invoice", async () => {
    const getNote = session.xero.accountingApi.getCreditNote.bind(session.xero.accountingApi);
    const accountingApi = new Proxy(session.xero.accountingApi, { get(target, name) {
      if (name === "getCreditNote") return async (...args: Parameters<XeroClient["accountingApi"]["getCreditNote"]>) => {
        const response = await getNote(...args);
        response.body.creditNotes![0]!.lineItems!.push({ ...line(1), accountCode: "401" });
        return response;
      };
      return Reflect.get(target, name);
    } });
    setXeroClientForTests({ tenantId: session.tenantId, xero: { accountingApi } as XeroClient });
    await expect(correctXeroCreditNote(correction(1000))).rejects.toThrow("NOTE_MIXED_LINES");
    expect(fake.snapshot().invoices).toHaveLength(0);
  });

  it("refuses an unrelated invoice carrying the correction reference", async () => {
    await session.xero.accountingApi.createInvoices(session.tenantId, { invoices: [{
      type: Invoice.TypeEnum.ACCREC, status: Invoice.StatusEnum.AUTHORISED, contact: { contactID: contactId },
      reference: correction(1000).reference, lineAmountTypes: LineAmountTypes.Inclusive, lineItems: [line(20)],
    }] });
    await expect(correctXeroCreditNote(correction(1000))).rejects.toThrow("CORRECTION_INVOICE_CHANGED");
    expect(fake.snapshot().allocations).toHaveLength(0);
  });
});
