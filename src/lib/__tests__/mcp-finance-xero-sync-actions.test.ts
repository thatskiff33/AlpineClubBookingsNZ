/**
 * ALP-721 (`INV-MCP-006`): the Finance area's Xero sync actions, each held to
 * the contract it exposes (`expectActionContract`):
 *
 * - the connection is answered with exactly the action's `returns` fields, so
 *   a field the Xero screen reads but the action does not name (an email
 *   address, a Xero object id or link, a request payload, an idempotency key)
 *   never reaches the AI provider;
 * - the browser's answer is unchanged;
 * - the request the catalogue builds is the one the route accepts, and the
 *   service each route calls is handed what the app sent.
 *
 * The route's own guard is stubbed to admit a finance officer: who may call
 * each route is the route map's and the guard's job, tested with them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class XeroOperationRetryError extends Error {
    constructor(message: string, readonly status = 400) {
      super(message);
    }
  }
  class XeroInboundReplayError extends Error {
    constructor(message: string, readonly status = 400) {
      super(message);
    }
  }
  class XeroSyncNowError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
    }
  }
  class XeroContactValidationError extends Error {
    constructor(readonly missingFields: string[]) {
      super("missing");
    }
  }
  return {
    XeroOperationRetryError,
    XeroInboundReplayError,
    XeroSyncNowError,
    XeroContactValidationError,
    requireAdmin: vi.fn(),
    listOpenXeroTaxOverrideMismatches: vi.fn(),
    clearXeroTaxOverridePause: vi.fn(),
    logAudit: vi.fn(),
    createAuditLog: vi.fn(),
    transaction: vi.fn(),
    operationFindMany: vi.fn(),
    operationCount: vi.fn(),
    operationFindUnique: vi.fn(),
    operationUpdateMany: vi.fn(),
    inboundFindMany: vi.fn(),
    inboundCount: vi.fn(),
    memberFindMany: vi.fn(),
    bookingFindMany: vi.fn(),
    getXeroConnectionStatus: vi.fn(),
    getXeroFeatureFlags: vi.fn(),
    probeXeroConnectionHealth: vi.fn(),
    getXeroAdminHealthSnapshot: vi.fn(),
    getTodaysXeroUsageSummary: vi.fn(),
    resolveFailedXeroOperationStates: vi.fn(),
    getFailedXeroOperationOverview: vi.fn(),
    getXeroOperationRetryMeta: vi.fn(),
    enqueueXeroSyncOperationRetry: vi.fn(),
    processQueuedXeroOperationRetries: vi.fn(),
    markStaleRunningXeroOperationFailed: vi.fn(),
    writeStaleRunningXeroOperationReset: vi.fn(),
    findSupersededRefundNoteRowIds: vi.fn(),
    claimResolvedInXeroMark: vi.fn(),
    findRetryOverlappingMark: vi.fn(),
    resolvePrecheckRefusal: vi.fn(),
    refundNoteResolveShape: vi.fn(),
    resolveCreditNotePrompt: vi.fn(),
    replayStoredXeroInboundEvent: vi.fn(),
    getXeroRecordActivity: vi.fn(),
    syncMemberFromXeroNow: vi.fn(),
    syncBookingFromXeroNow: vi.fn(),
    syncClubFromXeroNow: vi.fn(),
    syncContactsFromXero: vi.fn(),
    refreshAllMembershipStatuses: vi.fn(),
    checkMembershipStatus: vi.fn(),
    findOrCreateXeroContact: vi.fn(),
    enqueueXeroBookingInvoiceOperation: vi.fn(),
    processQueuedXeroOutboxOperations: vi.fn(),
    backfillHistoricalXeroObjectLinks: vi.fn(),
    cleanupStaleCanonicalXeroObjectLinks: vi.fn(),
  };
});

const tx = {
  xeroSyncOperation: { updateMany: h.operationUpdateMany },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: h.transaction,
    xeroSyncOperation: {
      findMany: h.operationFindMany,
      count: h.operationCount,
      findUnique: h.operationFindUnique,
      updateMany: h.operationUpdateMany,
    },
    xeroInboundEvent: { findMany: h.inboundFindMany, count: h.inboundCount },
    xeroObjectLink: { findMany: vi.fn(async () => []) },
    member: { findMany: h.memberFindMany },
    booking: { findMany: h.bookingFindMany },
  },
}));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
// The real pause sentence, so the test sees what the route sends.
vi.mock("@/lib/xero-tax-override-safeguard", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-tax-override-safeguard")),
  listOpenXeroTaxOverrideMismatches: h.listOpenXeroTaxOverrideMismatches,
  clearXeroTaxOverridePause: h.clearXeroTaxOverridePause,
}));
vi.mock("@/lib/audit", () => ({ logAudit: h.logAudit, createAuditLog: h.createAuditLog }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/club-format-server", () => ({ clubFormatValues: vi.fn(async () => ({})) }));
vi.mock("@/lib/club-time/server", () => ({ clubTimeZone: vi.fn(async () => "Pacific/Auckland") }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ success: true })),
  rateLimitedResponse: vi.fn(),
}));
vi.mock("@/lib/xero-link-short-code", () => ({ getXeroOrgShortCode: vi.fn(async () => null) }));
vi.mock("@/lib/xero-token-store", () => ({ getXeroConnectionStatus: h.getXeroConnectionStatus }));
vi.mock("@/lib/xero-feature-flags", () => ({ getXeroFeatureFlags: h.getXeroFeatureFlags }));
vi.mock("@/lib/xero-connection-probe", () => ({ probeXeroConnectionHealth: h.probeXeroConnectionHealth }));
vi.mock("@/lib/xero-admin-health", () => ({ getXeroAdminHealthSnapshot: h.getXeroAdminHealthSnapshot }));
vi.mock("@/lib/xero-api-usage", () => ({ getTodaysXeroUsageSummary: h.getTodaysXeroUsageSummary }));
vi.mock("@/lib/xero-admin-failures", () => ({
  resolveFailedXeroOperationStates: h.resolveFailedXeroOperationStates,
  getFailedXeroOperationOverview: h.getFailedXeroOperationOverview,
}));
vi.mock("@/lib/xero-operation-retry", () => ({
  XeroOperationRetryError: h.XeroOperationRetryError,
  getXeroOperationRetryMeta: h.getXeroOperationRetryMeta,
}));
vi.mock("@/lib/xero-operation-queue", () => ({
  enqueueXeroSyncOperationRetry: h.enqueueXeroSyncOperationRetry,
  processQueuedXeroOperationRetries: h.processQueuedXeroOperationRetries,
}));
vi.mock("@/lib/xero-stale-operations", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-stale-operations")),
  markStaleRunningXeroOperationFailed: h.markStaleRunningXeroOperationFailed,
  writeStaleRunningXeroOperationReset: h.writeStaleRunningXeroOperationReset,
}));
vi.mock("@/lib/xero-operation-resolve-guards", () => ({
  findSupersededRefundNoteRowIds: h.findSupersededRefundNoteRowIds,
  claimResolvedInXeroMark: h.claimResolvedInXeroMark,
  findRetryOverlappingMark: h.findRetryOverlappingMark,
  resolvePrecheckRefusal: h.resolvePrecheckRefusal,
  retryRunningRefusal: vi.fn(() => "running"),
  withdrawResolvedInXeroMark: vi.fn(),
}));
vi.mock("@/lib/xero-resolve-refund-note", () => ({
  refundNoteResolveShape: h.refundNoteResolveShape,
  resolveCreditNotePrompt: h.resolveCreditNotePrompt,
  answerExistingResolveMark: vi.fn(),
  resolveRecordingRefundNote: vi.fn(),
  withdrawRecordedNoteOrAlert: vi.fn(),
}));
vi.mock("@/lib/bank-refund-void-answer", () => ({ reconcileHandMadeNoteAfterRecording: vi.fn() }));
vi.mock("@/lib/xero-inbound-reconciliation", () => ({
  replayStoredXeroInboundEvent: h.replayStoredXeroInboundEvent,
  XeroInboundReplayError: h.XeroInboundReplayError,
}));
vi.mock("@/lib/xero-record-activity", () => ({ getXeroRecordActivity: h.getXeroRecordActivity }));
vi.mock("@/lib/xero-sync-now", () => ({
  syncMemberFromXeroNow: h.syncMemberFromXeroNow,
  syncBookingFromXeroNow: h.syncBookingFromXeroNow,
  syncClubFromXeroNow: h.syncClubFromXeroNow,
  XeroSyncNowError: h.XeroSyncNowError,
}));
// The real change-to-field mapping, so the test sees what the route sends.
vi.mock("@/lib/xero-bulk-contact-sync", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-bulk-contact-sync")),
  syncContactsFromXero: h.syncContactsFromXero,
}));
vi.mock("@/lib/xero-membership-sync", () => ({
  refreshAllMembershipStatuses: h.refreshAllMembershipStatuses,
  checkMembershipStatus: h.checkMembershipStatus,
}));
vi.mock("@/lib/xero-contacts", () => ({
  findOrCreateXeroContact: h.findOrCreateXeroContact,
  XeroContactValidationError: h.XeroContactValidationError,
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: h.enqueueXeroBookingInvoiceOperation,
  processQueuedXeroOutboxOperations: h.processQueuedXeroOutboxOperations,
}));
vi.mock("@/lib/xero-hardening", () => ({
  backfillHistoricalXeroObjectLinks: h.backfillHistoricalXeroObjectLinks,
  cleanupStaleCanonicalXeroObjectLinks: h.cleanupStaleCanonicalXeroObjectLinks,
}));

import { GET as getHealth } from "@/app/api/admin/xero/health/route";
import { POST as replayInboundEvent } from "@/app/api/admin/xero/inbound-events/[id]/replay/route";
import { GET as listInboundEvents } from "@/app/api/admin/xero/inbound-events/route";
import { POST as forceSync } from "@/app/api/admin/xero/force-sync/route";
import { POST as runLinkMaintenance } from "@/app/api/admin/xero/link-maintenance/route";
import { POST as markFailed } from "@/app/api/admin/xero/operations/[id]/mark-failed/route";
import { POST as markNonReplayable } from "@/app/api/admin/xero/operations/[id]/mark-non-replayable/route";
import { POST as requeueOperation } from "@/app/api/admin/xero/operations/[id]/requeue/route";
import { POST as resolveOperation } from "@/app/api/admin/xero/operations/[id]/resolve/route";
import { POST as retryOperation } from "@/app/api/admin/xero/operations/[id]/retry/route";
import { POST as resetStaleRunning } from "@/app/api/admin/xero/operations/reset-stale-running/route";
import { POST as retryAll } from "@/app/api/admin/xero/operations/retry-all/route";
import { GET as listOperations } from "@/app/api/admin/xero/operations/route";
import { GET as getRecordActivity } from "@/app/api/admin/xero/records/[localModel]/[localId]/route";
import { GET as getStatus } from "@/app/api/admin/xero/status/route";
import { POST as syncContacts } from "@/app/api/admin/xero/sync-contacts/route";
import { POST as syncMemberships } from "@/app/api/admin/xero/sync-memberships/route";
import { POST as syncNow } from "@/app/api/admin/xero/sync-now/route";
import { GET as getUsage } from "@/app/api/admin/xero/usage/route";
import { GET as listTaxOverrides } from "@/app/api/admin/xero/tax-override-pause/route";
import { POST as resumeTaxOverrides } from "@/app/api/admin/xero/tax-override-pause/clear/route";
import { expectActionContract } from "@/lib/__tests__/helpers/mcp-action-contract";
import { adminSession } from "@/lib/__tests__/helpers/sessions";
import { findMcpAction, mcpActionInputSchema } from "@/lib/mcp/catalogue";

const financeOfficer = adminSession({ id: "treasurer-1", accessRoles: ["USER", "FINANCE_ADMIN"] });

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({ ok: true, session: financeOfficer });
  h.transaction.mockImplementation(async (run: (client: typeof tx) => Promise<unknown>) => run(tx));
  h.createAuditLog.mockResolvedValue(undefined);
});

/** Withheld values every fixture carries somewhere: none may reach a connection. */
const WITHHELD = /aroha@example\.org|xero-obj-uuid|xero-contact-uuid|xero-inv-uuid|tenant-uuid|idem-secret|corr-secret|root-secret|link-secret/;

