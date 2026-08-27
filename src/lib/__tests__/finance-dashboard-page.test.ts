import { beforeEach, describe, expect, it, vi } from "vitest";
import { FinanceSnapshotType } from "@prisma/client";

/*
  `APP_TIME_ZONE` IS PINNED BEHIND GREENWICH, AND THE CLUB'S PERSISTED ZONE IS
  NOT IT (#3123).

  Two of this page model's temporal questions used to be answered by the
  container: `generatedOn` went through `formatNZDateTime`, and the reporting
  month came from `getTodayDateOnly()`. Both read `APP_TIME_ZONE`. Pinning it to
  `America/Denver` while the persisted zone below is `Pacific/Auckland` makes the
  two disagree about the frozen instant (2026-07-01T00:00:00.000Z is 1 July in
  Auckland and 30 June in Denver), so `currentMonth: "2026-07"` and the season
  windows further down are now assertions about the CLUB's day rather than the
  host's. Deliberately not `Pacific/Auckland` here: that is exactly what
  `APP_TIME_ZONE` falls back to, so a suite agreeing with it could not tell the
  persisted zone from the environment's.
*/
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "America/Denver",
  APP_LOCALE: "en-NZ",
}));

const {
  mockBuildFinanceMonthlyPnlSummary,
  mockBuildFinanceMonthlyBalanceSeries,
  mockBuildFinanceRatioMatrix,
  mockBuildFinanceFinancialYearsPanelItems,
  mockBuildFinanceRevenueReconciliation,
  mockBuildFinanceSyncHealth,
  mockGetFinanceBookingMetrics,
  mockGetFinanceSyncDiagnosticsStatus,
  mockListFinanceSnapshots,
  mockParseCashSnapshot,
  mockRefreshFinancialYearConfig,
  mockSeasonFindMany,
  mockLodgeFindMany,
  mockGetXeroOrgShortCode,
  mockClubTimeSettingsFindUnique,
} = vi.hoisted(() => ({
  mockBuildFinanceMonthlyPnlSummary: vi.fn(),
  mockBuildFinanceMonthlyBalanceSeries: vi.fn(),
  mockBuildFinanceRatioMatrix: vi.fn(),
  mockBuildFinanceFinancialYearsPanelItems: vi.fn(),
  mockBuildFinanceRevenueReconciliation: vi.fn(),
  mockBuildFinanceSyncHealth: vi.fn(),
  mockGetFinanceBookingMetrics: vi.fn(),
  mockGetFinanceSyncDiagnosticsStatus: vi.fn(),
  mockListFinanceSnapshots: vi.fn(),
  mockParseCashSnapshot: vi.fn(),
  mockRefreshFinancialYearConfig: vi.fn(),
  mockSeasonFindMany: vi.fn(),
  mockLodgeFindMany: vi.fn(),
  mockGetXeroOrgShortCode: vi.fn(),
  mockClubTimeSettingsFindUnique: vi.fn(),
}));

/*
  THE `clubTimeSettings` DELEGATE IS NOT OPTIONAL ON THIS MOCK (#3123).
  `getClubTimeZone` is fail-soft in three places — no delegate, a throwing query,
  no row — and every one of them degrades SILENTLY to the environment. A prisma
  mock without it therefore passes for exactly the reason the club-zone cases in
  this file exist to rule out: they would measure `APP_TIME_ZONE` and report it
  as the club's answer.
*/
vi.mock("@/lib/prisma", () => ({
  prisma: {
    season: {
      findMany: mockSeasonFindMany,
    },
    lodge: {
      findMany: mockLodgeFindMany,
    },
    clubTimeSettings: {
      findUnique: mockClubTimeSettingsFindUnique,
    },
  },
}));

vi.mock("@/lib/finance-sync-diagnostics", () => ({
  getFinanceSyncDiagnosticsStatus: mockGetFinanceSyncDiagnosticsStatus,
}));

vi.mock("@/lib/finance-sync-health", () => ({
  buildFinanceSyncHealth: mockBuildFinanceSyncHealth,
}));

vi.mock("@/lib/finance-booking-metrics", () => ({
  getFinanceBookingMetrics: mockGetFinanceBookingMetrics,
}));

vi.mock("@/lib/finance-monthly-pnl", () => ({
  buildFinanceMonthlyPnlSummary: mockBuildFinanceMonthlyPnlSummary,
}));

vi.mock("@/lib/finance-monthly-balance", () => ({
  buildFinanceMonthlyBalanceSeries: mockBuildFinanceMonthlyBalanceSeries,
}));

vi.mock("@/lib/finance-ratio-insights", () => ({
  buildFinanceRatioMatrix: mockBuildFinanceRatioMatrix,
  buildFinanceFinancialYearsPanelItems: mockBuildFinanceFinancialYearsPanelItems,
}));

vi.mock("@/lib/financial-year-server", () => ({
  refreshFinancialYearConfig: mockRefreshFinancialYearConfig,
}));

