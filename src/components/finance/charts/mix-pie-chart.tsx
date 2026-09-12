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

const LABEL_RADIAN = Math.PI / 180;

// #2190 P4 — Recharts fills the outer slice labels with the SLICE colour by
// default, which fails WCAG AA on the light card for every cat-scale fill. Render
// the labels as theme-NEUTRAL text (`--foreground`, always max contrast on the
// card in both modes) positioned from the slice geometry Recharts passes.
function renderMixLabel(props: {
  cx?: number;
  cy?: number;
  midAngle?: number;
  outerRadius?: number;
  name?: string;
  percent?: number;
}) {
  const cx = props.cx ?? 0;
  const cy = props.cy ?? 0;
  const midAngle = props.midAngle ?? 0;
  const outerRadius = props.outerRadius ?? 0;
  const { name, percent } = props;
  const r = outerRadius + 18;
  const x = cx + r * Math.cos(-midAngle * LABEL_RADIAN);
  const y = cy + r * Math.sin(-midAngle * LABEL_RADIAN);
  return (
    <text
      x={x}
      y={y}
      textAnchor={x > cx ? "start" : "end"}
      dominantBaseline="central"
      style={{ fill: "var(--foreground)", fontSize: "11px" }}
    >
      {name} ({Math.round((percent ?? 0) * 100)}%)
    </text>
  );
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
      <p className="py-8 text-center text-sm text-muted-foreground">{emptyMessage}</p>
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
    const [entry] = payload;
    if (!entry) return null;
    const value = Number(entry.value ?? 0);
    const share = total > 0 ? value / total : 0;
    return (
      <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-sm">
        <p className="font-semibold text-popover-foreground">{entry.name}</p>
        <p className="text-muted-foreground">
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
              label={renderMixLabel}
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
        <p className="mt-2 text-center text-xs text-muted-foreground">
          {omittedCount} line{omittedCount === 1 ? "" : "s"} with a zero or
          negative amount {omittedCount === 1 ? "is" : "are"} not shown; use
          CSV export for the full breakdown.
        </p>
      ) : null}
    </div>
  );
}