describe("get_xero_connection_status", () => {
  it("answers with the connection state and the live check, never the Xero tenant id", async () => {
    h.getXeroConnectionStatus.mockResolvedValue({
      connected: true,
      needsReentry: false,
      reentryCause: "tokens-unreadable",
      tenantId: "tenant-uuid",
      tokenExpiresAt: "2026-07-01T00:30:00.000Z",
    });
    h.getXeroFeatureFlags.mockReturnValue({
      dailyMembershipRefresh: true,
      liveMemberGroupLookups: false,
      autoLoadContactGroups: true,
    });
    h.probeXeroConnectionHealth.mockResolvedValue({
      tokenHealth: "ok",
      checkedAt: "2026-07-01T00:00:00.000Z",
      lastErrorMessage: null,
      cached: false,
    });
    const { connection, browser } = await expectActionContract({
      actionId: "get_xero_connection_status",
      handler: getStatus,
      args: { probe: "1" },
    });
    expect(JSON.stringify(connection)).not.toMatch(WITHHELD);
    expect(browser).toEqual(expect.objectContaining({ tenantId: "tenant-uuid", probe: expect.any(Object) }));
    // `probe: "1"` reached the route as the live check, once per run.
    expect(h.probeXeroConnectionHealth).toHaveBeenCalledTimes(2);
  });
});

