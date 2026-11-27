import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreditNote, CurrencyCode, Invoice, LineAmountTypes, type XeroClient } from "xero-node";
import { XeroFake } from "@/test/providers/xero-fake";
import { xeroTransport } from "@/test/providers/xero-transport";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/xero-api-usage", async (original) => ({
  ...((await original()) as typeof import("@/lib/xero-api-usage")),
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
  vi.stubEnv("APP_ENVIRONMENT_ROLE", "non-production");
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
afterEach(() => { resetXeroClientForTests(); resetXeroRateLimitStateForTests(); vi.unstubAllEnvs(); });

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

  it("adopts an exact invoice by reference even when its create key is no longer available", async () => {
    const response = await session.xero.accountingApi.createInvoices(session.tenantId, { invoices: [{
      type: Invoice.TypeEnum.ACCREC, status: Invoice.StatusEnum.AUTHORISED, contact: { contactID: contactId },
      reference: correction(1000).reference, currencyCode: CurrencyCode.NZD, sentToContact: false,
      lineAmountTypes: LineAmountTypes.Inclusive, lineItems: [line(10)],
    }] }, undefined, undefined, "expired-create-key");
    const result = await correctXeroCreditNote(correction(1000));
    expect(result.xeroInvoiceId).toBe(response.body.invoices![0]!.invoiceID);
    expect(fake.snapshot().invoices).toHaveLength(1);
    expect(fake.snapshot().allocations).toHaveLength(1);
  });

  it("awaits the caller's durable fence before each mutation and a refused fence writes nothing", async () => {
    const beforeMutation = vi.fn(async () => { throw new Error("worker claim lost"); });
    await expect(correctXeroCreditNote({ ...correction(1000), beforeMutation })).rejects.toThrow("worker claim lost");
    expect(fake.snapshot().invoices).toHaveLength(0);
    beforeMutation.mockImplementation(async () => undefined as never);
    await correctXeroCreditNote({ ...correction(1000), beforeMutation });
    expect(beforeMutation).toHaveBeenCalledTimes(3); // rejected create fence, create fence, allocation fence
    await correctXeroCreditNote({ ...correction(1000), beforeMutation });
    expect(beforeMutation).toHaveBeenCalledTimes(3); // replay only reads
  });

  it("refuses an unrelated invoice carrying the correction reference", async () => {
    await session.xero.accountingApi.createInvoices(session.tenantId, { invoices: [{
      type: Invoice.TypeEnum.ACCREC, status: Invoice.StatusEnum.AUTHORISED, contact: { contactID: contactId },
      reference: correction(1000).reference, lineAmountTypes: LineAmountTypes.Inclusive, lineItems: [line(20)],
    }] });
    await expect(correctXeroCreditNote(correction(1000))).rejects.toThrow("CORRECTION_INVOICE_CHANGED");
    expect(fake.snapshot().allocations).toHaveLength(0);
  });

  const proxyApi = (name: string, wrap: (original: (...args: never[]) => Promise<{ body: Record<string, unknown[] | undefined> }>) => unknown) => {
    const original = (session.xero.accountingApi as unknown as Record<string, (...args: never[]) => Promise<{ body: Record<string, unknown[] | undefined> }>>)[name]!.bind(session.xero.accountingApi);
    const accountingApi = new Proxy(session.xero.accountingApi, { get: (target, key) => key === name ? wrap(original) : Reflect.get(target, key) });
    setXeroClientForTests({ tenantId: session.tenantId, xero: { accountingApi } as XeroClient });
  };
  const adoptable = () => session.xero.accountingApi.createInvoices(session.tenantId, { invoices: [{
    type: Invoice.TypeEnum.ACCREC, status: Invoice.StatusEnum.AUTHORISED, contact: { contactID: contactId },
    reference: correction(1000).reference, currencyCode: CurrencyCode.NZD, sentToContact: false,
    lineAmountTypes: LineAmountTypes.Inclusive, lineItems: [line(10)],
  }] }).then((response) => response.body.invoices![0]!.invoiceID!);

  it("refuses a note it cannot verify as the member's sales credit note", async () => {
    proxyApi("getCreditNote", (original) => async (...args: never[]) => {
      const response = await original(...args);
      (response.body.creditNotes![0] as CreditNote).type = CreditNote.TypeEnum.ACCPAYCREDIT;
      return response;
    });
    await expect(correctXeroCreditNote(correction(1000))).rejects.toThrow("NOTE_CHANGED_IN_XERO: the original credit note cannot be verified");
    expect(fake.snapshot().invoices).toHaveLength(0);
  });

  it("refuses to void a note whose total is not the whole deduction", async () => {
    await expect(correctXeroCreditNote(correction(5000, "VOID"))).rejects.toThrow("NOTE_CHANGED_IN_XERO: the note total");
    expect(fake.snapshot().creditNotes[0]!.status).toBe("AUTHORISED");
  });

  it("refuses an allocation of its invoice for another amount", async () => {
    const invoiceId = await adoptable();
    fake.allocate("short", noteId, invoiceId, 500);
    await expect(correctXeroCreditNote(correction(1000))).rejects.toThrow("CORRECTION_INVOICE_CHANGED: the correction allocation");
    expect(fake.snapshot().allocations).toHaveLength(1);
  });

  it("refuses to allocate once its invoice was part paid some other way", async () => {
    const invoiceId = await adoptable();
    fake.payInvoice("elsewhere", invoiceId, 400);
    await expect(correctXeroCreditNote(correction(1000))).rejects.toThrow("NOTE_CHANGED_IN_XERO: the correction invoice or the credit note has already been used");
    expect(fake.snapshot().allocations).toHaveLength(0);
  });

  it("fails, for a later read to settle, when Xero does not confirm the allocation", async () => {
    proxyApi("createCreditNoteAllocation", (original) => async (...args: never[]) => {
      const response = await original(...args);
      return { ...response, body: { ...response.body, allocations: [] } };
    });
    await expect(correctXeroCreditNote(correction(1000))).rejects.toThrow("Xero did not confirm the correction allocation");
    setXeroClientForTests(session);
    await expect(correctXeroCreditNote(correction(1000))).resolves.toMatchObject({ xeroAllocationId: expect.any(String) });
    expect(fake.snapshot().allocations).toHaveLength(1);
  });
});