vi.mock("@/lib/finance-revenue-reconciliation", () => ({
  buildFinanceRevenueReconciliation: mockBuildFinanceRevenueReconciliation,
}));

vi.mock("@/lib/finance-sync-storage", () => ({
  DEFAULT_FINANCE_SNAPSHOT_SCOPE: "default",
  listFinanceSnapshots: mockListFinanceSnapshots,
}));

vi.mock("@/lib/finance-cash-snapshot", () => ({
  parseCashSnapshot: mockParseCashSnapshot,
}));

// #2314: the dashboard's "Open Xero reports" links are server-built, so they
// resolve the organisation short code the same way every other server-side
// producer does. Only the short-code read is mocked — the URL itself is built
// by the real `xero-links` builder, so a link that quietly lost its
// organisation would fail here.
vi.mock("@/lib/xero-link-short-code", () => ({
  getXeroOrgShortCode: mockGetXeroOrgShortCode,
}));

import { buildFinanceDashboardPageModel } from "@/lib/finance-dashboard-page";

import type { FinanceDashboardView } from "@/lib/finance-dashboard-ranges";
import { buildXeroReportsUrl } from "@/lib/xero-links";

/** The club's persisted zone. Held apart from `APP_TIME_ZONE` above. */
const CLUB_ZONE = "Pacific/Auckland";

