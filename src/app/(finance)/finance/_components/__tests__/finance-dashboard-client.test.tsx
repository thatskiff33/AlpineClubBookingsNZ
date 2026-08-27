// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
import { ClubTimeProvider } from "@/components/club-time-provider";
import { bindClubTime, fixedClubClock, requireClubTimeZone } from "@/lib/club-time";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FinanceDashboardClient } from "@/app/(finance)/finance/_components/finance-dashboard-client";
import { parseDateOnly } from "@/lib/date-only";
import { resolveFinanceDashboardSelection } from "@/lib/finance-dashboard-ranges";
import type { FinanceDashboardPageModel } from "@/lib/finance-dashboard-page";

const mocks = vi.hoisted(() => ({
  routerReplace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.routerReplace }),
}));

vi.mock("next/dynamic", () => ({
  default: () => () => null,
}));

vi.mock("@/components/finance/charts/kpi-stat-card", () => ({
  KpiStatCard: () => null,
}));

vi.mock("@/app/(finance)/finance/_components/ratio-explorer", () => ({
  RatioExplorer: () => null,
}));

const TODAY = parseDateOnly("2026-08-01");

function buildModel(
  searchParams?: Record<string, string>,
): FinanceDashboardPageModel {
  const selection = resolveFinanceDashboardSelection({
    searchParams,
    today: TODAY,
    financialYearEndMonth: 3,
  });

  return {
    generatedOn: "1 Aug 2026",
    isManager: false,
    selection,
    ratios: null,
    selectionLabels: {
      view: "Costs",
      range: "Last Month",
      compare: "Previous Period",
      forward: "Next Month",
      primaryWindow: "July 2026",
      comparisonWindow: "June 2026",
      forwardWindow: "September 2026",
    },
    syncStatus: {
      label: "Current",
      tone: "success",
      detail: "Finance data is current.",
      lastSyncedAt: null,
    },
    warnings: [],
    cards: [],
    trends: [],
    mix: null,
    statusPanels: [],
    costFilters: {
      categories: [{ id: "food", label: "Food" }],
      lines: [{ value: "groceries", label: "Groceries", categoryId: "food" }],
    },
    sourceNotes: [],
    exportSections: [],
    lodges: [
      { id: "lodge-1", name: "Lodge One" },
      { id: "lodge-2", name: "Lodge Two" },
    ],
    selectedLodgeId: searchParams?.lodgeId ?? null,
  };
}

describe("FinanceDashboardClient dataset Reset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("always renders Reset and disables it only at selector defaults", () => {
    render(
      <FinanceDashboardClient
        model={buildModel({ view: "costs" })}
        currentSearch="view=costs"
      />,
    );

    expect(
      screen.getByRole("button", {
        name: /Reset\. Search, filters, sort, and page are already at their defaults\./,
      }),
    ).toBeDisabled();
  });

  it("replaces the URL after removing only Finance dataset keys", () => {
    const currentSearch =
      "view=costs&lodgeId=lodge-2&range=custom&compare=custom&from=2025-01&to=2025-03&compareFrom=2024-01&compareTo=2024-03&forward=custom&forwardFrom=2026-01&forwardTo=2026-04&expenseCategoryId=food&expenseLine=groceries&ratioNumerator=income&ratioDenominator=costs&ratioRange=fy-current&futureContext=keep";

    render(
      <FinanceDashboardClient
        model={buildModel(Object.fromEntries(new URLSearchParams(currentSearch)))}
        currentSearch={currentSearch}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));

    expect(mocks.routerReplace).toHaveBeenCalledTimes(1);
    const [path, options] = mocks.routerReplace.mock.calls[0];
    const resetUrl = new URL(path, "https://example.test");
    expect(options).toEqual({ scroll: false });
    expect(resetUrl.pathname).toBe("/finance");
    expect(resetUrl.searchParams.get("view")).toBe("costs");
    expect(resetUrl.searchParams.get("lodgeId")).toBe("lodge-2");
    expect(resetUrl.searchParams.get("ratioNumerator")).toBe("income");
    expect(resetUrl.searchParams.get("ratioDenominator")).toBe("costs");
    expect(resetUrl.searchParams.get("ratioRange")).toBe("fy-current");
    expect(resetUrl.searchParams.get("futureContext")).toBe("keep");
    for (const key of [
      "range",
      "compare",
      "from",
      "to",
      "compareFrom",
      "compareTo",
      "forward",
      "forwardFrom",
      "forwardTo",
      "expenseCategoryId",
      "expenseLine",
    ]) {
      expect(resetUrl.searchParams.has(key), key).toBe(false);
    }
  });

  it("re-seeds uncontrolled controls when replacement navigation updates the query", () => {
    const { rerender } = render(
      <FinanceDashboardClient
        model={buildModel({
          view: "costs",
          range: "last-3-months",
          expenseCategoryId: "food",
        })}
        currentSearch="view=costs&range=last-3-months&expenseCategoryId=food"
      />,
    );

    fireEvent.change(screen.getByLabelText("Range"), {
      target: { value: "last-12-months" },
    });
    expect(screen.getByLabelText("Range")).toHaveValue("last-12-months");

    rerender(
      <FinanceDashboardClient
        model={buildModel({ view: "costs" })}
        currentSearch="view=costs"
      />,
    );

    expect(screen.getByLabelText("Range")).toHaveValue("last-month");
    expect(screen.getByLabelText("Expense Category")).toHaveValue("");
  });
});

