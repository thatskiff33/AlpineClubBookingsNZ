import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAuth,
  mockFindUnique,
  mockGetFinanceSyncDiagnosticsStatus,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindUnique: vi.fn(),
  mockGetFinanceSyncDiagnosticsStatus: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: mockFindUnique,
    },
  },
}));

vi.mock("@/lib/finance-sync-diagnostics", () => ({
  getFinanceSyncDiagnosticsStatus: mockGetFinanceSyncDiagnosticsStatus,
}));

import { GET as getFinanceSyncStatusRoute } from "@/app/api/finance/sync/status/route";

function getFinanceSyncStatus() {
  return getFinanceSyncStatusRoute(new NextRequest("http://localhost/api/finance/sync/status"));
}

function managerSession() {
  return { user: { id: "finance-manager-1", role: "USER", accessRoles: [{ role: "USER" }] } };
}

function viewerMember() {
  return {
    id: "finance-viewer-1",
    email: "viewer@example.com",
    firstName: "View",
    lastName: "Only",
    role: "USER",
    financeAccessLevel: "MANAGER",
    accessRoles: [{ role: "FINANCE_USER" }],
    active: true,
    forcePasswordChange: false,
  };
}

function managerMember() {
  return {
    id: "finance-manager-1",
    email: "manager@example.com",
    firstName: "Fin",
    lastName: "Manager",
    role: "USER",
    financeAccessLevel: "NONE",
    accessRoles: [{ role: "FINANCE_ADMIN" }],
    active: true,
    forcePasswordChange: false,
  };
}

describe("finance sync diagnostics route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(managerSession());
    mockFindUnique.mockResolvedValue(managerMember());
    mockGetFinanceSyncDiagnosticsStatus.mockResolvedValue({
      workflow: "daily-finance-sync",
      latestRun: null,
      cron: {
        jobName: "finance-daily-sync",
        schedule: "15 10 * * *",
        timezone: "Pacific/Auckland",
        latestRun: null,
      },
      recentFailures: {
        syncRuns: [],
        cronRuns: [],
      },
    });
  });

  it("returns diagnostics status for FINANCE_ADMIN access", async () => {
    const response = await getFinanceSyncStatus();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      workflow: "daily-finance-sync",
      latestRun: null,
      cron: {
        jobName: "finance-daily-sync",
        schedule: "15 10 * * *",
        timezone: "Pacific/Auckland",
        latestRun: null,
      },
      recentFailures: {
        syncRuns: [],
        cronRuns: [],
      },
    });
    expect(mockGetFinanceSyncDiagnosticsStatus).toHaveBeenCalledTimes(1);
  });

  it("rejects FINANCE_USER access even when financeAccessLevel is stale", async () => {
    mockFindUnique.mockResolvedValue(viewerMember());

    const response = await getFinanceSyncStatus();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Finance manager access required",
    });
    expect(mockGetFinanceSyncDiagnosticsStatus).not.toHaveBeenCalled();
  });

  it("returns a 500 response when diagnostics loading fails", async () => {
    mockGetFinanceSyncDiagnosticsStatus.mockRejectedValue(
      new Error("Failed to load diagnostics from storage")
    );

    const response = await getFinanceSyncStatus();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to load diagnostics from storage",
    });
  });
});
