import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  operationFindUnique: vi.fn(),
  operationFindFirst: vi.fn(),
  operationUpdate: vi.fn(),
  operationUpdateMany: vi.fn(),
  taskFindUnique: vi.fn(),
  taskFindMany: vi.fn(),
  linkFindFirst: vi.fn(),
  bookingFindUnique: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  createInvoices: vi.fn(),
  createPayments: vi.fn(),
  findOrCreateContact: vi.fn(),
  getResolvedAccountMapping: vi.fn(),
  getAccountMapping: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroSyncOperation: {
      findUnique: (...a: unknown[]) => mocks.operationFindUnique(...a),
      findFirst: (...a: unknown[]) => mocks.operationFindFirst(...a),
      update: (...a: unknown[]) => mocks.operationUpdate(...a),
      updateMany: (...a: unknown[]) => mocks.operationUpdateMany(...a),
    },
    manualRefundTask: {
      findUnique: (...a: unknown[]) => mocks.taskFindUnique(...a),
      findMany: (...a: unknown[]) => mocks.taskFindMany(...a),
    },
    xeroObjectLink: { findFirst: (...a: unknown[]) => mocks.linkFindFirst(...a) },
    booking: { findUnique: (...a: unknown[]) => mocks.bookingFindUnique(...a) },
  },
}));
vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: (...parts: unknown[]) => parts.join(":"),
  sanitizeForJson: (value: unknown) => value,
  startXeroSyncOperation: (...a: unknown[]) => mocks.startXeroSyncOperation(...a),
  completeXeroSyncOperation: (...a: unknown[]) => mocks.completeXeroSyncOperation(...a),
  failXeroSyncOperation: (...a: unknown[]) => mocks.failXeroSyncOperation(...a),
}));
vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: async () => ({
    tenantId: "tenant",
    xero: {
      accountingApi: {
        createInvoices: (...a: unknown[]) => mocks.createInvoices(...a),
        createPayments: (...a: unknown[]) => mocks.createPayments(...a),
      },
    },
  }),
  callXeroApi: (fn: () => unknown) => fn(),
}));
vi.mock("@/lib/xero-contacts", () => ({
  retryXeroWriteWithContactRepair: (options: {
    currentContactId: string;
    run: (args: { contactId: string }) => unknown;
  }) => options.run({ contactId: options.currentContactId }),
}));
vi.mock("@/lib/organisation-xero-contacts", () => ({
  findOrCreateXeroContactForInvoicedParty: (...a: unknown[]) => mocks.findOrCreateContact(...a),
  invoicedPartyContactRepair: () => undefined,
}));
vi.mock("@/lib/xero-mappings", () => ({
  getResolvedAccountMapping: (...a: unknown[]) => mocks.getResolvedAccountMapping(...a),
  getAccountMapping: (...a: unknown[]) => mocks.getAccountMapping(...a),
}));
vi.mock("@/lib/club-time-zone-runtime", () => ({
  readClubTimeZoneOutsideRequest: async () => "Pacific/Auckland",
}));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  KEPT_LATE_CAPTURE_INVOICE_ROLE,
  KEPT_LATE_CAPTURE_PAYMENT_ROLE,
  createXeroKeptLateCaptureInvoice,
  enqueueXeroKeptLateCaptureInvoiceOperation,
  findKeptLateCaptureInvoiceIdForPayment,
  withdrawQueuedKeptLateCaptureRecord,
} from "@/lib/xero-kept-late-capture-invoice";

/**
 * #3635 (owner decision 29 Sep 2026, `INV-PAY-110`): the Xero record of a late
 * card payment a treasurer kept - an invoice for exactly the kept cents, paid
 * from the Stripe bank account, anchored on the approval task.
 */
