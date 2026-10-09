import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  operationFindUnique: vi.fn(),
  operationFindMany: vi.fn(),
  operationUpdate: vi.fn(),
  operationUpdateMany: vi.fn(),
  taskFindUnique: vi.fn(),
  taskFindMany: vi.fn(),
  transactionFindFirst: vi.fn(),
  linkFindFirst: vi.fn(),
  linkCount: vi.fn(),
  linkFindMany: vi.fn(),
  readReceipt: vi.fn(),
  bookingFindUnique: vi.fn(),
  executeRaw: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  createInvoices: vi.fn(),
  createXeroPaymentForInvoice: vi.fn(),
  creditBackLateCaptureRefunds: vi.fn(),
  getResolvedAccountMapping: vi.fn(),
  findClose: vi.fn(),
  upsertLink: vi.fn(),
  noteClose: vi.fn(),
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
      findMany: (...a: unknown[]) => mocks.taskFindMany(...a),
    },
    paymentTransaction: {
      findFirst: (...a: unknown[]) => mocks.transactionFindFirst(...a),
    },
    xeroObjectLink: {
      findFirst: (...a: unknown[]) => mocks.linkFindFirst(...a),
      count: (...a: unknown[]) => mocks.linkCount(...a),
      findMany: (...a: unknown[]) => mocks.linkFindMany(...a),
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
  upsertXeroObjectLink: (...a: unknown[]) => mocks.upsertLink(...a),
}));
vi.mock("@/lib/late-capture-paid-another-way", () => ({
  findLateCaptureRefundPaidAnotherWay: (...a: unknown[]) => mocks.findClose(...a),
}));
vi.mock("@/lib/late-capture-xero-receipt", () => ({
  readLateCaptureXeroReceipt: (...a: unknown[]) => mocks.readReceipt(...a),
}));
vi.mock("@/lib/club-time-zone-runtime", () => ({
  readClubTimeZoneOutsideRequest: async () => "Pacific/Auckland",
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
  notePaidAnotherWayCloseOnReceipt: (...a: unknown[]) => mocks.noteClose(...a),
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
  keptReceiptHeldForOfficer,
  settleKeptLateCaptureRecordOnApproval,
} from "@/lib/xero-kept-late-capture-invoice";
import {
  queueWaitingPaidAnotherWayNote,
  queueWaitingPaidAnotherWayNotesForPayment,
} from "@/lib/paid-another-way-receipt-note";

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
  mocks.linkFindMany.mockResolvedValue([]);
  // The receipt as Xero holds it once the worker has linked it.
  mocks.readReceipt.mockResolvedValue({ kind: "recorded", invoiceId: "inv_kept" });
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
  mocks.findClose.mockResolvedValue(null);
  mocks.upsertLink.mockResolvedValue({});
  mocks.noteClose.mockResolvedValue(null);
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

function enqueue(options: { requeueFailedUnsent?: boolean } = {}) {
  return enqueueXeroKeptLateCaptureInvoiceOperation({
    ...options,
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

  // #3924 round 6 (owner, 8 Oct 2026: "Record receipt, then credit").
  it("MUTATION: queues the receipt of an APPROVED capture whose card refund was closed as paid another way", async () => {
    mocks.taskFindUnique.mockResolvedValue({ status: "COMPLETED" });
    mocks.findClose.mockResolvedValue({ id: "close-1" });
    await expect(enqueue()).resolves.toMatchObject({ queueOperationId: "op_kept" });
    expect(mocks.findClose).toHaveBeenCalledWith("pi_kept", db);
    // Read under the task's lock, like the status.
    expect(mocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.findClose.mock.invocationCallOrder[0]);
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

  // #3924 round 7 (money M2): a FAILED row is not live work - nothing else retries
  // it automatically. Only the paid-another-way close asks for this; the repair
  // tool offers the row's own retry (`addPaidAnotherWayReceiptFinding`).
  describe("requeueFailedUnsent (the paid-another-way close)", () => {
    const failed = {
      id: "op_failed",
      queueType: "KEPT_LATE_CAPTURE_INVOICE",
      status: "FAILED",
      manuallyResolvedAt: null,
      requestPayload: { ...QUEUED },
    };
    const linked = (...roles: string[]) => mocks.linkFindMany.mockResolvedValue(roles.map((role) => ({ role })));

    it("MUTATION: puts a FAILED row whose invoice never reached Xero back to PENDING, status-guarded", async () => {
      mocks.operationFindMany.mockResolvedValue([failed]);
      await expect(enqueue({ requeueFailedUnsent: true })).resolves.toMatchObject({ queueOperationId: "op_failed" });
      expect(mocks.operationUpdateMany).toHaveBeenCalledWith({
        where: { id: "op_failed", status: "FAILED", manuallyResolvedAt: null },
        data: expect.objectContaining({ status: "PENDING", completedAt: null, lastErrorMessage: null }),
      });
      expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
    });

    it.each([
      ["without being asked (a keep)", {}, [failed], []],
      ["once its invoice is linked in Xero", { requeueFailedUnsent: true }, [failed], [KEPT_LATE_CAPTURE_INVOICE_ROLE]],
      ["when an officer resolved it in Xero", { requeueFailedUnsent: true }, [{ ...failed, manuallyResolvedAt: new Date("2026-06-21T00:00:00.000Z") }], []],
    ])("leaves it as it is %s", async (_when, options, rows, roles) => {
      mocks.operationFindMany.mockResolvedValue(rows);
      linked(...roles);
      await expect(enqueue(options)).resolves.toMatchObject({ queueOperationId: "op_failed" });
      expect(mocks.operationUpdateMany).not.toHaveBeenCalled();
    });

    // #3924 round 8 (money review): running it again could raise a second
    // receipt in Xero, so it is left FAILED for an officer, who checks Xero.
    it.each([
      ["its Stripe payment is linked", { ...failed }, [KEPT_LATE_CAPTURE_PAYMENT_ROLE]],
      ["it attempted createInvoices (the invoice it sent is on the row)", { ...failed, requestPayload: { ...QUEUED, invoices: [{}] } }, []],
    ])("MUTATION: never puts it back to run when %s - it may have reached Xero", async (_when, row, roles) => {
      mocks.operationFindMany.mockResolvedValue([row]);
      linked(...roles);
      const result = await enqueue({ requeueFailedUnsent: true });
      // Round 9 (both lenses): the id is the FAILED row, and the caller is told
      // it is held for an officer - never a queued receipt.
      expect(result).toMatchObject({ queueOperationId: "op_failed", awaitingOfficerRetry: true });
      expect(result.message).toMatch(/may have reached Xero.*Check Xero, then retry it/);
      expect(mocks.operationUpdateMany).not.toHaveBeenCalled();
      // The plan reads the same fact.
      await expect(keptReceiptHeldForOfficer(db as never, "task_kept")).resolves.toBe(true);
    });

    it("MUTATION: round 9: a row put back to run, or one never failed, is not held for an officer", async () => {
      mocks.operationFindMany.mockResolvedValue([failed]);
      const requeued = await enqueue({ requeueFailedUnsent: true });
      expect(requeued).not.toHaveProperty("awaitingOfficerRetry");
      await expect(keptReceiptHeldForOfficer(db as never, "task_kept")).resolves.toBe(false);
      for (const row of [
        { ...failed, status: "PENDING", requestPayload: { ...QUEUED, invoices: [{}] } },
        { ...failed, manuallyResolvedAt: new Date("2026-06-21T00:00:00.000Z"), requestPayload: { ...QUEUED, invoices: [{}] } },
      ]) {
        mocks.operationFindMany.mockResolvedValue([row]);
        await expect(keptReceiptHeldForOfficer(db as never, "task_kept")).resolves.toBe(false);
      }
      mocks.operationFindMany.mockResolvedValue([{ ...failed, requestPayload: { ...QUEUED, invoices: [{}] } }]);
      linked(KEPT_LATE_CAPTURE_INVOICE_ROLE);
      await expect(keptReceiptHeldForOfficer(db as never, "task_kept")).resolves.toBe(false);
    });

    // #3924 round 8 (concurrency): an officer acted on the row after the read.
    describe("MUTATION: a requeue that claims nothing answers what the row is now", () => {
      it("an officer resolved it by hand: nothing is queued, and the caller is told it changed", async () => {
        mocks.operationFindMany.mockResolvedValue([failed]);
        mocks.operationUpdateMany.mockResolvedValue({ count: 0 });
        mocks.operationFindUnique.mockResolvedValue({ status: "FAILED", manuallyResolvedAt: new Date("2026-06-21T00:00:00.000Z") });
        await expect(enqueue({ requeueFailedUnsent: true })).resolves.toMatchObject({
          queueOperationId: null,
          changedByOfficer: true,
        });
      });

      it("an officer retried it: the row is live", async () => {
        mocks.operationFindMany.mockResolvedValue([failed]);
        mocks.operationUpdateMany.mockResolvedValue({ count: 0 });
        mocks.operationFindUnique.mockResolvedValue({ status: "RUNNING", manuallyResolvedAt: null });
        const result = await enqueue({ requeueFailedUnsent: true });
        expect(result).toMatchObject({ queueOperationId: "op_failed" });
        expect(result.message).toBe("The Xero invoice for this payment is already queued or sent.");
        expect(result).not.toHaveProperty("changedByOfficer");
      });
    });
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
      // `INV-INT-025`: a row resolved in Xero was recorded by hand and stands.
      manuallyResolvedAt: null,
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
      // Never a row resolved in Xero: resolved is done, and never re-run.
      manuallyResolvedAt: null,
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

  it("MUTATION: sends the receipt of an approved capture whose card refund was closed as paid another way", async () => {
    mocks.taskFindUnique.mockResolvedValue({ status: "COMPLETED" });
    mocks.findClose.mockResolvedValue({ id: "close-1" });
    await expect(createXeroKeptLateCaptureInvoice({ syncOperationId: "op_kept" })).resolves.toBe("inv_kept");
    expect(mocks.createInvoices).toHaveBeenCalledTimes(1);
  });

  // #3924 round 6: the receipt, THEN the close's note - never the other way
  // round. Round 7 (C9): in two transactions, so a note failure leaves the
  // receipt's link standing.
  it("MUTATION: records the receipt's link under the task lock, THEN queues a waiting close's note under it again, before the row completes", async () => {
    await createXeroKeptLateCaptureInvoice({ syncOperationId: "op_kept" });

    const order = (mock: { mock: { invocationCallOrder: number[] } }, index = 0) =>
      mock.mock.invocationCallOrder[index];
    // The send-time decision's lock, the link's, then the note's.
    expect(mocks.executeRaw).toHaveBeenCalledTimes(3);
    expect(order(mocks.createInvoices)).toBeLessThan(order(mocks.executeRaw, 1));
    expect(order(mocks.executeRaw, 1)).toBeLessThan(order(mocks.upsertLink));
    expect(order(mocks.upsertLink)).toBeLessThan(order(mocks.executeRaw, 2));
    expect(order(mocks.executeRaw, 2)).toBeLessThan(order(mocks.noteClose));
    expect(order(mocks.noteClose)).toBeLessThan(order(mocks.completeXeroSyncOperation));
    expect(mocks.upsertLink).toHaveBeenCalledWith(
      expect.objectContaining({
        localModel: "ManualRefundTask",
        localId: "task_kept",
        role: KEPT_LATE_CAPTURE_INVOICE_ROLE,
        xeroObjectId: "inv_kept",
      }),
      { store: db },
    );
    expect(mocks.noteClose).toHaveBeenCalledWith({
      paymentIntentId: "pi_kept",
      receiptInvoiceId: "inv_kept",
      clubZone: "Pacific/Auckland",
      store: db,
    });
  });

  it("MUTATION: C9 (round 7): a failed note step fails the run AFTER the receipt's link is written, so the link stands", async () => {
    mocks.noteClose.mockRejectedValueOnce(new Error("database blip"));
    await expect(createXeroKeptLateCaptureInvoice({ syncOperationId: "op_kept" })).rejects.toThrow("database blip");
    expect(mocks.upsertLink).toHaveBeenCalledTimes(1);
    expect(mocks.completeXeroSyncOperation).not.toHaveBeenCalled();
    expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith("op_kept", expect.any(Error));
  });

  it("once its invoice exists, records the missing payment whatever the task says now - and runs the note step again, which queues at most once", async () => {
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
    // A retry after a failed note step: the link is not written again, the note step runs.
    expect(mocks.upsertLink).not.toHaveBeenCalled();
    expect(mocks.noteClose).toHaveBeenCalledWith(expect.objectContaining({ receiptInvoiceId: "inv_kept" }));
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

// #3924 round 8 (owner, 8 Oct 2026: "Raise a refund note for all"): the one note
// step, for the receipt this worker sends and for a change's invoice sent for
// the capture (`createXeroSupplementaryInvoice`).
describe("queueWaitingPaidAnotherWayNote", () => {
  beforeEach(() => {
    mocks.taskFindUnique.mockResolvedValue({ id: "task_kept" });
    mocks.noteClose.mockResolvedValue("op_note");
  });

  it("MUTATION: reads the receipt under the approval task's lock and credits the invoice Xero holds", async () => {
    await expect(queueWaitingPaidAnotherWayNote("pi_kept")).resolves.toBe("op_note");
    expect(lockedTask()).toBe(true);
    expect(mocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.readReceipt.mock.invocationCallOrder[0]);
    expect(mocks.readReceipt).toHaveBeenCalledWith("pi_kept", db);
    expect(mocks.noteClose).toHaveBeenCalledWith({
      paymentIntentId: "pi_kept",
      receiptInvoiceId: "inv_kept",
      clubZone: "Pacific/Auckland",
      store: db,
    });
  });

  it.each([
    ["recorded but not yet in Xero (a change's invoice still sending)", { kind: "recorded", invoiceId: null }],
    ["not recorded", { kind: "none" }],
    ["resolved by hand", { kind: "resolved-by-hand" }],
  ])("MUTATION: queues nothing while the receipt is %s", async (_when, receipt) => {
    mocks.readReceipt.mockResolvedValue(receipt);
    await expect(queueWaitingPaidAnotherWayNote("pi_kept")).resolves.toBeNull();
    expect(mocks.noteClose).not.toHaveBeenCalled();
  });

  it("nothing for a capture with no approval task", async () => {
    mocks.taskFindUnique.mockResolvedValue(null);
    await expect(queueWaitingPaidAnotherWayNote("pi_kept")).resolves.toBeNull();
    expect(mocks.executeRaw).not.toHaveBeenCalled();
  });
});

// #3924 round 9: the nightly credit reconciliation's retry of the note step,
// for a payment whose closes' own notes do not cover what they paid back.
describe("queueWaitingPaidAnotherWayNotesForPayment", () => {
  beforeEach(() => {
    mocks.taskFindUnique.mockResolvedValue({ id: "task_kept" });
    mocks.noteClose.mockResolvedValue("op_note");
  });

  it("MUTATION: runs the one note step, under each approval task's lock, for every approved late capture on the payment", async () => {
    mocks.taskFindMany.mockResolvedValue([
      { lateCaptureApprovalIntentId: "pi_kept" },
      { lateCaptureApprovalIntentId: "pi_other" },
    ]);
    mocks.noteClose.mockResolvedValueOnce("op_note").mockResolvedValueOnce(null);
    await expect(queueWaitingPaidAnotherWayNotesForPayment("pay_1")).resolves.toBe(1);
    expect(mocks.taskFindMany).toHaveBeenCalledWith({
      where: { paymentId: "pay_1", status: "COMPLETED", lateCaptureApprovalIntentId: { not: null } },
      select: { lateCaptureApprovalIntentId: true },
    });
    expect(mocks.noteClose.mock.calls.map(([call]) => (call as { paymentIntentId: string }).paymentIntentId)).toEqual([
      "pi_kept",
      "pi_other",
    ]);
    // Each read and queue under the task's row lock.
    expect(mocks.executeRaw).toHaveBeenCalledTimes(2);
    expect(mocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.readReceipt.mock.invocationCallOrder[0]);
  });

  it("nothing for a payment with no approved late capture", async () => {
    mocks.taskFindMany.mockResolvedValue([]);
    await expect(queueWaitingPaidAnotherWayNotesForPayment("pay_1")).resolves.toBe(0);
    expect(mocks.noteClose).not.toHaveBeenCalled();
  });
});
