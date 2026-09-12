import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  after: vi.fn((callback: () => Promise<void> | void) => {
    void callback();
  }),
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  logAudit: vi.fn(),
  createAuditLog: vi.fn(),
  xeroOperationFindUnique: vi.fn(),
  xeroOperationFindMany: vi.fn(),
  xeroOperationCount: vi.fn(),
  xeroOperationUpdate: vi.fn(),
  xeroOperationUpdateMany: vi.fn(),
  resolveFailedXeroOperationStates: vi.fn(),
  enqueueXeroSyncOperationRetry: vi.fn(),
  processQueuedXeroOperationRetries: vi.fn(),
  getXeroOperationRetryMeta: vi.fn(),
  getXeroApiErrorInfo: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("next/server");

  return {
    ...actual,
    after: mocks.after,
  };
});

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mocks.logAudit,
  createAuditLog: mocks.createAuditLog,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroSyncOperation: {
      findUnique: mocks.xeroOperationFindUnique,
      findMany: mocks.xeroOperationFindMany,
      count: mocks.xeroOperationCount,
      update: mocks.xeroOperationUpdate,
      updateMany: mocks.xeroOperationUpdateMany,
    },
  },
}));

vi.mock("@/lib/xero-stale-operations", () => ({
  staleRunningXeroOperationFilter: () => ({
    status: "RUNNING",
    startedAt: { lt: new Date("2026-01-01T00:00:00.000Z") },
  }),
}));

