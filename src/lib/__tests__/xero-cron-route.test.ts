import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  refreshAllMembershipStatuses: vi.fn(),
  isXeroConnected: vi.fn(),
  processQueuedXeroOperationRetries: vi.fn(),
  processStoredXeroInboundEvents: vi.fn(),
  backfillHistoricalXeroObjectLinks: vi.fn(),
  sendXeroReconciliationReport: vi.fn(),
}));

vi.mock("@/lib/xero", () => ({
  refreshAllMembershipStatuses: mocks.refreshAllMembershipStatuses,
  isXeroConnected: mocks.isXeroConnected,
}));

vi.mock("@/lib/xero-operation-queue", () => ({
  processQueuedXeroOperationRetries: mocks.processQueuedXeroOperationRetries,
}));

vi.mock("@/lib/xero-inbound-reconciliation", () => ({
  processStoredXeroInboundEvents: mocks.processStoredXeroInboundEvents,
}));

vi.mock("@/lib/xero-hardening", () => ({
  backfillHistoricalXeroObjectLinks: mocks.backfillHistoricalXeroObjectLinks,
  sendXeroReconciliationReport: mocks.sendXeroReconciliationReport,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
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
  });

  it("runs all Xero tasks together", async () => {
    process.env.XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH = "true";
    mocks.isXeroConnected.mockResolvedValue(true);
    mocks.refreshAllMembershipStatuses.mockResolvedValue({ checked: 4, errors: 0 });
    mocks.processQueuedXeroOperationRetries.mockResolvedValue({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    mocks.processStoredXeroInboundEvents.mockResolvedValue({
      found: 2,
      processed: 2,
      succeeded: 2,
      failed: 0,
      skipped: 0,
    });
    mocks.backfillHistoricalXeroObjectLinks.mockResolvedValue({
      totals: {
        scanned: 4,
        createdLinks: 2,
        createdOperations: 2,
      },
    });
    mocks.sendXeroReconciliationReport.mockResolvedValue({
      sent: true,
      report: {
        summary: {
          issueCategoryCount: 1,
          issueTotalCount: 2,
        },
      },
    });

    const response = await POST(makeRequest("all"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toBe("Xero cron tasks completed");
    expect(body.membershipRefresh).toEqual({ checked: 4, errors: 0 });
    expect(body.queuedRetries).toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    expect(body.inboundReconciliation).toEqual({
      found: 2,
      processed: 2,
      succeeded: 2,
      failed: 0,
      skipped: 0,
    });
    expect(body.linkBackfill).toEqual({
      totals: {
        scanned: 4,
        createdLinks: 2,
        createdOperations: 2,
      },
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
  });

  it("runs inbound reconciliation on demand", async () => {
    mocks.isXeroConnected.mockResolvedValue(true);
    mocks.processStoredXeroInboundEvents.mockResolvedValue({
      found: 3,
      processed: 3,
      succeeded: 2,
      failed: 1,
      skipped: 0,
    });

    const response = await POST(makeRequest("inbound"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toBe("Xero inbound reconciliation processed");
    expect(body.inboundReconciliation).toEqual({
      found: 3,
      processed: 3,
      succeeded: 2,
      failed: 1,
      skipped: 0,
    });
    expect(mocks.processStoredXeroInboundEvents).toHaveBeenCalled();
  });
});
