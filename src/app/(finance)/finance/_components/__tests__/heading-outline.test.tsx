// @vitest-environment jsdom

import type { ReactNode } from "react";
import { cleanup, render } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeAll, describe, it, vi } from "vitest";
import { FinanceDashboardClient } from "@/app/(finance)/finance/_components/finance-dashboard-client";
import FinanceDashboardLoading from "@/app/(finance)/finance/loading";
import FinanceError from "@/app/(finance)/finance/error";
import { parseDateOnly } from "@/lib/date-only";
import { resolveFinanceDashboardSelection } from "@/lib/finance-dashboard-ranges";
import type { FinanceDashboardPageModel } from "@/lib/finance-dashboard-page/model";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { applyTailwindHiddenRule, expectSoundOutline } from "@/lib/__tests__/support/heading-outline";

/**
 * The /finance workspace's heading outline in every state it renders (#5216,
 * `INV-PUB-006`). The workspace layout owns the screen's one h1 ("<club>
 * finance workspace"); the dashboard's cards are level 2 under it, its KPI
 * figures are not headings, and the error boundary is an h2 under the same h1.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ shortName: "Test Club" }),
}));

// The charts load through next/dynamic and draw SVG, never a heading.
vi.mock("next/dynamic", () => ({
  default: () => () => null,
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const LAYOUT_H1 = "Test Club finance workspace";

/**
 * The h1 `(finance)/finance/layout.tsx` renders above every page, boundary
 * included. The layout itself is a server component that reads the session,
 * so the test supplies its heading, word for word, around the real page.
 */
function UnderWorkspaceLayout({ children }: { children: ReactNode }) {
  return (
    <main>
      <h1>{LAYOUT_H1}</h1>
      {children}
    </main>
  );
}

const TODAY = parseDateOnly("2026-08-01");

function buildModel(overrides: Partial<FinanceDashboardPageModel> = {}): FinanceDashboardPageModel {
  return {
    generatedOn: "1 Aug 2026",
    isManager: false,
    selection: resolveFinanceDashboardSelection({
      searchParams: { view: "overview" },
      today: TODAY,
      format: CLUB_FORMAT_TEST,
      financialYearEndMonth: 3,
    }),
    ratios: null,
    selectionLabels: {
      view: "Overview",
      range: "Last Month",
      compare: "Previous Period",
      forward: "Next Month",
      primaryWindow: "July 2026",
      comparisonWindow: "June 2026",
      forwardWindow: "September 2026",
    },
    syncStatus: { label: "Current", tone: "success", detail: "Current.", lastSyncedAt: null },
    warnings: [],
    cards: [],
    trends: [],
    mix: null,
    statusPanels: [],
    costFilters: { categories: [], lines: [] },
    sourceNotes: [],
    exportSections: [],
    lodges: [],
    selectedLodgeId: null,
    ...overrides,
  };
}

const LOADED: Partial<FinanceDashboardPageModel> = {
  ratios: {
    matrix: {
      months: ["2026-06", "2026-07"],
      provisionalMonths: [],
      series: [
        { id: "total-income", name: "Total income", kind: "REVENUE", isTotal: true, valuesCents: [100_00, 200_00] },
        { id: "total-expenses", name: "Total expenses", kind: "EXPENSE", isTotal: true, valuesCents: [50_00, 80_00] },
      ],
      financialYearEndMonth: 3,
      currentMonth: "2026-07",
    } as NonNullable<FinanceDashboardPageModel["ratios"]>["matrix"],
    initialNumeratorId: null,
    initialDenominatorId: null,
    initialRangeKey: null,
  },
  cards: [{ title: "Revenue", value: "$300.00", description: "July 2026" }],
  trends: [
    {
      title: "Revenue trend",
      description: "By month",
      variant: "bar",
      xKey: "month",
      data: [{ month: "Jul", revenue: 300 }],
      series: [{ key: "revenue", name: "Revenue", color: "#000", valueType: "currency" }],
    },
  ],
  mix: { title: "Revenue mix", description: "By source", valueType: "currency", data: [{ name: "Hut fees", value: 300 }] },
  statusPanels: [
    {
      title: "Receivables",
      description: "Owed to the club",
      badgeLabel: "2 open",
      items: [{ label: "Invoices", value: "$40.00" }],
    },
  ],
  sourceNotes: [{ label: "Xero", description: "Monthly facts." }],
};

describe("/finance heading outline (#5216)", () => {
  // The dashboard's print-only title ("Finance - <view>") is an h1 that is
  // display:none on screen.
  beforeAll(applyTailwindHiddenRule);

  afterEach(() => {
    cleanup();
  });

  it.each([
    ["loaded, viewer", { ...LOADED }],
    ["loaded, manager (the sync button shows)", { ...LOADED, isManager: true }],
    ["empty: nothing synced yet", {}],
    [
      "no monthly data for the ratio explorer",
      {
        ratios: {
          ...LOADED.ratios!,
          matrix: { ...LOADED.ratios!.matrix, months: [], series: [] },
        },
      },
    ],
  ] as const)("%s", (_state, overrides) => {
    render(
      <UnderWorkspaceLayout>
        <FinanceDashboardClient model={buildModel(overrides)} currentSearch="view=overview" />
      </UnderWorkspaceLayout>,
    );
    expectSoundOutline(LAYOUT_H1);
  });

  it("loading", () => {
    render(
      <UnderWorkspaceLayout>
        <FinanceDashboardLoading />
      </UnderWorkspaceLayout>,
    );
    expectSoundOutline(LAYOUT_H1);
  });

  it("error: the boundary's heading sits under the layout's h1", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <UnderWorkspaceLayout>
        <FinanceError error={new Error("boom")} retry={vi.fn()} />
      </UnderWorkspaceLayout>,
    );
    expectSoundOutline(LAYOUT_H1);
  });
});
