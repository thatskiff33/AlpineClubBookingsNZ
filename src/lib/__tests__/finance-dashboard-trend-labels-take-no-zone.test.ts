import { describe, expect, it, vi } from "vitest";

/**
 * CT-4 (#2870), group F4a: the finance dashboard's two trend-axis labels name the
 * day and the month they were handed, and consult no timezone to do it.
 *
 * ## The defect this closes, in plain English
 *
 * Both labels describe a CALENDAR value. `finance-dashboard-page.ts`'s day label
 * ("14 Jun") is handed a `yyyy-MM-dd` metric key minted by `buildIsoDateRange`;
 * `finance-dashboard-labels.ts`'s month label ("Jun 2026") is handed a `YYYY-MM`
 * month key. A calendar date has no timezone — 16 April 2026 is a Thursday
 * everywhere on earth — so neither may be projected through one.
 *
 * Both kept a local `Intl.DateTimeFormat` pinned to `APP_TIME_ZONE`, the
 * CONTAINER's zone rather than even the club's persisted one
 * (`INV-CONFIG-002`), over the key's UTC-midnight encoding. For a club BEHIND
 * Greenwich that projection moves the reading back a day: every point on the
 * occupancy and forward-demand trends named the previous day, every finance trend
 * axis named the previous month, and on a January key the month label lost the
 * YEAR as well — "2026-01" rendered as "Dec 2025".
 *
 * Both now call the kernel's `dayMonth` / `shortMonthYear` calendar-date shapes,
 * which pin `UTC` over the kernel's own encoding and are therefore provably the
 * identity for every club.
 *
 * ## What this file proves: zone-INDEPENDENCE, not zone-authority
 *
 * The difference decides what the mock has to be. A calendar date takes no zone,
 * so after the change neither module reads one on this path — mocking a persisted
 * `ClubTimeSettings` row would prove nothing, because nothing reads one and the
 * old projection would sail straight past such a test. `APP_TIME_ZONE` is the
 * only zone the replaced formatters ever read, so it is pinned BEHIND Greenwich
 * here and the first case measures what that pin does to a stored day, so the
 * premise cannot go quiet.
 *
 * This has to be a `vi.mock` rather than the machine's own `TZ`. `APP_TIME_ZONE`
 * is `process.env.TZ || NEXT_PUBLIC_TZ || "Pacific/Auckland"` and CI sets no
 * `TZ`, so on CI the zone resolves to New Zealand — which is AHEAD of Greenwich,
 * where a UTC-midnight instant never changes date. A suite that let the
 * environment choose could not tell the corrected implementation from the broken
 * one on the very runner that gates the merge.
 *
 * ## Measured
 *
 * Restoring each module's own `APP_TIME_ZONE`-pinned formatter, one at a time:
 * the month-label mutant fails 3 of the 3 month cases; the day-label mutant fails
 * the trend-label case. The premise case is deliberately NOT discriminating — it
 * asserts the legacy projection's answer on purpose — and says so below.
 */

// Inlined: `vi.mock` factories hoist above every const in this file.
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "America/Denver",
  APP_LOCALE: "en-NZ",
}));