const QUEUED = {
  queueType: "KEPT_LATE_CAPTURE_INVOICE",
  bookingId: "booking-1234567890",
  manualRefundTaskId: "task_kept",
  paymentIntentId: "pi_kept",
  keptCents: 24000,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.operationFindUnique.mockResolvedValue({ requestPayload: { ...QUEUED } });
  mocks.operationFindFirst.mockResolvedValue(null);
  mocks.operationUpdate.mockResolvedValue({});
  mocks.operationUpdateMany.mockResolvedValue({ count: 1 });
  mocks.taskFindUnique.mockResolvedValue({ status: "DISMISSED" });
  mocks.taskFindMany.mockResolvedValue([{ id: "task_kept" }]);
  mocks.linkFindFirst.mockResolvedValue(null);
  mocks.bookingFindUnique.mockResolvedValue({
    id: QUEUED.bookingId,
    memberId: "member-1",
    member: { id: "member-1", firstName: "Alice", lastName: "Example", email: "a@example.test" },
    organisation: null,
  });
  mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_kept" });
  mocks.completeXeroSyncOperation.mockResolvedValue({});
  mocks.createInvoices.mockResolvedValue({
    body: { invoices: [{ invoiceID: "inv_kept", invoiceNumber: "INV-9" }] },
  });
  mocks.createPayments.mockResolvedValue({ body: { payments: [{ paymentID: "pay_kept" }] } });
  mocks.findOrCreateContact.mockResolvedValue("contact-1");
  mocks.getResolvedAccountMapping.mockResolvedValue({
    code: "200",
    itemCode: null,
    codeExplicitlyConfigured: false,
  });
  mocks.getAccountMapping.mockResolvedValue("606");
});

function sentInvoice() {
  const [, body, , , key] = mocks.createInvoices.mock.calls[0];
  return { invoice: body.invoices[0], key };
}
function sentPayment() {
  const [, body, , key] = mocks.createPayments.mock.calls[0];
  return { payment: body.payments[0], key };
}

describe("enqueueXeroKeptLateCaptureInvoiceOperation", () => {
  it("queues one PENDING row anchored on the task, keyed by the task, carrying the frozen cents", async () => {
    const store = {
      xeroSyncOperation: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    await expect(
      enqueueXeroKeptLateCaptureInvoiceOperation({
        manualRefundTaskId: "task_kept",
        bookingId: QUEUED.bookingId,
        paymentIntentId: "pi_kept",
        keptCents: 24000,
        createdByMemberId: "treasurer-1",
        store: store as never,
      }),
    ).resolves.toMatchObject({ queueOperationId: "op_kept" });
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        localModel: "ManualRefundTask",
        localId: "task_kept",
        status: "PENDING",
        queueType: "KEPT_LATE_CAPTURE_INVOICE",
        idempotencyKey: "manual-refund-task:task_kept:kept-late-capture-invoice:v1",
        requestPayload: QUEUED,
        store,
      }),
    );
  });

  it("returns the task's existing row rather than queue a second (a replay, a keep after a reopen)", async () => {
    mocks.operationFindFirst.mockResolvedValue({ id: "op_earlier" });
    await expect(
      enqueueXeroKeptLateCaptureInvoiceOperation({
        manualRefundTaskId: "task_kept",
        bookingId: QUEUED.bookingId,
        paymentIntentId: "pi_kept",
        keptCents: 24000,
      }),
    ).resolves.toMatchObject({ queueOperationId: "op_earlier" });
    expect(mocks.operationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ localId: "task_kept", status: { not: "CANCELLED" } }),
      }),
    );
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("queues nothing for no kept cents", async () => {
    await expect(
      enqueueXeroKeptLateCaptureInvoiceOperation({
        manualRefundTaskId: "task_kept",
        bookingId: QUEUED.bookingId,
        paymentIntentId: "pi_kept",
        keptCents: 0,
      }),
    ).resolves.toMatchObject({ queueOperationId: null });
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });
});

