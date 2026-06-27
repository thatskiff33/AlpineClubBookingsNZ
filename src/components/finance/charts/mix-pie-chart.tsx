"use client";

import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import {
  FINANCE_MIX_COLORS,
  type FinanceValueType,
  formatFinanceValue,
} from "./finance-chart-theme";

export interface MixPieChartDatum {
  name: string;
  value: number;
}

export interface MixPieChartProps {
  data: MixPieChartDatum[];
  valueType?: FinanceValueType;
  colors?: readonly string[];
  height?: number;
  emptyMessage?: string;
}

interface TooltipPayloadEntry {
  name?: number | string;
  value?: number | string | ReadonlyArray<number | string>;
}

export function MixPieChart({
  data,
  valueType = "currency",
  colors = FINANCE_MIX_COLORS,
  height = 300,
  emptyMessage = "No breakdown available for this period.",
}: MixPieChartProps) {
  const positive = data.filter((datum) => datum.value > 0);

  if (positive.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-slate-500">{emptyMessage}</p>
    );
  }

  const total = positive.reduce((sum, datum) => sum + datum.value, 0);
  // A pie cannot render zero/negative slices, so they are excluded from the
  // chart and its percentage base. Surface the count so the chart is not
  // silently inconsistent with exported detail (e.g. an income reversal line).
  const omittedCount = data.length - positive.length;

  const renderTooltip = ({
    active,
    payload,
  }: {
    active?: boolean;
    payload?: readonly TooltipPayloadEntry[];
  }) => {
    if (!active || !payload || payload.length === 0) {
      return null;
    }
    const entry = payload[0];
    const value = Number(entry.value ?? 0);
    const share = total > 0 ? value / total : 0;
    return (
      <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-sm">
        <p className="font-semibold text-slate-900">{entry.name}</p>
        <p className="text-slate-600">
          {formatFinanceValue(value, valueType)} (
          {(share * 100).toFixed(0)}%)
        </p>
      </div>
    );
  };

  return (
    <div>
      <div className="h-[300px] print:h-[220px]" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={positive}
              dataKey="value"
              nameKey="name"
              innerRadius={55}
              outerRadius={90}
              paddingAngle={3}
              label={({ name, percent }) =>
                `${name} (${((percent ?? 0) * 100).toFixed(0)}%)`
              }
              labelLine={false}
            >
              {positive.map((datum, index) => (
                <Cell
                  key={datum.name}
                  fill={colors[index % colors.length]}
                />
              ))}
            </Pie>
            <Tooltip content={renderTooltip} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      {omittedCount > 0 ? (
        <p className="mt-2 text-center text-xs text-slate-500">
          {omittedCount} line{omittedCount === 1 ? "" : "s"} with a zero or
          negative amount {omittedCount === 1 ? "is" : "are"} not shown; use
          CSV export for the full breakdown.
        </p>
      ) : null}
    </div>
  );
}
