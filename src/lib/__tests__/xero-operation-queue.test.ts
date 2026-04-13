import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUniqueOperation: vi.fn(),
  findFirstQueued: vi.fn(),
  findManyQueued: vi.fn(),
  updateManyOperation: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  getRetryMeta: vi.fn(),
  retryXeroSyncOperation: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroSyncOperation: {
      findUnique: mocks.findUniqueOperation,
      findFirst: mocks.findFirstQueued,
      findMany: mocks.findManyQueued,
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
    parts.filter((part) => part !== null && part !== undefined && part !== "").join(":"),
  startXeroSyncOperation: mocks.startXeroSyncOperation,
  completeXeroSyncOperation: mocks.completeXeroSyncOperation,
  failXeroSyncOperation: mocks.failXeroSyncOperation,
}));

vi.mock("@/lib/xero-operation-retry", () => {
  class TestXeroOperationRetryError extends Error {
    status: number;

    constructor(message: string, status = 400) {
      super(message);
      this.name = "XeroOperationRetryError";
      this.status = status;
    }
  }

  return {
    getXeroOperationRetryMeta: mocks.getRetryMeta,
    retryXeroSyncOperation: mocks.retryXeroSyncOperation,
    XeroOperationRetryError: TestXeroOperationRetryError,
  };
});

import {
  enqueueXeroSyncOperationRetry,
  processQueuedXeroOperationRetries,
  XERO_OPERATION_REQUEUE_TYPE,
} from "@/lib/xero-operation-queue";

function makeOperation(overrides: Record<string, unknown> = {}) {
  return {
    id: "op_123",
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    localModel: "Payment",
    localId: "pay_123",
    status: "FAILED",
    createdByMemberId: null,
    requestPayload: null,
    ...overrides,
  };
}

function makeQueuedOperation(overrides: Record<string, unknown> = {}) {
  return {
    id: "queue_1",
    createdByMemberId: "admin_1",
    requestPayload: {
      originalOperationId: "op_123",
    },
    ...overrides,
  };
}

describe("enqueueXeroSyncOperationRetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRetryMeta.mockReturnValue({ supported: true, reason: null });
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "queue_1" });
  });

  it("creates a pending queue operation for a supported failed sync", async () => {
    mocks.findUniqueOperation.mockResolvedValue(makeOperation());
    mocks.findFirstQueued.mockResolvedValue(null);

    await expect(
      enqueueXeroSyncOperationRetry("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      queueOperationId: "queue_1",
      message: "Xero operation queued for background retry.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: XERO_OPERATION_REQUEUE_TYPE,
        localModel: "Payment",
        localId: "pay_123",
        status: "PENDING",
        replayable: false,
        createdByMemberId: "admin_1",
        requestPayload: {
          originalOperationId: "op_123",
          originalOperationType: "CREATE",
          originalStatus: "FAILED",
        },
      })
    );
  });

  it("rejects duplicate queued retries while one is pending", async () => {
    mocks.findUniqueOperation.mockResolvedValue(makeOperation());
    mocks.findFirstQueued.mockResolvedValue({ id: "queue_existing" });

    await expect(
      enqueueXeroSyncOperationRetry("op_123", { createdByMemberId: "admin_1" })
    ).rejects.toMatchObject({
      name: "XeroOperationRetryError",
      status: 409,
    });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });
});

describe("processQueuedXeroOperationRetries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });
  });

  it("claims and completes queued retry rows", async () => {
    mocks.findManyQueued.mockResolvedValue([makeQueuedOperation()]);
    mocks.retryXeroSyncOperation.mockResolvedValue({
      message: "Retried Xero booking invoice creation.",
    });

    await expect(processQueuedXeroOperationRetries({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.updateManyOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "queue_1",
          status: "PENDING",
          operationType: XERO_OPERATION_REQUEUE_TYPE,
        },
      })
    );
    expect(mocks.retryXeroSyncOperation).toHaveBeenCalledWith("op_123", {
      createdByMemberId: "admin_1",
    });
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "queue_1",
      expect.objectContaining({
        status: "SUCCEEDED",
        responsePayload: expect.objectContaining({
          originalOperationId: "op_123",
        }),
      })
    );
  });

  it("fails queued retries with malformed payloads", async () => {
    mocks.findManyQueued.mockResolvedValue([
      makeQueuedOperation({
        requestPayload: {},
      }),
    ]);

    await expect(processQueuedXeroOperationRetries()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 0,
      failed: 1,
      skipped: 0,
    });

    expect(mocks.retryXeroSyncOperation).not.toHaveBeenCalled();
    expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith(
      "queue_1",
      expect.objectContaining({
        name: "XeroOperationRetryError",
      })
    );
  });
});