vi.mock("@/lib/xero-admin-failures", () => ({
  resolveFailedXeroOperationStates: mocks.resolveFailedXeroOperationStates,
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
    getXeroOperationRetryMeta: mocks.getXeroOperationRetryMeta,
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
import { POST as markNonReplayableOperation } from "@/app/api/admin/xero/operations/[id]/mark-non-replayable/route";
import { POST as resolveOperation } from "@/app/api/admin/xero/operations/[id]/resolve/route";
import { POST as resetStaleRunning } from "@/app/api/admin/xero/operations/reset-stale-running/route";
import { GET as listOperations } from "@/app/api/admin/xero/operations/route";
import { XeroOperationRetryError } from "@/lib/xero-operation-retry";

describe("Xero operation admin retry routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
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
      clientMessage: "Xero unavailable",
      diagnosticMessage: "provider diagnostic",
    });
    mocks.getXeroOperationRetryMeta.mockReturnValue({
      supported: true,
      reason: null,
    });
    mocks.xeroOperationFindUnique.mockResolvedValue({
      id: "op_failed",
      direction: "OUTBOUND",
      entityType: "CONTACT",
      operationType: "UPDATE",
      localModel: "Member",
      localId: "member_1",
      status: "FAILED",
      replayable: true,
    });
    mocks.xeroOperationUpdate.mockResolvedValue({});
    mocks.xeroOperationFindMany.mockResolvedValue([]);
    mocks.xeroOperationCount.mockResolvedValue(0);
    mocks.resolveFailedXeroOperationStates.mockResolvedValue(new Map());
    mocks.createAuditLog.mockResolvedValue(undefined);
  });

  it("lists operations with scoped filters and pagination metadata", async () => {
    const createdAt = new Date("2026-04-14T09:00:00Z");
    mocks.xeroOperationFindMany.mockResolvedValue([
      {
        id: "op_1",
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "pay_1",
        status: "PENDING",
        idempotencyKey: "idem_1",
        correlationKey: "corr_1",
        attemptCount: 1,
        replayable: true,
        lastErrorCode: null,
        lastErrorMessage: null,
        requestPayload: {},
        responsePayload: null,
        xeroObjectType: "INVOICE",
        xeroObjectId: "inv_1",
        xeroObjectNumber: null,
        xeroObjectUrl: null,
        createdByMemberId: "admin-1",
        startedAt: null,
        completedAt: null,
        createdAt,
        updatedAt: createdAt,
      },
    ]);
    mocks.xeroOperationCount.mockResolvedValue(1);

    const response = await listOperations(
      new NextRequest(
        "http://localhost/api/admin/xero/operations?localModel=Payment&localId=pay_1&operationType=CREATE&resourceId=inv_1&page=2&pageSize=10"
      )
    );

    expect(response.status).toBe(200);
    expect(mocks.xeroOperationFindMany).toHaveBeenCalledWith({
      where: {
        localModel: "Payment",
        localId: "pay_1",
        operationType: "CREATE",
        xeroObjectId: "inv_1",
      },
      orderBy: { createdAt: "desc" },
      skip: 10,
      take: 10,
    });

    await expect(response.json()).resolves.toMatchObject({
      total: 1,
      page: 2,
      pageSize: 10,
      data: [
        {
          id: "op_1",
          localUrl: "/admin/xero/records/Payment/pay_1",
        },
      ],
    });
  });

  it("filters failed operations by resolved failure state before pagination", async () => {
    const createdAt = new Date("2026-04-14T09:00:00Z");
    const active = {
      id: "op_active",
      direction: "OUTBOUND",
      entityType: "CONTACT",
      operationType: "CREATE",
      localModel: "Member",
      localId: "member_1",
      status: "FAILED",
      replayable: true,
      requestPayload: {},
      createdAt,
      updatedAt: createdAt,
    };
    const repaired = {
      ...active,
      id: "op_repaired",
      localId: "member_2",
    };
    mocks.xeroOperationFindMany.mockResolvedValue([active, repaired]);
    mocks.resolveFailedXeroOperationStates.mockResolvedValue(
      new Map([
        [
          "op_active",
          {
            state: "ACTIVE",
            reason: "Still failing",
            rootKey: "root-active",
            representativeOperationId: "op_active",
          },
        ],
        [
          "op_repaired",
          {
            state: "REPAIRED",
            reason: "Fixed later",
            rootKey: "root-repaired",
            representativeOperationId: "op_repaired",
          },
        ],
      ])
    );

    const response = await listOperations(
      new NextRequest("http://localhost/api/admin/xero/operations?failureState=ACTIVE")
    );

    expect(response.status).toBe(200);
    expect(mocks.xeroOperationFindMany).toHaveBeenCalledWith({
      where: { status: "FAILED", manuallyResolvedAt: null },
      orderBy: { createdAt: "desc" },
    });

    const body = await response.json();
    expect(body.total).toBe(1);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: "op_active",
      failureState: "ACTIVE",
      failureStateReason: "Still failing",
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
      category: "xero",
      memberId: "admin-1",
      targetId: "op_123",
      entityType: "XeroSyncOperation",
      entityId: "op_123",
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
      category: "xero",
      memberId: "admin-1",
      targetId: "op_456",
      entityType: "XeroSyncOperation",
      entityId: "op_456",
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

  it("marks failed operations non-replayable with an audit reason", async () => {
    const response = await markNonReplayableOperation(
      new NextRequest("http://localhost", {
        method: "POST",
        body: JSON.stringify({ reason: "Payload was manually repaired in Xero." }),
      }),
      {
        params: Promise.resolve({ id: "op_failed" }),
      }
    );

    expect(response.status).toBe(200);
    expect(mocks.xeroOperationUpdate).toHaveBeenCalledWith({
      where: { id: "op_failed" },
      data: { replayable: false },
    });
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "xero.operation.marked_non_replayable",
        actorMemberId: "admin-1",
        targetId: "op_failed",
        details: "Payload was manually repaired in Xero.",
      })
    );
    await expect(response.json()).resolves.toEqual({
      ok: true,
      message: "Xero operation marked non-replayable with an audit record.",
    });
  });

  it("marks a failed operation resolved in Xero and audits it", async () => {
    const response = await resolveOperation(
      new NextRequest("http://localhost", {
        method: "POST",
        body: JSON.stringify({ reason: "Contact was archived directly in Xero." }),
      }),
      {
        params: Promise.resolve({ id: "op_failed" }),
      }
    );

    expect(response.status).toBe(200);
    expect(mocks.xeroOperationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "op_failed" },
        data: expect.objectContaining({
          manuallyResolvedReason: "Contact was archived directly in Xero.",
          manuallyResolvedById: "admin-1",
          manuallyResolvedAt: expect.any(Date),
        }),
      })
    );
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "xero.operation.manually_resolved",
        targetId: "op_failed",
        details: "Contact was archived directly in Xero.",
      })
    );
  });

  it("resets stale running operations without erasing provider-created recovery proof", async () => {
    mocks.xeroOperationUpdateMany.mockResolvedValue({ count: 3 });

    const response = await resetStaleRunning();

    expect(response.status).toBe(200);
    expect(mocks.xeroOperationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "RUNNING" }),
        data: expect.objectContaining({
          status: "FAILED",
          lastErrorCode: "ORPHANED_STALE_RUNNING",
        }),
      })
    );
    const update = mocks.xeroOperationUpdateMany.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(update.data).not.toHaveProperty("responsePayload");
    expect(update.data).not.toHaveProperty("xeroObjectType");
    expect(update.data).not.toHaveProperty("xeroObjectId");
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ ok: true, count: 3 })
    );
  });
});
