"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  financeFinancialYearBuckets,
  last12MonthWindow,
  ratioForWindow,
  sumRatioSeries,
  type FinanceRatioMatrix,
  type FinanceRatioSeries,
} from "@/lib/finance-ratio-shared";
import {
  formatDollarsDisplay,
  formatFinancePercent,
} from "@/lib/finance-format";
import { formatClubShortMonthYear, requireCalendarDate } from "@/lib/club-time";

/*
  Finance chart axes need the SHORT month ("Apr 2026"), where the kernel's
  `monthYear` shape is the long one ("April 2026"). F3 (#3079) declared the short
  bag as `shortMonthYear` for exactly the two call sites that were keeping a local
  formatter, so this is now one kernel call (CT-4, #2870).

  A MONTH IS A CALENDAR CONCEPT AND TAKES NO TIMEZONE. The value is the first day
  of a finance month, so the shape pins `UTC` over the kernel's own UTC-midnight
  encoding — provably the identity, where the local formatter's earlier
  `APP_TIME_ZONE` pin cancelled only because New Zealand is east of Greenwich. For
  a club that is not, every axis label and every range chip named the PREVIOUS
  month.
*/

const chartLoading = () => <div style={{ height: 300 }} />;
const TrendChart = dynamic(
  () =>
    import("@/components/finance/charts/trend-chart").then((m) => m.TrendChart),
  { ssr: false, loading: chartLoading }
);

interface RatioExplorerProps {
  matrix: FinanceRatioMatrix;
  initialNumeratorId?: string | null;
  initialDenominatorId?: string | null;
  initialRangeKey?: string | null;
}

interface RangeChip {
  key: string;
  label: string;
  fromMonth: string;
  toMonth: string;
}

function shortMonthLabel(monthKey: string) {
  return formatClubShortMonthYear(requireCalendarDate(`${monthKey}-01`));
}

function defaultSeriesId(
  series: FinanceRatioSeries[],
  kind: "REVENUE" | "EXPENSE",
  nameHint: string,
  totalId: string
): string {
  const hinted = series.find(
    (entry) =>
      entry.kind === kind &&
      !entry.isTotal &&
      entry.name.toLowerCase().includes(nameHint)
  );
  if (hinted) {
    return hinted.id;
  }
  const firstOfKind = series.find((entry) => entry.kind === kind && !entry.isTotal);
  return firstOfKind?.id ?? totalId;
}

function buildRangeChips(matrix: FinanceRatioMatrix): RangeChip[] {
  const [thisFy, lastFy, fyBefore] = financeFinancialYearBuckets(matrix);
  const lastDataMonth = matrix.months.at(-1) ?? matrix.currentMonth;
  const firstDataMonth = matrix.months[0] ?? matrix.currentMonth;
  const last12 = last12MonthWindow(matrix);

  return [
    { key: "this-fy", ...thisFy },
    { key: "last-fy", ...lastFy },
    { key: "fy-before", ...fyBefore },
    {
      key: "last-12",
      label: "Last 12 months",
      fromMonth: last12.fromMonth,
      toMonth: last12.toMonth,
    },
    {
      key: "all",
      label: "All history",
      fromMonth: firstDataMonth,
      toMonth: lastDataMonth,
    },
  ];
}