describe("createXeroKeptLateCaptureInvoice", () => {
  it("raises an invoice for exactly the kept cents and pays it from the Stripe account, both keyed by the task", async () => {
    await expect(createXeroKeptLateCaptureInvoice({ syncOperationId: "op_kept" })).resolves.toBe(
      "inv_kept",
    );

    const { invoice, key } = sentInvoice();
    expect(key).toBe("manual-refund-task:task_kept:kept-late-capture-invoice:v1");
    expect(invoice).toMatchObject({
      type: "ACCREC",
      contact: { contactID: "contact-1" },
      status: "AUTHORISED",
      lineItems: [
        {
          description: "Payment kept after cancellation - booking booking-",
          quantity: 1,
          unitAmount: 240,
          accountCode: "200",
        },
      ],
    });
    const { payment, key: paymentKey } = sentPayment();
    expect(paymentKey).toBe("manual-refund-task:task_kept:kept-late-capture-payment:v1");
    expect(payment).toMatchObject({
      invoice: { invoiceID: "inv_kept" },
      account: { code: "606" },
      amount: 240,
      reference: "Stripe pi_kept",
    });
    expect(mocks.getResolvedAccountMapping).toHaveBeenCalledWith("hutFeesIncome");
    expect(mocks.getAccountMapping).toHaveBeenCalledWith("stripeBankAccount");
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_kept",
      expect.objectContaining({
        status: "SUCCEEDED",
        extraLinks: [
          expect.objectContaining({
            localModel: "ManualRefundTask",
            localId: "task_kept",
            role: KEPT_LATE_CAPTURE_INVOICE_ROLE,
            xeroObjectId: "inv_kept",
          }),
          expect.objectContaining({ role: KEPT_LATE_CAPTURE_PAYMENT_ROLE, xeroObjectId: "pay_kept" }),
        ],
      }),
    );
    // The queued instruction is kept beside the request, so a retry replays it.
    expect(mocks.operationUpdate.mock.calls[0][0].data.requestPayload).toMatchObject(QUEUED);
  });

  it("uses the club's own hut-fee item and account when it has set them (no club value in code)", async () => {
    mocks.getResolvedAccountMapping.mockResolvedValue({
      code: "4100",
      itemCode: "HUT",
      codeExplicitlyConfigured: true,
    });
    await createXeroKeptLateCaptureInvoice({ syncOperationId: "op_kept" });
    expect(sentInvoice().invoice.lineItems[0]).toMatchObject({ itemCode: "HUT", accountCode: "4100" });
  });

  it("is PARTIAL when the payment fails, and a retry re-uses the raised invoice, recording only the payment", async () => {
    mocks.createPayments.mockRejectedValueOnce(new Error("xero down"));
    await createXeroKeptLateCaptureInvoice({ syncOperationId: "op_kept" });
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_kept",
      expect.objectContaining({ status: "PARTIAL" }),
    );

    vi.clearAllMocks();
    mocks.operationFindUnique.mockResolvedValue({ requestPayload: { ...QUEUED } });
    mocks.taskFindUnique.mockResolvedValue({ status: "DISMISSED" });
    mocks.bookingFindUnique.mockResolvedValue({ id: QUEUED.bookingId, member: {}, organisation: null });
    mocks.getAccountMapping.mockResolvedValue("606");
    mocks.createPayments.mockResolvedValue({ body: { payments: [{ paymentID: "pay_kept" }] } });
    mocks.linkFindFirst.mockImplementation(async ({ where }: { where: { role: string } }) =>
      where.role === KEPT_LATE_CAPTURE_INVOICE_ROLE
        ? { xeroObjectId: "inv_kept", xeroObjectNumber: "INV-9" }
        : null,
    );
    await createXeroKeptLateCaptureInvoice({ syncOperationId: "op_kept" });
    expect(mocks.createInvoices).not.toHaveBeenCalled();
    expect(sentPayment().payment).toMatchObject({ invoice: { invoiceID: "inv_kept" }, amount: 240 });
  });

  it("raises nothing, and closes the row CANCELLED, when the task no longer keeps the money", async () => {
    for (const status of ["OPEN", "COMPLETED"]) {
      vi.clearAllMocks();
      mocks.operationFindUnique.mockResolvedValue({ requestPayload: { ...QUEUED } });
      mocks.taskFindUnique.mockResolvedValue({ status });
      await expect(createXeroKeptLateCaptureInvoice({ syncOperationId: "op_kept" })).resolves.toBeNull();
      expect(mocks.createInvoices).not.toHaveBeenCalled();
      expect(mocks.createPayments).not.toHaveBeenCalled();
      expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
        "op_kept",
        expect.objectContaining({ status: "CANCELLED" }),
      );
    }
  });

  /**
   * THE WORKED EXAMPLES: it cannot count the kept cash twice, whatever the
   * booking's own invoice did. Each case lists the documents Xero already holds
   * for the booking (untouched by this worker), adds what the worker sends, and
   * sums income and the Stripe bank account. The kept $240 must appear exactly
   * once in each.
   */
  describe("worked examples: the kept $240 is counted once", () => {
    type Doc = { kind: "invoice" | "credit-note"; incomeCents: number; stripeCents: number };
    const cases: { name: string; existing: Doc[] }[] = [
      { name: "no booking invoice was ever raised (card cancelled before capture)", existing: [] },
      {
        name: "the booking invoice was cleared by the cancellation's clearing note",
        existing: [
          { kind: "invoice", incomeCents: 30000, stripeCents: 0 },
          { kind: "credit-note", incomeCents: -30000, stripeCents: 0 },
        ],
      },
      {
        name: "account credit was used and restored at cancel (no document ever moved it)",
        existing: [],
      },
      {
        name: "the booking was re-priced after the payment was asked for",
        existing: [
          { kind: "invoice", incomeCents: 26000, stripeCents: 0 },
          { kind: "credit-note", incomeCents: -26000, stripeCents: 0 },
        ],
      },
    ];

    for (const example of cases) {
      it(example.name, async () => {
        await createXeroKeptLateCaptureInvoice({ syncOperationId: "op_kept" });
        const sentIncomeCents = Math.round(
          sentInvoice().invoice.lineItems.reduce(
            (sum: number, line: { unitAmount: number; quantity: number }) =>
              sum + line.unitAmount * line.quantity * 100,
            0,
          ),
        );
        const sentStripeCents = Math.round(sentPayment().payment.amount * 100);
        const income = example.existing.reduce((s, d) => s + d.incomeCents, 0) + sentIncomeCents;
        const stripe = example.existing.reduce((s, d) => s + d.stripeCents, 0) + sentStripeCents;
        expect(income).toBe(24000);
        expect(stripe).toBe(24000);
        // Nothing of the booking's own was touched: one invoice and one payment
        // were created, both naming only the new invoice.
        expect(mocks.createInvoices).toHaveBeenCalledTimes(1);
        expect(mocks.createPayments).toHaveBeenCalledTimes(1);
        expect(sentPayment().payment.invoice).toEqual({ invoiceID: "inv_kept" });
      });
    }
  });
});

