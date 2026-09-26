import { describe, expect, it } from "vitest";
import { FinanceMonthlyStatementKind } from "@prisma/client";
import {
  classifyFinanceSyncHealth,
  type FinanceSyncHealthFactFreshness,
  type FinanceSyncHealthSourceData,
} from "@/lib/finance-sync-health";
import type { FinanceSyncDiagnosticsStatus } from "@/lib/finance-sync-diagnostics";
import type { FinanceRevenueReconciliation } from "@/lib/finance-revenue-reconciliation";
import type { XeroAdminHealthSnapshot } from "@/lib/xero-admin-health";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

const NOW = new Date("2026-06-15T10:00:00.000Z");
const CURRENT_MONTH = "2026-06";

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 3_600_000);
}

function diagnostics(overrides?: {
  status?: string;
  ranHoursAgo?: number;
  latestRun?: null;
}): FinanceSyncDiagnosticsStatus {
  const ranAt = hoursAgo(overrides?.ranHoursAgo ?? 2).toISOString();
  return {
    workflow: "finance-sync",
    latestRun:
      overrides?.latestRun === null
        ? null
        : {
            id: "run-1",
            workflow: "finance-sync",
            trigger: "CRON",
            status: overrides?.status ?? "SUCCEEDED",
            startedAt: ranAt,
            completedAt: ranAt,
            durationMs: 1200,
            xeroTenantId: "tenant-1",
            requestedByMemberId: null,
            snapshotCount: 8,
            totalRowCount: 120,
            datasetCount: 10,
            successfulDatasetCount: 10,
            failedDatasetCount: 0,
            datasets: [],
            errorSummary: null,
            failureDetails: [],
          },
    cron: {
      jobName: "finance-sync",
      schedule: "0 3 * * *",
      timezone: "Pacific/Auckland",
      latestRun: null,
    },
    recentFailures: { syncRuns: [], cronRuns: [] },
  } as unknown as FinanceSyncDiagnosticsStatus;
}

function reconciliation(
  overallStatus: FinanceRevenueReconciliation["overallStatus"] = "TIES"
): FinanceRevenueReconciliation {
  return {
    generatedAt: NOW.toISOString(),
    overallStatus,
    toleranceCents: 100,
    tolerancePct: 0.005,
    periods:
      overallStatus === "DOES_NOT_TIE"
        ? [{ status: "DOES_NOT_TIE" }, { status: "TIES" }]
        : [{ status: "TIES" }],
  } as unknown as FinanceRevenueReconciliation;
}

function xeroHealth(overrides?: {
  failed?: number;
  pending?: number;
  missingInvoices?: number;
  refundsMissingCreditNotes?: number;
}): XeroAdminHealthSnapshot {
  return {
    unlinkedMembers: { count: 0, href: "/admin/members" },
    failedOperations: { count: overrides?.failed ?? 0, legacyCount: 0 },
    pendingOperations: { count: overrides?.pending ?? 0 },
    staleRunningOperations: { count: 0, thresholdMinutes: 30 },
    staleProcessingInboundEvents: { count: 0, thresholdMinutes: 30 },
    lastMembershipRefresh: {
      at: null,
      lastCronStatus: null,
      lastCronStartedAt: null,
    },
    missingInvoices: { count: overrides?.missingInvoices ?? 0 },
    refundsMissingCreditNotes: {
      count: overrides?.refundsMissingCreditNotes ?? 0,
      graceHours: 24,
    },
    contactGroupMismatches: { count: 0, cacheReady: true },
    contactLinkMismatches: { count: 0, cacheReady: true },
    apiBudget: {
      status: "healthy",
      usagePercent: 4,
      totalCalls: 40,
      failedCalls: 0,
    },
  } as unknown as XeroAdminHealthSnapshot;
}

function freshFacts(overrides?: {
  syncedHoursAgo?: number;
  latestFinalMonth?: string | null;
  maxSyncedAt?: null;
}): FinanceSyncHealthFactFreshness[] {
  return Object.values(FinanceMonthlyStatementKind).map((kind) => ({
    kind,
    maxSyncedAt:
      overrides?.maxSyncedAt === null
        ? null
        : hoursAgo(overrides?.syncedHoursAgo ?? 6),
    latestFinalMonth:
      overrides?.latestFinalMonth === undefined
        ? "2026-05"
        : overrides.latestFinalMonth,
  }));
}

function healthyInput(): FinanceSyncHealthSourceData {
  return {
    now: NOW,
    currentMonth: CURRENT_MONTH,
    diagnostics: diagnostics(),
    reconciliation: reconciliation(),
    xeroHealth: xeroHealth(),
    factFreshness: freshFacts(),
    format: CLUB_FORMAT_TEST,
  };
}

function signal(input: FinanceSyncHealthSourceData, id: string) {
  const health = classifyFinanceSyncHealth(input);
  const found = health.sections
    .flatMap((section) => section.signals)
    .find((entry) => entry.id === id || entry.id.startsWith(id));
  if (!found) throw new Error(`signal ${id} not found`);
  return { health, found };
}

