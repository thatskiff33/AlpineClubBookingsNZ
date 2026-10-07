// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { render, screen } from "@/lib/__tests__/support/club-time-render";
import { describe, expect, it, vi } from "vitest";

let activeChartData: Array<{
  label: string;
  revenueCents: number;
  tooltipLabel?: string;
}> = [];

vi.mock("recharts", () => ({
  BarChart: ({
    data,
    children,
  }: {
    data: typeof activeChartData;
    children: ReactNode;
  }) => {
    activeChartData = data;
    return <div>{children}</div>;
  },
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Tooltip: ({
    formatter,
    labelFormatter,
  }: {
    formatter: (value: number) => ReactNode[];
    labelFormatter: (
      value: string,
      payload: Array<{ payload: (typeof activeChartData)[number] }>,
    ) => ReactNode;
  }) => {
    const point = activeChartData[0];
    return (
      <div data-testid="revenue-tooltip">
        <span>{labelFormatter(point.label, [{ payload: point }])}</span>
        {formatter(point.revenueCents).map((value, index) => (
          <span key={index}>{value}</span>
        ))}
      </div>
    );
  },
  Bar: () => null,
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: ({ tickFormatter }: { tickFormatter?: (value: number) => string }) => (
    <div data-testid="revenue-axis">
      {tickFormatter
        ? activeChartData.map((point) => (
            <span key={point.label}>{tickFormatter(point.revenueCents)}</span>
          ))
        : null}
    </div>
  ),
  LineChart: () => null,
  Line: () => null,
  AreaChart: () => null,
  Area: () => null,
  PieChart: () => null,
  Pie: () => null,
  Cell: () => null,
  Legend: () => null,
}));

import { RevenueBarChart } from "@/app/(admin)/admin/reports/_components/report-charts";

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

    const tooltip = screen.getByTestId("revenue-tooltip");
    expect(tooltip).toHaveTextContent("Monday 1 June 2026");
    expect(tooltip).toHaveTextContent("$0.33");
    expect(tooltip).toHaveTextContent("Booked revenue");
    expect(screen.getByTestId("revenue-axis")).toHaveTextContent(
      "$0.33$0.34$135.00",
    );
  });
});
