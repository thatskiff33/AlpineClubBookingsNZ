import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FinanceSnapshotType } from "@prisma/client";

const { mockListFinanceSnapshots } = vi.hoisted(() => ({
  mockListFinanceSnapshots: vi.fn(),
}));

vi.mock("@/lib/finance-sync-storage", () => ({
  DEFAULT_FINANCE_SNAPSHOT_SCOPE: "default",
  listFinanceSnapshots: mockListFinanceSnapshots,
}));

vi.mock("@/lib/finance-auth", () => ({
  hasFinanceManagerAccess: (level: string) => level === "MANAGER",
}));

import {
  buildDefaultFinanceCashReportFilters,
  buildFinanceCashReportPageModel,
  resolveFinanceCashReportFilters,
} from "@/lib/finance-cash-report-page";

function financeViewer() {
  return {
    id: "finance-viewer-1",
    email: "viewer@example.com",
    firstName: "View",
    lastName: "Only",
    role: "MEMBER" as const,
    financeAccessLevel: "VIEWER" as const,
    active: true,
    forcePasswordChange: false,
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
  };
}

function bankBalanceSnapshot(input: {
  id: string;
  asOfDate: string;
  periodStart: string;
  periodEnd: string;
  sourceUpdatedAt: string;
  operatingBalance: string;
  savingsBalance: string;
  totalBalance: string;
}) {
  return {
    id: input.id,
    snapshotType: FinanceSnapshotType.BANK_BALANCES,
    scope: "default",
    asOfDate: new Date(`${input.asOfDate}T00:00:00.000Z`),
    periodStart: new Date(`${input.periodStart}T00:00:00.000Z`),
    periodEnd: new Date(`${input.periodEnd}T00:00:00.000Z`),
    rowCount: 3,
    currency: null,
    sourceUpdatedAt: new Date(input.sourceUpdatedAt),
    payload: {
      reportDate: input.asOfDate,
      reportTitles: [
        "Bank Summary",
        "Tokoroa Alpine Club",
        `As at ${input.asOfDate}`,
      ],
      fields: [
        {
          fieldId: "period",
          description: "Period",
          value: input.asOfDate,
        },
      ],
      rows: [
        {
          rowType: "Section",
          title: "Bank accounts",
          cells: [],
          rows: [
            {
              rowType: "Row",
              title: null,
              cells: [
                { value: "Operating account" },
                { value: input.operatingBalance },
              ],
              rows: [],
            },
            {
              rowType: "Row",
              title: null,
              cells: [
                { value: "Savings account" },
                { value: input.savingsBalance },
              ],
              rows: [],
            },
            {
              rowType: "SummaryRow",
              title: null,
              cells: [{ value: "Total" }, { value: input.totalBalance }],
              rows: [],
            },
          ],
        },
      ],
    },
    syncRunId: "run-1",
    createdAt: new Date("2026-05-01T00:20:00.000Z"),
    updatedAt: new Date("2026-05-01T00:20:00.000Z"),
  };
}

const consoleErrorSpy = vi
  .spyOn(console, "error")
  .mockImplementation(() => undefined);