describe("classifyFinanceSyncHealth", () => {
  it("is green across the board when every signal is healthy", () => {
    const health = classifyFinanceSyncHealth(healthyInput());
    expect(health.overallTone).toBe("green");
    expect(health.overallLabel).toBe("All clear");
    expect(health.warnings).toEqual([]);
    expect(health.sections.map((section) => section.tone)).toEqual([
      "green",
      "green",
      "green",
      "green",
    ]);
  });

  it("goes red when the latest sync run failed within 24 hours", () => {
    const { health, found } = signal(
      { ...healthyInput(), diagnostics: diagnostics({ status: "FAILED", ranHoursAgo: 3 }) },
      "latest-sync-run"
    );
    expect(found.tone).toBe("red");
    expect(health.overallTone).toBe("red");
    expect(health.overallLabel).toBe("Action required");
  });

  it("downgrades an old sync failure to amber", () => {
    const { found } = signal(
      { ...healthyInput(), diagnostics: diagnostics({ status: "FAILED", ranHoursAgo: 30 }) },
      "latest-sync-run"
    );
    expect(found.tone).toBe("amber");
  });

  it("marks a partial sync amber and a running sync green", () => {
    expect(
      signal(
        { ...healthyInput(), diagnostics: diagnostics({ status: "PARTIAL" }) },
        "latest-sync-run"
      ).found.tone
    ).toBe("amber");
    expect(
      signal(
        { ...healthyInput(), diagnostics: diagnostics({ status: "RUNNING" }) },
        "latest-sync-run"
      ).found.tone
    ).toBe("green");
  });

  it("is amber when the sync has never run or diagnostics are unavailable", () => {
    expect(
      signal(
        { ...healthyInput(), diagnostics: diagnostics({ latestRun: null }) },
        "latest-sync-run"
      ).found.tone
    ).toBe("amber");
    expect(
      signal({ ...healthyInput(), diagnostics: null }, "latest-sync-run").found
        .tone
    ).toBe("amber");
  });

  it("goes red when revenue reconciliation does not tie", () => {
    const { health, found } = signal(
      { ...healthyInput(), reconciliation: reconciliation("DOES_NOT_TIE") },
      "revenue-reconciliation"
    );
    expect(found.tone).toBe("red");
    expect(found.detail).toContain("1 of 2");
    expect(health.overallTone).toBe("red");
  });

  it("is amber when reconciliation is unavailable", () => {
    expect(
      signal(
        { ...healthyInput(), reconciliation: reconciliation("XERO_UNAVAILABLE") },
        "revenue-reconciliation"
      ).found.tone
    ).toBe("amber");
    expect(
      signal({ ...healthyInput(), reconciliation: null }, "revenue-reconciliation")
        .found.tone
    ).toBe("amber");
  });

  it("goes red on failed outbox operations and amber on pending ones", () => {
    const failed = signal(
      { ...healthyInput(), xeroHealth: xeroHealth({ failed: 2 }) },
      "failed-operations"
    );
    expect(failed.found.tone).toBe("red");
    expect(failed.health.overallTone).toBe("red");

    const pending = signal(
      { ...healthyInput(), xeroHealth: xeroHealth({ pending: 4 }) },
      "pending-operations"
    );
    expect(pending.found.tone).toBe("amber");
    expect(pending.health.overallTone).toBe("amber");
  });

  it("flags missing invoices and refunds without credit notes as amber", () => {
    expect(
      signal(
        { ...healthyInput(), xeroHealth: xeroHealth({ missingInvoices: 1 }) },
        "missing-invoices"
      ).found.tone
    ).toBe("amber");
    expect(
      signal(
        {
          ...healthyInput(),
          xeroHealth: xeroHealth({ refundsMissingCreditNotes: 1 }),
        },
        "refunds-missing-credit-notes"
      ).found.tone
    ).toBe("amber");
  });

  it("is amber when stored facts are stale or missing", () => {
    expect(
      signal(
        { ...healthyInput(), factFreshness: freshFacts({ syncedHoursAgo: 40 }) },
        "facts-synced-PROFIT_AND_LOSS"
      ).found.tone
    ).toBe("amber");
    expect(
      signal(
        { ...healthyInput(), factFreshness: freshFacts({ maxSyncedAt: null }) },
        "facts-synced-PROFIT_AND_LOSS"
      ).found.tone
    ).toBe("amber");
  });

  it("is amber when a finished month is still provisional-only", () => {
    // Current month June: May has ended, but the newest final month is April.
    const { found, health } = signal(
      { ...healthyInput(), factFreshness: freshFacts({ latestFinalMonth: "2026-04" }) },
      "facts-final-month-PROFIT_AND_LOSS"
    );
    expect(found.tone).toBe("amber");
    expect(found.detail).toContain("May 2026");
    expect(health.overallTone).toBe("amber");
    expect(health.overallLabel).toBe("Needs attention");
  });

  it("collects every non-green signal into the warnings list", () => {
    const health = classifyFinanceSyncHealth({
      ...healthyInput(),
      diagnostics: diagnostics({ status: "FAILED", ranHoursAgo: 3 }),
      xeroHealth: xeroHealth({ pending: 4 }),
    });
    expect(health.warnings.length).toBe(2);
    expect(health.warnings.some((warning) => warning.includes("Latest sync run"))).toBe(
      true
    );
    expect(
      health.warnings.some((warning) => warning.includes("Pending operations"))
    ).toBe(true);
  });
});