const mocks = vi.hoisted(() => ({
  getFinanceBookingMetrics: vi.fn(),
  getFinanceSyncDiagnosticsStatus: vi.fn(),
  buildFinanceSyncHealth: vi.fn(),
  buildFinanceMonthlyPnlSummary: vi.fn(),
  buildFinanceMonthlyBalanceSeries: vi.fn(),
  buildFinanceRatioMatrix: vi.fn(),
  buildFinanceFinancialYearsPanelItems: vi.fn(),
  buildFinanceRevenueReconciliation: vi.fn(),
  listFinanceSnapshots: vi.fn(),
  parseCashSnapshot: vi.fn(),
  refreshFinancialYearConfig: vi.fn(),
  getXeroOrgShortCode: vi.fn(),
  seasonFindMany: vi.fn(),
  lodgeFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    season: { findMany: (...a: unknown[]) => mocks.seasonFindMany(...a) },
    lodge: { findMany: (...a: unknown[]) => mocks.lodgeFindMany(...a) },
  },
}));
vi.mock("@/lib/finance-booking-metrics", () => ({
  getFinanceBookingMetrics: (...a: unknown[]) => mocks.getFinanceBookingMetrics(...a),
}));
vi.mock("@/lib/finance-sync-diagnostics", () => ({
  getFinanceSyncDiagnosticsStatus: (...a: unknown[]) =>
    mocks.getFinanceSyncDiagnosticsStatus(...a),
}));
vi.mock("@/lib/finance-sync-health", () => ({
  buildFinanceSyncHealth: (...a: unknown[]) => mocks.buildFinanceSyncHealth(...a),
}));
vi.mock("@/lib/finance-monthly-pnl", () => ({
  buildFinanceMonthlyPnlSummary: (...a: unknown[]) =>
    mocks.buildFinanceMonthlyPnlSummary(...a),
}));
vi.mock("@/lib/finance-monthly-balance", () => ({
  buildFinanceMonthlyBalanceSeries: (...a: unknown[]) =>
    mocks.buildFinanceMonthlyBalanceSeries(...a),
}));
vi.mock("@/lib/finance-ratio-insights", () => ({
  buildFinanceRatioMatrix: (...a: unknown[]) => mocks.buildFinanceRatioMatrix(...a),
  buildFinanceFinancialYearsPanelItems: (...a: unknown[]) =>
    mocks.buildFinanceFinancialYearsPanelItems(...a),
}));
vi.mock("@/lib/finance-revenue-reconciliation", () => ({
  buildFinanceRevenueReconciliation: (...a: unknown[]) =>
    mocks.buildFinanceRevenueReconciliation(...a),
}));
vi.mock("@/lib/finance-sync-storage", () => ({
  DEFAULT_FINANCE_SNAPSHOT_SCOPE: "default",
  listFinanceSnapshots: (...a: unknown[]) => mocks.listFinanceSnapshots(...a),
}));
vi.mock("@/lib/finance-cash-snapshot", () => ({
  parseCashSnapshot: (...a: unknown[]) => mocks.parseCashSnapshot(...a),
}));
vi.mock("@/lib/financial-year-server", () => ({
  refreshFinancialYearConfig: (...a: unknown[]) => mocks.refreshFinancialYearConfig(...a),
}));
vi.mock("@/lib/xero-link-short-code", () => ({
  getXeroOrgShortCode: (...a: unknown[]) => mocks.getXeroOrgShortCode(...a),
}));

import { APP_TIME_ZONE } from "@/config/operational";
import { formatDateOnlyForTimeZone } from "@/lib/date-only";
import { buildFinanceDashboardPageModel } from "@/lib/finance-dashboard-page";
import { financeDashboardTrendMonthLabel } from "@/lib/finance-dashboard-labels";

/**
 * The zone the `@/config/operational` factory above pins, named rather than left
 * to the helper's `APP_TIME_ZONE` default, which #3123 deletes. The premise case
 * asserts the two are still the same zone, so this constant cannot drift out of
 * step with the factory and leave the cases below measuring nothing.
 */
const CLUB_ZONE_BEHIND_UTC = "America/Denver";

/** The occupancy trend's three stored days, and their labels. */
const REALIZED_DAYS = ["2026-05-01", "2026-05-02", "2026-05-03"] as const;
const REALIZED_LABELS = ["1 May", "2 May", "3 May"] as const;

function dailyMetric(date: string) {
  return {
    date,
    bookingCount: 1,
    guestNights: 2,
    occupiedBeds: 2,
    availableBeds: 30,
    occupancyRate: 0.0667,
    bookedRevenueCents: 8_000,
  };
}

function bucket() {
  return {
    bookingCount: 1,
    bookingNights: 2,
    guestNights: 2,
    bookedRevenueCents: 8_000,
    occupancy: {
      occupiedBedNights: 2,
      capacityBedNights: 90,
      occupancyRate: 0.0222,
    },
  };
}

/**
 * The minimum metrics shape the "bookings" view needs to build its occupancy
 * trend. `forward` is deliberately null: one trend proves the label, and the
 * forward series is fed by the same private helper.
 */
