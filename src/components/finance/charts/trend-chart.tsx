"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  type FinanceValueType,
  formatFinanceAxisTick,
  formatFinanceValue,
} from "./finance-chart-theme";

export interface TrendChartSeries {
  key: string;
  name: string;
  color: string;
  valueType: FinanceValueType;
  /** Stack id for stacked bars/areas. Series sharing an id stack together. */
  stackId?: string;
}

export interface TrendChartProps {
  variant: "bar" | "area" | "line";
  data: Array<Record<string, number | string>>;
  series: TrendChartSeries[];
  xKey: string;
  height?: number;
  emptyMessage?: string;
}

interface TooltipPayloadEntry {
  name?: number | string;
  value?: number | string | ReadonlyArray<number | string>;
  color?: string;
  dataKey?: string | number | ((obj: never) => unknown);
}

export function TrendChart({
  variant,
  data,
  series,
  xKey,
  height = 300,
  emptyMessage = "No data available for this period.",
}: TrendChartProps) {
  if (data.length === 0 || series.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {emptyMessage}
      </p>
    );
  }

  const [firstSeries] = series;
  // Unreachable: the length check above already returned for an empty
  // `series`, so this can only be undefined if that guarantee is violated.
  // "count" is the same fallback formatFinanceValue/formatFinanceAxisTick
  // already use for an unrecognised valueType (their own `default` case),
  // not a new invented choice.
  const axisValueType = firstSeries?.valueType ?? "count";
  const seriesByKey = new Map(series.map((entry) => [entry.key, entry]));

  const renderTooltip = ({
    active,
    label,
    payload,
  }: {
    active?: boolean;
    label?: string | number;
    payload?: readonly TooltipPayloadEntry[];
  }) => {
    if (!active || !payload || payload.length === 0) {
      return null;
    }

    return (
      <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-sm">
        <p className="mb-1 font-semibold text-popover-foreground">{label}</p>
        {payload.map((entry) => {
          const matched = seriesByKey.get(String(entry.dataKey));
          return (
            <p key={String(entry.dataKey)} className="text-muted-foreground">
              <span style={{ color: entry.color ?? matched?.color }}>●</span>{" "}
              {matched?.name ?? entry.name}:{" "}
              {formatFinanceValue(
                Number(entry.value ?? 0),
                matched?.valueType ?? axisValueType
              )}
            </p>
          );
        })}
      </div>
    );
  };

  const sharedAxes = (
    <>
      {/* Grid/axis/tick colours are themed in globals.css via `.finance-trend-chart
          .recharts-*` selectors — CSS var() does not resolve inside SVG
          presentation attributes, so these literals are only the light-mode
          fallback and the CSS rules override them (incl. dark mode). */}
      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
      <XAxis
        dataKey={xKey}
        tick={{ fontSize: 12 }}
        stroke="#94a3b8"
        tickMargin={8}
      />
      <YAxis
        tick={{ fontSize: 12 }}
        stroke="#94a3b8"
        width={64}
        tickFormatter={(value: number) =>
          formatFinanceAxisTick(value, axisValueType)
        }
      />
      <Tooltip content={renderTooltip} />
      {series.length > 1 ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null}
    </>
  );

  return (
    <div
      className="finance-trend-chart h-[300px] print:h-[220px]"
      style={{ height }}
    >
      <ResponsiveContainer width="100%" height="100%">
        {variant === "bar" ? (
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            {sharedAxes}
            {series.map((entry) => (
              <Bar
                key={entry.key}
                dataKey={entry.key}
                name={entry.name}
                fill={entry.color}
                stackId={entry.stackId}
                radius={[4, 4, 0, 0]}
              />
            ))}
          </BarChart>
        ) : variant === "area" ? (
          <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            {sharedAxes}
            {series.map((entry) => (
              <Area
                key={entry.key}
                type="monotone"
                dataKey={entry.key}
                name={entry.name}
                stroke={entry.color}
                fill={entry.color}
                fillOpacity={0.2}
                stackId={entry.stackId}
              />
            ))}
          </AreaChart>
        ) : (
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            {sharedAxes}
            {series.map((entry) => (
              <Line
                key={entry.key}
                type="monotone"
                dataKey={entry.key}
                name={entry.name}
                stroke={entry.color}
                strokeWidth={2}
                dot={false}
              />
            ))}
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
