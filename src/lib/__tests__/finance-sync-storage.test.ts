import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FinanceSnapshotType,
  FinanceSyncRunStatus,
  FinanceSyncRunTrigger,
} from "@prisma/client";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    financeSyncRun: {
      create: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
    },
    financeSnapshot: {
      upsert: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import {
  completeFinanceSyncRun,
  createFinanceSyncRun,
  DEFAULT_FINANCE_SNAPSHOT_SCOPE,
  failFinanceSyncRun,
  getLatestFinanceSyncRun,
  listFinanceSnapshotHeaders,
  upsertFinanceSnapshot,
} from "@/lib/finance-sync-storage";

describe("finance-sync-storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates finance sync runs with the running status", async () => {
    const startedAt = new Date("2026-04-19T10:30:00.000Z");
    mockPrisma.financeSyncRun.create.mockResolvedValue({ id: "run-1" });

    await createFinanceSyncRun({
      workflow: " daily-finance-sync ",
      trigger: FinanceSyncRunTrigger.SCHEDULED,
      startedAt,
      xeroTenantId: "tenant-123",
      requestedByMemberId: "member-123",
      metadata: { source: "cron" },
    });

    expect(mockPrisma.financeSyncRun.create).toHaveBeenCalledWith({
      data: {
        workflow: "daily-finance-sync",
        trigger: FinanceSyncRunTrigger.SCHEDULED,
        status: FinanceSyncRunStatus.RUNNING,
        startedAt,
        xeroTenantId: "tenant-123",
        requestedByMemberId: "member-123",
        metadata: { source: "cron" },
      },
    });
  });

  it("marks a finance sync run as succeeded by default", async () => {
    const completedAt = new Date("2026-04-19T10:35:00.000Z");
    mockPrisma.financeSyncRun.update.mockResolvedValue({ id: "run-1" });

    await completeFinanceSyncRun({
      runId: "run-1",
      completedAt,
      snapshotCount: 3,
      totalRowCount: 42,
      resultSummary: { snapshotTypes: ["CONTACTS"] },
      errorSummary: " ",
    });

    expect(mockPrisma.financeSyncRun.update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: {
        status: FinanceSyncRunStatus.SUCCEEDED,
        completedAt,
        snapshotCount: 3,
        totalRowCount: 42,
        resultSummary: { snapshotTypes: ["CONTACTS"] },
        errorSummary: null,
      },
    });
  });

  it("marks a finance sync run as failed with trimmed error details", async () => {
    const completedAt = new Date("2026-04-19T10:36:00.000Z");
    mockPrisma.financeSyncRun.update.mockResolvedValue({ id: "run-1" });

    await failFinanceSyncRun({
      runId: "run-1",
      completedAt,
      errorSummary: "  Xero timeout  ",
      errorDetails: { statusCode: 504 },
      snapshotCount: 1,
      totalRowCount: 10,
    });

    expect(mockPrisma.financeSyncRun.update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: {
        status: FinanceSyncRunStatus.FAILED,
        completedAt,
        snapshotCount: 1,
        totalRowCount: 10,
        errorSummary: "Xero timeout",
        errorDetails: { statusCode: 504 },
      },
    });
  });

  it("upserts finance snapshots through the finance-only table with the default scope", async () => {
    const asOfDate = new Date("2026-03-31T00:00:00.000Z");
    const sourceUpdatedAt = new Date("2026-04-19T10:40:00.000Z");
    mockPrisma.financeSnapshot.upsert.mockResolvedValue({ id: "snapshot-1" });

    await upsertFinanceSnapshot({
      snapshotType: FinanceSnapshotType.BALANCE_SHEET,
      asOfDate,
      rowCount: 12,
      currency: " NZD ",
      sourceUpdatedAt,
      syncRunId: "run-1",
      payload: {
        accounts: [{ code: "100", balance: 123.45 }],
      },
    });

    expect(mockPrisma.financeSnapshot.upsert).toHaveBeenCalledWith({
      where: {
        snapshotType_scope_asOfDate: {
          snapshotType: FinanceSnapshotType.BALANCE_SHEET,
          scope: DEFAULT_FINANCE_SNAPSHOT_SCOPE,
          asOfDate,
        },
      },
      create: {
        snapshotType: FinanceSnapshotType.BALANCE_SHEET,
        scope: DEFAULT_FINANCE_SNAPSHOT_SCOPE,
        asOfDate,
        periodStart: null,
        periodEnd: null,
        rowCount: 12,
        currency: "NZD",
        sourceUpdatedAt,
        payload: {
          accounts: [{ code: "100", balance: 123.45 }],
        },
        syncRunId: "run-1",
      },
      update: {
        periodStart: null,
        periodEnd: null,
        rowCount: 12,
        currency: "NZD",
        sourceUpdatedAt,
        payload: {
          accounts: [{ code: "100", balance: 123.45 }],
        },
        syncRunId: "run-1",
      },
    });
  });

  it("lists finance snapshot headers without loading payloads", async () => {
    mockPrisma.financeSnapshot.findMany.mockResolvedValue([]);

    await listFinanceSnapshotHeaders({
      snapshotType: FinanceSnapshotType.CONTACTS,
      scope: " finance ",
      limit: 250,
    });

    expect(mockPrisma.financeSnapshot.findMany).toHaveBeenCalledWith({
      where: {
        snapshotType: FinanceSnapshotType.CONTACTS,
        scope: "finance",
      },
      select: {
        id: true,
        snapshotType: true,
        scope: true,
        asOfDate: true,
        periodStart: true,
        periodEnd: true,
        rowCount: true,
        currency: true,
        sourceUpdatedAt: true,
        syncRunId: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ asOfDate: "desc" }, { updatedAt: "desc" }],
      take: 100,
    });
  });

  it("loads the latest finance sync run for a workflow", async () => {
    mockPrisma.financeSyncRun.findFirst.mockResolvedValue({ id: "run-2" });

    await getLatestFinanceSyncRun(" manual-finance-sync ");

    expect(mockPrisma.financeSyncRun.findFirst).toHaveBeenCalledWith({
      where: { workflow: "manual-finance-sync" },
      orderBy: [{ startedAt: "desc" }, { createdAt: "desc" }],
    });
  });
});