describe("get_xero_sync_health", () => {
  it("answers with the health counts, not the screen's links", async () => {
    const snapshot = {
      webhookHealth: { connected: true, silent: false, hours: 24, lastReceivedAt: "2026-06-30T23:00:00.000Z" },
      unlinkedMembers: { count: 4, href: "/admin/members?xeroLinked=false&secret=link-secret" },
      failedOperations: { count: 2, legacyCount: 1 },
      pendingOperations: { count: 3 },
      staleRunningOperations: { count: 0, thresholdMinutes: 15 },
      staleProcessingInboundEvents: { count: 0, thresholdMinutes: 10 },
      lastMembershipRefresh: { at: null, lastCronStatus: "SUCCEEDED", lastCronStartedAt: "2026-06-30T14:00:00.000Z" },
      missingInvoices: { count: 1 },
      refundsMissingCreditNotes: { count: 0, graceHours: 24 },
      contactGroupMismatches: { count: 3, resyncCount: 2, reviewByHandCount: 1, cacheReady: true },
      contactLinkMismatches: { count: 0, cacheReady: true },
      creditNotesSpentOutsideApp: { count: 0 },
      taxTreatment: { checked: true, problems: ["GST rate differs"] },
      apiBudget: { status: "healthy", usagePercent: 0.1, totalCalls: 500, failedCalls: 2 },
    };
    h.getXeroAdminHealthSnapshot.mockResolvedValue(snapshot);
    const { connection, browser } = await expectActionContract({ actionId: "get_xero_sync_health", handler: getHealth });
    expect(JSON.stringify(connection)).not.toMatch(WITHHELD);
    expect(browser).toEqual(snapshot);
  });
});

describe("get_xero_api_usage", () => {
  it("answers with today's usage, without the usage rows' ids", async () => {
    const failure = {
      id: "usage-row-secret",
      operation: "getInvoice",
      workflow: "syncFromXeroNow",
      resourceType: "INVOICE",
      rateLimitCategory: "day",
      statusCode: 429,
      errorMessage: "Daily limit reached",
      createdAt: "2026-06-30T23:00:00.000Z",
    };
    const bucket = { label: "getInvoice", count: 10, successCount: 9, failureCount: 1 };
    const summary = {
      budget: { limit: 5000, thresholds: [{ fraction: 0.8, callCount: 4000 }] },
      today: {
        usageDate: "2026-07-01T00:00:00.000Z",
        totalCalls: 10,
        successfulCalls: 9,
        failedCalls: 1,
        dayRateLimitHits: 1,
        minuteRateLimitHits: 0,
        lastRateLimitCategory: "day",
        lastRateLimitAt: "2026-06-30T23:00:00.000Z",
        usagePercent: 0.002,
        budgetStatus: "healthy",
      },
      byOperation: [bucket],
      topWorkflows: [bucket],
      recentFailures: [failure],
      lastDailyLimitEvent: { ...failure, durationMs: 120, usageDate: "2026-07-01T00:00:00.000Z" },
    };
    h.getTodaysXeroUsageSummary.mockResolvedValue(summary);
    const { connection, browser } = await expectActionContract({ actionId: "get_xero_api_usage", handler: getUsage });
    expect(JSON.stringify(connection)).not.toMatch(/usage-row-secret/);
    expect(browser).toEqual(summary);
  });
});