describe("finance cash report page model", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:30:00.000Z"));
    vi.clearAllMocks();
    mockListFinanceSnapshots.mockResolvedValue([
      bankBalanceSnapshot({
        id: "snapshot-april-30",
        asOfDate: "2026-04-30",
        periodStart: "2026-04-01",
        periodEnd: "2026-04-30",
        sourceUpdatedAt: "2026-05-01T00:15:00.000Z",
        operatingBalance: "1000.00",
        savingsBalance: "500.00",
        totalBalance: "1500.00",
      }),
      bankBalanceSnapshot({
        id: "snapshot-april-29",
        asOfDate: "2026-04-29",
        periodStart: "2026-04-01",
        periodEnd: "2026-04-29",
        sourceUpdatedAt: "2026-04-30T00:15:00.000Z",
        operatingBalance: "900.00",
        savingsBalance: "400.00",
        totalBalance: "1300.00",
      }),
    ]);
  });

  afterEach(() => {
    consoleErrorSpy.mockClear();
    vi.useRealTimers();
  });

  it("uses the latest stored cash snapshots for managers", async () => {
    const model = await buildFinanceCashReportPageModel({
      member: financeManager(),
    });

    expect(model.isManager).toBe(true);
    expect(model.filters).toEqual(buildDefaultFinanceCashReportFilters());
    expect(model.summaryCards[0]).toMatchObject({
      title: "Latest stored cash position",
      value: "$1500.00",
    });
    expect(model.summaryCards[1]).toMatchObject({
      title: "Average stored cash position",
      value: "$1400.00",
    });
    expect(model.summaryCards[2]).toMatchObject({
      title: "Highest stored cash position",
      value: "$1500.00",
      footnote: "As of 30 Apr 2026.",
    });
    expect(model.summaryCards[3]).toMatchObject({
      title: "Accounts tracked",
      value: "2",
      footnote: "2 accounts appeared in the latest stored snapshot.",
    });
    expect(model.coverageSummary).toBe(
      "Showing 2 stored bank-balance snapshots from 30 Apr 2026 backwards."
    );
    expect(model.snapshotRows).toEqual([
      {
        snapshotId: "snapshot-april-30",
        asOfDateLabel: "30 Apr 2026",
        sourceWindow: "1 Apr 2026 to 30 Apr 2026",
        totalBalance: "$1500.00",
        accountCount: "2",
        sourceUpdatedAtLabel: "1 May 2026, 12:15 pm",
      },
      {
        snapshotId: "snapshot-april-29",
        asOfDateLabel: "29 Apr 2026",
        sourceWindow: "1 Apr 2026 to 29 Apr 2026",
        totalBalance: "$1300.00",
        accountCount: "2",
        sourceUpdatedAtLabel: "30 Apr 2026, 12:15 pm",
      },
    ]);
    expect(model.accountRows).toEqual([
      {
        accountName: "Operating account",
        latestBalance: "$1000.00",
        selectedAverage: "$950.00",
        selectedRange: "$900.00 to $1000.00",
        periodsPresent: "2",
      },
      {
        accountName: "Savings account",
        latestBalance: "$500.00",
        selectedAverage: "$450.00",
        selectedRange: "$400.00 to $500.00",
        periodsPresent: "2",
      },
    ]);
    expect(mockListFinanceSnapshots).toHaveBeenCalledWith({
      snapshotType: FinanceSnapshotType.BANK_BALANCES,
      scope: "default",
      limit: 7,
    });
  });

  it("falls back invalid cash period filters to the default window", () => {
    const resolved = resolveFinanceCashReportFilters({
      searchParams: {
        periods: "0",
      },
    });

    expect(resolved.filters).toEqual({
      periods: 7,
    });
    expect(resolved.warnings).toEqual([
      "Cash periods must be a whole number between 1 and 31. Showing the default 7-period window.",
    ]);
  });

  it("returns a safe unavailable state when no cash snapshots exist", async () => {
    mockListFinanceSnapshots.mockResolvedValue([]);

    const model = await buildFinanceCashReportPageModel({
      member: financeViewer(),
    });

    expect(model.isManager).toBe(false);
    expect(model.loadError).toBe(
      "No bank balance snapshots are available yet. Run the finance sync and try again once the bank summary dataset has landed."
    );
    expect(model.summaryCards).toEqual([]);
    expect(model.snapshotRows).toEqual([]);
  });

  it("returns a safe unavailable state when cash snapshot loading fails", async () => {
    mockListFinanceSnapshots.mockRejectedValue(new Error("database timeout"));

    const model = await buildFinanceCashReportPageModel({
      member: financeViewer(),
    });

    expect(model.isManager).toBe(false);
    expect(model.loadError).toBe(
      "Finance cash snapshots are temporarily unavailable. Try again shortly or use manager diagnostics to confirm the latest finance sync status."
    );
    expect(model.accountRows).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
