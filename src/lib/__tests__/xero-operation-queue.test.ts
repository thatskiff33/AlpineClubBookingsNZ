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
  buildXeroOperationRequeueCorrelationKey,
  enqueueXeroSyncOperationRetry,
  parseXeroOperationRequeueOriginalId,
  processQueuedXeroOperationRetries,
  XERO_OPERATION_REQUEUE_TYPE,
} from "@/lib/xero-operation-queue";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

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

describe("parseXeroOperationRequeueOriginalId", () => {
  it("round-trips the original operation id through the correlation key", () => {
    const originalOperationId = "cmqdxeu50002101n22w2ivcas";
    const correlationKey = buildXeroOperationRequeueCorrelationKey(originalOperationId);

    expect(parseXeroOperationRequeueOriginalId(correlationKey)).toBe(originalOperationId);
  });

  it("returns null for non-requeue or empty correlation keys", () => {
    expect(parseXeroOperationRequeueOriginalId(null)).toBeNull();
    expect(parseXeroOperationRequeueOriginalId(undefined)).toBeNull();
    expect(
      parseXeroOperationRequeueOriginalId(
        "member-subscription:sub_1:membership-cancellation-credit:part_1:v1"
      )
    ).toBeNull();
    expect(parseXeroOperationRequeueOriginalId("xero-operation:requeue:")).toBeNull();
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

    await expect(processQueuedXeroOperationRetries({ limit: 5 }, CLUB_FORMAT_TEST)).resolves.toEqual({
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
    expect(mocks.retryXeroSyncOperation).toHaveBeenCalledWith("op_123", CLUB_FORMAT_TEST, {
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

  it("recovers the original operation id from the correlation key when the payload copy was redacted", async () => {
    // An operation id containing a phone-like run of digits gets rewritten to
    // "[REDACTED]" in the stored payload, but the correlation key is intact.
    const originalOperationId = "cmqdxeu50002101n22w2ivcas";
    mocks.findManyQueued.mockResolvedValue([
      makeQueuedOperation({
        correlationKey: buildXeroOperationRequeueCorrelationKey(originalOperationId),
        requestPayload: { originalOperationId: "[REDACTED]" },
      }),
    ]);
    mocks.retryXeroSyncOperation.mockResolvedValue({
      message: "Retried Xero membership cancellation credit note creation.",
    });

    await expect(processQueuedXeroOperationRetries({ limit: 5 }, CLUB_FORMAT_TEST)).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.retryXeroSyncOperation).toHaveBeenCalledWith(originalOperationId, CLUB_FORMAT_TEST, {
      createdByMemberId: "admin_1",
    });
  });

  it("fails queued retries with malformed payloads", async () => {
    mocks.findManyQueued.mockResolvedValue([
      makeQueuedOperation({
        requestPayload: {},
      }),
    ]);

    await expect(processQueuedXeroOperationRetries(undefined, CLUB_FORMAT_TEST)).resolves.toEqual({
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

  it("skips a queued retry it loses the claim race for (updateMany matched zero PENDING rows)", async () => {
    // A concurrent worker already claimed the requeue row, so the conditional
    // claim matches nothing. The single-flight must skip it, never replaying the
    // original operation twice.
    mocks.findManyQueued.mockResolvedValue([makeQueuedOperation()]);
    mocks.updateManyOperation.mockResolvedValue({ count: 0 });

    await expect(processQueuedXeroOperationRetries({ limit: 5 }, CLUB_FORMAT_TEST)).resolves.toEqual({
      found: 1,
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 1,
    });

    expect(mocks.retryXeroSyncOperation).not.toHaveBeenCalled();
    expect(mocks.completeXeroSyncOperation).not.toHaveBeenCalled();
  });
});
