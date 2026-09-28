import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  operationFindUnique: vi.fn(),
  operationFindMany: vi.fn(),
  operationUpdate: vi.fn(),
  operationUpdateMany: vi.fn(),
  taskFindUnique: vi.fn(),
  transactionFindFirst: vi.fn(),
  linkFindFirst: vi.fn(),
  linkCount: vi.fn(),
  bookingFindUnique: vi.fn(),
  executeRaw: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  createInvoices: vi.fn(),
  createXeroPaymentForInvoice: vi.fn(),
  creditBackLateCaptureRefunds: vi.fn(),
  getResolvedAccountMapping: vi.fn(),
}));

const db = vi.hoisted(() => {
  const db: Record<string, unknown> = {
    xeroSyncOperation: {
      findUnique: (...a: unknown[]) => mocks.operationFindUnique(...a),
      findMany: (...a: unknown[]) => mocks.operationFindMany(...a),
      update: (...a: unknown[]) => mocks.operationUpdate(...a),
      updateMany: (...a: unknown[]) => mocks.operationUpdateMany(...a),
    },
    manualRefundTask: {
      findUnique: (...a: unknown[]) => mocks.taskFindUnique(...a),
    },
    paymentTransaction: {
      findFirst: (...a: unknown[]) => mocks.transactionFindFirst(...a),
    },
    xeroObjectLink: {
      findFirst: (...a: unknown[]) => mocks.linkFindFirst(...a),
      count: (...a: unknown[]) => mocks.linkCount(...a),
    },
    booking: { findUnique: (...a: unknown[]) => mocks.bookingFindUnique(...a) },
    $executeRaw: (...a: unknown[]) => mocks.executeRaw(...a),
  };
  db.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
  return db;
});

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: (...parts: unknown[]) => parts.join(":"),
  sanitizeForJson: (value: unknown) => value,
  startXeroSyncOperation: (...a: unknown[]) =>
    mocks.startXeroSyncOperation(...a),
  completeXeroSyncOperation: (...a: unknown[]) =>
    mocks.completeXeroSyncOperation(...a),
  failXeroSyncOperation: (...a: unknown[]) => mocks.failXeroSyncOperation(...a),
}));
vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: async () => ({
    tenantId: "tenant",
    xero: {
      accountingApi: {
        createInvoices: (...a: unknown[]) => mocks.createInvoices(...a),
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
  findOrCreateXeroContactForInvoicedParty: async () => "contact-1",
  invoicedPartyContactRepair: () => undefined,
}));
vi.mock("@/lib/xero-mappings", () => ({
  getResolvedAccountMapping: (...a: unknown[]) =>
    mocks.getResolvedAccountMapping(...a),
}));
vi.mock("@/lib/xero-invoice-payments", () => ({
  createXeroPaymentForInvoice: (...a: unknown[]) =>
    mocks.createXeroPaymentForInvoice(...a),
}));
vi.mock("@/lib/late-capture-refund-credit-note", () => ({
  creditBackLateCaptureRefunds: (...a: unknown[]) =>
    mocks.creditBackLateCaptureRefunds(...a),
}));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  KEPT_LATE_CAPTURE_INVOICE_ROLE,
  KEPT_LATE_CAPTURE_PAYMENT_ROLE,
} from "@/lib/late-capture-kept-xero-rules";
import {
  createXeroKeptLateCaptureInvoice,
  enqueueXeroKeptLateCaptureInvoiceOperation,
  settleKeptLateCaptureRecordOnApproval,
} from "@/lib/xero-kept-late-capture-invoice";

/**
 * #3635 (`INV-PAY-110`): the kept-capture invoice's enqueue, approval
 * settlement and worker, one behaviour each. The books they produce together
 * are `xero-kept-late-capture-ledger.test.ts`'s.
 */
