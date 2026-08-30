import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  bookingModificationFindUnique: vi.fn(),
  xeroSyncOperationUpdate: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  getAuthenticatedXeroClient: vi.fn(),
  callXeroApi: vi.fn(),
  getResolvedAccountMapping: vi.fn(),
  getAccountMapping: vi.fn(),
  findOrCreateXeroContact: vi.fn(),
  retryXeroWriteWithContactRepair: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: mocks.bookingFindUnique,
    },
    bookingModification: {
      findUnique: mocks.bookingModificationFindUnique,
    },
    xeroSyncOperation: {
      update: mocks.xeroSyncOperationUpdate,
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/xero-links", () => ({
  buildXeroInvoiceUrl: (id: string) => `https://xero.example/invoice/${id}`,
}));

// Keep buildXeroIdempotencyKey / sanitizeForJson real so we can assert the actual
// key the operation records.
vi.mock("@/lib/xero-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-sync")>();
  return {
    ...actual,
    startXeroSyncOperation: mocks.startXeroSyncOperation,
    completeXeroSyncOperation: mocks.completeXeroSyncOperation,
    failXeroSyncOperation: mocks.failXeroSyncOperation,
  };
});

vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: mocks.getAuthenticatedXeroClient,
  callXeroApi: mocks.callXeroApi,
}));

vi.mock("@/lib/xero-mappings", () => ({
  getResolvedAccountMapping: mocks.getResolvedAccountMapping,
  getAccountMapping: mocks.getAccountMapping,
}));

vi.mock("@/lib/xero-contacts", () => ({
  findOrCreateXeroContact: mocks.findOrCreateXeroContact,
  retryXeroWriteWithContactRepair: mocks.retryXeroWriteWithContactRepair,
}));

// This module no longer imports `xero-invoice-helpers` at all: #2834 moved both
// of its dates onto the club calendar via `formatDateOnlyForTimeZone`, so the
// stub that used to pin `formatDate` here would mock a module nothing loads. The
// dates themselves are pinned at the NZ-morning boundary in
// `xero-document-dates-club-calendar.test.ts`.

import { createXeroSupplementaryInvoice } from "@/lib/xero-supplementary-invoices";
import { lineTotalCents } from "@/lib/__tests__/helpers";

describe("createXeroSupplementaryInvoice idempotency-key discriminator (#1234, L2)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.bookingFindUnique.mockResolvedValue({
      id: "bk1",
      memberId: "mem1",
      payment: { xeroInvoiceId: "inv_orig" },
    });
    mocks.bookingModificationFindUnique.mockResolvedValue({
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    mocks.getAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi: {} },
      tenantId: "tenant_1",
    });
    mocks.findOrCreateXeroContact.mockResolvedValue("contact_1");
    mocks.getResolvedAccountMapping.mockResolvedValue({
      code: "200",
      itemCode: undefined,
      codeExplicitlyConfigured: false,
    });
    mocks.getAccountMapping.mockResolvedValue("606");
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_x" });
    mocks.failXeroSyncOperation.mockResolvedValue(undefined);
  });

  it("throws when bookingModificationId is absent instead of collapsing the key to bookingId", async () => {
    await expect(
      createXeroSupplementaryInvoice({
        bookingId: "bk1",
        priceDiffCents: 5000,
        changeFeeCents: 2000,
      })
    ).rejects.toThrow(
      "Supplementary invoice requires a bookingModificationId for a distinct Xero idempotency key"
    );

    // The guard fires before any Xero/DB work.
    expect(mocks.bookingFindUnique).not.toHaveBeenCalled();
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("builds the Xero idempotency key from the bookingModificationId discriminator", async () => {
    // Stop the operation right after the key is recorded so we can assert it
    // without driving the full Xero write.
    mocks.retryXeroWriteWithContactRepair.mockRejectedValue(
      new Error("sentinel-stop")
    );

    await expect(
      createXeroSupplementaryInvoice({
        bookingId: "bk1",
        priceDiffCents: 5000,
        changeFeeCents: 2000,
        bookingModificationId: "mod_123",
      })
    ).rejects.toThrow("sentinel-stop");

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledTimes(1);
    const enqueued = mocks.startXeroSyncOperation.mock.calls[0][0];
    expect(enqueued.localModel).toBe("BookingModification");
    expect(enqueued.localId).toBe("mod_123");
    // The key is scoped by the modification, not the booking, so two same-amount
    // deltas on one booking never collide.
    expect(enqueued.idempotencyKey).toBe(
      "booking-mod:mod_123:supplementary-invoice:5000:2000:v1"
    );
    expect(enqueued.correlationKey).toBe(enqueued.idempotencyKey);
    // The failed operation is marked failed and the error re-thrown.
    expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith(
      "op_x",
      expect.any(Error)
    );
  });
});