const OPERATION_ROW = {
  id: "op-1",
  direction: "OUTBOUND",
  entityType: "INVOICE",
  operationType: "CREATE",
  localModel: "Payment",
  localId: "pay-1",
  status: "FAILED",
  idempotencyKey: "idem-secret",
  correlationKey: "corr-secret",
  attemptCount: 2,
  replayable: true,
  lastErrorCode: "VALIDATION",
  lastErrorMessage: "Account code missing",
  requestPayload: { contact: { email: "aroha@example.org" } },
  queueType: "BOOKING_INVOICE",
  invoiceEmailDelivery: "SEND",
  responsePayload: { raw: true },
  xeroObjectType: "INVOICE",
  xeroObjectId: "xero-obj-uuid",
  xeroObjectNumber: "INV-0042",
  xeroObjectUrl: "https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=xero-obj-uuid",
  createdByMemberId: "member-creator",
  startedAt: new Date("2026-06-30T20:00:00.000Z"),
  completedAt: new Date("2026-06-30T20:00:05.000Z"),
  manuallyResolvedAt: null,
  manuallyResolvedReason: null,
  manuallyResolvedById: null,
  createdAt: new Date("2026-06-30T20:00:00.000Z"),
  updatedAt: new Date("2026-06-30T20:00:05.000Z"),
};

describe("list_xero_operations", () => {
  it("answers with the queue rows an officer acts on, never payloads, keys or Xero ids", async () => {
    h.operationFindMany.mockResolvedValue([OPERATION_ROW]);
    h.operationCount.mockResolvedValue(1);
    h.resolveFailedXeroOperationStates.mockResolvedValue(
      new Map([["op-1", { state: "ACTIVE", reason: "Latest attempt failed", rootKey: "root-secret" }]]),
    );
    h.getXeroOperationRetryMeta.mockReturnValue({ supported: true, reason: null });
    h.findSupersededRefundNoteRowIds.mockResolvedValue(new Set());
    h.refundNoteResolveShape.mockReturnValue({ kind: "other" });
    h.resolveCreditNotePrompt.mockReturnValue({
      resolveAsksCreditNoteNumber: false,
      resolveCreditNoteAmountCents: 1_250,
      resolveRefusal: null,
    });
    const { connection, browser } = await expectActionContract({
      actionId: "list_xero_operations",
      handler: listOperations,
      args: { status: "FAILED", createdFrom: "2026-06-01", page: 1 },
    });
    expect(JSON.stringify(connection)).not.toMatch(WITHHELD);
    expect(browser).toEqual(
      expect.objectContaining({
        data: [expect.objectContaining({ requestPayload: OPERATION_ROW.requestPayload, xeroObjectId: "xero-obj-uuid" })],
        total: 1,
      }),
    );
    // The filters and the club-day bound reach the query: 1 June in Auckland
    // (NZST) starts at 12:00 UTC on 31 May, not at UTC midnight.
    expect(h.operationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "FAILED",
          createdAt: { gte: new Date("2026-05-31T12:00:00.000Z") },
        }),
      }),
    );
  });
});

describe("retry_xero_operation and requeue_xero_operation", () => {
  it.each([
    ["retry_xero_operation", retryOperation],
    ["requeue_xero_operation", requeueOperation],
  ] as const)("%s queues the operation the app named", async (actionId, handler) => {
    h.enqueueXeroSyncOperationRetry.mockResolvedValue({ queueOperationId: "queue-1", message: "Queued for retry." });
    h.processQueuedXeroOperationRetries.mockResolvedValue({});
    const { connection, browser } = await expectActionContract({ actionId, handler, args: { id: "op-1" } });
    expect(connection).toEqual({ ok: true, message: "Queued for retry.", queueOperationId: "queue-1" });
    expect(browser).toEqual(connection);
    expect(h.enqueueXeroSyncOperationRetry).toHaveBeenCalledWith("op-1", { createdByMemberId: "treasurer-1" });
  });
});

describe("mark_xero_operation_failed", () => {
  it("marks the named operation and audits the officer's reason", async () => {
    const operation = {
      id: "op-1",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: "pay-1",
      startedAt: new Date("2026-06-30T20:00:00.000Z"),
      previousErrorCode: null,
      previousErrorMessage: null,
    };
    h.markStaleRunningXeroOperationFailed.mockImplementation(
      async (_id: string, audit: (client: unknown, row: typeof operation) => Promise<unknown>) => {
        await audit(tx, operation);
        return { outcome: "marked", operation, returnedTo: "FAILED" };
      },
    );
    const { connection, browser } = await expectActionContract({
      actionId: "mark_xero_operation_failed",
      handler: markFailed,
      args: { id: "op-1", reason: "Worker died mid-run" },
    });
    expect(connection).toEqual({ ok: true, message: expect.stringContaining("marked failed") });
    expect(browser).toEqual(connection);
    expect(h.markStaleRunningXeroOperationFailed).toHaveBeenCalledWith("op-1", expect.any(Function));
    expect(h.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ details: "Worker died mid-run" }), tx);
  });

  it("refuses a reason shorter than the route accepts before the route sees it", () => {
    const schema = mcpActionInputSchema(findMcpAction("mark_xero_operation_failed")!);
    expect(schema.safeParse({ id: "op-1", reason: "no" }).success).toBe(false);
  });
});

