import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetLatestFinanceSyncRun,
  mockGetFinanceSyncDatasets,
  mockRunFinanceSync,
} = vi.hoisted(() => ({
  mockGetLatestFinanceSyncRun: vi.fn(),
  mockGetFinanceSyncDatasets: vi.fn(),
  mockRunFinanceSync: vi.fn(),
}));

vi.mock("@/lib/finance-sync-storage", () => ({
  getLatestFinanceSyncRun: mockGetLatestFinanceSyncRun,
}));

vi.mock("@/lib/finance-sync-datasets", () => ({
  getFinanceSyncDatasets: mockGetFinanceSyncDatasets,
}));

vi.mock("@/lib/finance-sync-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/finance-sync-service")>(
    "@/lib/finance-sync-service"
  );

  return {
    ...actual,
    runFinanceSync: mockRunFinanceSync,
  };
});

vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
  },
}));

import { runManualFinanceSync } from "@/lib/finance-sync-manual";

describe("runManualFinanceSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetFinanceSyncDatasets.mockReturnValue([
      {
        key: "profit-and-loss",
        sync: vi.fn(),
      },
    ]);
    mockRunFinanceSync.mockResolvedValue({
      runId: "run-1",
      workflow: "daily-finance-sync",
      trigger: "MANUAL",
      status: "SUCCEEDED",
      xeroTenantId: "tenant-1",
      startedAt: new Date("2026-05-02T00:00:00.000Z"),
      completedAt: new Date("2026-05-02T00:05:00.000Z"),
      snapshotCount: 4,
      totalRowCount: 120,
      datasetResults: [],
    });
  });

  it("returns the active run instead of starting a second manual sync", async () => {
    const startedAt = new Date("2026-05-02T00:00:00.000Z");
    mockGetLatestFinanceSyncRun.mockResolvedValue({
      id: "run-active",
      status: "RUNNING",
      startedAt,
    });

    const result = await runManualFinanceSync({
      requestedByMemberId: "finance-manager-1",
    });

    expect(result).toEqual({
      outcome: "already-running",
      runId: "run-active",
      startedAt,
    });
    expect(mockRunFinanceSync).not.toHaveBeenCalled();
  });

  it("runs the default finance workflow as a manager-triggered sync", async () => {
    mockGetLatestFinanceSyncRun.mockResolvedValue({
      id: "run-previous",
      status: "SUCCEEDED",
      startedAt: new Date("2026-05-01T00:00:00.000Z"),
    });

    const result = await runManualFinanceSync({
      requestedByMemberId: "finance-manager-1",
    });

    expect(result).toMatchObject({
      outcome: "finished",
      execution: {
        runId: "run-1",
        workflow: "daily-finance-sync",
        status: "SUCCEEDED",
      },
    });
    expect(mockRunFinanceSync).toHaveBeenCalledWith({
      workflow: "daily-finance-sync",
      trigger: "MANUAL",
      requestedByMemberId: "finance-manager-1",
      datasets: [
        {
          key: "profit-and-loss",
          sync: expect.any(Function),
        },
      ],
      metadata: {
        source: "manual",
        initiatedFrom: "/finance",
      },
    });
  });
});
