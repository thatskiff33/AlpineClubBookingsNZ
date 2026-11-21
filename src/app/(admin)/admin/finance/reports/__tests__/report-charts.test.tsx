// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { render, screen } from "@/lib/__tests__/support/club-time-render";
import { describe, expect, it, vi } from "vitest";
import { ClubFormatProvider } from "@/components/club-format-provider";
import { formatClubDayMonth, requireCalendarDate } from "@/lib/club-time";

type ChartPoint = Record<string, unknown>;

/**
 * A stand-in recharts: each chart records the `data` it was handed, the
 * x-axis renders its `tickFormatter` over every point's `dataKey`, and the
 * tooltip renders its `labelFormatter` for the first point — the same value
 * recharts hands it (the x-axis key, plus the point as payload).
 */
let activeChartData: ChartPoint[] = [];
let activeXKey = "";

vi.mock("recharts", () => {
  const chart = ({ data, children }: { data: ChartPoint[]; children: ReactNode }) => {
    activeChartData = data;
    return <div>{children}</div>;
  };
  return {
    BarChart: chart,
    AreaChart: chart,
    LineChart: chart,
    ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Tooltip: ({
      formatter,
      labelFormatter,
    }: {
      formatter?: (value: unknown) => ReactNode[];
      labelFormatter?: (value: unknown, payload: Array<{ payload: ChartPoint }>) => ReactNode;
    }) => {
      const point = activeChartData[0];
      return (
        <div data-testid="tooltip">
          <span data-testid="tooltip-label">
            {labelFormatter?.(point[activeXKey], [{ payload: point }])}
          </span>
          {formatter?.(point.revenueCents ?? point.occupancyRate).map((value, index) => (
            <span key={index}>{value}</span>
          ))}
        </div>
      );
    },
    XAxis: ({
      dataKey,
      tickFormatter,
    }: {
      dataKey: string;
      tickFormatter?: (value: unknown) => string;
    }) => {
      activeXKey = dataKey;
      return (
        <div data-testid="x-axis">
          {activeChartData.map((point, index) => (
            <span key={index} data-testid="x-tick">
              {tickFormatter ? tickFormatter(point[dataKey]) : String(point[dataKey])}
            </span>
          ))}
        </div>
      );
    },
    YAxis: ({ tickFormatter }: { tickFormatter?: (value: number) => string }) => (
      <div data-testid="y-axis">
        {tickFormatter
          ? activeChartData.map((point, index) => (
              <span key={index}>{tickFormatter(Number(point.revenueCents))}</span>
            ))
          : null}
      </div>
    ),
    Bar: () => null,
    CartesianGrid: () => null,
    Line: () => null,
    Area: () => null,
    PieChart: () => null,
    Pie: () => null,
    Cell: () => null,
    Legend: () => null,
  };
});

import {
  OccupancyAreaChart,
  RevenueBarChart,
  TrendsLineChart,
} from "@/app/(admin)/admin/finance/reports/_components/report-charts";

function GermanSwiss({ children }: { children: ReactNode }) {
  return (
    <ClubFormatProvider currencyCode="CHF" locale="de-CH">
      {children}
    </ClubFormatProvider>
  );
}

function ticks(): string[] {
  return screen.getAllByTestId("x-tick").map((tick) => tick.textContent ?? "");
}

function tooltipLabel(): string {
  return screen.getByTestId("tooltip-label").textContent ?? "";
}

const OCCUPANCY = [
  { date: "2026-04-16", occupancyRate: 40 },
  { date: "2026-04-17", occupancyRate: 55 },
];

const TREND_ROW = {
  total: 3,
  pending: 0,
  paymentPending: 0,
  confirmed: 1,
  paid: 2,
  awaitingReview: 0,
  completed: 0,
};

const TRENDS = [
  { week: "2026-04-13", ...TREND_ROW },
  { week: "2026-04-20", ...TREND_ROW },
];

describe("OccupancyAreaChart date labels (#5258)", () => {
  it("writes the axis and tooltip in the club's en-NZ format", () => {
    render(<OccupancyAreaChart data={OCCUPANCY} />);
    expect(ticks()).toEqual(["16 Apr", "17 Apr"]);
    expect(tooltipLabel()).toBe("Thu, 16 Apr 2026");
    expect(screen.getByTestId("tooltip")).toHaveTextContent("40%Occupancy");
  });

  it("writes the axis and tooltip in the club's de-CH format", () => {
    render(<OccupancyAreaChart data={OCCUPANCY} />, { wrapper: GermanSwiss });
    expect(ticks()).toEqual(["16. Apr.", "17. Apr."]);
    expect(tooltipLabel()).toBe("Do., 16. Apr. 2026");
  });

  it("reads a daily label the same way as the page's own en-NZ dates", () => {
    render(<OccupancyAreaChart data={OCCUPANCY} />);
    expect(ticks()[0]).toBe(
      formatClubDayMonth(requireCalendarDate("2026-04-16"), { locale: "en-NZ" }),
    );
  });

  it("charts exactly the data it was given, and renders a malformed key as itself", () => {
    const data = [...OCCUPANCY, { date: "not-a-day", occupancyRate: 0 }];
    render(<OccupancyAreaChart data={data} />);
    expect(activeChartData).toBe(data);
    expect(ticks()).toEqual(["16 Apr", "17 Apr", "not-a-day"]);
  });
});

describe("TrendsLineChart date labels (#5258)", () => {
  it("writes the axis and tooltip in the club's en-NZ format", () => {
    render(<TrendsLineChart data={TRENDS} />);
    expect(ticks()).toEqual(["13 Apr", "20 Apr"]);
    expect(tooltipLabel()).toBe("Week of 13 Apr 2026");
  });

  it("writes the axis and tooltip in the club's de-CH format", () => {
    render(<TrendsLineChart data={TRENDS} />, { wrapper: GermanSwiss });
    expect(ticks()).toEqual(["13. Apr.", "20. Apr."]);
    expect(tooltipLabel()).toBe("Week of 13.04.2026");
  });

  it("charts exactly the data it was given", () => {
    render(<TrendsLineChart data={TRENDS} />);
    expect(activeChartData).toBe(TRENDS);
  });
});

describe("RevenueBarChart", () => {
  it("renders exact integer cents on the revenue axis and tooltip", () => {
    render(
      <RevenueBarChart
        data={[
          {
            label: "First night",
            tooltipLabel: "Monday 1 June 2026",
            revenueCents: 33,
          },
          {
            label: "Second night",
            tooltipLabel: "Tuesday 2 June 2026",
            revenueCents: 34,
          },
          {
            label: "Whole stay",
            tooltipLabel: "June 2026",
            revenueCents: 13_500,
          },
        ]}
        granularity="monthly"
      />,
    );

    const tooltip = screen.getByTestId("tooltip");
    expect(tooltip).toHaveTextContent("Monday 1 June 2026");
    expect(tooltip).toHaveTextContent("$0.33");
    expect(tooltip).toHaveTextContent("Booked revenue");
    expect(screen.getByTestId("y-axis")).toHaveTextContent(
      "$0.33$0.34$135.00",
    );
    // The revenue axis shows the server-written label verbatim.
    expect(ticks()).toEqual(["First night", "Second night", "Whole stay"]);
  });
});