describe("mark_xero_operation_non_replayable", () => {
  it("flags the named operation under the status guard and audits the reason", async () => {
    h.operationFindUnique.mockResolvedValue(OPERATION_ROW);
    h.getXeroOperationRetryMeta.mockReturnValue({ supported: true, reason: null });
    h.operationUpdateMany.mockResolvedValue({ count: 1 });
    const { connection, browser } = await expectActionContract({
      actionId: "mark_xero_operation_non_replayable",
      handler: markNonReplayable,
      args: { id: "op-1", reason: "Raised by hand in Xero" },
    });
    expect(connection).toEqual({ ok: true, message: "Xero operation marked non-replayable with an audit record." });
    expect(browser).toEqual(connection);
    expect(h.operationUpdateMany).toHaveBeenCalledWith({
      where: { id: "op-1", status: { in: ["FAILED", "PARTIAL"] } },
      data: { replayable: false },
    });
    expect(h.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ details: "Raised by hand in Xero" }), tx);
  });
});

describe("resolve_xero_operation", () => {
  it("claims the resolved-in-Xero mark for the named operation with the officer's reason", async () => {
    h.operationFindUnique.mockResolvedValue(OPERATION_ROW);
    h.refundNoteResolveShape.mockReturnValue({ kind: "other" });
    h.resolvePrecheckRefusal.mockResolvedValue(null);
    h.claimResolvedInXeroMark.mockResolvedValue(true);
    h.findRetryOverlappingMark.mockResolvedValue(null);
    const { connection, browser } = await expectActionContract({
      actionId: "resolve_xero_operation",
      handler: resolveOperation,
      args: { id: "op-1", reason: "Fixed in Xero by hand" },
    });
    expect(connection).toEqual({ ok: true, message: expect.stringContaining("marked resolved") });
    expect(browser).toEqual(connection);
    expect(h.claimResolvedInXeroMark).toHaveBeenCalledWith(
      expect.objectContaining({ id: "op-1", reason: "Fixed in Xero by hand", resolvedById: "treasurer-1" }),
    );
  });
});

describe("reset_stale_running_xero_operations", () => {
  it("answers with how many stuck rows were reset, and to what", async () => {
    h.writeStaleRunningXeroOperationReset.mockResolvedValue({ failed: 2, partial: 1 });
    const { connection, browser } = await expectActionContract({
      actionId: "reset_stale_running_xero_operations",
      handler: resetStaleRunning,
    });
    expect(connection).toEqual({ ok: true, count: 3, failed: 2, partial: 1, message: expect.stringContaining("Reset") });
    expect(browser).toEqual(connection);
  });
});

describe("retry_all_failed_xero_operations", () => {
  it("answers with what was queued and why each skipped row was skipped", async () => {
    h.getFailedXeroOperationOverview.mockResolvedValue({
      activeOperations: [
        { id: "op-1", replayable: true },
        { id: "op-2", replayable: true },
        { id: "op-3", replayable: false },
      ],
      legacyFailedCount: 4,
    });
    h.enqueueXeroSyncOperationRetry
      .mockResolvedValueOnce({ queueOperationId: "queue-1", message: "Queued." })
      .mockRejectedValueOnce(new h.XeroOperationRetryError("Resolved in Xero", 409))
      .mockResolvedValueOnce({ queueOperationId: "queue-2", message: "Queued." })
      .mockRejectedValueOnce(new h.XeroOperationRetryError("Resolved in Xero", 409));
    h.processQueuedXeroOperationRetries.mockResolvedValue({});
    const { connection, browser } = await expectActionContract({
      actionId: "retry_all_failed_xero_operations",
      handler: retryAll,
    });
    expect(connection).toEqual({
      ok: true,
      found: 2,
      queued: 1,
      skipped: 1,
      legacySkipped: 4,
      skippedOperations: [{ id: "op-2", reason: "Resolved in Xero" }],
      message: expect.stringContaining("Queued 1"),
    });
    expect(browser).toEqual(connection);
    // A row that cannot be replayed is never queued.
    expect(h.enqueueXeroSyncOperationRetry).not.toHaveBeenCalledWith("op-3", expect.anything());
  });
});

describe("list_xero_inbound_events", () => {
  it("answers with the events, never Xero's payload, resource id or correlation key", async () => {
    const event = {
      id: "evt-1",
      source: "webhook",
      eventCategory: "INVOICE",
      eventType: "UPDATE",
      resourceId: "xero-obj-uuid",
      eventCreatedAt: new Date("2026-06-30T22:00:00.000Z"),
      correlationKey: "corr-secret",
      payload: { Contact: { EmailAddress: "aroha@example.org" } },
      status: "FAILED",
      errorMessage: "Invoice not linked",
      processedAt: null,
      createdAt: new Date("2026-06-30T22:00:01.000Z"),
      updatedAt: new Date("2026-06-30T22:00:02.000Z"),
    };
    h.inboundFindMany.mockResolvedValue([event]);
    h.inboundCount.mockResolvedValue(1);
    const { connection, browser } = await expectActionContract({
      actionId: "list_xero_inbound_events",
      handler: listInboundEvents,
      args: { status: "FAILED", eventCategory: "INVOICE", pageSize: 10 },
    });
    expect(JSON.stringify(connection)).not.toMatch(WITHHELD);
    expect(browser).toEqual(
      expect.objectContaining({
        data: [expect.objectContaining({ payload: event.payload, resourceId: "xero-obj-uuid", canReplay: true })],
        pageSize: 10,
      }),
    );
    expect(h.inboundFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: "FAILED" }), take: 10 }),
    );
  });
});

describe("replay_xero_inbound_event", () => {
  it("replays the named event and answers with its counts and new status", async () => {
    h.replayStoredXeroInboundEvent.mockResolvedValue({
      result: { found: 1, processed: 1, succeeded: 1, failed: 0, skipped: 0 },
      event: { id: "evt-1", status: "PROCESSED", errorMessage: null, processedAt: "2026-07-01T00:00:00.000Z", correlationKey: "corr-secret" },
    });
    const { connection, browser } = await expectActionContract({
      actionId: "replay_xero_inbound_event",
      handler: replayInboundEvent,
      args: { id: "evt-1" },
    });
    expect(JSON.stringify(connection)).not.toMatch(WITHHELD);
    expect(browser).toEqual(expect.objectContaining({ replay: expect.objectContaining({ event: expect.objectContaining({ correlationKey: "corr-secret" }) }) }));
    expect(h.replayStoredXeroInboundEvent).toHaveBeenCalledWith("evt-1");
  });
});