const QUEUED = {
  queueType: "KEPT_LATE_CAPTURE_INVOICE",
  bookingId: "booking-1234567890",
  manualRefundTaskId: "task_kept",
  paymentIntentId: "pi_kept",
  capturedCents: 24000,
  capturedOn: "2026-06-10",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.operationFindUnique.mockResolvedValue({
    requestPayload: { ...QUEUED },
  });
  mocks.operationFindMany.mockResolvedValue([]);
  mocks.operationUpdate.mockResolvedValue({});
  mocks.operationUpdateMany.mockResolvedValue({ count: 1 });
  mocks.taskFindUnique.mockResolvedValue({ status: "DISMISSED" });
  mocks.transactionFindFirst.mockResolvedValue({
    status: "SUCCEEDED",
    amountCents: 24000,
  });
  mocks.linkFindFirst.mockResolvedValue(null);
  mocks.linkCount.mockResolvedValue(0);
  mocks.bookingFindUnique.mockResolvedValue({
    id: QUEUED.bookingId,
    member: {},
    organisation: null,
  });
  mocks.executeRaw.mockResolvedValue(0);
  mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_kept" });
  mocks.completeXeroSyncOperation.mockResolvedValue({});
  mocks.createInvoices.mockResolvedValue({
    body: { invoices: [{ invoiceID: "inv_kept", invoiceNumber: "INV-9" }] },
  });
  mocks.createXeroPaymentForInvoice.mockResolvedValue("pay_kept");
  mocks.creditBackLateCaptureRefunds.mockResolvedValue(undefined);
  mocks.getResolvedAccountMapping.mockResolvedValue({
    code: "200",
    itemCode: null,
    codeExplicitlyConfigured: false,
  });
});

const lockedTask = () =>
  mocks.executeRaw.mock.calls.some(([sql]) =>
    String((sql as { strings?: string[] }).strings?.join("?") ?? sql).includes(
      'FROM "ManualRefundTask" WHERE "id" =',
    ),
  );

function enqueue() {
  return enqueueXeroKeptLateCaptureInvoiceOperation({
    manualRefundTaskId: "task_kept",
    bookingId: QUEUED.bookingId,
    paymentIntentId: "pi_kept",
    capturedCents: 24000,
    capturedOn: "2026-06-10",
    createdByMemberId: "treasurer-1",
    store: db as never,
  });
}

describe("enqueueXeroKeptLateCaptureInvoiceOperation", () => {
  it("locks the task, re-reads it, and queues one PENDING row with the gross cents and the capture day", async () => {
    await expect(enqueue()).resolves.toMatchObject({
      queueOperationId: "op_kept",
    });
    expect(lockedTask()).toBe(true);
    expect(mocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.taskFindUnique.mock.invocationCallOrder[0],
    );
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        localModel: "ManualRefundTask",
        localId: "task_kept",
        status: "PENDING",
        queueType: "KEPT_LATE_CAPTURE_INVOICE",
        idempotencyKey:
          "manual-refund-task:task_kept:kept-late-capture-invoice:v1",
        requestPayload: QUEUED,
        store: db,
      }),
    );
  });

  it("queues nothing for a task that is no longer kept (a stale repair snapshot)", async () => {
    for (const status of ["OPEN", "COMPLETED"]) {
      mocks.taskFindUnique.mockResolvedValue({ status });
      await expect(enqueue()).resolves.toMatchObject({
        queueOperationId: null,
      });
    }
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("returns the task's live row, in any state but CANCELLED, rather than queue a second", async () => {
    mocks.operationFindMany.mockResolvedValue([
      {
        id: "op_withdrawn",
        queueType: "KEPT_LATE_CAPTURE_INVOICE",
        status: "CANCELLED",
      },
      {
        id: "op_live",
        queueType: "KEPT_LATE_CAPTURE_INVOICE",
        status: "RUNNING",
      },
    ]);
    await expect(enqueue()).resolves.toMatchObject({
      queueOperationId: "op_live",
    });
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });
});

describe("settleKeptLateCaptureRecordOnApproval", () => {
  const settle = () =>
    settleKeptLateCaptureRecordOnApproval({
      manualRefundTaskId: "task_kept",
      paymentIntentId: "pi_kept",
      store: db as never,
    });
  const calls = () =>
    mocks.operationUpdateMany.mock.calls.map(([args]) => args);

  it("with no invoice in Xero, withdraws a PENDING or FAILED row, and the change's PENDING supplementary", async () => {
    await settle();
    const [own, change] = calls();
    expect(own.where).toMatchObject({
      localModel: "ManualRefundTask",
      localId: "task_kept",
      queueType: "KEPT_LATE_CAPTURE_INVOICE",
      status: { in: ["PENDING", "FAILED"] },
    });
    expect(own.data).toMatchObject({
      status: "CANCELLED",
      lastErrorCode: "KEPT_LATE_CAPTURE_WITHDRAWN",
    });
    expect(change.where).toMatchObject({
      queueType: "SUPPLEMENTARY_INVOICE",
      status: "PENDING",
      requestPayload: { path: ["paymentIntentId"], equals: "pi_kept" },
    });
  });

  it("with the invoice in Xero, withdraws nothing of it and sends a PARTIAL row back for its payment", async () => {
    mocks.linkCount.mockResolvedValue(1);
    await settle();
    const [own] = calls();
    expect(own.where).toMatchObject({
      localId: "task_kept",
      status: "PARTIAL",
    });
    expect(own.data).toMatchObject({ status: "PENDING" });
    expect(
      calls().some(
        (args) => args.data.status === "CANCELLED" && args.where.localId,
      ),
    ).toBe(false);
  });
});

