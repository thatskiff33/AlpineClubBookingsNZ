import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  after: vi.fn((callback: () => Promise<void> | void) => {
    void callback();
  }),
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  logAudit: vi.fn(),
  enqueueXeroSyncOperationRetry: vi.fn(),
  processQueuedXeroOperationRetries: vi.fn(),
  getXeroApiErrorInfo: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();

  return {
    ...actual,
    after: mocks.after,
  };
});

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mocks.logAudit,
}));

vi.mock("@/lib/xero-operation-queue", () => ({
  enqueueXeroSyncOperationRetry: mocks.enqueueXeroSyncOperationRetry,
  processQueuedXeroOperationRetries: mocks.processQueuedXeroOperationRetries,
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
    XeroOperationRetryError: TestXeroOperationRetryError,
  };
});

vi.mock("@/lib/xero-api-errors", () => ({
  getXeroApiErrorInfo: mocks.getXeroApiErrorInfo,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import { POST as retryOperation } from "@/app/api/admin/xero/operations/[id]/retry/route";
import { POST as requeueOperation } from "@/app/api/admin/xero/operations/[id]/requeue/route";
import { XeroOperationRetryError } from "@/lib/xero-operation-retry";

describe("Xero operation admin retry routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.enqueueXeroSyncOperationRetry.mockResolvedValue({
      queueOperationId: "queue_1",
      message: "Xero operation queued for background retry.",
    });
    mocks.processQueuedXeroOperationRetries.mockResolvedValue({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    mocks.getXeroApiErrorInfo.mockReturnValue({
      handled: true,
      status: 503,
      message: "Xero unavailable",
    });
  });

  it("queues retry requests through the background worker route", async () => {
    const response = await retryOperation(new NextRequest("http://localhost"), {
      params: Promise.resolve({ id: "op_123" }),
    });

    expect(response.status).toBe(202);
    expect(mocks.enqueueXeroSyncOperationRetry).toHaveBeenCalledWith("op_123", {
      createdByMemberId: "admin-1",
    });
    expect(mocks.processQueuedXeroOperationRetries).toHaveBeenCalledWith({ limit: 1 });
    expect(mocks.logAudit).toHaveBeenCalledWith({
      action: "XERO_OPERATION_RETRY",
      memberId: "admin-1",
      targetId: "op_123",
      details: "Xero operation queued for background retry.",
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      message: "Xero operation queued for background retry.",
      queueOperationId: "queue_1",
    });
  });

  it("keeps the requeue route as a queued retry alias", async () => {
    const response = await requeueOperation(new NextRequest("http://localhost"), {
      params: Promise.resolve({ id: "op_456" }),
    });

    expect(response.status).toBe(202);
    expect(mocks.enqueueXeroSyncOperationRetry).toHaveBeenCalledWith("op_456", {
      createdByMemberId: "admin-1",
    });
    expect(mocks.processQueuedXeroOperationRetries).toHaveBeenCalledWith({ limit: 1 });
    expect(mocks.logAudit).toHaveBeenCalledWith({
      action: "XERO_OPERATION_REQUEUED",
      memberId: "admin-1",
      targetId: "op_456",
      details: "Xero operation queued for background retry.",
    });
  });

  it("returns typed retry errors from the queueing flow", async () => {
    mocks.enqueueXeroSyncOperationRetry.mockRejectedValue(
      new XeroOperationRetryError("A queued retry is already pending for this Xero operation.", 409)
    );

    const response = await retryOperation(new NextRequest("http://localhost"), {
      params: Promise.resolve({ id: "op_busy" }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "A queued retry is already pending for this Xero operation.",
    });
    expect(mocks.processQueuedXeroOperationRetries).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });
});