describe("get_xero_record_activity", () => {
  const reference = { localModel: "Booking", localId: "booking-1", label: "Booking for Aroha Ngata", relation: "root", url: "/admin/bookings/booking-1" };
  const data = {
    rootRecord: reference,
    scopeRecords: [reference],
    relatedRecords: [{ ...reference, localModel: "Payment", localId: "pay-1", relation: "payment" }],
    summary: { totalOperations: 1, failedOperations: 1, pendingOperations: 0, partialOperations: 0, activeLinks: 1 },
    operations: [
      {
        ...OPERATION_ROW,
        localUrl: "/admin/bookings/booking-1",
        localLabel: "Payment",
        startedAt: "2026-06-30T20:00:00.000Z",
        completedAt: null,
        createdAt: "2026-06-30T20:00:00.000Z",
        updatedAt: "2026-06-30T20:00:05.000Z",
        supported: true,
        reason: null,
      },
    ],
    links: [
      {
        id: "link-secret-1",
        localModel: "Payment",
        localId: "pay-1",
        localUrl: "/admin/bookings/booking-1",
        localLabel: "Payment",
        xeroObjectType: "INVOICE",
        xeroObjectId: "xero-obj-uuid",
        xeroObjectNumber: "INV-0042",
        xeroObjectUrl: "https://go.xero.com/x?InvoiceID=xero-obj-uuid",
        role: "BOOKING_INVOICE",
        active: true,
        metadata: { contactEmail: "aroha@example.org" },
        createdAt: "2026-06-30T20:00:05.000Z",
        updatedAt: "2026-06-30T20:00:05.000Z",
      },
    ],
    inboundEvents: [
      {
        id: "evt-1",
        source: "webhook",
        eventCategory: "INVOICE",
        eventType: "UPDATE",
        resourceId: "xero-obj-uuid",
        correlationKey: "corr-secret",
        status: "PROCESSED",
        errorMessage: null,
        processedAt: "2026-06-30T22:00:03.000Z",
        createdAt: "2026-06-30T22:00:01.000Z",
        payload: { raw: "aroha@example.org" },
        xeroObjectUrl: null,
        canReplay: true,
      },
    ],
    backLink: { href: "/admin/bookings/booking-1", label: "Back to booking" },
  };

  it("answers with the record's operations, links and events, without Xero ids, payloads or keys", async () => {
    h.getXeroRecordActivity.mockResolvedValue(data);
    const { connection, browser } = await expectActionContract({
      actionId: "get_xero_record_activity",
      handler: getRecordActivity,
      args: { localModel: "Booking", localId: "booking-1" },
    });
    expect(JSON.stringify(connection)).not.toMatch(WITHHELD);
    expect(browser).toEqual({ data });
    expect(h.getXeroRecordActivity).toHaveBeenCalledWith("Booking", "booking-1", expect.anything(), 25);
  });

  it("offers only the local models the route accepts", () => {
    const schema = mcpActionInputSchema(findMcpAction("get_xero_record_activity")!);
    expect(schema.safeParse({ localModel: "Organisation", localId: "org-1" }).success).toBe(false);
    expect(schema.safeParse({ localModel: "MemberSubscription", localId: "sub-1" }).success).toBe(true);
  });
});

describe("sync-now actions", () => {
  const recordResult = { changed: 2, invoices: 3, creditNotes: 1, contactFields: 1, message: "Updated 2 financial record(s)." };

  it("sync_member_from_xero syncs the member the app named", async () => {
    h.syncMemberFromXeroNow.mockResolvedValue(recordResult);
    const { connection, browser } = await expectActionContract({
      actionId: "sync_member_from_xero",
      handler: syncNow,
      args: { id: "member-7" },
    });
    expect(connection).toEqual(recordResult);
    expect(browser).toEqual(recordResult);
    // The fixed scope decides the sync: a member id never runs a booking sync.
    expect(h.syncMemberFromXeroNow).toHaveBeenCalledWith("member-7");
    expect(h.syncBookingFromXeroNow).not.toHaveBeenCalled();
  });

  it("sync_booking_from_xero syncs the booking the app named", async () => {
    h.syncBookingFromXeroNow.mockResolvedValue({ ...recordResult, contactFields: 0 });
    await expectActionContract({ actionId: "sync_booking_from_xero", handler: syncNow, args: { id: "booking-1" } });
    expect(h.syncBookingFromXeroNow).toHaveBeenCalledWith("booking-1");
    expect(h.syncMemberFromXeroNow).not.toHaveBeenCalled();
  });

  it("sync_club_from_xero answers with the counts, not the run's raw result", async () => {
    const clubResult = {
      message: "Reconciled 1 event(s).",
      events: 1,
      records: 2,
      invoices: 3,
      writtenDown: 0,
      restored: 0,
      result: { inboundReconciliation: { contact: "aroha@example.org" } },
    };
    h.syncClubFromXeroNow.mockResolvedValue(clubResult);
    const { connection, browser } = await expectActionContract({ actionId: "sync_club_from_xero", handler: syncNow });
    expect(JSON.stringify(connection)).not.toMatch(WITHHELD);
    expect(browser).toEqual(clubResult);
    expect(h.syncClubFromXeroNow).toHaveBeenCalledTimes(2);
  });
});