// #1356 (F16): a price reduction combined with a larger late-change fee must
// invoice the SIGNED components so the line items sum exactly to the net the
// member paid, and the recorded Xero payment must equal the Stripe capture —
// not the gross fee.
describe("createXeroSupplementaryInvoice mixed-sign components (#1356)", () => {
  const createPayments = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.bookingFindUnique.mockResolvedValue({
      id: "bk1",
      memberId: "mem1",
      payment: { xeroInvoiceId: "inv_orig" },
    });
    mocks.bookingModificationFindUnique.mockResolvedValue({
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    createPayments.mockResolvedValue({
      body: { payments: [{ paymentID: "pay_1" }] },
    });
    mocks.getAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi: { createPayments } },
      tenantId: "tenant_1",
    });
    mocks.findOrCreateXeroContact.mockResolvedValue("contact_1");
    // Key-aware mapping: give-backs post to the hutFeeRefunds mapping (owner
    // decision on #1356), income lines to hutFeesIncome.
    mocks.getResolvedAccountMapping.mockImplementation(async (key: string) =>
      key === "hutFeeRefunds"
        ? { code: "201", itemCode: undefined, codeExplicitlyConfigured: true }
        : { code: "200", itemCode: undefined, codeExplicitlyConfigured: false }
    );
    mocks.getAccountMapping.mockResolvedValue("606");
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_x" });
    mocks.completeXeroSyncOperation.mockResolvedValue(undefined);
    mocks.failXeroSyncOperation.mockResolvedValue(undefined);
    // createInvoices goes through the contact-repair wrapper; createPayments
    // calls callXeroApi directly, so run the thunk for real.
    mocks.retryXeroWriteWithContactRepair.mockResolvedValue({
      body: { invoices: [{ invoiceID: "inv_supp", invoiceNumber: "INV-0042" }] },
    });
    mocks.callXeroApi.mockImplementation((fn: () => unknown) => fn());
  });

  it("bills the signed net: negative price line + fee line, payment equals the Stripe capture", async () => {
    const invoiceId = await createXeroSupplementaryInvoice({
      bookingId: "bk1",
      priceDiffCents: -500,
      changeFeeCents: 1000,
      bookingModificationId: "mod_mixed",
    });

    expect(invoiceId).toBe("inv_supp");

    // The queued operation's invoice carries BOTH signed component lines,
    // summing exactly to the +500 net charge.
    const enqueued = mocks.startXeroSyncOperation.mock.calls[0][0];
    const lines = enqueued.requestPayload.invoices[0].lineItems;
    expect(lines).toHaveLength(2);
    expect(lines[0].description).toContain("price adjustment");
    expect(lines[0].unitAmount).toBe(-5);
    // The give-back line posts to the hutFeeRefunds mapping; the fee stays on
    // hutFeesIncome (clubs may map both to one code to collapse the split).
    expect(lines[0].accountCode).toBe("201");
    expect(lines[1].description).toContain("change fee");
    expect(lines[1].unitAmount).toBe(10);
    expect(lines[1].accountCode).toBe("200");
    expect(lineTotalCents(lines)).toBe(500);
    // The idempotency key carries the signed component, not a clamped zero.
    expect(enqueued.idempotencyKey).toBe(
      "booking-mod:mod_mixed:supplementary-invoice:-500:1000:v1"
    );

    // The recorded Xero payment is the 500-cent net Stripe captured — never
    // the 1000-cent gross fee.
    expect(createPayments).toHaveBeenCalledTimes(1);
    const [tenantId, paymentBody, , paymentIdempotencyKey] =
      createPayments.mock.calls[0];
    expect(tenantId).toBe("tenant_1");
    expect(paymentBody.payments[0].amount).toBe(5);
    expect(paymentIdempotencyKey).toBe(
      "booking-mod:mod_mixed:supplementary-payment:500:v1"
    );

    // The payment link metadata mirrors the net for repair-pass evidence.
    const completion = mocks.completeXeroSyncOperation.mock.calls[0][1];
    const paymentLink = completion.extraLinks.find(
      (link: { role: string }) => link.role === "SUPPLEMENTARY_INVOICE_PAYMENT"
    );
    expect(paymentLink.metadata).toEqual({
      invoiceId: "inv_supp",
      amountCents: 500,
    });
  });

  it("completes as skipped without provider calls when the net is not positive", async () => {
    const invoiceId = await createXeroSupplementaryInvoice({
      bookingId: "bk1",
      priceDiffCents: -1500,
      changeFeeCents: 1000,
      bookingModificationId: "mod_negative_net",
      syncOperationId: "op_waiting",
    });

    expect(invoiceId).toBeNull();
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith("op_waiting", {
      responsePayload: {
        skipped: true,
        reason: expect.stringContaining("net amount is not positive"),
      },
    });
    expect(mocks.bookingFindUnique).not.toHaveBeenCalled();
    expect(mocks.getAuthenticatedXeroClient).not.toHaveBeenCalled();
    expect(createPayments).not.toHaveBeenCalled();
  });
});

/**
 * #3193 (epic #2797): THE SECOND ASK'S DOCUMENT.
 *
 * When a booking change's supplementary invoice has already gone out, a review
 * share settled afterwards is billed on its own small invoice. Three things about
 * that document have to be right, and one flag decides all three so a caller
 * cannot take one without the others: the link it writes must NOT land on the
 * booking change (or the change's own "is an invoice already going out?" reads
 * would find it and could raise it to the combined total), the Xero idempotency
 * key must not be the change's (or Xero answers the create with the earlier
 * invoice and the difference is never billed), and the member has to be told why
 * a second invoice has arrived.
 */