function persistClubZone(timeZone: string) {
  mockClubTimeSettingsFindUnique.mockResolvedValue({
    timeZone,
    updatedByMemberId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
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

function financeViewer() {
  return {
    id: "finance-viewer-1",
    email: "viewer@example.com",
    firstName: "Fin",
    lastName: "Viewer",
    role: "USER" as const,
    financeAccessLevel: "MANAGER" as const,
    accessRoles: [{ role: "FINANCE_USER" as const }],
    active: true,
    forcePasswordChange: false,
    twoFactorEnabled: false,
  };
}

function bookingMetrics() {
  const bucket = {
    bookingCount: 2,
    bookingNights: 3,
    guestNights: 6,
    bookedRevenueCents: 24_000,
    occupancy: {
      occupiedBedNights: 6,
      capacityBedNights: 60,
      occupancyRate: 0.1,
    },
  };
  return {
    generatedAt: "2026-06-28T00:00:00.000Z",
    bookingCount: 2,
    paymentSummary: {
      bookingCount: 2,
      bookingsWithPayment: 2,
      bookingsWithoutPayment: 0,
      paymentStatusBreakdown: {
        PENDING: 0,
        PROCESSING: 0,
        SUCCEEDED: 2,
        FAILED: 0,
        REFUNDED: 0,
        PARTIALLY_REFUNDED: 0,
        NONE: 0,
      },
      additionalPaymentStatusBreakdown: {
        PENDING: 0,
        SUCCEEDED: 0,
        FAILED: 0,
        NONE: 2,
      },
      capturedGrossCents: 24_000,
      capturedAdditionalCents: 0,
      outstandingAdditionalCents: 0,
      outstandingAdditionalBookings: 0,
      additionalLedgerGapCents: 0,
      additionalLedgerGapBookings: 0,
      refundedCents: 0,
      netCollectedCents: 24_000,
      creditAppliedCents: 0,
      changeFeeCents: 0,
    },
    realized: {
      window: {
        from: "2026-05-01",
        to: "2026-05-31",
        cutoffDate: "2026-05-31",
        effectiveFrom: "2026-05-01",
        effectiveTo: "2026-05-31",
        dayCount: 31,
      },
      totals: {
        ...bucket,
        averageNightlyRevenueCents: 8_000,
      },
      statusBreakdown: {
        CONFIRMED: bucket,
        PAID: { ...bucket, bookingCount: 0, guestNights: 0, bookedRevenueCents: 0 },
        COMPLETED: { ...bucket, bookingCount: 0, guestNights: 0, bookedRevenueCents: 0 },
      },
      byDate: [
        {
          date: "2026-05-01",
          bookingCount: 1,
          guestNights: 2,
          occupiedBeds: 2,
          availableBeds: 30,
          occupancyRate: 0.0667,
          bookedRevenueCents: 8_000,
        },
      ],
    },
    forward: {
      window: {
        from: "2026-07-01",
        to: "2026-07-31",
        asOfDate: "2026-05-31",
        effectiveFrom: "2026-07-01",
        effectiveTo: "2026-07-31",
        dayCount: 31,
      },
      totals: {
        committed: {
          ...bucket,
          statusBreakdown: { PAID: bucket },
        },
        atRisk: {
          ...bucket,
          guestNights: 3,
          statusBreakdown: {
            PENDING: { ...bucket, guestNights: 3 },
            CONFIRMED: { ...bucket, bookingCount: 0, guestNights: 0 },
          },
        },
        totalPipeline: { ...bucket, guestNights: 9 },
      },
      byDate: [
        {
          date: "2026-07-01",
          committed: {
            date: "2026-07-01",
            bookingCount: 1,
            guestNights: 2,
            occupiedBeds: 2,
            availableBeds: 30,
            occupancyRate: 0.0667,
            bookedRevenueCents: 8_000,
          },
          atRisk: {
            date: "2026-07-01",
            bookingCount: 1,
            guestNights: 1,
            occupiedBeds: 1,
            availableBeds: 30,
            occupancyRate: 0.0333,
            bookedRevenueCents: 4_000,
          },
          totalPipeline: {
            date: "2026-07-01",
            bookingCount: 2,
            guestNights: 3,
            occupiedBeds: 3,
            availableBeds: 30,
            occupancyRate: 0.1,
            bookedRevenueCents: 12_000,
          },
        },
      ],
    },
  };
}

function mappedSummary(kind: "REVENUE" | "EXPENSE") {
  return {
    kind,
    amountCents: kind === "REVENUE" ? 100_000 : 40_000,
    comparisonAmountCents: kind === "REVENUE" ? 80_000 : 35_000,
    deltaCents: kind === "REVENUE" ? 20_000 : 5_000,
    formattedAmount: kind === "REVENUE" ? "$1,000" : "$400",
    formattedComparisonAmount: kind === "REVENUE" ? "$800" : "$350",
    formattedDelta: kind === "REVENUE" ? "+$200" : "+$50",
    groups: [
      {
        id: "group-1",
        name: kind === "REVENUE" ? "Hut Fees" : "Insurance",
        subtype: kind === "REVENUE" ? "Operating" : "Overheads",
        kind,
        sortOrder: 10,
        amountCents: kind === "REVENUE" ? 100_000 : 40_000,
        comparisonAmountCents: kind === "REVENUE" ? 80_000 : 35_000,
        deltaCents: kind === "REVENUE" ? 20_000 : 5_000,
        formattedAmount: kind === "REVENUE" ? "$1,000" : "$400",
        formattedComparisonAmount: kind === "REVENUE" ? "$800" : "$350",
        formattedDelta: kind === "REVENUE" ? "+$200" : "+$50",
        lineCount: 1,
        lines: [
          {
            key: "line-1",
            sectionLabel: kind === "REVENUE" ? "Income" : "Expenses",
            lineLabel: kind === "REVENUE" ? "Hut Fees" : "Insurance",
            accountCode: kind === "REVENUE" ? "200" : null,
            amountCents: kind === "REVENUE" ? 100_000 : 40_000,
            comparisonAmountCents: kind === "REVENUE" ? 80_000 : 35_000,
            formattedAmount: kind === "REVENUE" ? "$1,000" : "$400",
            formattedComparisonAmount: kind === "REVENUE" ? "$800" : "$350",
            formattedDelta: kind === "REVENUE" ? "+$200" : "+$50",
            periodsPresent: 1,
          },
        ],
      },
    ],
    mix: [
      {
        name: kind === "REVENUE" ? "Hut Fees" : "Insurance",
        valueCents: kind === "REVENUE" ? 100_000 : 40_000,
      },
    ],
    trend: [
      {
        monthKey: "2026-05",
        label: "May 2026",
        amountCents: kind === "REVENUE" ? 100_000 : 40_000,
        comparisonAmountCents: kind === "REVENUE" ? 80_000 : 35_000,
        isProvisional: false,
      },
    ],
    availableExpenseLines:
      kind === "EXPENSE"
        ? [{ value: "INSURANCE", label: "Insurance", categoryId: "group-1" }]
        : [],
    warnings: [],
    monthsWithData: 1,
    includesProvisionalMonth: false,
  };
}

function balanceSeries() {
  const point = {
    monthKey: "2026-05",
    label: "May 2026",
    assetsCents: 500_000,
    liabilitiesCents: 120_000,
    equityCents: 380_000,
    netAssetsCents: 380_000,
    currentAssetsCents: 200_000,
    currentLiabilitiesCents: 50_000,
    workingCapitalCents: 150_000,
    bankCents: 150_000,
    hasData: true,
    isProvisional: false,
  };
  return {
    points: [point],
    latest: point,
    latestBankAccounts: [
      { label: "Operating", balanceCents: 100_000 },
      { label: "Savings", balanceCents: 50_000 },
    ],
    monthsWithData: 1,
  };
}

describe("finance dashboard page model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    persistClubZone(CLUB_ZONE);
    mockGetXeroOrgShortCode.mockResolvedValue("!aBc12");
    mockSeasonFindMany.mockResolvedValue([]);
    // Single active lodge by default: the reporting-lodge selector stays hidden
    // (ADR-002) and metrics run club-wide, matching existing expectations.
    mockLodgeFindMany.mockResolvedValue([{ id: "lodge-default", name: "The Lodge" }]);
    mockGetFinanceSyncDiagnosticsStatus.mockResolvedValue({
      latestRun: {
        status: "SUCCEEDED",
        startedAt: "2026-06-28T00:00:00.000Z",
        completedAt: "2026-06-28T00:02:00.000Z",
        snapshotCount: 8,
        totalRowCount: 120,
      },
      cron: { schedule: "0 5 * * *", timezone: "Pacific/Auckland" },
    });
    mockGetFinanceBookingMetrics.mockResolvedValue(bookingMetrics());
    mockRefreshFinancialYearConfig.mockResolvedValue(3);
    mockBuildFinanceMonthlyPnlSummary.mockImplementation(async (input: { kind: "REVENUE" | "EXPENSE" }) =>
      mappedSummary(input.kind)
    );
    mockBuildFinanceMonthlyBalanceSeries.mockResolvedValue(balanceSeries());
    mockBuildFinanceRatioMatrix.mockResolvedValue({
      months: ["2026-05", "2026-06"],
      provisionalMonths: [],
      series: [
        {
          id: "total-income",
          name: "Total income",
          kind: "REVENUE",
          isTotal: true,
          valuesCents: [100_000, 80_000],
        },
        {
          id: "cat-hut",
          name: "Hut Fees",
          kind: "REVENUE",
          isTotal: false,
          valuesCents: [100_000, 80_000],
        },
      ],
      financialYearEndMonth: 3,
      currentMonth: "2026-07",
    });
    mockBuildFinanceFinancialYearsPanelItems.mockReturnValue([
      {
        label: "Total income",
        value: "$1,800",
        detail: "FY2026 $0 · FY2025 $0",
        emphasis: true,
      },
    ]);
    mockBuildFinanceRevenueReconciliation.mockResolvedValue({
      overallStatus: "TIES",
      periods: [
        {
          periodLabel: "May 2026",
          varianceCents: 0,
          xeroHutFeesIncomeCents: 100_000,
          bookingHutFeesCents: 100_000,
        },
      ],
    });
    mockBuildFinanceSyncHealth.mockResolvedValue({
      overallTone: "amber",
      overallLabel: "Needs attention",
      warnings: ["Pending operations: 2."],
      sections: [
        {
          id: "daily-sync",
          title: "Daily Xero sync",
          description: "The scheduled pull.",
          tone: "green",
          signals: [
            {
              id: "latest-sync-run",
              label: "Latest sync run",
              value: "Succeeded 2h ago",
              tone: "green",
              href: "/admin/xero",
              linkLabel: "Open Xero admin",
            },
          ],
        },
        {
          id: "xero-operations",
          title: "Xero operations",
          description: "Outbound writes.",
          tone: "amber",
          signals: [
            {
              id: "pending-operations",
              label: "Pending operations",
              value: "2",
              detail: "Queued writes.",
              tone: "amber",
              href: "/admin/xero",
            },
          ],
        },
      ],
    });
    mockListFinanceSnapshots.mockResolvedValue([{ id: "snapshot-1" }]);
    mockParseCashSnapshot.mockReturnValue({
      totalBalanceCents: 150_000,
      totalBalance: "$1500.00",
      accountCount: 2,
      snapshotLabel: "31 May 2026",
      sourceUpdatedAtLabel: "31 May 2026, 12:00 pm",
      accounts: [
        { label: "Operating", balanceCents: 100_000 },
        { label: "Savings", balanceCents: 50_000 },
      ],
    });
  });

  it.each<FinanceDashboardView>([
    "bookings",
    "revenue",
    "costs",
    "ratios",
    "pricing-sensitivity",
    "working-capital",
    "cash",
    "balance-sheet",
    "sync-health",
  ])("builds the %s dashboard from stored/modelled data", async (view) => {
    const model = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view },
    });

    expect(model.selection.view).toBe(view);
    if (view === "ratios") {
      expect(model.ratios?.matrix.months.length).toBeGreaterThan(0);
    } else {
      expect(model.cards.length).toBeGreaterThan(0);
      expect(model.ratios).toBeNull();
    }
    expect(model.exportSections[0].title).toBe("Dashboard selection");
    expect(model.sourceNotes.length).toBeGreaterThan(0);
  });

  // #2314: "Open Xero reports" is the club's highest-value Xero deep link, and
  // its readers are exactly the multi-organisation treasurers the rule exists
  // for — a short-code-less link drops them into whichever organisation their
  // Xero session last used, which may be another club's books.
  it.each<FinanceDashboardView>([
    "revenue",
    "costs",
    "balance-sheet",
    "working-capital",
  ])("scopes the %s view's Open Xero reports link to the club", async (view) => {
    const model = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view },
    });

    const note = model.sourceNotes.find(
      (sourceNote) => sourceNote.linkLabel === "Open Xero reports",
    );
    expect(note?.href).toBe(buildXeroReportsUrl({ shortCode: "!aBc12" }));
    expect(note?.href).toContain("shortcode=!aBc12");
  });

  it("degrades Open Xero reports to the generic link when no short code resolves", async () => {
    mockGetXeroOrgShortCode.mockResolvedValue(null);

    const model = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view: "revenue" },
    });

    const note = model.sourceNotes.find(
      (sourceNote) => sourceNote.linkLabel === "Open Xero reports",
    );
    // Live, just not organisation-scoped — degrading is never a dead link.
    expect(note?.href).toBe(buildXeroReportsUrl());
    expect(note?.href).not.toContain("shortcode");
  });

  it("maps sync-health sections onto status panels with tones, links, and warnings", async () => {
    const model = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view: "sync-health" },
    });

    expect(model.cards[0]).toMatchObject({
      title: "Sync confidence",
      value: "Needs attention",
    });

    const opsPanel = model.statusPanels.find(
      (panel) => panel.title === "Xero operations"
    );
    expect(opsPanel).toMatchObject({
      badgeLabel: "Attention",
      badgeTone: "warning",
    });
    expect(opsPanel?.items[0]).toMatchObject({
      label: "Pending operations",
      value: "2",
      emphasis: true,
      href: "/admin/xero",
    });

    const syncPanel = model.statusPanels.find(
      (panel) => panel.title === "Daily Xero sync"
    );
    expect(syncPanel).toMatchObject({ badgeLabel: "OK", badgeTone: "success" });
    expect(syncPanel?.items[0]).toMatchObject({ emphasis: false });

    expect(model.warnings).toContain("Pending operations: 2.");
    expect(
      model.exportSections.some((section) => section.title === "Sync health signals")
    ).toBe(true);
  });

  it("appends the financial-years committee panel to revenue and costs views", async () => {
    const revenue = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view: "revenue" },
    });
    const costs = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view: "costs" },
    });

    for (const model of [revenue, costs]) {
      const panel = model.statusPanels.find(
        (statusPanel) => statusPanel.title === "Financial years"
      );
      expect(panel).toBeDefined();
      expect(panel?.items[0]).toMatchObject({ label: "Total income" });
    }
  });

  it("passes the ratio explorer selection through from query params", async () => {
    const model = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: {
        view: "ratios",
        ratioNumerator: "cat-catering",
        ratioDenominator: "cat-hut",
      },
    });

    expect(model.ratios).toMatchObject({
      initialNumeratorId: "cat-catering",
      initialDenominatorId: "cat-hut",
    });
  });

  it("groups mapped P&L categories under subtype sub-headings with sub-totals", async () => {
    const model = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view: "revenue" },
    });

    const panel = model.statusPanels.find(
      (statusPanel) => statusPanel.title === "Revenue groups"
    );
    expect(panel).toBeDefined();
    const subheading = panel?.items.find((item) => item.emphasis);
    expect(subheading).toMatchObject({ label: "Operating", value: "$1,000" });
    expect(panel?.items.some((item) => item.label === "Hut Fees")).toBe(true);
  });

  it("derives manager-only dashboard actions from access role rows", async () => {
    const managerModel = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view: "bookings" },
    });
    const viewerModel = await buildFinanceDashboardPageModel({
      member: financeViewer(),
      searchParams: { view: "bookings" },
    });

    expect(managerModel.isManager).toBe(true);
    expect(viewerModel.isManager).toBe(false);
  });

  it("keeps the booking metrics club-wide and hides the lodge selector for a single-lodge club (#17, ADR-002)", async () => {
    // Default beforeEach: one active lodge.
    const model = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view: "bookings" },
    });

    expect(model.lodges).toEqual([]);
    expect(model.selectedLodgeId).toBeNull();
    // All-lodges scope: metrics run with lodgeId null.
    expect(mockGetFinanceBookingMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ lodgeId: null })
    );
  });

  /*
    #2350: the additional-payment breakdown had been computed for a long time
    and rendered nowhere, so an upward booking change whose extra was never
    collected was invisible on every finance surface.
  */
  it("renders the outstanding additional payments card and panel on the bookings view", async () => {
    const metrics = bookingMetrics();
    metrics.paymentSummary.outstandingAdditionalCents = 25_000;
    metrics.paymentSummary.outstandingAdditionalBookings = 2;
    metrics.paymentSummary.additionalPaymentStatusBreakdown = {
      PENDING: 1,
      SUCCEEDED: 0,
      FAILED: 1,
      NONE: 0,
    };
    mockGetFinanceBookingMetrics.mockResolvedValue(metrics);

    const model = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view: "bookings" },
    });

    const card = model.cards.find(
      (entry) => entry.title === "Outstanding additional payments",
    );
    expect(card?.value).toBe("$250");
    expect(card?.footnote).toContain("2 bookings");

    const panel = model.statusPanels.find(
      (entry) => entry.title === "Outstanding additional payments",
    );
    expect(panel?.items.map((item) => [item.label, item.value])).toEqual([
      ["Awaiting payment", "1"],
      ["Payment failed", "1"],
      ["Total outstanding", "$250"],
    ]);
  });

  /*
    #2408: net collected cash is the gross captured figure, which contains a
    collected price increase because the payment ledger put it there. A payment
    claiming that collection with no ledger row behind it is the one shape where
    it does not, so the figure would be short — and the treasurer has to be told
    where they read the number, not only in a server log.
  */
  it("warns on the cash figure when a collected increase has no payment record", async () => {
    const metrics = bookingMetrics();
    metrics.paymentSummary.additionalLedgerGapCents = 2_100;
    metrics.paymentSummary.additionalLedgerGapBookings = 1;
    mockGetFinanceBookingMetrics.mockResolvedValue(metrics);

    const model = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view: "bookings" },
    });

    expect(
      model.warnings.some(
        (warning) =>
          warning.includes("Net collected cash may understate by $21") &&
          warning.includes("1 booking"),
      ),
    ).toBe(true);
    expect(
      model.cards.find((entry) => entry.title === "Net collected cash")
        ?.footnote,
    ).toContain("May understate by $21");
  });

  it("leaves the cash figure uncaveated when the ledger backs every increase", async () => {
    const model = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view: "bookings" },
    });

    expect(
      model.warnings.some((warning) =>
        warning.includes("Net collected cash may understate"),
      ),
    ).toBe(false);
    expect(
      model.cards.find((entry) => entry.title === "Net collected cash")
        ?.footnote,
    ).toBe("Cash is local payment-derived and separate from Xero revenue.");
  });

  it("keeps the outstanding-payments panel off the dashboard when nothing is owing", async () => {
    const model = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view: "bookings" },
    });

    expect(
      model.statusPanels.some(
        (entry) => entry.title === "Outstanding additional payments",
      ),
    ).toBe(false);
    // The KPI card still reports the all-clear rather than disappearing.
    expect(
      model.cards.find(
        (entry) => entry.title === "Outstanding additional payments",
      )?.value,
    ).toBe("$0");
  });

  it("scopes the booking metrics to the selected lodge and exposes the selector when a second lodge exists (#17)", async () => {
    mockLodgeFindMany.mockResolvedValue([
      { id: "lodge-a", name: "Alpha Lodge" },
      { id: "lodge-b", name: "Bravo Lodge" },
    ]);

    const model = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view: "bookings", lodgeId: "lodge-b" },
    });

    expect(model.lodges).toEqual([
      { id: "lodge-a", name: "Alpha Lodge" },
      { id: "lodge-b", name: "Bravo Lodge" },
    ]);
    expect(model.selectedLodgeId).toBe("lodge-b");
    expect(mockGetFinanceBookingMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ lodgeId: "lodge-b" })
    );
  });

  it("falls back to all-lodges when the requested lodgeId is not an active lodge (#17)", async () => {
    mockLodgeFindMany.mockResolvedValue([
      { id: "lodge-a", name: "Alpha Lodge" },
      { id: "lodge-b", name: "Bravo Lodge" },
    ]);

    const model = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view: "bookings", lodgeId: "lodge-ghost" },
    });

    expect(model.selectedLodgeId).toBeNull();
    expect(mockGetFinanceBookingMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ lodgeId: null })
    );
  });

  // #2919. The seasons that drive the "Rest of Season" forward window were read
  // with no lodge filter and no lodge column, so at a two-lodge club one lodge's
  // season could silently define the other lodge's forward range.
  describe("the Rest of Season forward window honours the reporting lodge", () => {
    // The suite runs with today frozen at 2026-07-01, so both of these are
    // active-or-upcoming for good.
    const alphaSeason = {
      name: "Alpha Winter",
      startDate: new Date("2026-06-01T00:00:00.000Z"),
      endDate: new Date("2026-08-31T00:00:00.000Z"),
      active: true,
      lodge: { name: "Alpha Lodge" },
    };
    const bravoSeason = {
      name: "Bravo Winter",
      startDate: new Date("2026-07-15T00:00:00.000Z"),
      endDate: new Date("2026-09-30T00:00:00.000Z"),
      active: true,
      lodge: { name: "Bravo Lodge" },
    };

    function twoLodges() {
      mockLodgeFindMany.mockResolvedValue([
        { id: "lodge-a", name: "Alpha Lodge" },
        { id: "lodge-b", name: "Bravo Lodge" },
      ]);
    }

    it("reads only the selected lodge's seasons, and says nothing new on screen", async () => {
      twoLodges();
      mockSeasonFindMany.mockResolvedValue([bravoSeason]);

      const model = await buildFinanceDashboardPageModel({
        member: financeManager(),
        searchParams: {
          view: "bookings",
          lodgeId: "lodge-b",
          forward: "rest-of-season",
        },
      });

      expect(mockSeasonFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { active: true, lodge: { active: true }, lodgeId: "lodge-b" },
        })
      );
      // Scoped to one lodge there is nothing to disambiguate, so the header
      // keeps the dates-only wording it has always had — while the Forward
      // demand card's footnote still names the season, exactly as before, and
      // without a lodge name it has no use for.
      expect(model.selectionLabels.forwardWindow).toBe(
        "15 Jul 2026 to 30 Sept 2026"
      );
      expect(model.selection.forwardWindow.label).toBe(
        "Bravo Winter: 15 Jul 2026 to 30 Sept 2026"
      );
      expect(model.selection.forwardWindow.to).toBe("2026-09-30");
    });

    it("labels the season with its lodge when All Lodges is selected", async () => {
      twoLodges();
      // Both lodges' seasons come back; the earliest-starting one wins, and it
      // is not the lodge the reader is looking at unless it says so.
      mockSeasonFindMany.mockResolvedValue([alphaSeason, bravoSeason]);

      const model = await buildFinanceDashboardPageModel({
        member: financeManager(),
        searchParams: { view: "bookings", forward: "rest-of-season" },
      });

      expect(model.selectedLodgeId).toBeNull();
      expect(mockSeasonFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { active: true, lodge: { active: true } },
        })
      );
      expect(model.selectionLabels.forwardWindow).toBe(
        "Alpha Lodge — Alpha Winter: 1 Jul 2026 to 31 Aug 2026"
      );
      // One construction only: the header reuses the label the range resolver
      // built, so the two can never drift apart (review finding, #2919).
      expect(model.selectionLabels.forwardWindow).toBe(
        model.selection.forwardWindow.label
      );
      expect(model.selection.forwardWindow.to).toBe("2026-08-31");
    });

    it("leaves a single-lodge club's wording untouched (ADR-002)", async () => {
      // Default beforeEach: one active lodge, so there is no selector and
      // nothing to disambiguate.
      mockSeasonFindMany.mockResolvedValue([alphaSeason]);

      const model = await buildFinanceDashboardPageModel({
        member: financeManager(),
        searchParams: { view: "bookings", forward: "rest-of-season" },
      });

      expect(mockSeasonFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { active: true, lodge: { active: true } },
        })
      );
      // Untouched means untouched: the dates alone, with neither the season
      // name nor a lodge name added to what a one-lodge club used to read.
      expect(model.selectionLabels.forwardWindow).toBe(
        "1 Jul 2026 to 31 Aug 2026"
      );
      expect(model.selectionLabels.forwardWindow).not.toContain("Alpha Winter");
      expect(model.selectionLabels.forwardWindow).not.toContain("Alpha Lodge");
    });

    // Review finding (#2919): the view select and the lodge select share one GET
    // form, so switching to an accounting view resubmits the lodgeId the previous
    // view had — on a page that renders no lodge selector. Honouring it there
    // would scope the window, or raise the "configure seasons" warning, with no
    // control on screen to explain or clear it.
    it("ignores a lodgeId carried over onto a view that shows no lodge selector", async () => {
      twoLodges();
      mockSeasonFindMany.mockResolvedValue([alphaSeason, bravoSeason]);

      const model = await buildFinanceDashboardPageModel({
        member: financeManager(),
        searchParams: {
          view: "revenue",
          lodgeId: "lodge-b",
          forward: "rest-of-season",
        },
      });

      expect(mockSeasonFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { active: true, lodge: { active: true } },
        })
      );
      expect(model.warnings).not.toContain(
        "Rest of Season needs an active or upcoming configured season. Configure seasons before using this forward window."
      );
    });

    it("raises no spurious warning on an accounting view when the carried lodge has no season", async () => {
      twoLodges();
      // Club-wide there IS a season; only lodge-b lacks one. The mock filters
      // the way Postgres would, so scoping the read to the invisible
      // carried-over lodge really does come back empty.
      mockSeasonFindMany.mockImplementation(
        async (args: { where?: { lodgeId?: string } }) =>
          args.where?.lodgeId ? [] : [alphaSeason]
      );

      const model = await buildFinanceDashboardPageModel({
        member: financeManager(),
        searchParams: {
          view: "balance-sheet",
          lodgeId: "lodge-b",
          forward: "rest-of-season",
        },
      });

      expect(model.warnings).not.toContain(
        "Rest of Season needs an active or upcoming configured season. Configure seasons before using this forward window."
      );
      expect(model.selection.forwardWindow.to).toBe("2026-08-31");
    });

    it("warns rather than borrowing another lodge's season when the selected lodge has none", async () => {
      twoLodges();
      mockSeasonFindMany.mockResolvedValue([]);

      const model = await buildFinanceDashboardPageModel({
        member: financeManager(),
        searchParams: {
          view: "bookings",
          lodgeId: "lodge-b",
          forward: "rest-of-season",
        },
      });

      expect(model.warnings).toContain(
        "Rest of Season needs an active or upcoming configured season. Configure seasons before using this forward window."
      );
    });
  });

  it("surfaces missing stored monthly data as a compact warning", async () => {
    mockBuildFinanceMonthlyBalanceSeries.mockResolvedValue({
      points: [],
      latest: null,
      latestBankAccounts: [],
      monthsWithData: 0,
    });
    mockListFinanceSnapshots.mockImplementation(async (input?: { snapshotType?: FinanceSnapshotType }) => {
      if (input?.snapshotType === FinanceSnapshotType.BANK_BALANCES) {
        return [];
      }
      return [{ id: "snapshot-1" }];
    });

    const model = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view: "cash" },
    });

    expect(
      model.warnings.some((warning) =>
        warning.includes("No monthly Xero balance data is stored")
      )
    ).toBe(true);
  });

  it("overlays the comparison series on the revenue trend and omits it when compare is none", async () => {
    const withComparison = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view: "revenue" },
    });
    const revenueTrend = withComparison.trends[0];
    expect(revenueTrend.series.map((series) => series.key)).toEqual([
      "amount",
      "comparison",
    ]);
    expect(revenueTrend.data[0]).toMatchObject({
      label: "May 2026",
      amount: 100_000,
      comparison: 80_000,
    });

    const withoutComparison = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view: "revenue", compare: "none" },
    });
    expect(mockBuildFinanceMonthlyPnlSummary).toHaveBeenLastCalledWith(
      expect.objectContaining({ comparison: null })
    );
    expect(withoutComparison.selectionLabels.comparisonWindow).toBe("None");
  });

  it("renders a gap, not a $0 bar, for unaligned trailing comparison months", async () => {
    mockBuildFinanceMonthlyPnlSummary.mockImplementation(
      async (input: { kind: "REVENUE" | "EXPENSE" }) => ({
        ...mappedSummary(input.kind),
        trend: [
          {
            monthKey: "2026-05",
            label: "May 2026",
            amountCents: 100_000,
            comparisonAmountCents: 80_000,
            isProvisional: false,
          },
          {
            // A comparison window shorter than the primary leaves this month
            // unaligned (null), which must render as a gap rather than $0.
            monthKey: "2026-06",
            label: "Jun 2026",
            amountCents: 120_000,
            comparisonAmountCents: null,
            isProvisional: false,
          },
        ],
      })
    );

    const model = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view: "revenue" },
    });
    const trend = model.trends[0];

    expect(trend.data[0]).toMatchObject({
      label: "May 2026",
      amount: 100_000,
      comparison: 80_000,
    });
    expect(trend.data[1]).toMatchObject({ label: "Jun 2026", amount: 120_000 });
    // The unaligned month omits the comparison key so the chart draws a gap.
    expect("comparison" in trend.data[1]).toBe(false);
  });

  /*
    #3123 — the finance page's own two temporal questions come from the CLUB.

    `generatedOn` is a real INSTANT (the moment the model was built) and takes the
    club's persisted zone; the reporting month comes from the club's TODAY, which
    the page resolves once and threads into `finance-dashboard-ranges` because that
    module is on the browser graph and may read no zone at all.

    Under the frozen clock (2026-07-01T00:00:00.000Z) Auckland reads 1 July and
    Denver reads 30 June, so the two never agree and nothing here can pass by
    coincidence. This block shares the file's `APP_TIME_ZONE = America/Denver` pin,
    which is what makes the default cases above assertions about the club rather
    than the container.
  */
  describe("the finance page's dates come from the persisted club zone (#3123)", () => {
    beforeEach(() => {
      mockGetFinanceBookingMetrics.mockResolvedValue(bookingMetrics());
    });

    it("stamps generatedOn with the club's day, not the container's", async () => {
      // BEFORE the migration this read "1 Jul 2026, 6:00 pm" — Denver's clock
      // through APP_TIME_ZONE — no matter what the club had configured.
      persistClubZone("America/Denver");
      const model = await buildFinanceDashboardPageModel({
        member: financeManager(),
        searchParams: { view: "bookings" },
      });
      expect(model.generatedOn).toContain("30 Jun 2026");
      expect(model.generatedOn).not.toContain("1 Jul 2026");
    });

    it("moves generatedOn with the persisted zone — kills a hard-coded one", async () => {
      // The leg a literal club zone cannot pass.
      persistClubZone("Pacific/Auckland");
      const auckland = await buildFinanceDashboardPageModel({
        member: financeManager(),
        searchParams: { view: "bookings" },
      });
      persistClubZone("Pacific/Pago_Pago");
      const pago = await buildFinanceDashboardPageModel({
        member: financeManager(),
        searchParams: { view: "bookings" },
      });
      expect(auckland.generatedOn).toContain("1 Jul 2026");
      expect(pago.generatedOn).toContain("30 Jun 2026");
    });

    it("picks the reporting month from the club's today, across a month end", async () => {
      /*
        THE ONE THAT MOVES MONEY. `currentMonth` selects the reporting month and
        the financial-year bucket, so on 1 July UTC a club at UTC-11 is still in
        June and its "last completed month" is May, not June. Reading that day off
        the container put a whole finance figure in the wrong period.
      */
      persistClubZone("Pacific/Auckland");
      const auckland = await buildFinanceDashboardPageModel({
        member: financeManager(),
        searchParams: { view: "bookings" },
      });
      persistClubZone("Pacific/Pago_Pago");
      const pago = await buildFinanceDashboardPageModel({
        member: financeManager(),
        searchParams: { view: "bookings" },
      });
      expect(auckland.selection.currentMonth).toBe("2026-07");
      expect(pago.selection.currentMonth).toBe("2026-06");
      expect(auckland.selection.primary.fromMonth).toBe("2026-06");
      expect(pago.selection.primary.fromMonth).toBe("2026-05");
    });
  });
});
