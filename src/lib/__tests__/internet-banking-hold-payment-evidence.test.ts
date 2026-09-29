import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3643 (`INV-PAY-107`): what the hold-expiry job reads before it may release
 * a hold. Xero is read live (a transfer that landed just before the deadline
 * may not have reached the inbound reconcile), the recorded PAYMENT links are
 * the fallback and the under-lock re-check, and anything that cannot be
 * established is `unreadable` — never `unpaid`.
 */

const mocks = vi.hoisted(() => ({
  linkFindMany: vi.fn(),
  modificationFindMany: vi.fn(),
  getInvoice: vi.fn(),
  getAuthenticatedXeroClient: vi.fn(),
  findBookingSupplementaryInvoiceIds: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroObjectLink: { findMany: mocks.linkFindMany },
    bookingModification: { findMany: mocks.modificationFindMany },
  },
}));

vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: mocks.getAuthenticatedXeroClient,
  callXeroApi: (call: () => Promise<unknown>) => call(),
}));

vi.mock("@/lib/xero-clearing-allocations", () => ({
  findBookingSupplementaryInvoiceIds: mocks.findBookingSupplementaryInvoiceIds,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  hasRecordedInvoicePayment,
  readHoldPaymentEvidence,
} from "@/lib/internet-banking-hold-payment-evidence";
import { isRecordedBookingInvoicePayment } from "@/lib/xero-inbound/object-links";

const HOLD = {
  id: "pay_1",
  bookingId: "booking_1",
  xeroInvoiceId: "inv_1",
  xeroInvoiceNumber: "INV-001",
};

function invoiceResponse(fields: Record<string, unknown>) {
  return { body: { invoices: [{ invoiceNumber: "INV-001", status: "AUTHORISED", ...fields }] } };
}

function paymentLink(overrides: Record<string, unknown> = {}) {
  return {
    xeroObjectType: "PAYMENT",
    role: "INVOICE_PAYMENT",
    metadata: { amount: 150, status: "AUTHORISED" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.linkFindMany.mockResolvedValue([]);
  mocks.modificationFindMany.mockResolvedValue([]);
  mocks.findBookingSupplementaryInvoiceIds.mockResolvedValue([]);
  mocks.getAuthenticatedXeroClient.mockResolvedValue({
    xero: { accountingApi: { getInvoice: mocks.getInvoice } },
    tenantId: "tenant_1",
  });
  mocks.getInvoice.mockResolvedValue(invoiceResponse({ amountPaid: 0, amountDue: 300 }));
});

describe("readHoldPaymentEvidence (#3643)", () => {
  it("calls a part-paid invoice paid, with what was paid and what is owed", async () => {
    mocks.getInvoice.mockResolvedValue(invoiceResponse({ amountPaid: 150, amountDue: 150 }));

    const evidence = await readHoldPaymentEvidence(HOLD);

    expect(evidence).toMatchObject({
      kind: "paid",
      fromRecordedLinkOnly: false,
      paidCents: 15000,
      amountDueCents: 15000,
      cashComplete: true,
      paidInFull: false,
    });
    expect(evidence.readStartedAt).toBeInstanceOf(Date);
    expect(mocks.getInvoice).toHaveBeenCalledWith("tenant_1", "inv_1");
  });

  it("says paid in full when Xero shows nothing left owing (the inbound sync is behind)", async () => {
    mocks.getInvoice.mockResolvedValue(invoiceResponse({ amountPaid: 300, amountDue: 0 }));

    const evidence = await readHoldPaymentEvidence(HOLD);

    expect(evidence).toMatchObject({ kind: "paid", paidInFull: true, amountDueCents: 0 });
  });

  it("calls an invoice with no cash and no recorded payment unpaid", async () => {
    const evidence = await readHoldPaymentEvidence(HOLD);

    expect(evidence).toMatchObject({ kind: "unpaid" });
  });

  it("counts an applied overpayment as money paid (the inbound cash rule)", async () => {
    mocks.getInvoice.mockResolvedValue(
      invoiceResponse({ amountPaid: 0, amountDue: 200, overpayments: [{ appliedAmount: 100 }] }),
    );

    const evidence = await readHoldPaymentEvidence(HOLD);

    expect(evidence).toMatchObject({ kind: "paid", paidCents: 10000 });
  });

  it("reads the supplementary invoices too: money on one keeps the hold", async () => {
    mocks.findBookingSupplementaryInvoiceIds.mockResolvedValue(["inv_supp"]);
    mocks.getInvoice.mockImplementation(async (_tenant: string, invoiceId: string) =>
      invoiceId === "inv_supp"
        ? invoiceResponse({ invoiceNumber: "INV-002", amountPaid: 20, amountDue: 30 })
        : invoiceResponse({ amountPaid: 0, amountDue: 300 }),
    );

    const evidence = await readHoldPaymentEvidence(HOLD);

    expect(mocks.getInvoice).toHaveBeenCalledTimes(2);
    expect(evidence).toMatchObject({ kind: "paid", paidCents: 2000, amountDueCents: 33000 });
  });

  it("calls an invoice Xero cannot be asked about unreadable, never unpaid", async () => {
    mocks.getAuthenticatedXeroClient.mockRejectedValue(
      new Error("Xero is not connected. Please connect via admin panel."),
    );

    const evidence = await readHoldPaymentEvidence(HOLD);

    expect(evidence).toMatchObject({
      kind: "unreadable",
      reason: "Xero is not connected. Please connect via admin panel.",
      notFound: false,
    });
  });

  it("marks a Xero 404 for the booking's invoice as not found, still unreadable", async () => {
    mocks.getInvoice.mockRejectedValue(
      Object.assign(new Error("Not Found"), { response: { statusCode: 404 } }),
    );

    const evidence = await readHoldPaymentEvidence(HOLD);

    expect(evidence).toMatchObject({ kind: "unreadable", notFound: true });
  });

  it("keeps the primary's cash when a supplementary invoice cannot be read", async () => {
    mocks.findBookingSupplementaryInvoiceIds.mockResolvedValue(["inv_supp"]);
    mocks.getInvoice.mockImplementation(async (_tenant: string, invoiceId: string) => {
      if (invoiceId === "inv_supp") throw new Error("503");
      return invoiceResponse({ amountPaid: 150, amountDue: 150 });
    });

    const evidence = await readHoldPaymentEvidence(HOLD);

    expect(evidence).toMatchObject({
      kind: "paid",
      fromRecordedLinkOnly: false,
      paidCents: 15000,
      // Not every invoice was read, so nothing can be sized or recorded.
      amountDueCents: null,
      cashComplete: false,
      paidInFull: false,
    });
  });

  it("calls a payload with no payment fields unreadable", async () => {
    mocks.getInvoice.mockResolvedValue(invoiceResponse({ amountDue: 300 }));

    const evidence = await readHoldPaymentEvidence(HOLD);

    expect(evidence).toMatchObject({ kind: "unreadable" });
  });

  it("still calls it paid when Xero is down but a payment link is recorded", async () => {
    mocks.linkFindMany.mockResolvedValue([paymentLink()]);
    mocks.getInvoice.mockRejectedValue(new Error("503"));

    const evidence = await readHoldPaymentEvidence(HOLD);

    expect(evidence).toMatchObject({ kind: "paid", fromRecordedLinkOnly: true });
  });

  it("lets a clean Xero read of no cash overrule a stale recorded payment link", async () => {
    // The treasurer matched a deposit to this invoice and then removed it:
    // Xero shows amountPaid 0, the local link still says AUTHORISED.
    mocks.linkFindMany.mockResolvedValue([paymentLink()]);

    const evidence = await readHoldPaymentEvidence(HOLD);

    expect(evidence).toMatchObject({ kind: "unpaid" });
  });

  it("releases (no-invoice) a hold with no issued invoice and no payment link", async () => {
    const evidence = await readHoldPaymentEvidence({ ...HOLD, xeroInvoiceId: null });

    expect(evidence).toMatchObject({ kind: "no-invoice" });
    expect(mocks.getInvoice).not.toHaveBeenCalled();
  });
});

describe("hasRecordedInvoicePayment (#3643)", () => {
  it("finds a part payment recorded on the booking's payment or its edits' invoices", async () => {
    mocks.modificationFindMany.mockResolvedValue([{ id: "mod_1" }]);
    mocks.linkFindMany.mockResolvedValue([paymentLink()]);

    await expect(
      hasRecordedInvoicePayment({ paymentId: "pay_1", bookingId: "booking_1" }),
    ).resolves.toBe(true);
    expect(mocks.linkFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          active: true,
          xeroObjectType: "PAYMENT",
          OR: [
            { localModel: "Payment", localId: "pay_1" },
            { localModel: "BookingModification", localId: { in: ["mod_1"] } },
          ],
        }),
      }),
    );
  });

  it("counts only links created since the read started when asked (the re-check)", async () => {
    const since = new Date("2026-07-01T00:00:00Z");

    await hasRecordedInvoicePayment({ paymentId: "pay_1", bookingId: "booking_1", since });

    expect(mocks.linkFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ createdAt: { gte: since } }),
      }),
    );
  });

  it("ignores a payment Xero reported as DELETED", async () => {
    mocks.linkFindMany.mockResolvedValue([
      paymentLink({ metadata: { amount: 150, status: "DELETED" } }),
    ]);

    await expect(
      hasRecordedInvoicePayment({ paymentId: "pay_1", bookingId: "booking_1" }),
    ).resolves.toBe(false);
  });

  it("reads through the transaction client it is given", async () => {
    const tx = {
      xeroObjectLink: { findMany: vi.fn().mockResolvedValue([paymentLink()]) },
      bookingModification: { findMany: vi.fn().mockResolvedValue([]) },
    };

    await expect(
      hasRecordedInvoicePayment({ paymentId: "pay_1", bookingId: "booking_1" }, tx as never),
    ).resolves.toBe(true);
    expect(mocks.linkFindMany).not.toHaveBeenCalled();
  });
});

describe("isRecordedBookingInvoicePayment (#3643, the one rule)", () => {
  it.each([
    ["a payment on the primary invoice", { role: "INVOICE_PAYMENT" }, true],
    ["a payment on a supplementary invoice", { role: "SUPPLEMENTARY_INVOICE_PAYMENT" }, true],
    ["a payment with no status recorded", { role: "INVOICE_PAYMENT", metadata: null }, true],
    ["a refund's payment on the same Payment row", { role: "REFUND_PAYMENT" }, false],
    ["a subscription payment", { role: "SUBSCRIPTION_PAYMENT" }, false],
    ["no role", { role: null }, false],
    ["an invoice link, not a payment", { xeroObjectType: "INVOICE" }, false],
    ["a reversed (DELETED) payment", { metadata: { status: "DELETED" } }, false],
    ["a VOIDED payment", { metadata: { status: "voided" } }, false],
  ])("%s -> %s", (_label, overrides, expected) => {
    expect(isRecordedBookingInvoicePayment(paymentLink(overrides))).toBe(expected);
  });
});