function syncQueryParams(numeratorId: string, denominatorId: string, range: string) {
  if (typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  url.searchParams.set("ratioNumerator", numeratorId);
  url.searchParams.set("ratioDenominator", denominatorId);
  url.searchParams.set("ratioRange", range);
  window.history.replaceState(null, "", url.toString());
}

export function RatioExplorer({
  matrix,
  initialNumeratorId,
  initialDenominatorId,
  initialRangeKey,
}: RatioExplorerProps) {
  const chips = useMemo(() => buildRangeChips(matrix), [matrix]);
  const seriesById = useMemo(
    () => new Map(matrix.series.map((series) => [series.id, series])),
    [matrix]
  );

  const [numeratorId, setNumeratorId] = useState(() =>
    initialNumeratorId && seriesById.has(initialNumeratorId)
      ? initialNumeratorId
      : defaultSeriesId(matrix.series, "EXPENSE", "catering", "total-expenses")
  );
  const [denominatorId, setDenominatorId] = useState(() =>
    initialDenominatorId && seriesById.has(initialDenominatorId)
      ? initialDenominatorId
      : defaultSeriesId(matrix.series, "REVENUE", "hut", "total-income")
  );
  const [rangeKey, setRangeKey] = useState(() =>
    initialRangeKey && chips.some((chip) => chip.key === initialRangeKey)
      ? initialRangeKey
      : (chips[0]?.key ?? "this-fy")
  );

  const numerator = seriesById.get(numeratorId) ?? matrix.series[0];
  const denominator = seriesById.get(denominatorId) ?? matrix.series[0];
  const activeChip = chips.find((chip) => chip.key === rangeKey) ?? chips[0];

  const headline = useMemo(() => {
    if (!numerator || !denominator || !activeChip) {
      return null;
    }
    return ratioForWindow(matrix, numerator, denominator, activeChip);
  }, [matrix, numerator, denominator, activeChip]);

  const fyTable = useMemo(() => {
    if (!numerator || !denominator) {
      return [];
    }
    return financeFinancialYearBuckets(matrix).map((bucket) => ({
      label: bucket.label,
      ratio: ratioForWindow(matrix, numerator, denominator, bucket),
      numeratorCents: sumRatioSeries(matrix, numerator, bucket),
      denominatorCents: sumRatioSeries(matrix, denominator, bucket),
    }));
  }, [matrix, numerator, denominator]);

  const sparklineData = useMemo(() => {
    if (!numerator || !denominator || !activeChip) {
      return [];
    }
    const provisional = new Set(matrix.provisionalMonths);
    return matrix.months.flatMap((month, index) => {
      if (month < activeChip.fromMonth || month > activeChip.toMonth) {
        return [];
      }
      const denominatorCents = denominator.valuesCents[index] ?? 0;
      if (denominatorCents === 0) {
        return [];
      }
      return [
        {
          label: provisional.has(month)
            ? `${shortMonthLabel(month)} (MTD)`
            : shortMonthLabel(month),
          ratio: (numerator.valuesCents[index] ?? 0) / denominatorCents,
        },
      ];
    });
  }, [matrix, numerator, denominator, activeChip]);

  const includesProvisional = Boolean(
    activeChip &&
      matrix.provisionalMonths.some(
        (month) => month >= activeChip.fromMonth && month <= activeChip.toMonth
      )
  );

  const selectSeries = (kind: "numerator" | "denominator") => (id: string) => {
    if (kind === "numerator") {
      setNumeratorId(id);
      syncQueryParams(id, denominatorId, rangeKey);
    } else {
      setDenominatorId(id);
      syncQueryParams(numeratorId, id, rangeKey);
    }
  };

  if (matrix.months.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Ratios</CardTitle>
          <CardDescription>
            No monthly Xero data is stored yet. Run the finance sync, or the
            monthly-facts backfill for history, then revisit this view.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Ratio explorer</CardTitle>
          <CardDescription>
            Pick any category and compare it to another — for example catering
            cost as a share of hut-fee income — then flick through financial
            years without reloading.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ratio-numerator">Show</Label>
              <select
                id="ratio-numerator"
                value={numeratorId}
                onChange={(event) => selectSeries("numerator")(event.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm"
              >
                {matrix.series.map((series) => (
                  <option key={series.id} value={series.id}>
                    {series.name}
                    {series.kind === "EXPENSE" ? " (expense)" : " (income)"}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ratio-denominator">As a percentage of</Label>
              <select
                id="ratio-denominator"
                value={denominatorId}
                onChange={(event) =>
                  selectSeries("denominator")(event.target.value)
                }
                className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm"
              >
                {matrix.series.map((series) => (
                  <option key={series.id} value={series.id}>
                    {series.name}
                    {series.kind === "EXPENSE" ? " (expense)" : " (income)"}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {chips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={() => {
                  setRangeKey(chip.key);
                  syncQueryParams(numeratorId, denominatorId, chip.key);
                }}
                className={`rounded-full border px-3 py-1 text-sm ${
                  chip.key === rangeKey
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-transparent text-foreground hover:bg-muted"
                }`}
              >
                {chip.label}
              </button>
            ))}
          </div>

          <div className="rounded-lg border border-border bg-muted p-4">
            <div className="text-sm text-muted-foreground">
              {numerator?.name} ÷ {denominator?.name} — {activeChip?.label}
            </div>
            <div className="text-4xl font-semibold text-card-foreground">
              {headline === null ? "—" : formatFinancePercent(headline)}
            </div>
            <div className="text-sm text-muted-foreground">
              {numerator && activeChip
                ? formatDollarsDisplay(
                    sumRatioSeries(matrix, numerator, activeChip)
                  )
                : "—"}{" "}
              of{" "}
              {denominator && activeChip
                ? formatDollarsDisplay(
                    sumRatioSeries(matrix, denominator, activeChip)
                  )
                : "—"}
              {includesProvisional
                ? " · includes the in-progress month (month-to-date)"
                : ""}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Financial year</th>
                  <th className="py-2 pr-4 font-medium">Ratio</th>
                  <th className="py-2 pr-4 font-medium">{numerator?.name}</th>
                  <th className="py-2 font-medium">{denominator?.name}</th>
                </tr>
              </thead>
              <tbody>
                {fyTable.map((row) => (
                  <tr key={row.label} className="border-b border-border/60">
                    <td className="py-2 pr-4">{row.label}</td>
                    <td className="py-2 pr-4 font-semibold">
                      {row.ratio === null ? "—" : formatFinancePercent(row.ratio)}
                    </td>
                    <td className="py-2 pr-4">
                      {formatDollarsDisplay(row.numeratorCents)}
                    </td>
                    <td className="py-2">
                      {formatDollarsDisplay(row.denominatorCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Monthly ratio trend</CardTitle>
          <CardDescription>
            {numerator?.name} as a share of {denominator?.name} per month over{" "}
            {activeChip?.label}. Months where the denominator is zero are
            omitted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sparklineData.length > 0 ? (
            <TrendChart
              variant="line"
              xKey="label"
              data={sparklineData}
              series={[
                {
                  key: "ratio",
                  name: "Ratio",
                  color: "#0d9488",
                  valueType: "percent",
                },
              ]}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              No months in this range have a non-zero denominator.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
