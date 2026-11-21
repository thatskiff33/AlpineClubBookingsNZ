/**
 * #4369 (`INV-PAY-151`): the worker that records a failed card refund's money
 * back in the Stripe account. Provider fakes only. The frozen clock is the
 * suite's; this file reads no clock of its own.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { xeroClaim } from "@/lib/__tests__/helpers/xero-claim";

const mocks = vi.hoisted(() => ({
  operationFindUnique: vi.fn(),
  operationUpdate: vi.fn(),
  linkFindFirst: vi.fn(),
  bookingFindUnique: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  createInvoices: vi.fn(),
  createPayment: vi.fn(),
  lockDates: vi.fn(),
  start: vi.fn(),
  recordManifest: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroSyncOperation: {
      findUnique: (...args: unknown[]) => mocks.operationFindUnique(...args),
      update: (...args: unknown[]) => mocks.operationUpdate(...args),
      findFirst: async () => null,
    },
    xeroObjectLink: {
      findFirst: (...args: unknown[]) => mocks.linkFindFirst(...args),
    },
    booking: { findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args) },
  },
}));
vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: (...parts: unknown[]) => parts.filter((part) => part !== null && part !== undefined && part !== "").join(":"),
  sanitizeForJson: (value: unknown) => value,
  startXeroSyncOperation: (...args: unknown[]) => mocks.start(...args),
  completeXeroSyncOperation: (...args: unknown[]) => mocks.complete(...args),
  failXeroSyncOperation: (...args: unknown[]) => mocks.fail(...args),
}));
vi.mock("@/lib/xero-tax-anchors", () => import("./support/xero-tax-anchors-baseline"));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
// #4525 (M13): the recorder never throws (its own suite proves it); here, only what the sender hands it.
vi.mock("@/lib/member-money/doors", () => ({
  recordFailedLaterRefundReversalManifest: (...args: unknown[]) => mocks.recordManifest(...args),
}));

import { LineAmountTypes } from "xero-node";
import { resolveXeroTaxRendering } from "@/lib/xero-tax-anchors";
import { BASELINE_XERO_TAX_RENDERING } from "@/lib/xero-tax-rendering";
import {
  cardRefundReversalDocumentDate,
  cardRefundReversalReference,
  createXeroCardRefundReversalInvoice,
  enqueueCardRefundReversalInvoiceOperation,
} from "@/lib/xero-card-refund-reversal-invoice";

const CLOSED_ON = "2026-07-01";
const PAYLOAD = {
  queueType: "CARD_REFUND_REVERSAL_INVOICE",
  bookingId: "booking-abcdefgh",
  paymentId: "pay-1",
  closeTaskId: "close-1",
  amountCents: 8_000,
  closedOn: CLOSED_ON,
};

function invoiceFrom(call: unknown[]) {
  const body = call[1] as { invoices: Array<Record<string, unknown>> };
  return body.invoices[0]!;
}

const providers = () => ({
  getAuthenticatedXeroClient: async () => ({
    tenantId: "tenant",
    xero: { accountingApi: { createInvoices: (...args: unknown[]) => mocks.createInvoices(...args) } },
  }),
  callXeroApi: async (run: () => Promise<unknown>) => run(),
  findOrCreateXeroContactForInvoicedParty: async () => "contact-1",
  createXeroPaymentForInvoice: (...args: unknown[]) => mocks.createPayment(...args),
  getResolvedAccountMapping: async () => ({ itemCode: null, code: "210", codeExplicitlyConfigured: true }),
  getXeroLockDates: () => mocks.lockDates(),
  retryXeroWriteWithContactRepair: async (options: { run: (arg: { contactId: string }) => Promise<{ body: unknown }> }) =>
    options.run({ contactId: "contact-1" }),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.operationFindUnique.mockResolvedValue({ requestPayload: PAYLOAD });
  mocks.operationUpdate.mockResolvedValue({});
  mocks.linkFindFirst.mockResolvedValue(null);
  mocks.bookingFindUnique.mockResolvedValue({
    id: PAYLOAD.bookingId,
    memberId: "member-1",
    organisationId: null,
    member: { id: "member-1" },
    organisation: null,
  });
  mocks.lockDates.mockResolvedValue({ periodLockDate: null, endOfYearLockDate: null });
  mocks.createInvoices.mockResolvedValue({ body: { invoices: [{ invoiceID: "inv-1", invoiceNumber: "INV-1" }] } });
  mocks.createPayment.mockResolvedValue("xpay-1");
  mocks.complete.mockResolvedValue(undefined);
  mocks.fail.mockResolvedValue(undefined);
  mocks.start.mockResolvedValue({ id: "op-new" });
  mocks.recordManifest.mockResolvedValue(undefined);
});

describe("the failed-card-refund reversal invoice (#4369)", () => {
  it("carries the booking's tax treatment, so it undoes the note under the treatment that note used (#4632)", async () => {
    vi.mocked(resolveXeroTaxRendering).mockResolvedValueOnce({ lineAmountTypes: LineAmountTypes.NoTax });
    await createXeroCardRefundReversalInvoice({ syncOperation: xeroClaim("op-1") }, providers() as never);
    expect(resolveXeroTaxRendering).toHaveBeenCalledWith({ kind: "booking", bookingId: PAYLOAD.bookingId });
    const invoice = invoiceFrom(mocks.createInvoices.mock.calls[0]!);
    expect(invoice.lineAmountTypes).toBe("NoTax");
    expect((invoice.lineItems as Array<Record<string, unknown>>)[0]).not.toHaveProperty("taxType");
  });

  it("is an inclusive hut-fee-refunds invoice, paid into Stripe, not emailed and not allocated", async () => {
    await createXeroCardRefundReversalInvoice({ syncOperation: xeroClaim("op-1") }, providers() as never);
    expect(mocks.createInvoices).toHaveBeenCalledTimes(1);
    const invoice = invoiceFrom(mocks.createInvoices.mock.calls[0]!);
    expect(invoice).toMatchObject({
      type: "ACCREC",
      date: CLOSED_ON,
      dueDate: CLOSED_ON,
      status: "AUTHORISED",
      lineAmountTypes: "Inclusive",
      reference: cardRefundReversalReference(PAYLOAD.bookingId, CLOSED_ON),
    });
    expect(invoice).not.toHaveProperty("sentToContact");
    const line = (invoice.lineItems as Array<Record<string, unknown>>)[0]!;
    expect(line).toMatchObject({ quantity: 1, unitAmount: 80, taxType: "OUTPUT2", accountCode: "210" });
    expect(String(line.description)).toMatch(/money returned to the Stripe account/);
    expect(String(line.description)).toContain(PAYLOAD.bookingId.slice(0, 8));
    expect(mocks.createInvoices.mock.calls[0]![4]).toBe("payment:pay-1:card-refund-reversal:close-1");
    expect(mocks.createPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 8_000,
        role: "CARD_REFUND_REVERSAL_PAYMENT",
        date: CLOSED_ON,
        invoiceId: "inv-1",
      }),
    );
    const completion = mocks.complete.mock.calls[0]![1] as { status: string; extraLinks: Array<{ role: string; metadata: { amountCents: number } }> };
    expect(completion.status).toBe("SUCCEEDED");
    expect(completion.extraLinks[0]).toMatchObject({
      role: "CARD_REFUND_REVERSAL_INVOICE",
      localId: "pay-1",
      metadata: { amountCents: 8_000, closeTaskId: "close-1", documentDate: CLOSED_ON },
    });
  });

  it("MUTATION: a lock on the close day dates the invoice the next open day and keeps the close day in the reference", async () => {
    mocks.lockDates.mockResolvedValue({
      periodLockDate: new Date("2026-07-01T00:00:00.000Z"),
      endOfYearLockDate: null,
    });
    await createXeroCardRefundReversalInvoice({ syncOperation: xeroClaim("op-1") }, providers() as never);
    const invoice = invoiceFrom(mocks.createInvoices.mock.calls[0]!);
    expect(invoice.date).toBe("2026-07-02");
    expect(invoice.reference).toBe(cardRefundReversalReference(PAYLOAD.bookingId, CLOSED_ON));
    expect(mocks.createPayment).toHaveBeenCalledWith(expect.objectContaining({ date: "2026-07-02" }));
    expect(mocks.createInvoices).toHaveBeenCalledTimes(1);
  });

  it("when the lock date cannot be read, one lock refusal re-dates once and a second refusal fails", async () => {
    mocks.lockDates.mockRejectedValue(new Error("lock dates unread"));
    mocks.createInvoices
      .mockRejectedValueOnce(new Error("The document date cannot be before the period lock date"))
      .mockResolvedValueOnce({ body: { invoices: [{ invoiceID: "inv-1", invoiceNumber: "INV-1" }] } });
    await createXeroCardRefundReversalInvoice({ syncOperation: xeroClaim("op-1") }, providers() as never);
    expect(invoiceFrom(mocks.createInvoices.mock.calls[0]!).date).toBe(CLOSED_ON);
    expect(invoiceFrom(mocks.createInvoices.mock.calls[1]!).date).toBe("2026-07-02");
    expect(invoiceFrom(mocks.createInvoices.mock.calls[1]!).reference).toContain("closed 2026-07-01");

    mocks.createInvoices.mockReset();
    mocks.createInvoices.mockRejectedValue(new Error("The document date cannot be before the end of year lock date"));
    mocks.complete.mockClear();
    await expect(
      createXeroCardRefundReversalInvoice({ syncOperation: xeroClaim("op-1") }, providers() as never),
    ).rejects.toThrow(/end of year lock date/);
    expect(mocks.createInvoices).toHaveBeenCalledTimes(2);
    expect(mocks.fail).toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("an invoice already linked is not created again, and a voided one is not raised", async () => {
    mocks.linkFindFirst.mockImplementation(async (query: { where: { role: string } }) => {
      if (query.where.role === "CARD_REFUND_REVERSAL_INVOICE") {
        return { xeroObjectId: "inv-1", xeroObjectNumber: "INV-1", active: true, metadata: { documentDate: CLOSED_ON, amountCents: 8_000 } };
      }
      return { xeroObjectId: "xpay-1", active: true, metadata: {} };
    });
    await createXeroCardRefundReversalInvoice({ syncOperation: xeroClaim("op-1") }, providers() as never);
    expect(mocks.createInvoices).not.toHaveBeenCalled();
    expect(mocks.createPayment).not.toHaveBeenCalled();

    mocks.linkFindFirst.mockResolvedValue({ xeroObjectId: "inv-void", active: false, metadata: { status: "VOIDED" } });
    await createXeroCardRefundReversalInvoice({ syncOperation: xeroClaim("op-2") }, providers() as never);
    expect(mocks.createInvoices).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "SUCCEEDED", responsePayload: expect.objectContaining({ skipped: true }) }),
    );
  });

  it("a stored document date that is not a real day is not used: the date is chosen afresh (ALP-580)", async () => {
    mocks.linkFindFirst.mockImplementation(async (query: { where: { role: string } }) =>
      query.where.role === "CARD_REFUND_REVERSAL_INVOICE"
        ? { xeroObjectId: "inv-1", xeroObjectNumber: "INV-1", active: true, metadata: { documentDate: "2026-02-30", amountCents: 8_000 } }
        : null,
    );
    await createXeroCardRefundReversalInvoice({ syncOperation: xeroClaim("op-1") }, providers() as never);
    expect(mocks.createInvoices).not.toHaveBeenCalled();
    expect(mocks.createPayment).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: "inv-1", date: CLOSED_ON }));
  });

  it("a Stripe receipt that fails leaves the invoice link and completes partial", async () => {
    mocks.createPayment.mockRejectedValue(new Error("payment refused"));
    await createXeroCardRefundReversalInvoice({ syncOperation: xeroClaim("op-1") }, providers() as never);
    expect(mocks.createInvoices).toHaveBeenCalledTimes(1);
    expect(mocks.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "PARTIAL",
        extraLinks: [expect.objectContaining({ role: "CARD_REFUND_REVERSAL_INVOICE", xeroObjectId: "inv-1" })],
      }),
    );
    expect(mocks.fail).not.toHaveBeenCalled();
  });

  it("records the reversal's export manifest after completing: the sent line on a send, the stored request on a replay, nothing when voided", async () => {
    await expect(createXeroCardRefundReversalInvoice({ syncOperation: xeroClaim("op-1") }, providers() as never)).resolves.toBe("inv-1");
    expect(mocks.recordManifest).toHaveBeenCalledTimes(1);
    expect(mocks.complete.mock.invocationCallOrder[0]!).toBeLessThan(mocks.recordManifest.mock.invocationCallOrder[0]!);
    const sentLine = (invoiceFrom(mocks.createInvoices.mock.calls[0]!).lineItems as unknown[])[0];
    expect(mocks.recordManifest).toHaveBeenCalledWith({
      paymentId: "pay-1",
      bookingId: PAYLOAD.bookingId,
      closeTaskId: "close-1",
      invoiceId: "inv-1",
      legacyKey: "payment:pay-1:card-refund-reversal:close-1",
      source: { kind: "BUILT", lines: [sentLine], taxRendering: BASELINE_XERO_TAX_RENDERING },
    });

    mocks.recordManifest.mockClear();
    mocks.linkFindFirst.mockImplementation(async (query: { where: { role: string } }) =>
      query.where.role === "CARD_REFUND_REVERSAL_INVOICE"
        ? { xeroObjectId: "inv-1", xeroObjectNumber: "INV-1", active: true, metadata: { documentDate: CLOSED_ON } }
        : null);
    await expect(createXeroCardRefundReversalInvoice({ syncOperation: xeroClaim("op-2") }, providers() as never)).resolves.toBe("inv-1");
    expect(mocks.recordManifest).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: "inv-1", source: { kind: "REPLAY", operationId: "op-2" } }));

    mocks.recordManifest.mockClear();
    mocks.linkFindFirst.mockResolvedValue({ xeroObjectId: "inv-void", active: false, metadata: {} });
    await expect(createXeroCardRefundReversalInvoice({ syncOperation: xeroClaim("op-3") }, providers() as never)).resolves.toBeNull();
    expect(mocks.recordManifest).not.toHaveBeenCalled();
  });

  it("#4632: hands the recorder the very rendering it sent the invoice with, resolved once, not a second resolve or the baseline", async () => {
    const rendering = { lineAmountTypes: LineAmountTypes.Inclusive, taxType: "OUTPUT3" };
    vi.mocked(resolveXeroTaxRendering).mockResolvedValueOnce(rendering);
    await expect(createXeroCardRefundReversalInvoice({ syncOperation: xeroClaim("op-1") }, providers() as never)).resolves.toBe("inv-1");
    expect(resolveXeroTaxRendering).toHaveBeenCalledTimes(1);
    const invoice = invoiceFrom(mocks.createInvoices.mock.calls[0]!);
    expect((invoice.lineItems as Array<Record<string, unknown>>)[0]).toMatchObject({ taxType: "OUTPUT3" });
    const source = (mocks.recordManifest.mock.calls[0]![0] as { source: { kind: string; lines: unknown[]; taxRendering: unknown } }).source;
    expect(source.kind).toBe("BUILT");
    expect(source.taxRendering).toBe(rendering);
    expect(source.lines).toEqual(invoice.lineItems);
  });

  it("queues one row per close, and will not queue another after the invoice was voided", async () => {
    const store = {
      xeroSyncOperation: { findFirst: vi.fn<() => Promise<{ id: string } | null>>(async () => null) },
      xeroObjectLink: { findFirst: vi.fn<() => Promise<{ id: string } | null>>(async () => null) },
    };
    const queued = await enqueueCardRefundReversalInvoiceOperation({
      paymentId: "pay-1",
      bookingId: "booking-abcdefgh",
      closeTaskId: "close-1",
      amountCents: 8_000,
      closedOn: CLOSED_ON,
      store: store as never,
    });
    expect(queued.queueOperationId).toBe("op-new");
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "payment:pay-1:card-refund-reversal:close-1",
        localModel: "Payment",
        localId: "pay-1",
      }),
    );

    store.xeroSyncOperation.findFirst.mockResolvedValue({ id: "op-old" });
    expect(
      (await enqueueCardRefundReversalInvoiceOperation({
        paymentId: "pay-1",
        bookingId: "booking-abcdefgh",
        closeTaskId: "close-1",
        amountCents: 8_000,
        closedOn: CLOSED_ON,
        store: store as never,
      })).queueOperationId,
    ).toBe("op-old");

    store.xeroSyncOperation.findFirst.mockResolvedValue(null);
    store.xeroObjectLink.findFirst.mockResolvedValue({ id: "link-void" });
    expect(
      (await enqueueCardRefundReversalInvoiceOperation({
        paymentId: "pay-1",
        bookingId: "booking-abcdefgh",
        closeTaskId: "close-1",
        amountCents: 8_000,
        closedOn: CLOSED_ON,
        store: store as never,
      })).queueOperationId,
    ).toBeNull();
  });

  it("dates a locked close the first open day", () => {
    expect(cardRefundReversalDocumentDate("2026-06-01", "2026-07-01")).toEqual({ date: "2026-07-02", redated: true });
    expect(cardRefundReversalDocumentDate("2026-07-02", "2026-07-01")).toEqual({ date: "2026-07-02", redated: false });
    expect(cardRefundReversalDocumentDate("2026-07-01", null)).toEqual({ date: "2026-07-01", redated: false });
  });
});