function bookingMetrics() {
  return {
    generatedAt: "2026-06-28T00:00:00.000Z",
    bookingCount: 1,
    paymentSummary: {
      bookingCount: 1,
      bookingsWithPayment: 1,
      bookingsWithoutPayment: 0,
      paymentStatusBreakdown: {
        PENDING: 0,
        PROCESSING: 0,
        SUCCEEDED: 1,
        FAILED: 0,
        REFUNDED: 0,
        PARTIALLY_REFUNDED: 0,
        NONE: 0,
      },
      additionalPaymentStatusBreakdown: {
        PENDING: 0,
        SUCCEEDED: 0,
        FAILED: 0,
        NONE: 1,
      },
      capturedGrossCents: 8_000,
      capturedAdditionalCents: 0,
      outstandingAdditionalCents: 0,
      outstandingAdditionalBookings: 0,
      additionalLedgerGapCents: 0,
      additionalLedgerGapBookings: 0,
      refundedCents: 0,
      netCollectedCents: 8_000,
      creditAppliedCents: 0,
      changeFeeCents: 0,
    },
    realized: {
      window: {
        from: "2026-05-01",
        to: "2026-05-03",
        cutoffDate: "2026-05-03",
        effectiveFrom: "2026-05-01",
        effectiveTo: "2026-05-03",
        dayCount: 3,
      },
      totals: { ...bucket(), averageNightlyRevenueCents: 8_000 },
      statusBreakdown: { CONFIRMED: bucket() },
      byDate: REALIZED_DAYS.map(dailyMetric),
    },
    forward: null,
  };
}

function financeManager() {
  return {
    id: "finance-manager-1",
    email: "manager@example.com",
    firstName: "Fin",
    lastName: "Manager",
    role: "USER" as const,
    financeAccessLevel: "NONE" as const,
    accessRoles: [{ role: "FINANCE_ADMIN" as const }],
    active: true,
    forcePasswordChange: false,
    twoFactorEnabled: false,
  };
}

describe("the finance dashboard's trend labels take no timezone (CT-4, #2870)", () => {
  it("PREMISE: the mocked zone really does move a stored day back", () => {
    // Measured, not assumed. If `America/Denver` ever stopped shifting a
    // UTC-midnight day, every assertion below would hold for the wrong reason and
    // this file would silently stop guarding anything. `formatDateOnlyForTimeZone`
    // is exactly the projection the two replaced formatters performed.
    //
    // DELIBERATELY NOT DISCRIMINATING: it asserts the legacy behaviour on purpose.
    //
    // The zone the replaced formatters read is `APP_TIME_ZONE`, so the constant
    // below has to keep naming it for this premise to be about the right zone.
    expect(APP_TIME_ZONE).toBe(CLUB_ZONE_BEHIND_UTC);
    expect(
      formatDateOnlyForTimeZone(
        new Date("2026-05-01T00:00:00.000Z"),
        CLUB_ZONE_BEHIND_UTC,
      ),
    ).toBe("2026-04-30");
  });

  it("names the month a month key holds, not the month behind it", () => {
    expect(financeDashboardTrendMonthLabel("2026-06")).toBe("Jun 2026");
  });

  it("keeps the YEAR on a January key, which the projection also moved", () => {
    // The worst reading of the old defect: projecting `2026-01-01T00:00:00.000Z`
    // into a zone behind Greenwich lands on 31 December 2025, so the axis tick
    // named a month in the previous financial year.
    expect(financeDashboardTrendMonthLabel("2026-01")).toBe("Jan 2026");
  });

  it("keeps December on a December key, where the projection stays in year", () => {
    expect(financeDashboardTrendMonthLabel("2026-12")).toBe("Dec 2026");
  });

  it("labels each occupancy trend point with the day its metric key holds", async () => {
    mocks.getXeroOrgShortCode.mockResolvedValue("!aBc12");
    mocks.seasonFindMany.mockResolvedValue([]);
    mocks.lodgeFindMany.mockResolvedValue([{ id: "lodge-default", name: "The Lodge" }]);
    mocks.getFinanceBookingMetrics.mockResolvedValue(bookingMetrics());
    mocks.getFinanceSyncDiagnosticsStatus.mockResolvedValue(null);
    mocks.buildFinanceSyncHealth.mockReturnValue({
      tone: "ok" as const,
      headline: "Up to date",
      details: [],
    });
    mocks.listFinanceSnapshots.mockResolvedValue([]);
    mocks.refreshFinancialYearConfig.mockResolvedValue(3);

    const model = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view: "bookings" },
    });

    const occupancyTrend = model.trends.find((trend) =>
      trend.title.includes("Occupancy"),
    );
    expect(occupancyTrend?.data.map((point) => point.label)).toEqual([
      ...REALIZED_LABELS,
    ]);
  });
});
