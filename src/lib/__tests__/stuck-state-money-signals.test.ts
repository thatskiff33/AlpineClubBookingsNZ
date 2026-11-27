import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import type { AdminCronRun } from "@/lib/admin-cron-health";
import { BOOKING_MONEY_CENSUS_JOB_NAME } from "@/lib/booking-money-census-job";
import type { BookingMoneyCensusSummary } from "@/lib/booking-money-census-summary";
import { classifyBookingMoneyCensusRuns } from "@/lib/stuck-state-money-signals";

const NOW = new Date("2026-07-01T00:00:00.000Z");
const ZONE = "Pacific/Auckland";
const HOUR_MS = 60 * 60 * 1000;

const summary: BookingMoneyCensusSummary = {
  verdict: "GATE_CLOSED",
  bookingsChecked: 12,
  findings: 1,
  drift: 1,
  unacknowledgedClassInstances: 0,
  classes: [{ class: "disagreement:CAPTURED", group: "disagreement", count: 1, bookingIds: ["booking-a"] }],
  reconciliation: { totalBookings: 12, reconciled: 12, unreconciled: 0, byReason: {} },
  alert: { newFindings: 1, sent: true, failed: false },
};

function run(hoursAgo: number, overrides?: Partial<AdminCronRun>): AdminCronRun {
  const startedAt = new Date(NOW.getTime() - hoursAgo * HOUR_MS);
  return {
    id: `run-${hoursAgo}`,
    jobName: BOOKING_MONEY_CENSUS_JOB_NAME,
    startedAt,
    completedAt: new Date(startedAt.getTime() + 4_000),
    durationMs: 4_000,
    status: "SUCCESS",
    resultSummary: summary,
    error: null,
    ...overrides,
  };
}

const failure = (hoursAgo: number) =>
  run(hoursAgo, { status: "FAILURE", resultSummary: null, error: "census read failed" });

describe("classifyBookingMoneyCensusRuns (#4910)", () => {
  it("reports a fresh good run's findings with no problem", () => {
    const state = classifyBookingMoneyCensusRuns([run(6), run(30)], ZONE, NOW);

    expect(state.problem).toBeNull();
    expect(state.summary).toEqual(summary);
    expect(state.checkedAt).toEqual(new Date(NOW.getTime() - 6 * HOUR_MS + 4_000));
  });

  it("names the failure when the latest run failed, and keeps the last good run's findings", () => {
    const state = classifyBookingMoneyCensusRuns([failure(6), run(30)], ZONE, NOW);

    expect(state.problem).toBe("Latest run failed: census read failed");
    expect(state.summary).toEqual(summary);
    expect(state.checkedAt).toEqual(new Date(NOW.getTime() - 30 * HOUR_MS + 4_000));
  });

  it("calls the check stale once its last good run is older than the daily window", () => {
    expect(classifyBookingMoneyCensusRuns([run(35)], ZONE, NOW).problem).toBeNull();

    const stale = classifyBookingMoneyCensusRuns([run(37)], ZONE, NOW);
    expect(stale.problem).toMatch(/older than the .* freshness threshold/);
    expect(stale.summary).toEqual(summary);
  });

  it("reports nothing for a check that has never run: Background Jobs lists it as missing", () => {
    expect(classifyBookingMoneyCensusRuns([], ZONE, NOW)).toEqual({ problem: null, checkedAt: null, summary: null });
  });

  it("reports a failure with no good run behind it", () => {
    expect(classifyBookingMoneyCensusRuns([failure(6)], ZONE, NOW)).toEqual({
      problem: "Latest run failed: census read failed",
      checkedAt: null,
      summary: null,
    });
  });

  it("does not call a skipped run a problem while the last good run is fresh", () => {
    const skipped = run(1, { status: "SKIPPED", resultSummary: null });

    expect(classifyBookingMoneyCensusRuns([skipped, run(6)], ZONE, NOW).problem).toBeNull();
    expect(classifyBookingMoneyCensusRuns([skipped], ZONE, NOW).problem).toMatch(/skipped/);
  });

  it("keeps the findings of a run whose alert could not be sent: Background Jobs shows that warning", () => {
    const warned = run(6, { resultSummary: { ...summary, warning: "The alert for new findings could not be sent." } });

    const state = classifyBookingMoneyCensusRuns([warned], ZONE, NOW);
    expect(state.problem).toBeNull();
    expect(state.summary?.drift).toBe(1);
  });

  it("says so, and reports no findings, when the last good run's summary cannot be read", () => {
    const state = classifyBookingMoneyCensusRuns([run(6, { resultSummary: { verdict: "GATE_OPEN" } })], ZONE, NOW);

    expect(state.problem).toBe("Its latest summary could not be read.");
    expect(state.summary).toBeNull();
    expect(state.checkedAt).not.toBeNull();
  });
});