describe("sync_xero_contacts", () => {
  it("answers with the report by name, never emails or Xero contact ids, and passes the repair flags", async () => {
    const report = {
      created: [{ name: "Aroha Ngata", email: "aroha@example.org", xeroContactId: "xero-contact-uuid", group: "Adults" }],
      updated: [
        {
          name: "Aroha Ngata",
          memberId: "member-7",
          xeroContactId: "xero-contact-uuid",
          changes: ["Phone set to +64 21 555 0199"],
        },
      ],
      skippedNoChanges: 5,
      skippedNameMismatch: [
        {
          memberId: "member-8",
          memberName: "Tama Ngata",
          memberEmail: "aroha@example.org",
          xeroContactId: "xero-contact-uuid",
          xeroContactName: "T Ngata",
          xeroContactEmail: "aroha@example.org",
          reasons: ["first name differs"],
        },
      ],
      skippedNoEmail: [{ name: "No Email", xeroContactId: "xero-contact-uuid" }],
      skippedOther: [{ name: "Archived", xeroContactId: "xero-contact-uuid", reason: "archived" }],
      errors: [{ name: "Broken", xeroContactId: "xero-contact-uuid", error: "Xero said no" }],
      total: 9,
    };
    h.syncContactsFromXero.mockResolvedValue(report);
    const { connection, browser } = await expectActionContract({
      actionId: "sync_xero_contacts",
      handler: syncContacts,
      args: { fullResync: true },
    });
    expect(JSON.stringify(connection)).not.toMatch(WITHHELD);
    // The screen's change lines carry the member's new phone number.
    expect(JSON.stringify(connection)).not.toContain("555 0199");
    expect(connection).toMatchObject({ syncReport: { updated: [{ changedFields: ["phone"] }] } });
    expect(browser).toEqual({ syncReport: report });
    expect(h.syncContactsFromXero).toHaveBeenCalledWith(
      expect.objectContaining({ fullResync: true, auditActorMemberId: "treasurer-1" }),
    );
  });
});

describe("sync_xero_memberships", () => {
  it("passes the season and mode, and drops member labels and Xero invoice ids", async () => {
    const result = {
      seasonYear: 2026,
      cursorFrom: null,
      cursorTo: "2026-07-01T00:00:00.000Z",
      changedInvoices: 1,
      changedInvoiceIds: ["xero-inv-uuid"],
      affectedMembers: 1,
      checked: 10,
      updated: 1,
      errors: 1,
      errorDetails: [{ member: "Aroha Ngata (aroha@example.org)", error: "Xero said no" }],
    };
    h.refreshAllMembershipStatuses.mockResolvedValue(result);
    const { connection, browser } = await expectActionContract({
      actionId: "sync_xero_memberships",
      handler: syncMemberships,
      args: { seasonYear: 2026, mode: "backfill" },
    });
    expect(JSON.stringify(connection)).not.toMatch(WITHHELD);
    expect(browser).toEqual({ ...result, mode: "backfill" });
    expect(h.refreshAllMembershipStatuses).toHaveBeenCalledWith(2026, { includeBackfillCandidates: true });
  });
});

describe("force-sync actions", () => {
  const member = { id: "member-7", firstName: "Aroha", lastName: "Ngata", email: "aroha@example.org" };

  it("force_sync_member_xero_contact syncs the named member's contact, without the email or Xero contact id", async () => {
    h.memberFindMany.mockResolvedValue([member]);
    h.findOrCreateXeroContact.mockResolvedValue("xero-contact-uuid");
    const { connection, browser } = await expectActionContract({
      actionId: "force_sync_member_xero_contact",
      handler: forceSync,
      args: { query: "member-7" },
    });
    expect(JSON.stringify(connection)).not.toMatch(WITHHELD);
    expect(browser).toEqual(expect.objectContaining({ memberEmail: member.email, xeroContactId: "xero-contact-uuid" }));
    expect(h.findOrCreateXeroContact).toHaveBeenCalledWith("member-7", {
      createdByMemberId: "treasurer-1",
      repairExistingLink: true,
    });
    // The fixed sync type decides the run: no membership refresh or invoice.
    expect(h.checkMembershipStatus).not.toHaveBeenCalled();
    expect(h.enqueueXeroBookingInvoiceOperation).not.toHaveBeenCalled();
  });

  it("force_refresh_member_xero_membership answers with the status, not the Xero invoice or its link", async () => {
    h.memberFindMany.mockResolvedValue([member]);
    h.checkMembershipStatus.mockResolvedValue({ status: "PAID", xeroInvoiceId: "xero-inv-uuid" });
    const { connection, browser } = await expectActionContract({
      actionId: "force_refresh_member_xero_membership",
      handler: forceSync,
      args: { query: "member-7" },
    });
    expect(JSON.stringify(connection)).not.toMatch(WITHHELD);
    expect(connection).toEqual(expect.objectContaining({ syncType: "MEMBERSHIP", status: "PAID", memberId: "member-7" }));
    expect(browser).toEqual(expect.objectContaining({ xeroInvoiceId: "xero-inv-uuid", xeroInvoiceUrl: expect.stringContaining("xero-inv-uuid") }));
    expect(h.checkMembershipStatus).toHaveBeenCalledWith("member-7", undefined, { forceRefreshOnlineInvoiceUrl: true });
  });

  it("force_sync_booking_xero_invoice queues the named paid booking's invoice", async () => {
    h.bookingFindMany.mockResolvedValue([
      { id: "booking-1", memberId: "member-7", status: "PAID", payment: { id: "pay-1", xeroInvoiceId: null } },
    ]);
    h.enqueueXeroBookingInvoiceOperation.mockResolvedValue({ queueOperationId: "queue-9", message: "Invoice queued." });
    h.processQueuedXeroOutboxOperations.mockResolvedValue({});
    const { connection, browser } = await expectActionContract({
      actionId: "force_sync_booking_xero_invoice",
      handler: forceSync,
      args: { query: "booking-1" },
    });
    expect(connection).toEqual({
      ok: true,
      syncType: "INVOICE",
      bookingId: "booking-1",
      queueOperationId: "queue-9",
      message: "Invoice queued.",
    });
    expect(browser).toEqual(connection);
    expect(h.enqueueXeroBookingInvoiceOperation).toHaveBeenCalledWith(
      "booking-1",
      expect.objectContaining({ createdByMemberId: "treasurer-1", overrideResolvedInXero: true }),
    );
  });
});