describe("createXeroKeptLateCaptureInvoice", () => {
  it("raises the gross invoice dated the capture day and pays it that day, then credits back any refund", async () => {
    await expect(
      createXeroKeptLateCaptureInvoice({ syncOperationId: "op_kept" }),
    ).resolves.toBe("inv_kept");

    expect(lockedTask()).toBe(true);
    const [, body, , , key] = mocks.createInvoices.mock.calls[0];
    expect(key).toBe(
      "manual-refund-task:task_kept:kept-late-capture-invoice:v1",
    );
    expect(body.invoices[0]).toMatchObject({
      date: "2026-06-10",
      dueDate: "2026-06-10",
      lineItems: [
        {
          description: "Payment kept after cancellation - booking booking-",
          unitAmount: 240,
          accountCode: "200",
        },
      ],
    });
    expect(mocks.createXeroPaymentForInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        localModel: "ManualRefundTask",
        localId: "task_kept",
        invoiceId: "inv_kept",
        amountCents: 24000,
        date: "2026-06-10",
        role: KEPT_LATE_CAPTURE_PAYMENT_ROLE,
        idempotencyKey:
          "manual-refund-task:task_kept:kept-late-capture-payment:v1",
      }),
    );
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_kept",
      expect.objectContaining({
        status: "SUCCEEDED",
        extraLinks: [
          expect.objectContaining({
            role: KEPT_LATE_CAPTURE_INVOICE_ROLE,
            xeroObjectId: "inv_kept",
          }),
        ],
      }),
    );
    expect(mocks.creditBackLateCaptureRefunds).toHaveBeenCalledWith("pi_kept");
  });

  it("withdraws the row under the task lock, in the same transaction, when the task no longer keeps the money", async () => {
    for (const status of ["OPEN", "COMPLETED"]) {
      vi.clearAllMocks();
      mocks.operationFindUnique.mockResolvedValue({
        requestPayload: { ...QUEUED },
      });
      mocks.taskFindUnique.mockResolvedValue({ status });
      mocks.transactionFindFirst.mockResolvedValue({
        status: "SUCCEEDED",
        amountCents: 24000,
      });
      mocks.linkFindFirst.mockResolvedValue(null);
      await expect(
        createXeroKeptLateCaptureInvoice({ syncOperationId: "op_kept" }),
      ).resolves.toBeNull();
      expect(lockedTask()).toBe(true);
      expect(mocks.createInvoices).not.toHaveBeenCalled();
      expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
        "op_kept",
        expect.objectContaining({ status: "CANCELLED" }),
        { store: db },
      );
    }
  });

  it("once its invoice exists, records the missing payment whatever the task says now", async () => {
    mocks.taskFindUnique.mockResolvedValue({ status: "COMPLETED" });
    mocks.linkFindFirst.mockImplementation(
      async ({ where }: { where: { role: string } }) =>
        where.role === KEPT_LATE_CAPTURE_INVOICE_ROLE
          ? { xeroObjectId: "inv_kept", xeroObjectNumber: "INV-9" }
          : null,
    );
    await createXeroKeptLateCaptureInvoice({ syncOperationId: "op_kept" });
    expect(mocks.createInvoices).not.toHaveBeenCalled();
    expect(mocks.createXeroPaymentForInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: "inv_kept", amountCents: 24000 }),
    );
  });

  it("is PARTIAL when the payment fails", async () => {
    mocks.createXeroPaymentForInvoice.mockRejectedValueOnce(
      new Error("xero down"),
    );
    await createXeroKeptLateCaptureInvoice({ syncOperationId: "op_kept" });
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_kept",
      expect.objectContaining({ status: "PARTIAL" }),
    );
  });

  it("uses the club's own hut-fee item and account when it has set them (no club value in code)", async () => {
    mocks.getResolvedAccountMapping.mockResolvedValue({
      code: "4100",
      itemCode: "HUT",
      codeExplicitlyConfigured: true,
    });
    await createXeroKeptLateCaptureInvoice({ syncOperationId: "op_kept" });
    expect(
      mocks.createInvoices.mock.calls[0][1].invoices[0].lineItems[0],
    ).toMatchObject({
      itemCode: "HUT",
      accountCode: "4100",
    });
  });
});
