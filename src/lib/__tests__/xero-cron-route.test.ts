import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  refreshAllMembershipStatuses: vi.fn(),
  isXeroConnected: vi.fn(),
  processQueuedXeroOutboxOperations: vi.fn(),
  processQueuedXeroOperationRetries: vi.fn(),
  runXeroInboundReconciliationCycle: vi.fn(),
  backfillHistoricalXeroObjectLinks: vi.fn(),
  cleanupStaleCanonicalXeroObjectLinks: vi.fn(),
  runBankRefundVoidFollowUp: vi.fn(),
  sendXeroReconciliationReport: vi.fn(),
  reconcileXeroCreditSync: vi.fn(),
  runCreditNoteMirrorSweep: vi.fn(),
  isEffectiveModuleEnabled: vi.fn(),
  recordCronJobRunSafe: vi.fn(),
}));

// #1208: the cron runner imports these from the source domain modules
// directly (not the @/lib/xero facade), so the doubles mock those modules.
vi.mock("@/lib/xero-membership-sync", () => ({
  refreshAllMembershipStatuses: mocks.refreshAllMembershipStatuses,
}));

vi.mock("@/lib/xero-token-store", () => ({
  isXeroConnected: mocks.isXeroConnected,
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  processQueuedXeroOutboxOperations: mocks.processQueuedXeroOutboxOperations,
}));

vi.mock("@/lib/xero-operation-queue", () => ({
  processQueuedXeroOperationRetries: mocks.processQueuedXeroOperationRetries,
}));

vi.mock("@/lib/xero-inbound-reconciliation", () => ({
  runXeroInboundReconciliationCycle: mocks.runXeroInboundReconciliationCycle,
}));

// #4446: the inbound task also sweeps undelivered settlement alerts.
vi.mock("@/lib/xero-inbound/cash-settlement-alert-retry", () => ({
  retryCashSettlementAlerts: vi.fn(async () => 0),
}));

vi.mock("@/lib/xero-hardening", () => ({
  backfillHistoricalXeroObjectLinks: mocks.backfillHistoricalXeroObjectLinks,
  cleanupStaleCanonicalXeroObjectLinks: mocks.cleanupStaleCanonicalXeroObjectLinks,
  sendXeroReconciliationReport: mocks.sendXeroReconciliationReport,
}));

// #4162: the voided bank-transfer refund notes' follow-up, run after the cleanup.
vi.mock("@/lib/bank-refund-void-follow-up", () => ({
  runBankRefundVoidFollowUp: mocks.runBankRefundVoidFollowUp,
  bankRefundVoidFollowUpFailureMessage: (result: { counts?: { failed?: number } }) =>
    (result.counts?.failed ?? 0) > 0 ? "follow-up failed" : null,
}));

vi.mock("@/lib/xero-credit-sync-checker", () => ({
  reconcileXeroCreditSync: mocks.reconcileXeroCreditSync,
  XERO_CREDIT_SYNC_JOB_NAME: "xero-credit-sync-check",
}));

// #4270: the credit-note mirror's backstop sweep.
vi.mock("@/lib/xero-credit-note-mirror-sweep", () => ({
  runCreditNoteMirrorSweep: mocks.runCreditNoteMirrorSweep,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/admin-modules", () => ({
  isEffectiveModuleEnabled: mocks.isEffectiveModuleEnabled,
}));

vi.mock("@/lib/cron-job-run", () => ({
  recordCronJobRunSafe: mocks.recordCronJobRunSafe,
}));

import { POST } from "@/app/api/cron/xero/route";

function makeRequest(task: string) {
  return new NextRequest(`http://localhost/api/cron/xero?task=${task}`, {
    method: "POST",
    headers: {
      "x-cron-secret": "cron-secret",
    },
  });
}