describe("run_xero_link_maintenance", () => {
  it("answers with the counts, never the link id lists", async () => {
    const category = { scanned: 3, existingLinks: 2, createdLinks: 1, existingOperations: 0, createdOperations: 1 };
    h.backfillHistoricalXeroObjectLinks.mockResolvedValue({
      completedAt: "2026-07-01T00:00:00.000Z",
      members: category,
      paymentInvoices: category,
      paymentRefundCreditNotes: category,
      subscriptionInvoices: category,
      totals: { scanned: 12, createdLinks: 4, createdOperations: 4 },
    });
    h.cleanupStaleCanonicalXeroObjectLinks.mockResolvedValue({
      completedAt: "2026-07-01T00:00:00.000Z",
      scannedActiveLinks: 20,
      keptActiveLinks: 18,
      deactivatedLinks: 2,
      preservedStripeRefundCreditNoteLinks: 1,
      cancelledRefundCreditNoteMirrors: 1,
      healedCancelledRefundCreditNoteMirrors: 1,
      pointedInactiveCancelledRefundNoteMirrors: 0,
      releasedInactiveRefundNotePointers: 0,
      deferredRefundNoteHealLinkIds: ["link-secret-deferred"],
      failedRefundNoteHealLinkIds: ["link-9"],
      byCategory: {
        memberContacts: 1,
        paymentInvoices: 1,
        paymentRefundCreditNotes: 0,
        subscriptionInvoices: 0,
        otherCanonicalLinks: 0,
      },
      deactivatedLinkIds: ["link-secret-1", "link-secret-2"],
    });
    const { connection, browser } = await expectActionContract({
      actionId: "run_xero_link_maintenance",
      handler: runLinkMaintenance,
    });
    expect(JSON.stringify(connection)).not.toMatch(WITHHELD);
    expect(connection).toEqual(expect.objectContaining({ ok: false, warning: expect.stringContaining("link-9") }));
    expect(browser).toEqual(
      expect.objectContaining({ cleanup: expect.objectContaining({ deactivatedLinkIds: ["link-secret-1", "link-secret-2"] }) }),
    );
  });
});

describe("GST overrides (#5208)", () => {
  const MISMATCH = {
    id: "mismatch-1",
    createdAt: new Date("2026-06-30T01:00:00.000Z"),
    bookingId: "booking-1",
    providerInvoiceId: "xero-inv-uuid",
    invoiceNumber: "INV-0042",
    documentKind: "CREATE" as const,
    lines: [{ index: 0, sentCents: 1_304, xeroCents: 1_300 }],
  };

  it("list_xero_tax_override_mismatches answers with the invoices in cents, never Xero's invoice id", async () => {
    h.listOpenXeroTaxOverrideMismatches.mockResolvedValue([MISMATCH]);
    const { connection, browser } = await expectActionContract({
      actionId: "list_xero_tax_override_mismatches",
      handler: listTaxOverrides,
    });
    expect(JSON.stringify(connection)).not.toMatch(WITHHELD);
    expect(connection).toMatchObject({
      invoices: [{ invoiceNumber: "INV-0042", lines: [{ sentCents: 1_304, xeroCents: 1_300 }] }],
    });
    expect((connection as { problem: string }).problem).toContain("1 invoice");
    expect(browser).toMatchObject({ invoices: [{ providerInvoiceId: "xero-inv-uuid" }] });
  });

  it("resume_xero_tax_overrides clears only the ids sent, with the officer's note, and is destructive", async () => {
    h.clearXeroTaxOverridePause.mockResolvedValue({ cleared: 1 });
    // One flagged after the officer looked stays listed, holding the pause.
    h.listOpenXeroTaxOverrideMismatches.mockResolvedValue([{ ...MISMATCH, id: "mismatch-2" }]);
    const { connection } = await expectActionContract({
      actionId: "resume_xero_tax_overrides",
      handler: resumeTaxOverrides,
      args: { ids: ["mismatch-1"], note: "Checked INV-0042 in Xero: rounding only.", confirmed: true },
    });
    expect(JSON.stringify(connection)).not.toMatch(WITHHELD);
    expect(connection).toMatchObject({ cleared: 1, invoices: [{ id: "mismatch-2" }] });
    expect(h.clearXeroTaxOverridePause).toHaveBeenCalledWith(
      "treasurer-1",
      ["mismatch-1"],
      "Checked INV-0042 in Xero: rounding only.",
    );
    expect(findMcpAction("resume_xero_tax_overrides")!.kind).toBe("destructive");
  });

  it("resume_xero_tax_overrides cannot be sent without the officer's confirmation", () => {
    const schema = mcpActionInputSchema(findMcpAction("resume_xero_tax_overrides")!);
    expect(schema.safeParse({ ids: ["mismatch-1"], note: "Checked." }).success).toBe(false);
    expect(schema.safeParse({ ids: ["mismatch-1"], note: "Checked.", confirmed: true }).success).toBe(true);
  });
});
