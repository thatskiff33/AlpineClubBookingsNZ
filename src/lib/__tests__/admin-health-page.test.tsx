// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AdminHealthPage from "@/app/(admin)/admin/health/page";
import BackgroundJobsPage from "@/app/(admin)/admin/background-jobs/page";

const fetchMock = vi.fn();

function healthResponse() {
  return {
    health: {
      status: "healthy",
      version: "0.1.0",
      uptime: 1000,
      checks: {
        db: { status: "ok", latencyMs: 5 },
      },
    },
    cronJobs: {
      "finance-daily-sync": [
        {
          id: "cron-1",
          jobName: "finance-daily-sync",
          startedAt: "2026-05-14T22:15:00.000Z",
          completedAt: "2026-05-14T22:16:00.000Z",
          durationMs: 60000,
          status: "SUCCESS",
          resultSummary: null,
          error: null,
        },
      ],
    },
    cronHealth: {
      generatedAt: "2026-05-15T00:00:00.000Z",
      cronEnabled: true,
      defaultTimezone: "Pacific/Auckland",
      jobs: [
        {
          jobName: "finance-daily-sync",
          label: "Finance daily sync",
          schedule: "15 10 * * *",
          timezone: "Pacific/Auckland",
          expectedLocalTime: "10:15 NZT/NZDT daily",
          staleAfterMinutes: 2160,
          enabled: true,
          disabledReason: null,
          recordsRuns: true,
          note:
            "Runs at 10:15 local New Zealand time in Pacific/Auckland; UTC dashboards show this as 22:15 on the previous day during NZST or 21:15 during NZDT.",
          status: "current",
          severity: "ok",
          summary:
            "Latest successful run is within the 36h freshness threshold.",
          staleThreshold: "36h",
          latestRunAt: "2026-05-14T22:16:00.000Z",
          latestRunStatus: "SUCCESS",
          latestSuccessAt: "2026-05-14T22:16:00.000Z",
          latestFailureAt: null,
        },
      ],
    },
    webhookStats: {},
    recentWebhooks: [],
    emailDeliverability: {
      summary: {
        activeCount: 0,
        bounceCount: 0,
        complaintCount: 0,
        eventsLast24h: 0,
      },
      suppressions: [],
    },
    emailFailures: {
      summary: {
        activeCount: 0,
        reviewedCount: 0,
        scannedCount: 0,
        maxAttempts: 3,
      },
      failures: [],
      recentlyReviewed: [],
    },
    adminAlertDelivery: {
      summary: {
        recentCount: 0,
        lookbackDays: 7,
      },
      escalations: [],
    },
    tokenEmailRecovery: {
      summary: {
        activeCount: 0,
        reissuedCount: 0,
        scannedCount: 0,
      },
      failures: [],
      recentlyReissued: [],
    },
    systemInfo: {
      version: "0.1.0",
      nodeVersion: "v20.0.0",
      uptime: 1000,
      memoryMb: { rss: 128, heapUsed: 64, heapTotal: 96 },
      sentryConfigured: true,
      sentryDashboardUrl: null,
      sentryConfigWarning:
        "SENTRY_PROJECT is not configured; admin health cannot link directly to Sentry.",
    },
  };
}

describe("AdminHealthPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = fetchMock as typeof fetch;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => healthResponse(),
    });
  });

  it("shows Sentry config warnings without rendering placeholder dashboard links", async () => {
    render(<AdminHealthPage />);

    await waitFor(() =>
      expect(screen.queryByText("System is healthy")).not.toBeNull()
    );

    expect(screen.queryByText(/SENTRY_PROJECT is not configured/)).not.toBeNull();
    expect(
      screen.queryByRole("link", { name: /Open Sentry Dashboard/i })
    ).toBeNull();
  });

  it("renders cron schedule, threshold, and local finance sync timing", async () => {
    // Cron job rendering moved to the Background Jobs page when the System
    // Health page was split into per-section routes.
    render(<BackgroundJobsPage />);

    await waitFor(() =>
      expect(screen.queryByText("Finance daily sync")).not.toBeNull()
    );

    expect(screen.queryByText("15 10 * * *")).not.toBeNull();
    expect(screen.queryByText("10:15 NZT/NZDT daily")).not.toBeNull();
    expect(screen.queryByText("36h")).not.toBeNull();
    expect(
      screen.queryByText(/10:15 local New Zealand time/)
    ).not.toBeNull();
  });
});