describe("POST /api/cron/xero", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "cron-secret";
    delete process.env.XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH;
    mocks.isEffectiveModuleEnabled.mockResolvedValue(true);
  });

  it("skips cleanly when Admin Modules disables operational Xero", async () => {
    mocks.isEffectiveModuleEnabled.mockResolvedValue(false);

    const response = await POST(makeRequest("all"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      message: "Xero cron tasks skipped",
      task: "all",
      connected: false,
      skipped: true,
      reason: "Operational Xero effective module state is disabled",
      membershipRefresh: null,
      queuedOutboxOperations: null,
      queuedRetries: null,
      inboundReconciliation: null,
      linkBackfill: null,
      linkCleanup: null,
      bankRefundVoidFollowUp: null,
      reconciliationReport: null,
      creditSyncCheck: null,
      creditNoteMirror: null,
    });
    expect(mocks.isXeroConnected).not.toHaveBeenCalled();
    expect(mocks.refreshAllMembershipStatuses).not.toHaveBeenCalled();
    expect(mocks.recordCronJobRunSafe).toHaveBeenCalledTimes(10); // #4162: + the voided bank-transfer refund notes' follow-up; #4270: + the credit-note mirror
    expect(mocks.recordCronJobRunSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "xero-outbox",
        status: "SKIPPED",
      })
    );
  });

  it("runs the reconciliation report even when Xero is disconnected", async () => {
    mocks.isXeroConnected.mockResolvedValue(false);
    mocks.sendXeroReconciliationReport.mockResolvedValue({
      sent: true,
      report: {
        summary: {
          issueCategoryCount: 0,
          issueTotalCount: 0,
        },
      },
    });

    const response = await POST(makeRequest("report"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.connected).toBe(false);
    expect(body.membershipRefresh).toBeNull();
    expect(body.queuedOutboxOperations).toBeNull();
    expect(body.queuedRetries).toBeNull();
    expect(body.reconciliationReport).toEqual({
      sent: true,
      report: {
        summary: {
          issueCategoryCount: 0,
          issueTotalCount: 0,
        },
      },
    });
    expect(mocks.sendXeroReconciliationReport).toHaveBeenCalled();
    expect(mocks.recordCronJobRunSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "xero-reconciliation-report",
        status: "SUCCESS",
      })
    );
  });

  it("runs all Xero tasks together", async () => {
    process.env.XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH = "true";
    mocks.isXeroConnected.mockResolvedValue(true);
    mocks.refreshAllMembershipStatuses.mockResolvedValue({ checked: 4, errors: 0 });
    mocks.processQueuedXeroOutboxOperations.mockResolvedValue({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    mocks.processQueuedXeroOperationRetries.mockResolvedValue({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    mocks.runXeroInboundReconciliationCycle.mockResolvedValue({
      inbound: {
        batches: 1,
        found: 2,
        processed: 2,
        succeeded: 2,
        failed: 0,
        skipped: 0,
      },
      contactReconciliation: {
        cursorFrom: "2026-04-14T00:10:00.000Z",
        cursorTo: "2026-04-14T00:25:00.000Z",
        total: 2,
        created: 0,
        updated: 1,
        skippedNoChanges: 1,
        skippedNoEmail: 0,
        skippedOther: 0,
        errors: 0,
      },
      membershipReconciliation: {
        seasonYear: 2026,
        cursorFrom: "2026-04-14T00:00:00.000Z",
        cursorTo: "2026-04-14T00:05:00.000Z",
        changedInvoices: 1,
        changedInvoiceIds: ["inv_1"],
        affectedMembers: 1,
        checked: 1,
        updated: 1,
        errors: 0,
        errorDetails: [],
      },
      invoiceReconciliation: {
        processed: 1,
        succeeded: 1,
        failed: 0,
        errorDetails: [],
      },
    });
    mocks.backfillHistoricalXeroObjectLinks.mockResolvedValue({
      totals: {
        scanned: 4,
        createdLinks: 2,
        createdOperations: 2,
      },
    });
    mocks.cleanupStaleCanonicalXeroObjectLinks.mockResolvedValue({
      scannedActiveLinks: 5,
      deactivatedLinks: 1,
    });
    mocks.runBankRefundVoidFollowUp.mockResolvedValue({ mode: "report-only", scanned: 0, counts: { failed: 0 }, items: [] });
    mocks.sendXeroReconciliationReport.mockResolvedValue({
      sent: true,
      report: {
        summary: {
          issueCategoryCount: 1,
          issueTotalCount: 2,
        },
      },
    });
    mocks.reconcileXeroCreditSync.mockResolvedValue({
      skipped: false,
      scannedBookings: 3,
      checkedBookings: 3,
      deferredBookings: 0,
      driftBookings: 1,
      totalDriftCents: 1200,
      completePass: true,
      emailSent: true,
    });
    mocks.runCreditNoteMirrorSweep.mockResolvedValue({
      skipped: false,
      read: 2,
      writtenDown: 1,
      restored: 0,
      refused: { unsettled: 1 },
      readFailures: 0,
      completePass: true,
    });

    const response = await POST(makeRequest("all"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toBe("Xero cron tasks completed");
    expect(body.membershipRefresh).toEqual({ checked: 4, errors: 0 });
    expect(body.queuedOutboxOperations).toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    expect(body.queuedRetries).toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    expect(body.inboundReconciliation).toEqual({
      // #4446: the inbound task reports its settlement-alert sweep.
      settlementAlertCandidates: 0,
      inbound: {
        batches: 1,
        found: 2,
        processed: 2,
        succeeded: 2,
        failed: 0,
        skipped: 0,
      },
      contactReconciliation: {
        cursorFrom: "2026-04-14T00:10:00.000Z",
        cursorTo: "2026-04-14T00:25:00.000Z",
        total: 2,
        created: 0,
        updated: 1,
        skippedNoChanges: 1,
        skippedNoEmail: 0,
        skippedOther: 0,
        errors: 0,
      },
      membershipReconciliation: {
        seasonYear: 2026,
        cursorFrom: "2026-04-14T00:00:00.000Z",
        cursorTo: "2026-04-14T00:05:00.000Z",
        changedInvoices: 1,
        changedInvoiceIds: ["inv_1"],
        affectedMembers: 1,
        checked: 1,
        updated: 1,
        errors: 0,
        errorDetails: [],
      },
      invoiceReconciliation: {
        processed: 1,
        succeeded: 1,
        failed: 0,
        errorDetails: [],
      },
    });
    expect(body.linkBackfill).toEqual({
      totals: {
        scanned: 4,
        createdLinks: 2,
        createdOperations: 2,
      },
    });
    expect(body.linkCleanup).toEqual({
      scannedActiveLinks: 5,
      deactivatedLinks: 1,
    });
    expect(body.reconciliationReport).toEqual({
      sent: true,
      report: {
        summary: {
          issueCategoryCount: 1,
          issueTotalCount: 2,
        },
      },
    });
    expect(body.creditSyncCheck).toEqual({
      skipped: false,
      scannedBookings: 3,
      checkedBookings: 3,
      deferredBookings: 0,
      driftBookings: 1,
      totalDriftCents: 1200,
      completePass: true,
      emailSent: true,
    });
    expect(mocks.reconcileXeroCreditSync).toHaveBeenCalled();
    expect(mocks.recordCronJobRunSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "xero-credit-sync-check",
        status: "SUCCESS",
      })
    );
    expect(body.creditNoteMirror).toMatchObject({ read: 2, writtenDown: 1, completePass: true });
    expect(mocks.recordCronJobRunSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "xero-credit-note-outside-spend-mirror",
        status: "SUCCESS",
      })
    );
    expect(mocks.recordCronJobRunSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "xero-outbox",
        status: "SUCCESS",
      })
    );
    expect(mocks.recordCronJobRunSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "xero-link-cleanup",
        status: "SUCCESS",
      })
    );
  });

  it("skips membership refresh when the daily refresh flag is disabled", async () => {
    mocks.isXeroConnected.mockResolvedValue(true);

    const response = await POST(makeRequest("memberships"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.membershipRefresh).toEqual({
      skipped: true,
      reason: "Daily membership refresh disabled by XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH",
    });
    expect(mocks.refreshAllMembershipStatuses).not.toHaveBeenCalled();
    expect(mocks.recordCronJobRunSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "xero-membership-refresh",
        status: "SKIPPED",
      })
    );
  });

  it("runs inbound reconciliation on demand", async () => {
    mocks.isXeroConnected.mockResolvedValue(true);
    mocks.runXeroInboundReconciliationCycle.mockResolvedValue({
      inbound: {
        batches: 1,
        found: 3,
        processed: 3,
        succeeded: 2,
        failed: 1,
        skipped: 0,
      },
      contactReconciliation: {
        cursorFrom: "2026-04-14T00:10:00.000Z",
        cursorTo: null,
        total: 0,
        created: 0,
        updated: 0,
        skippedNoChanges: 0,
        skippedNoEmail: 0,
        skippedOther: 0,
        errors: 0,
        skipped: true,
        reason: "Contact cursor was refreshed recently; skipping duplicate incremental reconcile.",
      },
      membershipReconciliation: {
        seasonYear: 2026,
        cursorFrom: "2026-04-14T00:00:00.000Z",
        cursorTo: null,
        changedInvoices: 0,
        changedInvoiceIds: [],
        affectedMembers: 0,
        checked: 0,
        updated: 0,
        errors: 0,
        errorDetails: [],
        skipped: true,
        reason: "Membership cursor was refreshed recently; skipping duplicate incremental reconcile.",
      },
      invoiceReconciliation: {
        processed: 0,
        succeeded: 0,
        failed: 0,
        errorDetails: [],
        skipped: true,
        reason: "No changed membership invoices required invoice-linked reconciliation.",
      },
    });

    const response = await POST(makeRequest("inbound"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toBe("Xero inbound reconciliation cycle completed");
    expect(body.inboundReconciliation).toEqual({
      // #4446: the inbound task reports its settlement-alert sweep.
      settlementAlertCandidates: 0,
      inbound: {
        batches: 1,
        found: 3,
        processed: 3,
        succeeded: 2,
        failed: 1,
        skipped: 0,
      },
      contactReconciliation: {
        cursorFrom: "2026-04-14T00:10:00.000Z",
        cursorTo: null,
        total: 0,
        created: 0,
        updated: 0,
        skippedNoChanges: 0,
        skippedNoEmail: 0,
        skippedOther: 0,
        errors: 0,
        skipped: true,
        reason: "Contact cursor was refreshed recently; skipping duplicate incremental reconcile.",
      },
      membershipReconciliation: {
        seasonYear: 2026,
        cursorFrom: "2026-04-14T00:00:00.000Z",
        cursorTo: null,
        changedInvoices: 0,
        changedInvoiceIds: [],
        affectedMembers: 0,
        checked: 0,
        updated: 0,
        errors: 0,
        errorDetails: [],
        skipped: true,
        reason: "Membership cursor was refreshed recently; skipping duplicate incremental reconcile.",
      },
      invoiceReconciliation: {
        processed: 0,
        succeeded: 0,
        failed: 0,
        errorDetails: [],
        skipped: true,
        reason: "No changed membership invoices required invoice-linked reconciliation.",
      },
    });
    expect(mocks.runXeroInboundReconciliationCycle).toHaveBeenCalled();
  });
});