describe("withdrawQueuedKeptLateCaptureRecord (a reopened keep, then approved)", () => {
  it("cancels only still-PENDING rows, status-guarded, for the task and the change's invoice on the intent", async () => {
    const store = { xeroSyncOperation: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
    await expect(
      withdrawQueuedKeptLateCaptureRecord({
        manualRefundTaskId: "task_kept",
        paymentIntentId: "pi_kept",
        store: store as never,
      }),
    ).resolves.toBe(2);
    const [own, change] = store.xeroSyncOperation.updateMany.mock.calls.map(([args]) => args);
    expect(own.where).toMatchObject({
      localModel: "ManualRefundTask",
      localId: "task_kept",
      queueType: "KEPT_LATE_CAPTURE_INVOICE",
      status: "PENDING",
    });
    expect(change.where).toMatchObject({
      queueType: "SUPPLEMENTARY_INVOICE",
      status: "PENDING",
      requestPayload: { path: ["paymentIntentId"], equals: "pi_kept" },
    });
    for (const args of [own, change]) {
      expect(args.data).toMatchObject({
        status: "CANCELLED",
        lastErrorCode: "KEPT_LATE_CAPTURE_REFUNDED",
      });
    }
  });
});

describe("findKeptLateCaptureInvoiceIdForPayment", () => {
  it("names the sent kept invoice of the payment's approval tasks, for the refund note to answer", async () => {
    mocks.linkFindFirst.mockResolvedValue({ xeroObjectId: "inv_kept" });
    await expect(findKeptLateCaptureInvoiceIdForPayment("payment-1")).resolves.toBe("inv_kept");
    expect(mocks.linkFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          localModel: "ManualRefundTask",
          localId: { in: ["task_kept"] },
          role: KEPT_LATE_CAPTURE_INVOICE_ROLE,
          active: true,
        }),
      }),
    );

    mocks.taskFindMany.mockResolvedValue([]);
    await expect(findKeptLateCaptureInvoiceIdForPayment("payment-1")).resolves.toBeNull();
  });
});
