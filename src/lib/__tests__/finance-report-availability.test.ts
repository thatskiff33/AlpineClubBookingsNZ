import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetFinanceSyncDiagnosticsStatus,
  mockGetXeroConnectionStatus,
} = vi.hoisted(() => ({
  mockGetFinanceSyncDiagnosticsStatus: vi.fn(),
  mockGetXeroConnectionStatus: vi.fn(),
}));

function xeroStatus(overrides: {
  connected?: boolean;
  needsReentry?: boolean;
}) {
  return {
    connected: overrides.connected ?? false,
    needsReentry: overrides.needsReentry ?? false,
    tenantId: null,
    tokenExpiresAt: null,
  };
}

vi.mock("@/lib/admin-permissions", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/admin-permissions")),
  hasFinanceManagerAccess: (input: string | { financeAccessLevel?: string }) =>
    (typeof input === "string" ? input : input.financeAccessLevel) === "MANAGER",
}));

vi.mock("@/lib/finance-sync-diagnostics", () => ({
  getFinanceSyncDiagnosticsStatus: mockGetFinanceSyncDiagnosticsStatus,
}));

vi.mock("@/lib/xero", () => ({
  getXeroConnectionStatus: mockGetXeroConnectionStatus,
}));

import {
  buildFinanceSnapshotLoadErrorMessage,
  buildFinanceSnapshotMissingMessage,
} from "@/lib/finance-report-availability";

function financeViewer() {
  return {
    id: "finance-viewer-1",
    email: "viewer@example.com",
    firstName: "View",
    lastName: "Only",
    role: "USER" as const,
    financeAccessLevel: "VIEWER" as const,
    active: true,
    forcePasswordChange: false,
    accessRoles: [],
    twoFactorEnabled: false,
  };
}

function financeManager() {
  return {
    id: "finance-manager-1",
    email: "manager@example.com",
    firstName: "Fin",
    lastName: "Manager",
    role: "ADMIN" as const,
    financeAccessLevel: "MANAGER" as const,
    active: true,
    forcePasswordChange: false,
    accessRoles: [],
    twoFactorEnabled: false,
  };
}

describe("finance report availability messaging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetFinanceSyncDiagnosticsStatus.mockResolvedValue({
      workflow: "daily-finance-sync",
      latestRun: null,
      cron: {
        jobName: "finance-daily-sync",
        schedule: "0 5 * * *",
        timezone: "Pacific/Auckland",
        latestRun: null,
      },
      recentFailures: {
        syncRuns: [],
        cronRuns: [],
      },
    });
    mockGetXeroConnectionStatus.mockResolvedValue(
      xeroStatus({ connected: false })
    );
  });

  it("tells managers to connect Xero from the admin page when not connected", async () => {
    await expect(
      buildFinanceSnapshotMissingMessage({
        member: financeManager(),
        reportTitle: "This revenue report",
        dataLabel: "monthly revenue snapshots",
      })
    ).resolves.toContain("admin Xero page");
  });

  it("tells viewers when the first finance sync has not run yet", async () => {
    await expect(
      buildFinanceSnapshotMissingMessage({
        member: financeViewer(),
        reportTitle: "This revenue report",
        dataLabel: "monthly revenue snapshots",
      })
    ).resolves.toContain("first finance sync");
  });

  it("tells managers to reconnect Xero when stored tokens are unreadable", async () => {
    mockGetXeroConnectionStatus.mockResolvedValue(
      xeroStatus({ connected: false, needsReentry: true })
    );

    const message = await buildFinanceSnapshotMissingMessage({
      member: financeManager(),
      reportTitle: "This revenue report",
      dataLabel: "monthly revenue snapshots",
    });

    expect(message).toContain("reconnect Xero");
    expect(message).not.toContain("first finance sync");
  });

  it("tells viewers to ask an admin to reconnect Xero when tokens are unreadable", async () => {
    mockGetXeroConnectionStatus.mockResolvedValue(
      xeroStatus({ connected: false, needsReentry: true })
    );

    const message = await buildFinanceSnapshotMissingMessage({
      member: financeViewer(),
      reportTitle: "This revenue report",
      dataLabel: "monthly revenue snapshots",
    });

    expect(message).toContain("reconnect Xero");
  });

  it("reports sync failures as the reason data is missing", async () => {
    mockGetXeroConnectionStatus.mockResolvedValue(
      xeroStatus({ connected: true })
    );
    mockGetFinanceSyncDiagnosticsStatus.mockResolvedValue({
      workflow: "daily-finance-sync",
      latestRun: {
        id: "run-1",
        workflow: "daily-finance-sync",
        trigger: "CRON",
        status: "FAILED",
        startedAt: "2026-04-21T00:00:00.000Z",
        completedAt: "2026-04-21T00:02:00.000Z",
        durationMs: 120000,
        xeroTenantId: "tenant-123",
        requestedByMemberId: null,
        snapshotCount: 0,
        totalRowCount: 0,
        datasetCount: 7,
        successfulDatasetCount: 0,
        failedDatasetCount: 7,
        datasets: [],
        errorSummary: "sync failed",
        failureDetails: [],
      },
      cron: {
        jobName: "finance-daily-sync",
        schedule: "0 5 * * *",
        timezone: "Pacific/Auckland",
        latestRun: null,
      },
      recentFailures: {
        syncRuns: [],
        cronRuns: [],
      },
    });

    await expect(
      buildFinanceSnapshotMissingMessage({
        member: financeManager(),
        reportTitle: "This cash report",
        dataLabel: "cash balance snapshots",
      })
    ).resolves.toContain("latest finance sync failed");
  });

  it("uses a generic storage-read message when synced data cannot be read", async () => {
    mockGetXeroConnectionStatus.mockResolvedValue(
      xeroStatus({ connected: true })
    );
    mockGetFinanceSyncDiagnosticsStatus.mockResolvedValue({
      workflow: "daily-finance-sync",
      latestRun: {
        id: "run-1",
        workflow: "daily-finance-sync",
        trigger: "CRON",
        status: "SUCCEEDED",
        startedAt: "2026-04-21T00:00:00.000Z",
        completedAt: "2026-04-21T00:02:00.000Z",
        durationMs: 120000,
        xeroTenantId: "tenant-123",
        requestedByMemberId: null,
        snapshotCount: 7,
        totalRowCount: 140,
        datasetCount: 7,
        successfulDatasetCount: 7,
        failedDatasetCount: 0,
        datasets: [],
        errorSummary: null,
        failureDetails: [],
      },
      cron: {
        jobName: "finance-daily-sync",
        schedule: "0 5 * * *",
        timezone: "Pacific/Auckland",
        latestRun: null,
      },
      recentFailures: {
        syncRuns: [],
        cronRuns: [],
      },
    });

    await expect(
      buildFinanceSnapshotLoadErrorMessage({
        member: financeViewer(),
        reportTitle: "This balance sheet report",
        dataLabel: "balance sheet snapshots",
      })
    ).resolves.toContain("could not be loaded right now");
  });
});
