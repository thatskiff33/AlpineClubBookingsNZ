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
  xeroOperationFindFirst: vi.fn(),
  xeroOperationCount: vi.fn(),
  xeroOperationUpdate: vi.fn(),
  xeroOperationUpdateMany: vi.fn(),
  resolveFailedXeroOperationStates: vi.fn(),
  enqueueXeroSyncOperationRetry: vi.fn(),
  processQueuedXeroOperationRetries: vi.fn(),
  getXeroOperationRetryMeta: vi.fn(),
  getXeroApiErrorInfo: vi.fn(),
  transaction: vi.fn(),
  // Records every write made on the bare client rather than a transaction
  // client (#3462), so a rollback test can prove its write was inside the
  // transaction: one on the bare client would commit on its own in Postgres.
  bareClientWrite: vi.fn(),
}));

// The client the routes' transactions hand their writes and audit rows
// (#3462): its own object, so a test can tell an audit written inside the
// transaction from one written on the bare client.
const txClient = {
  xeroSyncOperation: {
    findUnique: mocks.xeroOperationFindUnique,
    update: mocks.xeroOperationUpdate,
    updateMany: mocks.xeroOperationUpdateMany,
  },
};

/**
 * A transaction that really rolls back: the row the test watches is restored
 * when the callback throws, as Postgres would restore it. An audit written
 * outside the transaction cannot undo the write, so only an audit inside it
 * leaves the row as it was.
 */
function simulateRollback(row: Record<string, unknown>) {
  mocks.transaction.mockImplementation(
    async (run: (tx: typeof txClient) => Promise<unknown>) => {
      const snapshot = { ...row };
      try {
        return await run(txClient);
      } catch (error) {
        Object.assign(row, snapshot);
        throw error;
      }
    },
  );
}

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
    $transaction: mocks.transaction,
    xeroSyncOperation: {
      findUnique: mocks.xeroOperationFindUnique,
      findMany: mocks.xeroOperationFindMany,
      findFirst: mocks.xeroOperationFindFirst,
      count: mocks.xeroOperationCount,
      update: (...args: unknown[]) => {
        mocks.bareClientWrite("update", ...args);
        return mocks.xeroOperationUpdate(...args);
      },
      updateMany: (...args: unknown[]) => {
        mocks.bareClientWrite("updateMany", ...args);
        return mocks.xeroOperationUpdateMany(...args);
      },
    },
  },
}));

// Partial, not wholesale (#3001): only the threshold-dependent filter is pinned
// here, so that a constant the route later reads from this module — it now takes
// the stale-reset error code from it — does not arrive `undefined` and turn the
// route 500 with nothing in the assertion to say why.
vi.mock("@/lib/xero-stale-operations", async (importOriginal) => ({
  // The cast sits OUTSIDE the call, not in a type argument: Semgrep cannot
  // parse the latter and silently stops scanning the rest of the file (#3318).
  ...((await importOriginal()) as typeof import("@/lib/xero-stale-operations")),
  staleRunningXeroOperationFilter: () => ({
    status: "RUNNING",
    startedAt: { lt: new Date("2026-01-01T00:00:00.000Z") },
  }),
}));

vi.mock("@/lib/xero-admin-failures", () => ({
  resolveFailedXeroOperationStates: mocks.resolveFailedXeroOperationStates,
}));

