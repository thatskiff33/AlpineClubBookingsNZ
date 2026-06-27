import { describe, expect, it } from "vitest";
import {
  resolveFinanceDashboardSelection,
  resolveForwardFinanceWindow,
  resolvePrimaryFinanceRange,
} from "@/lib/finance-dashboard-ranges";

const TODAY = new Date("2026-06-28T00:00:00.000Z");

describe("finance dashboard range selectors", () => {
  it("defaults to bookings, last month, previous month, and next month", () => {
    const selection = resolveFinanceDashboardSelection({ today: TODAY });

    expect(selection.view).toBe("bookings");
    expect(selection.range).toBe("last-month");
    expect(selection.compare).toBe("previous-month");
    expect(selection.forward).toBe("next-month");
    expect(selection.primary).toMatchObject({
      from: "2026-05-01",
      to: "2026-05-31",
      label: "May 2026",
    });
    expect(selection.comparison).toMatchObject({
      from: "2026-04-01",
      to: "2026-04-30",
      label: "April 2026",
    });
    expect(selection.forwardWindow).toMatchObject({
      from: "2026-07-01",
      to: "2026-07-31",
      label: "July 2026",
    });
  });

  it("treats last 12 months as completed calendar months ending last month", () => {
    const range = resolvePrimaryFinanceRange({
      option: "last-12-months",
      today: TODAY,
    });

    expect(range).toMatchObject({
      from: "2025-06-01",
      to: "2026-05-31",
      label: "June 2025 to May 2026",
    });
  });

  it("validates custom windows and falls back with a warning", () => {
    const selection = resolveFinanceDashboardSelection({
      today: TODAY,
      searchParams: {
        range: "custom",
        from: "2026-05-20",
        to: "2026-05-01",
        compare: "custom",
        compareFrom: "bad-date",
        compareTo: "2026-04-30",
        forward: "custom",
        forwardFrom: "2026-07-10",
      },
    });

    expect(selection.primary).toMatchObject({
      from: "2026-05-01",
      to: "2026-05-31",
    });
    expect(selection.comparison).toMatchObject({
      from: "2026-04-01",
      to: "2026-04-30",
    });
    expect(selection.forwardWindow).toMatchObject({
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(selection.warnings).toEqual([
      "Primary range custom end date must be on or after the start date. Showing May 2026.",
      "Comparison range custom dates were invalid. Showing April 2026.",
      "Forward window custom dates were incomplete. Showing July 2026.",
    ]);
  });

  it("uses configured active or upcoming seasons for Rest of Season", () => {
    const window = resolveForwardFinanceWindow({
      option: "rest-of-season",
      today: TODAY,
      seasons: [
        {
          name: "Winter 2026",
          startDate: new Date("2026-06-01T00:00:00.000Z"),
          endDate: new Date("2026-10-31T00:00:00.000Z"),
          active: true,
        },
      ],
    });

    expect(window).toMatchObject({
      from: "2026-06-28",
      to: "2026-10-31",
      seasonName: "Winter 2026",
    });
  });

  it("warns instead of guessing when Rest of Season has no configured season", () => {
    const warnings: string[] = [];
    const window = resolveForwardFinanceWindow({
      option: "rest-of-season",
      today: TODAY,
      seasons: [],
      warnings,
    });

    expect(window).toEqual({
      from: null,
      to: null,
      label: "Rest of Season unavailable",
    });
    expect(warnings).toEqual([
      "Rest of Season needs an active or upcoming configured season. Configure seasons before using this forward window.",
    ]);
  });
});