/*
  THE EXPORTED FILE IS STAMPED WITH THE CLUB'S DAY (CT-4 group E, #2870; epic
  #2988; INV-CONFIG-002).

  `downloadCsv` used to call `todayDateOnlyForTimeZone()`, which reads
  `APP_TIME_ZONE` — the container's `TZ`. It now takes the club's today from
  `useClubTime()`, so two treasurers in two countries exporting the same figures
  file them under the same club day.

  RENDERED UNDER TWO EXPLICIT ZONES rather than through the shared default, and
  that is the whole point: the default is `Pacific/Auckland`, which is also what
  the environment resolves to here, so a render through it cannot tell the
  persisted zone from the environment. The pair below can, on any host — an
  implementation that ignored the provider has one answer to give and fails one
  of the two halves.

  `America/Denver` is behind UTC, so on the frozen instant
  (2026-07-01T00:00:00.000Z) its day is 30 JUNE where New Zealand's is 1 July.
  The premise is asserted as those two ANSWERS rather than as a zone identifier,
  which would go vacuous on a host whose own zone happened to match.
*/
const CLUB_ZONE = "America/Denver";
const LEGACY_REFERENCE_ZONE = "Pacific/Auckland";
const frozenClock = fixedClubClock(new Date("2026-07-01T00:00:00.000Z"));

const urlAny = URL as unknown as {
  createObjectURL: unknown;
  revokeObjectURL: unknown;
};

describe("FinanceDashboardClient CSV stamp carries the club's day (CT-4, #2870)", () => {
  const realCreateObjectURL = urlAny.createObjectURL;
  const realRevokeObjectURL = urlAny.revokeObjectURL;
  let downloadedNames: string[] = [];
  let clickSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    downloadedNames = [];
    urlAny.createObjectURL = vi.fn(() => "blob:mock");
    urlAny.revokeObjectURL = vi.fn();
    clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloadedNames.push(this.download);
      });
  });

  afterEach(() => {
    clickSpy.mockRestore();
    urlAny.createObjectURL = realCreateObjectURL;
    urlAny.revokeObjectURL = realRevokeObjectURL;
  });

  function exportUnder(zone: string) {
    render(
      <ClubTimeProvider zone={zone}>
        <FinanceDashboardClient
          model={buildModel({ view: "costs" })}
          currentSearch="view=costs"
        />
      </ClubTimeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "CSV" }));
    return downloadedNames;
  }

  it("names the file with a behind-UTC club's day", () => {
    // PREMISE AS AN ANSWER: the two zones really are on different days here.
    expect(
      bindClubTime(requireClubTimeZone(CLUB_ZONE)).today(frozenClock),
    ).toBe("2026-06-30");
    expect(
      bindClubTime(requireClubTimeZone(LEGACY_REFERENCE_ZONE)).today(
        frozenClock,
      ),
    ).toBe("2026-07-01");

    expect(exportUnder(CLUB_ZONE)).toEqual(["finance-costs-2026-06-30.csv"]);
  });

  it("names it with a New Zealand club's day instead", () => {
    // The other half. A `downloadCsv` that read the environment, or the
    // treasurer's own browser, would answer both halves the same way.
    expect(exportUnder(LEGACY_REFERENCE_ZONE)).toEqual([
      "finance-costs-2026-07-01.csv",
    ]);
  });
});