vi.mock("@/lib/xero-operation-queue", async (importOriginal) => ({
  // The real requeue correlation key, which the resolve route checks (#3635).
  ...((await importOriginal()) as typeof import("@/lib/xero-operation-queue")),
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
import { POST as markFailedOperation } from "@/app/api/admin/xero/operations/[id]/mark-failed/route";
import { GET as listOperations } from "@/app/api/admin/xero/operations/route";
import { XeroOperationRetryError } from "@/lib/xero-operation-retry";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

describe("Xero operation admin retry routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (run: (tx: typeof txClient) => Promise<unknown>) => run(txClient),
    );
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
    mocks.xeroOperationFindFirst.mockResolvedValue(null);
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
          staleRunning: false,
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
    expect(mocks.processQueuedXeroOperationRetries).toHaveBeenCalledWith({ limit: 1 }, CLUB_FORMAT_TEST);
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
    expect(mocks.processQueuedXeroOperationRetries).toHaveBeenCalledWith({ limit: 1 }, CLUB_FORMAT_TEST);
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
      }),
      txClient,
    );
    await expect(response.json()).resolves.toEqual({
      ok: true,
      message: "Xero operation marked non-replayable with an audit record.",
    });
  });

  it("leaves the operation replayable when its non-replayable audit cannot be written (#3462)", async () => {
    const row: Record<string, unknown> = { replayable: true };
    simulateRollback(row);
    mocks.xeroOperationUpdate.mockImplementation(async ({ data }: { data: { replayable: boolean } }) => {
      row.replayable = data.replayable;
      return { id: "op_failed" };
    });
    mocks.createAuditLog.mockRejectedValue(new Error("audit insert failed"));

    const response = await markNonReplayableOperation(
      new NextRequest("http://localhost", {
        method: "POST",
        body: JSON.stringify({ reason: "Payload was manually repaired in Xero." }),
      }),
      { params: Promise.resolve({ id: "op_failed" }) }
    );

    expect(response.status).toBe(500);
    expect(mocks.xeroOperationUpdate).toHaveBeenCalled();
    expect(row.replayable).toBe(true);
    expect(mocks.bareClientWrite).not.toHaveBeenCalled();
  });

  it("marks a failed operation resolved in Xero and audits it", async () => {
    mocks.xeroOperationUpdateMany.mockResolvedValue({ count: 1 });
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
    expect(mocks.xeroOperationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // #3635: status-guarded, so a retry that claimed the row first wins.
        where: {
          id: "op_failed",
          status: { in: ["FAILED", "PARTIAL"] },
          manuallyResolvedAt: null,
        },
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

  const resolveRequest = () =>
    new NextRequest("http://localhost", {
      method: "POST",
      body: JSON.stringify({ reason: "Credit note raised by hand in Xero." }),
    });

  it("refuses to resolve an applied-credit allocation or deallocation, and says to retry it (#3635)", async () => {
    for (const queueType of ["APPLIED_CREDIT_ALLOCATION", "APPLIED_CREDIT_DEALLOCATION"]) {
      mocks.xeroOperationUpdateMany.mockClear();
      mocks.xeroOperationFindUnique.mockResolvedValueOnce({
        id: "op_credit",
        direction: "OUTBOUND",
        entityType: "ALLOCATION",
        operationType: "UPDATE",
        localModel: "Payment",
        localId: "pay_1",
        status: "FAILED",
        replayable: true,
        queueType,
        requestPayload: null,
        manuallyResolvedAt: null,
      });

      const response = await resolveOperation(resolveRequest(), {
        params: Promise.resolve({ id: "op_credit" }),
      });

      expect(response.status).toBe(409);
      expect((await response.json()).error).toMatch(/Retry it instead/);
      expect(mocks.xeroOperationUpdateMany).not.toHaveBeenCalled();
    }
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("refuses to resolve while a retry has claimed the operation itself (#3635)", async () => {
    mocks.xeroOperationFindUnique.mockResolvedValueOnce({
      id: "op_failed",
      status: "RUNNING",
      queueType: null,
      requestPayload: null,
      manuallyResolvedAt: null,
    });

    const response = await resolveOperation(resolveRequest(), {
      params: Promise.resolve({ id: "op_failed" }),
    });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/retry of this Xero operation is running/);
    expect(mocks.xeroOperationUpdateMany).not.toHaveBeenCalled();
  });

  // An evaluator of the retry-conflict query against one queued-retry row, so
  // the tests read what the where clause would match, not what a stub says.
  type RetryRow = { status: string; startedAt: Date | null; completedAt: Date | null };
  const retryRowMatches = (row: RetryRow, where: { OR: Record<string, unknown>[] }) =>
    where.OR.some((clause) => {
      if (clause.status === "RUNNING") return row.status === "RUNNING";
      const started = (clause.startedAt as { lte: Date }).lte;
      const completed = (clause.completedAt as { gte: Date }).gte;
      return (
        row.status !== "CANCELLED" &&
        row.startedAt !== null &&
        row.startedAt <= started &&
        row.completedAt !== null &&
        row.completedAt >= completed
      );
    });
  const withQueuedRetry = (row: RetryRow | ((markAt: Date) => RetryRow)) =>
    mocks.xeroOperationFindFirst.mockImplementation(
      async (args: { where: { operationType?: string; OR: Record<string, unknown>[] } }) => {
        if (args.where.operationType !== "REQUEUE") return null;
        const markAt = (args.where.OR[1]!.startedAt as { lte: Date }).lte;
        const resolved = typeof row === "function" ? row(markAt) : row;
        return retryRowMatches(resolved, args.where)
          ? { id: "queue_retry", status: resolved.status, startedAt: resolved.startedAt }
          : null;
      }
    );

  it("withdraws the mark and answers 409 when a queued retry of the operation is running (#3635)", async () => {
    mocks.xeroOperationUpdateMany.mockResolvedValue({ count: 1 });
    withQueuedRetry({ status: "RUNNING", startedAt: new Date(), completedAt: null });

    const response = await resolveOperation(resolveRequest(), {
      params: Promise.resolve({ id: "op_failed" }),
    });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/was not marked resolved/);
    expect(mocks.xeroOperationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          correlationKey: "xero-operation:requeue:op_failed",
          operationType: "REQUEUE",
        }),
      })
    );
    // The check runs after the mark is written, and the mark is taken back.
    const [writeCall, withdrawCall] = mocks.xeroOperationUpdateMany.mock.calls;
    const writtenAt = writeCall[0].data.manuallyResolvedAt;
    expect(writtenAt).toBeInstanceOf(Date);
    expect(withdrawCall[0]).toEqual({
      where: { id: "op_failed", manuallyResolvedAt: writtenAt },
      data: {
        manuallyResolvedAt: null,
        manuallyResolvedReason: null,
        manuallyResolvedById: null,
      },
    });
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("withdraws the mark when a queued retry finished in the moments between the mark and the check (#3635 N4)", async () => {
    mocks.xeroOperationUpdateMany.mockResolvedValue({ count: 1 });
    // Started before the mark (it read the row unresolved), completed after it.
    withQueuedRetry((markAt) => ({
      status: "SUCCEEDED",
      startedAt: new Date(markAt.getTime() - 50),
      completedAt: new Date(markAt.getTime() + 5),
    }));

    const response = await resolveOperation(resolveRequest(), {
      params: Promise.resolve({ id: "op_failed" }),
    });

    expect(response.status).toBe(409);
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
    expect(mocks.xeroOperationUpdateMany).toHaveBeenCalledTimes(2);
  });

  it("keeps the mark when the queued retry stood down or finished before it (#3635 N4)", async () => {
    mocks.xeroOperationUpdateMany.mockResolvedValue({ count: 1 });
    withQueuedRetry((markAt) => ({
      status: "SUCCEEDED",
      startedAt: new Date(markAt.getTime() - 5000),
      completedAt: new Date(markAt.getTime() - 4000),
    }));

    const response = await resolveOperation(resolveRequest(), {
      params: Promise.resolve({ id: "op_failed" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.createAuditLog).toHaveBeenCalled();
  });

  it("points at Reset stale running operations when the running retry looks stuck (#3635 N7)", async () => {
    mocks.xeroOperationUpdateMany.mockResolvedValue({ count: 1 });
    withQueuedRetry({
      status: "RUNNING",
      startedAt: new Date("2020-01-01T00:00:00.000Z"),
      completedAt: null,
    });

    const response = await resolveOperation(resolveRequest(), {
      params: Promise.resolve({ id: "op_failed" }),
    });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/Reset stale running operations/);
  });

  it("refuses while a live copy of the same document is queued (#3635 N3)", async () => {
    mocks.xeroOperationFindUnique.mockResolvedValueOnce({
      id: "op_failed",
      status: "FAILED",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      correlationKey: "payment:pay_1:refund-credit-note:5000:v2",
      queueType: "REFUND_CREDIT_NOTE",
      requestPayload: null,
      manuallyResolvedAt: null,
    });
    mocks.xeroOperationFindFirst.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      args.where.correlationKey === "payment:pay_1:refund-credit-note:5000:v2" &&
      (args.where.status as { in: string[] }).in.includes("PENDING")
        ? { id: "op_live_copy" }
        : null
    );

    const response = await resolveOperation(resolveRequest(), {
      params: Promise.resolve({ id: "op_failed" }),
    });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/new copy of this Xero document is queued/);
    expect(mocks.xeroOperationUpdateMany).not.toHaveBeenCalled();
  });

  it("never tells a second officer 'already resolved' while the first mark may still be withdrawn (#3635 N5)", async () => {
    const markAt = new Date("2026-06-30T00:00:00.000Z");
    mocks.xeroOperationFindUnique.mockResolvedValueOnce({
      id: "op_failed",
      status: "FAILED",
      queueType: null,
      requestPayload: null,
      manuallyResolvedAt: markAt,
    });
    withQueuedRetry({ status: "RUNNING", startedAt: new Date(), completedAt: null });

    const response = await resolveOperation(resolveRequest(), {
      params: Promise.resolve({ id: "op_failed" }),
    });

    expect(response.status).toBe(409);
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("answers 'already resolved' to the second of two officers resolving at once (#3635)", async () => {
    mocks.xeroOperationUpdateMany.mockResolvedValue({ count: 0 });
    mocks.xeroOperationFindUnique
      .mockResolvedValueOnce({
        id: "op_failed",
        status: "FAILED",
        queueType: null,
        requestPayload: null,
        manuallyResolvedAt: null,
      })
      .mockResolvedValueOnce({
        status: "FAILED",
        manuallyResolvedAt: new Date("2026-06-30T00:00:00.000Z"),
      });

    const response = await resolveOperation(resolveRequest(), {
      params: Promise.resolve({ id: "op_failed" }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).message).toBe("Xero operation was already resolved.");
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("refuses to resolve an operation a retry claimed after the read (#3635)", async () => {
    mocks.xeroOperationUpdateMany.mockResolvedValue({ count: 0 });

    const response = await resolveOperation(
      new NextRequest("http://localhost", {
        method: "POST",
        body: JSON.stringify({ reason: "Credit note raised by hand in Xero." }),
      }),
      { params: Promise.resolve({ id: "op_failed" }) }
    );

    expect(response.status).toBe(409);
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it.each([
    ["retry", retryOperation],
    ["requeue", requeueOperation],
  ])(
    "the %s route passes the queue's 409 refusal of a resolved operation through, and kicks nothing (#3635)",
    async (_name, route) => {
      mocks.enqueueXeroSyncOperationRetry.mockRejectedValue(
        new XeroOperationRetryError(
          "An officer marked this operation resolved in Xero; it is treated as done and is never re-run.",
          409
        )
      );

      const response = await route(new NextRequest("http://localhost"), {
        params: Promise.resolve({ id: "op_resolved" }),
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error:
          "An officer marked this operation resolved in Xero; it is treated as done and is never re-run.",
      });
      expect(mocks.processQueuedXeroOperationRetries).not.toHaveBeenCalled();
      expect(mocks.logAudit).not.toHaveBeenCalled();
    }
  );

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
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "XERO_OPERATIONS_RESET_STALE_RUNNING",
        category: "xero",
        details: "Reset 3 stale RUNNING Xero operations to FAILED",
      }),
      txClient,
    );
  });

  it("leaves stale operations RUNNING when the bulk reset's audit cannot be written (#3462)", async () => {
    const row: Record<string, unknown> = { status: "RUNNING" };
    simulateRollback(row);
    mocks.xeroOperationUpdateMany.mockImplementation(async ({ data }: { data: { status: string } }) => {
      row.status = data.status;
      return { count: 1 };
    });
    mocks.createAuditLog.mockRejectedValue(new Error("audit insert failed"));

    const response = await resetStaleRunning();

    expect(response.status).toBe(500);
    expect(row.status).toBe("RUNNING");
    expect(mocks.xeroOperationUpdateMany).toHaveBeenCalled();
    expect(mocks.bareClientWrite).not.toHaveBeenCalled();
  });

  it("writes no audit row when no operation was stale", async () => {
    mocks.xeroOperationUpdateMany.mockResolvedValue({ count: 0 });

    const response = await resetStaleRunning();

    expect(response.status).toBe(200);
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  describe("Mark failed on one stale running operation (#3462)", () => {
    // Past the real threshold (now is frozen at 2026-07-01, so 15 minutes
    // before it).
    const stuckSince = new Date("2025-12-31T00:00:00.000Z");
    const stuckRow = {
      id: "op_stuck",
      status: "RUNNING",
      startedAt: stuckSince,
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: "pay_1",
      lastErrorCode: null,
      lastErrorMessage: "Matched Xero contact is already linked to another member",
    };
    const markRequest = (body: unknown = { reason: "Stuck after a requeue" }) =>
      new NextRequest("http://localhost/api/admin/xero/operations/op_stuck/mark-failed", {
        method: "POST",
        body: JSON.stringify(body),
      });
    const params = { params: Promise.resolve({ id: "op_stuck" }) };

    it("marks the row FAILED through a write guarded on the claim it read, and audits it", async () => {
      mocks.xeroOperationFindUnique.mockResolvedValue(stuckRow);
      mocks.xeroOperationUpdateMany.mockResolvedValue({ count: 1 });

      const response = await markFailedOperation(markRequest(), params);

      expect(response.status).toBe(200);
      expect(mocks.xeroOperationUpdateMany).toHaveBeenCalledWith({
        where: {
          id: "op_stuck",
          status: "RUNNING",
          // The real threshold: the helper reads its own module's filter.
          startedAt: { equals: stuckSince, lt: new Date("2026-06-30T23:45:00.000Z") },
        },
        data: {
          status: "FAILED",
          lastErrorCode: "ORPHANED_STALE_RUNNING",
          lastErrorMessage:
            "Operation was stuck RUNNING past the staleness threshold and was marked FAILED by an operator. The last error recorded before it stuck: Matched Xero contact is already linked to another member",
          completedAt: new Date("2026-07-01T00:00:00.000Z"),
        },
      });
      expect(mocks.createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "xero.operation.marked_failed",
          category: "xero",
          memberId: "admin-1",
          targetId: "op_stuck",
          details: "Stuck after a requeue",
          metadata: expect.objectContaining({
            startedAt: stuckSince.toISOString(),
            previousErrorMessage: stuckRow.lastErrorMessage,
          }),
        }),
        txClient,
      );
    });

    it("leaves the row RUNNING and answers 500 when the audit row cannot be written", async () => {
      const row: Record<string, unknown> = { status: "RUNNING" };
      simulateRollback(row);
      mocks.xeroOperationFindUnique.mockResolvedValue(stuckRow);
      mocks.xeroOperationUpdateMany.mockImplementation(async ({ data }: { data: { status: string } }) => {
        row.status = data.status;
        return { count: 1 };
      });
      mocks.createAuditLog.mockRejectedValue(new Error("audit insert failed"));

      const response = await markFailedOperation(markRequest(), params);

      expect(response.status).toBe(500);
      expect(mocks.xeroOperationUpdateMany).toHaveBeenCalled();
      expect(mocks.bareClientWrite).not.toHaveBeenCalled();
      expect(row.status).toBe("RUNNING");
    });

    const markedMessage =
      "Operation was stuck RUNNING past the staleness threshold and was marked FAILED by an operator.";
    const cause = "Matched Xero contact is already linked to another member";
    it.each([
      [
        "an earlier Mark failed that carried a cause",
        `${markedMessage} The last error recorded before it stuck: ${cause}`,
        `${markedMessage} The last error recorded before it stuck: ${cause}`,
      ],
      [
        "an earlier Mark failed nested before this fix",
        `${markedMessage} The last error recorded before it stuck: ${markedMessage} The last error recorded before it stuck: ${cause}`,
        `${markedMessage} The last error recorded before it stuck: ${cause}`,
      ],
      [
        "an earlier bulk reset, which carried no cause",
        "Operation was stuck RUNNING past the staleness threshold and was reset to FAILED by an operator.",
        markedMessage,
      ],
    ])("does not nest the carried error when the row was stuck after %s", async (_case, previous, expected) => {
      mocks.xeroOperationFindUnique.mockResolvedValue({
        ...stuckRow,
        lastErrorCode: "ORPHANED_STALE_RUNNING",
        lastErrorMessage: previous,
      });
      mocks.xeroOperationUpdateMany.mockResolvedValue({ count: 1 });

      const response = await markFailedOperation(markRequest(), params);

      expect(response.status).toBe(200);
      expect(mocks.xeroOperationUpdateMany.mock.calls[0][0].data.lastErrorMessage).toBe(expected);
    });

    it("refuses a RUNNING row that is not stale yet, writing and auditing nothing", async () => {
      mocks.xeroOperationFindUnique.mockResolvedValue({
        ...stuckRow,
        startedAt: new Date("2026-06-30T23:55:00.000Z"),
      });

      const response = await markFailedOperation(markRequest(), params);

      expect(response.status).toBe(409);
      expect(mocks.xeroOperationUpdateMany).not.toHaveBeenCalled();
      expect(mocks.createAuditLog).not.toHaveBeenCalled();
    });

    it("answers 409 and audits nothing when the run completed between the read and the write", async () => {
      mocks.xeroOperationFindUnique
        .mockResolvedValueOnce(stuckRow)
        .mockResolvedValueOnce({ status: "SUCCEEDED" });
      mocks.xeroOperationUpdateMany.mockResolvedValue({ count: 0 });

      const response = await markFailedOperation(markRequest(), params);

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining("SUCCEEDED"),
      });
      expect(mocks.createAuditLog).not.toHaveBeenCalled();
    });

    it("refuses a row that is not RUNNING at all", async () => {
      mocks.xeroOperationFindUnique.mockResolvedValue({ ...stuckRow, status: "FAILED" });

      const response = await markFailedOperation(markRequest(), params);

      expect(response.status).toBe(409);
      expect(mocks.xeroOperationUpdateMany).not.toHaveBeenCalled();
    });

    it("answers 404 for an unknown operation and 400 without a reason", async () => {
      mocks.xeroOperationFindUnique.mockResolvedValue(null);
      expect((await markFailedOperation(markRequest(), params)).status).toBe(404);
      expect((await markFailedOperation(markRequest({}), params)).status).toBe(400);
      expect(mocks.xeroOperationUpdateMany).not.toHaveBeenCalled();
    });

    it("flags a stale RUNNING row in the operations list so the panel offers Mark failed", async () => {
      const createdAt = new Date("2025-12-30T00:00:00.000Z");
      mocks.xeroOperationFindMany.mockResolvedValue([
        { ...stuckRow, direction: "OUTBOUND", replayable: true, requestPayload: {}, responsePayload: null, createdAt, updatedAt: createdAt },
        { ...stuckRow, id: "op_fresh", startedAt: new Date("2026-06-30T23:55:00.000Z"), direction: "OUTBOUND", replayable: true, requestPayload: {}, responsePayload: null, createdAt, updatedAt: createdAt },
        // Completing a row never clears its startedAt, so an old finished row
        // has the stuck row's timestamp - only its status says it is not stuck.
        { ...stuckRow, id: "op_done", status: "SUCCEEDED", direction: "OUTBOUND", replayable: true, requestPayload: {}, responsePayload: null, createdAt, updatedAt: createdAt },
      ]);
      mocks.xeroOperationCount.mockResolvedValue(3);

      const response = await listOperations(
        new NextRequest("http://localhost/api/admin/xero/operations?status=RUNNING")
      );

      await expect(response.json()).resolves.toMatchObject({
        data: [
          { id: "op_stuck", staleRunning: true },
          { id: "op_fresh", staleRunning: false },
          { id: "op_done", staleRunning: false },
        ],
      });
    });
  });
});
