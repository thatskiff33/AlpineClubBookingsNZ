import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirstLink: vi.fn(),
  findUniqueBooking: vi.fn(),
  findUniquePayment: vi.fn(),
  findFirstOperation: vi.fn(),
  findManyOperations: vi.fn(),
  updateManyOperation: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  getEntranceFeeContext: vi.fn(),
  createXeroCreditNote: vi.fn(),
  createXeroEntranceFeeInvoice: vi.fn(),
  createXeroInvoiceForBooking: vi.fn(),
  isXeroConnected: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: mocks.findUniqueBooking,
    },
    payment: {
      findUnique: mocks.findUniquePayment,
    },
    xeroObjectLink: {
      findFirst: mocks.findFirstLink,
    },
    xeroSyncOperation: {
      findFirst: mocks.findFirstOperation,
      findMany: mocks.findManyOperations,
      updateMany: mocks.updateManyOperation,
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: (...parts: Array<string | number | boolean | null | undefined>) =>
    parts
      .filter((part): part is string | number | boolean => part !== null && part !== undefined && part !== "")
      .map((part) => String(part))
      .join(":"),
  startXeroSyncOperation: mocks.startXeroSyncOperation,
  failXeroSyncOperation: mocks.failXeroSyncOperation,
}));

vi.mock("@/lib/xero", () => ({
  buildEntranceFeeInvoiceIdempotencyKey: (
    memberId: string,
    category: string,
    amountCents: number
  ) => `member:${memberId}:entrance-fee-invoice:${category}:${amountCents}:v1`,
  createXeroCreditNote: mocks.createXeroCreditNote,
  getEntranceFeeContext: mocks.getEntranceFeeContext,
  createXeroEntranceFeeInvoice: mocks.createXeroEntranceFeeInvoice,
  createXeroInvoiceForBooking: mocks.createXeroInvoiceForBooking,
  isXeroConnected: mocks.isXeroConnected,
}));

import {
  enqueueXeroBookingInvoiceOperation,
  enqueueXeroEntranceFeeInvoiceOperation,
  enqueueXeroRefundCreditNoteOperation,
  processQueuedXeroOutboxOperations,
} from "@/lib/xero-operation-outbox";

describe("enqueueXeroEntranceFeeInvoiceOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      payment: {
        id: "payment_1",
        xeroInvoiceId: null,
      },
    });
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
      xeroRefundCreditNoteId: null,
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.getEntranceFeeContext.mockResolvedValue({
      category: "ADULT",
      feeMapping: {
        itemCode: "EF-ADULT",
        amountCents: 15000,
      },
    });
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_entrance_1" });
  });

  it("creates a pending primary Xero sync operation for entrance fee invoices", async () => {
    await expect(
      enqueueXeroEntranceFeeInvoiceOperation("member_1", {
        createdByMemberId: "admin_1",
      })
    ).resolves.toEqual({
      queueOperationId: "op_entrance_1",
      message: "Xero entrance fee invoice queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "Member",
        localId: "member_1",
        status: "PENDING",
        idempotencyKey: "member:member_1:entrance-fee-invoice:ADULT:15000:v1",
        correlationKey: "member:member_1:entrance-fee-invoice:ADULT:15000:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "ENTRANCE_FEE_INVOICE",
          category: "ADULT",
          itemCode: "EF-ADULT",
          feeAmountCents: 15000,
        },
      })
    );
  });

  it("skips queueing when there is no configured entrance fee", async () => {
    mocks.getEntranceFeeContext.mockResolvedValue({
      category: "CHILD",
      feeMapping: {
        itemCode: null,
        amountCents: null,
      },
    });

    await expect(
      enqueueXeroEntranceFeeInvoiceOperation("member_1")
    ).resolves.toEqual({
      queueOperationId: null,
      message: "No entrance fee is configured for this member category.",
    });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });
});

describe("enqueueXeroBookingInvoiceOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      payment: {
        id: "payment_1",
        xeroInvoiceId: null,
      },
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_booking_1" });
  });

  it("creates a pending primary Xero sync operation for booking invoices", async () => {
    await expect(
      enqueueXeroBookingInvoiceOperation("booking_1", {
        createdByMemberId: "admin_1",
      })
    ).resolves.toEqual({
      queueOperationId: "op_booking_1",
      message: "Xero booking invoice queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "payment_1",
        status: "PENDING",
        idempotencyKey: "booking:booking_1:invoice:v1",
        correlationKey: "booking:booking_1:invoice:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "BOOKING_INVOICE",
          bookingId: "booking_1",
        },
      })
    );
  });

  it("skips queueing when the booking payment is already linked to Xero", async () => {
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      payment: {
        id: "payment_1",
        xeroInvoiceId: "inv_existing",
      },
    });

    await expect(
      enqueueXeroBookingInvoiceOperation("booking_1")
    ).resolves.toEqual({
      queueOperationId: null,
      message: "Xero booking invoice already linked for this booking.",
    });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });
});

describe("enqueueXeroRefundCreditNoteOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
      xeroRefundCreditNoteId: null,
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_credit_note_1" });
  });

  it("creates a pending primary Xero sync operation for refund credit notes", async () => {
    await expect(
      enqueueXeroRefundCreditNoteOperation("payment_1", 5000, {
        createdByMemberId: "admin_1",
      })
    ).resolves.toEqual({
      queueOperationId: "op_credit_note_1",
      message: "Xero refund credit note queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "payment_1",
        status: "PENDING",
        idempotencyKey: "payment:payment_1:refund-credit-note:5000:v1",
        correlationKey: "payment:payment_1:refund-credit-note:5000:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "REFUND_CREDIT_NOTE",
          refundAmountCents: 5000,
        },
      })
    );
  });

  it("skips queueing when the refund credit note is already linked", async () => {
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
      xeroRefundCreditNoteId: "cn_existing",
    });

    await expect(
      enqueueXeroRefundCreditNoteOperation("payment_1", 5000)
    ).resolves.toEqual({
      queueOperationId: null,
      message: "Xero refund credit note already linked for this payment.",
    });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });
});

describe("processQueuedXeroOutboxOperations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });
  });

  it("claims and processes queued entrance fee operations", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_entrance_1",
        localId: "member_1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "ENTRANCE_FEE_INVOICE",
          category: "ADULT",
          itemCode: "EF-ADULT",
          feeAmountCents: 15000,
        },
      },
    ]);
    mocks.createXeroEntranceFeeInvoice.mockResolvedValue("inv_1");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.createXeroEntranceFeeInvoice).toHaveBeenCalledWith("member_1", {
      createdByMemberId: "admin_1",
      syncOperationId: "op_entrance_1",
      precomputedEntranceFee: {
        category: "ADULT",
        feeMapping: {
          itemCode: "EF-ADULT",
          amountCents: 15000,
        },
      },
    });
  });

  it("claims and processes queued booking invoice operations", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_booking_1",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "BOOKING_INVOICE",
          bookingId: "booking_1",
        },
      },
    ]);
    mocks.createXeroInvoiceForBooking.mockResolvedValue("inv_1");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.createXeroInvoiceForBooking).toHaveBeenCalledWith("booking_1", {
      createdByMemberId: "admin_1",
      syncOperationId: "op_booking_1",
    });
  });

  it("claims and processes queued refund credit note operations", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_credit_note_1",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "REFUND_CREDIT_NOTE",
          refundAmountCents: 5000,
        },
      },
    ]);
    mocks.createXeroCreditNote.mockResolvedValue("cn_1");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.createXeroCreditNote).toHaveBeenCalledWith("payment_1", 5000, {
      createdByMemberId: "admin_1",
      syncOperationId: "op_credit_note_1",
    });
  });

  it("fails malformed queued payloads", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_entrance_1",
        localModel: "Member",
        localId: "member_1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "ENTRANCE_FEE_INVOICE",
        },
      },
    ]);

    await expect(processQueuedXeroOutboxOperations()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 0,
      failed: 1,
      skipped: 0,
    });

    expect(mocks.createXeroEntranceFeeInvoice).not.toHaveBeenCalled();
    expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith(
      "op_entrance_1",
      expect.objectContaining({
        message: "Queued Xero outbox payload is incomplete.",
      })
    );
  });
});
