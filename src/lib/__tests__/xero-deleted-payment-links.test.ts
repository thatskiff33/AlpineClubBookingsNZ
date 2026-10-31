/**
 * #4531 (`INV-INT-031`): a payment link is retired only once Xero confirms its
 * payment DELETED; absence from a trusted payload only nominates it. Synthetic
 * fixtures and a doubled Xero client only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreditNote, Invoice } from "xero-node";

const h = vi.hoisted(() => ({
  linkFindMany: vi.fn(),
  linkUpdateMany: vi.fn(),
  linkFindUnique: vi.fn(),
  budgetAllows: vi.fn(),
  writeAudit: vi.fn(),
  getPayment: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroObjectLink: { findMany: h.linkFindMany, updateMany: h.linkUpdateMany, findUnique: h.linkFindUnique },
  },
}));
vi.mock("@/lib/xero-api-usage", () => ({ xeroDailyBudgetAllowsDeferrableCall: h.budgetAllows }));
vi.mock("@/lib/xero-inbound/audit", () => ({ writeXeroInboundAuditLogs: h.writeAudit }));
vi.mock("@/lib/logger", () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/xero-api-client", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-api-client");
  return { ...actual, callXeroApi: (fn: () => Promise<unknown>) => fn() };
});

import { XeroDailyLimitError } from "@/lib/xero-api-client";
import {
  confirmXeroPaymentDeleted,
  creditNotePaymentsForAbsence,
  invoicePaymentsForAbsence,
  MAX_DELETED_PAYMENT_CONFIRMATIONS_PER_RECONCILE,
  retireDeletedPaymentLinksAbsentFromPayload,
  retireDeletedXeroPaymentLink,
} from "@/lib/xero-inbound/deleted-payment-links";

const INVOICE = "inv-4531";
const NOTE = "cn-4531";
const SCOPE = [{ localModel: "Payment", localId: "pay-local-1" }];
const UPDATED = new Date("2026-06-30T10:00:00.000Z");
const session = { tenantId: "tenant-test", xero: { accountingApi: { getPayment: h.getPayment } } } as never;

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    invoiceID: INVOICE,
    status: "AUTHORISED",
    amountPaid: 120,
    payments: [{ paymentID: "replacement", amount: 120, status: "AUTHORISED" }],
    ...overrides,
  } as unknown as Invoice;
}

function linkRow(xeroObjectId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `link-${xeroObjectId}-${String(overrides.localId ?? "pay-local-1")}`,
    localModel: "Payment",
    localId: "pay-local-1",
    role: "INVOICE_PAYMENT",
    xeroObjectType: "PAYMENT",
    active: true,
    xeroObjectId,
    xeroObjectNumber: null,
    metadata: { invoiceId: INVOICE, amount: 120, status: null },
    updatedAt: UPDATED,
    ...overrides,
  };
}

function xeroPayment(paymentID: string, status: string, invoiceID = INVOICE) {
  return { body: { payments: [{ paymentID, status, invoice: { invoiceID } }] } };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.budgetAllows.mockResolvedValue(true);
  h.linkUpdateMany.mockResolvedValue({ count: 1 });
  h.linkFindUnique.mockResolvedValue({ active: false, metadata: {}, updatedAt: UPDATED });
});

describe("which payloads may nominate a candidate (#4531)", () => {
  it("trusts an invoice whose listed payments are complete and add up to AmountPaid", () => {
    const result = invoicePaymentsForAbsence(invoice());
    expect(result).toEqual({ trusted: true, presentIds: new Set(["replacement"]) });
  });

  it("counts a DELETED entry as present but not toward AmountPaid", () => {
    const result = invoicePaymentsForAbsence(
      invoice({
        payments: [
          { paymentID: "gone", amount: 120, status: "DELETED" },
          { paymentID: "replacement", amount: 120, status: "AUTHORISED" },
        ] as never,
      }),
    );
    expect(result).toEqual({ trusted: true, presentIds: new Set(["gone", "replacement"]) });
  });

  it("refuses a payload with no Payments list at all", () => {
    expect(invoicePaymentsForAbsence(invoice({ payments: undefined })).trusted).toBe(false);
    expect(creditNotePaymentsForAbsence({ creditNoteID: NOTE } as CreditNote).trusted).toBe(false);
  });

  it("refuses a listed payment without an id or a readable amount", () => {
    expect(invoicePaymentsForAbsence(invoice({ payments: [{ amount: 120 }] as never })).trusted).toBe(false);
    expect(
      invoicePaymentsForAbsence(invoice({ payments: [{ paymentID: "replacement", amount: "120" }] as never })).trusted,
    ).toBe(false);
  });

  it("refuses a truncated list whose payments fall short of AmountPaid", () => {
    expect(invoicePaymentsForAbsence(invoice({ amountPaid: 240 })).trusted).toBe(false);
  });

  it("refuses a payload the module's degraded-shape guard finds incomplete", () => {
    const degraded = invoice({
      overpayments: [{ overpaymentID: "op-1" }] as never,
    });
    expect(invoicePaymentsForAbsence(degraded)).toEqual({ trusted: false, reason: "The invoice's cash figures are incomplete." });
  });

  it("trusts a credit note whose refund payments are all identified", () => {
    const result = creditNotePaymentsForAbsence({
      creditNoteID: NOTE,
      payments: [{ paymentID: "refund-live", amount: 50 }],
    } as unknown as CreditNote);
    expect(result).toEqual({ trusted: true, presentIds: new Set(["refund-live"]) });
  });
});

describe("retiring the links of payments Xero deleted (#4531)", () => {
  const retire = (payments = invoicePaymentsForAbsence(invoice())) =>
    retireDeletedPaymentLinksAbsentFromPayload({
      session,
      document: { kind: "INVOICE", id: INVOICE },
      payments,
      localScope: SCOPE,
    });

  it("retires nothing, and asks nothing, when the payload cannot be trusted", async () => {
    const outcome = await retire(invoicePaymentsForAbsence(invoice({ payments: undefined })));
    expect(outcome).toMatchObject({ skippedReason: "The payload carries no Payments list.", retiredLinks: 0, xeroCalls: 0 });
    expect(h.linkFindMany).not.toHaveBeenCalled();
    expect(h.getPayment).not.toHaveBeenCalled();
    expect(h.linkUpdateMany).not.toHaveBeenCalled();
  });

  it("retires a confirmed DELETED payment and leaves the hand-entered replacement active", async () => {
    // The double ignores the query's filters, so the replacement comes back too.
    h.linkFindMany.mockResolvedValue([linkRow("deleted"), linkRow("replacement")]);
    h.getPayment.mockResolvedValue(xeroPayment("deleted", "DELETED"));

    const outcome = await retire();

    expect(h.linkFindMany.mock.calls[0][0].where).toMatchObject({
      xeroObjectType: "PAYMENT",
      active: true,
      metadata: { path: ["invoiceId"], equals: INVOICE },
      xeroObjectId: { notIn: ["replacement"] },
      OR: [{ localModel: "Payment", localId: "pay-local-1" }],
    });
    expect(h.getPayment).toHaveBeenCalledTimes(1);
    expect(h.getPayment).toHaveBeenCalledWith("tenant-test", "deleted");
    expect(h.linkUpdateMany).toHaveBeenCalledTimes(1);
    expect(h.linkUpdateMany).toHaveBeenCalledWith({
      where: { id: "link-deleted-pay-local-1", xeroObjectType: "PAYMENT", active: true, updatedAt: UPDATED },
      data: { active: false, metadata: { invoiceId: INVOICE, amount: 120, status: "DELETED" } },
    });
    expect(outcome).toMatchObject({ candidatePayments: 1, xeroCalls: 1, confirmedDeleted: ["deleted"], retiredLinks: 1 });
    expect(h.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "xero-inbound-deleted-payment-retired",
        links: [expect.objectContaining({ xeroObjectId: "deleted", role: "INVOICE_PAYMENT" })],
      }),
    );
  });

  it("asks once per payment and retires every link that names it", async () => {
    h.linkFindMany.mockResolvedValue([linkRow("deleted"), linkRow("deleted", { localModel: "Booking", localId: "booking-1" })]);
    h.getPayment.mockResolvedValue(xeroPayment("deleted", "DELETED"));
    const outcome = await retire();
    expect(h.getPayment).toHaveBeenCalledTimes(1);
    expect(h.linkUpdateMany).toHaveBeenCalledTimes(2);
    expect(outcome.retiredLinks).toBe(2);
  });

  it("keeps a candidate Xero still reports live", async () => {
    h.linkFindMany.mockResolvedValue([linkRow("absent-but-live")]);
    h.getPayment.mockResolvedValue(xeroPayment("absent-but-live", "AUTHORISED"));
    const outcome = await retire();
    expect(outcome).toMatchObject({ confirmedLive: ["absent-but-live"], retiredLinks: 0 });
    expect(h.linkUpdateMany).not.toHaveBeenCalled();
  });

  it("keeps a deleted payment Xero files under another invoice", async () => {
    h.linkFindMany.mockResolvedValue([linkRow("deleted")]);
    h.getPayment.mockResolvedValue(xeroPayment("deleted", "DELETED", "another-invoice"));
    const outcome = await retire();
    expect(outcome).toMatchObject({ unconfirmed: ["deleted"], retiredLinks: 0 });
    expect(h.linkUpdateMany).not.toHaveBeenCalled();
  });

  it("keeps a candidate when Xero's answer fails", async () => {
    h.linkFindMany.mockResolvedValue([linkRow("deleted")]);
    h.getPayment.mockRejectedValue(new Error("404 Not Found"));
    const outcome = await retire();
    expect(outcome).toMatchObject({ unconfirmed: ["deleted"], xeroCalls: 1, retiredLinks: 0 });
    expect(h.linkUpdateMany).not.toHaveBeenCalled();
  });

  it("defers without calling Xero when the day's budget is spent", async () => {
    h.linkFindMany.mockResolvedValue([linkRow("deleted")]);
    h.budgetAllows.mockResolvedValue(false);
    const outcome = await retire();
    expect(outcome).toMatchObject({ deferred: ["deleted"], xeroCalls: 0, retiredLinks: 0 });
    expect(h.getPayment).not.toHaveBeenCalled();
    expect(h.linkUpdateMany).not.toHaveBeenCalled();
  });

  it("stops asking once Xero's daily limit is hit, deferring the rest", async () => {
    h.linkFindMany.mockResolvedValue([linkRow("first"), linkRow("second")]);
    h.getPayment.mockRejectedValue(new XeroDailyLimitError(3600, true));
    const outcome = await retire();
    expect(h.getPayment).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ deferred: ["first", "second"], xeroCalls: 0, retiredLinks: 0 });
  });

  it(`asks about at most ${MAX_DELETED_PAYMENT_CONFIRMATIONS_PER_RECONCILE} payments per reconcile`, async () => {
    const ids = Array.from({ length: MAX_DELETED_PAYMENT_CONFIRMATIONS_PER_RECONCILE + 2 }, (_, index) => `p${index}`);
    h.linkFindMany.mockResolvedValue(ids.map((id) => linkRow(id)));
    h.getPayment.mockImplementation(async (_tenant: string, id: string) => xeroPayment(id, "DELETED"));
    const outcome = await retire();
    expect(h.getPayment).toHaveBeenCalledTimes(MAX_DELETED_PAYMENT_CONFIRMATIONS_PER_RECONCILE);
    expect(outcome.xeroCalls).toBe(MAX_DELETED_PAYMENT_CONFIRMATIONS_PER_RECONCILE);
    expect(outcome.deferred).toEqual(ids.slice(MAX_DELETED_PAYMENT_CONFIRMATIONS_PER_RECONCILE));
    expect(outcome.retiredLinks).toBe(MAX_DELETED_PAYMENT_CONFIRMATIONS_PER_RECONCILE);
  });

  it("a replay finds nothing to retire and writes no audit row", async () => {
    h.linkFindMany.mockResolvedValue([linkRow("deleted")]);
    h.getPayment.mockResolvedValue(xeroPayment("deleted", "DELETED"));
    h.linkUpdateMany.mockResolvedValue({ count: 0 });
    h.linkFindUnique.mockResolvedValue({ active: false, metadata: { status: "DELETED" }, updatedAt: UPDATED });
    const outcome = await retire();
    expect(outcome).toMatchObject({ confirmedDeleted: ["deleted"], retiredLinks: 0 });
    expect(h.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ links: [] }));
  });

  it("nominates a credit note's refund payments by the note's id", async () => {
    h.linkFindMany.mockResolvedValue([
      linkRow("refund-deleted", { role: "REFUND_PAYMENT", metadata: { creditNoteId: NOTE, amount: 50 } }),
    ]);
    h.getPayment.mockResolvedValue({ body: { payments: [{ paymentID: "refund-deleted", status: "DELETED", creditNote: { creditNoteID: NOTE } }] } });
    const outcome = await retireDeletedPaymentLinksAbsentFromPayload({
      session,
      document: { kind: "CREDIT_NOTE", id: NOTE },
      payments: creditNotePaymentsForAbsence({ creditNoteID: NOTE, payments: [] } as unknown as CreditNote),
      localScope: SCOPE,
    });
    expect(h.linkFindMany.mock.calls[0][0].where.metadata).toEqual({ path: ["creditNoteId"], equals: NOTE });
    expect(outcome.retiredLinks).toBe(1);
  });
});

describe("the guarded retire write (#4531)", () => {
  it("re-reads after a concurrent write and retires over its metadata", async () => {
    const later = new Date("2026-06-30T11:00:00.000Z");
    h.linkUpdateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    h.linkFindUnique.mockResolvedValue({ active: true, metadata: { invoiceId: INVOICE, amount: 125 }, updatedAt: later });
    expect(await retireDeletedXeroPaymentLink(linkRow("deleted"))).toBe(true);
    expect(h.linkUpdateMany.mock.calls[1][0]).toEqual({
      where: { id: "link-deleted-pay-local-1", xeroObjectType: "PAYMENT", active: true, updatedAt: later },
      data: { active: false, metadata: { invoiceId: INVOICE, amount: 125, status: "DELETED" } },
    });
  });

  it("gives up after two lost guards rather than overwrite blindly", async () => {
    h.linkUpdateMany.mockResolvedValue({ count: 0 });
    h.linkFindUnique.mockResolvedValue({ active: true, metadata: {}, updatedAt: UPDATED });
    expect(await retireDeletedXeroPaymentLink(linkRow("deleted"))).toBe(false);
    expect(h.linkUpdateMany).toHaveBeenCalledTimes(2);
  });
});

describe("confirming a payment's deletion (#4531)", () => {
  it("is DELETED only for the payment asked about", async () => {
    h.getPayment.mockResolvedValue(xeroPayment("someone-else", "DELETED"));
    expect(await confirmXeroPaymentDeleted(session, "deleted", { workflow: "test" })).toEqual({
      confirmation: "UNCONFIRMED",
      called: true,
    });
  });

  it("defers when today's usage cannot be read", async () => {
    h.budgetAllows.mockRejectedValue(new Error("db down"));
    expect(await confirmXeroPaymentDeleted(session, "deleted", { workflow: "test" })).toEqual({
      confirmation: "DEFERRED",
      called: false,
    });
    expect(h.getPayment).not.toHaveBeenCalled();
  });
});