describe("createXeroSupplementaryInvoice: the second ask (#3193)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.bookingFindUnique.mockResolvedValue({
      id: "bk1",
      memberId: "mem1",
      payment: { xeroInvoiceId: "inv_orig" },
    });
    mocks.bookingModificationFindUnique.mockResolvedValue({
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    mocks.getAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi: {} },
      tenantId: "tenant_1",
    });
    mocks.findOrCreateXeroContact.mockResolvedValue("contact_1");
    mocks.getResolvedAccountMapping.mockResolvedValue({
      code: "200",
      itemCode: undefined,
      codeExplicitlyConfigured: false,
    });
    mocks.getAccountMapping.mockResolvedValue("606");
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_x" });
    mocks.completeXeroSyncOperation.mockResolvedValue(undefined);
    mocks.failXeroSyncOperation.mockResolvedValue(undefined);
    mocks.retryXeroWriteWithContactRepair.mockResolvedValue({
      body: { invoices: [{ invoiceID: "inv_second", invoiceNumber: "INV-0043" }] },
    });
    mocks.callXeroApi.mockImplementation((fn: () => unknown) => fn());
  });

  it("anchors on the review task and keys the create so Xero cannot dedupe it", async () => {
    const invoiceId = await createXeroSupplementaryInvoice({
      bookingId: "bk1",
      priceDiffCents: 3000,
      changeFeeCents: 0,
      bookingModificationId: "mod_123",
      shortfallReviewTaskId: "task_2",
      recordPayment: false,
    });

    expect(invoiceId).toBe("inv_second");
    const enqueued = mocks.startXeroSyncOperation.mock.calls[0][0];
    expect(enqueued.localModel).toBe("ManualRefundTask");
    expect(enqueued.localId).toBe("task_2");
    expect(enqueued.idempotencyKey).toBe(
      "review-task:task_2:supplementary-shortfall-invoice:3000:0:v1",
    );
    // Not the change's key, in either half. A shared key would have Xero answer
    // this create with the invoice already sent.
    expect(enqueued.idempotencyKey).not.toContain("mod_123");
    expect(enqueued.idempotencyKey).not.toContain(":supplementary-invoice:");

    // And the LINK follows the anchor, which is what keeps it out of the reads
    // that decide whether the change already has an invoice going out.
    const completion = mocks.completeXeroSyncOperation.mock.calls[0][1];
    const invoiceLink = completion.extraLinks.find(
      (link: { role: string }) => link.role === "SUPPLEMENTARY_INVOICE",
    );
    expect(invoiceLink.localModel).toBe("ManualRefundTask");
    expect(invoiceLink.localId).toBe("task_2");
  });

  it("tells the member why a second invoice has arrived", async () => {
    await createXeroSupplementaryInvoice({
      bookingId: "bk1",
      priceDiffCents: 3000,
      changeFeeCents: 0,
      bookingModificationId: "mod_123",
      shortfallReviewTaskId: "task_2",
      recordPayment: false,
    });

    const enqueued = mocks.startXeroSyncOperation.mock.calls[0][0];
    const [line] = enqueued.requestPayload.invoices[0].lineItems;
    expect(line.unitAmount).toBe(30);
    expect(line.description).toContain("already been sent");
    expect(line.description).toContain("covers the remainder");
    // Plain English about THIS document, with no internal vocabulary and no
    // claim about how the club prices or reviews a change - this is the generic
    // product, and a club's policy is not a hard-coded string.
    expect(line.description).not.toMatch(/review|task|shortfall|supplementary/i);
    expect(enqueued.requestPayload.invoices[0].reference).toContain(
      "Further supplementary",
    );
  });

  /**
   * CONTROL. The change's OWN invoice is unchanged in all three respects -
   * without this, a change that simply broke the ordinary anchor, key or wording
   * would pass every assertion above.
   */
  it("CONTROL: the booking change's own invoice keeps its anchor, key and wording", async () => {
    await createXeroSupplementaryInvoice({
      bookingId: "bk1",
      priceDiffCents: 3000,
      changeFeeCents: 0,
      bookingModificationId: "mod_123",
      recordPayment: false,
    });

    const enqueued = mocks.startXeroSyncOperation.mock.calls[0][0];
    expect(enqueued.localModel).toBe("BookingModification");
    expect(enqueued.localId).toBe("mod_123");
    expect(enqueued.idempotencyKey).toBe(
      "booking-mod:mod_123:supplementary-invoice:3000:0:v1",
    );
    const [line] = enqueued.requestPayload.invoices[0].lineItems;
    expect(line.description).toContain("price adjustment");
    expect(line.description).not.toContain("already been sent");
    const completion = mocks.completeXeroSyncOperation.mock.calls[0][1];
    const invoiceLink = completion.extraLinks.find(
      (link: { role: string }) => link.role === "SUPPLEMENTARY_INVOICE",
    );
    expect(invoiceLink.localModel).toBe("BookingModification");
  });
});
