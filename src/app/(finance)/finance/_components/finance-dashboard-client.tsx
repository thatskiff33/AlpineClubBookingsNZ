"use client";

import { useRef, useState } from "react";
import {
  Download,
  FileDown,
  Filter,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { KpiStatCard } from "@/components/finance/charts/kpi-stat-card";
import { DatasetResetButton } from "@/components/admin/dataset-reset-button";
import { useClubTime } from "@/components/club-time-provider";

// Charts load on demand (#1147): recharts is ~139kB gz, so the chart
// components mount after the dashboard shell instead of blocking First Load
// JS. Placeholders match the charts' default 300px height for layout
// stability.
const chartLoading = () => <div style={{ height: 300 }} />;
const MixPieChart = dynamic(
  () =>
    import("@/components/finance/charts/mix-pie-chart").then(
      (m) => m.MixPieChart
    ),
  { ssr: false, loading: chartLoading }
);
const TrendChart = dynamic(
  () =>
    import("@/components/finance/charts/trend-chart").then(
      (m) => m.TrendChart
    ),
  { ssr: false, loading: chartLoading }
);
import {
  FINANCE_DASHBOARD_COMPARE_LABELS,
  FINANCE_DASHBOARD_COMPARE_OPTIONS,
  FINANCE_DASHBOARD_FORWARD_LABELS,
  FINANCE_DASHBOARD_FORWARD_OPTIONS,
  FINANCE_DASHBOARD_RANGE_LABELS,
  FINANCE_DASHBOARD_RANGE_OPTIONS,
  FINANCE_DASHBOARD_VIEW_LABELS,
  FINANCE_DASHBOARD_VIEWS,
  financeDashboardViewUsesLodgeScope,
} from "@/lib/finance-dashboard-ranges";
import type { FinanceDashboardPageModel } from "@/lib/finance-dashboard-page";
import {
  isFinanceDashboardDatasetDefault,
  resetFinanceDashboardDatasetSearchParams,
} from "@/lib/admin-dataset-reset-state";
import { RatioExplorer } from "./ratio-explorer";

interface FinanceDashboardClientProps {
  model: FinanceDashboardPageModel;
  currentSearch: string;
}

function toCsvCell(value: string | number) {
  const text = String(value);
  if (text.includes(",") || text.includes('"') || text.includes("\n")) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function buildCsv(model: FinanceDashboardPageModel) {
  const rows: string[][] = [];

  for (const section of model.exportSections) {
    rows.push([section.title]);
    const keys = Array.from(
      new Set(section.rows.flatMap((row) => Object.keys(row))),
    );
    if (keys.length > 0) {
      rows.push(keys);
      for (const row of section.rows) {
        rows.push(keys.map((key) => String(row[key] ?? "")));
      }
    }
    rows.push([]);
  }

  return rows.map((row) => row.map(toCsvCell).join(",")).join("\n");
}

/**
 * The exported file is stamped with the CLUB'S TODAY, not the viewer's and not
 * the container's (CT-4, #2870; epic #2988; INV-CONFIG-002).
 *
 * `today` is passed in rather than read here because this is a module function,
 * and the club's zone now reaches the browser as data through `ClubTimeProvider`
 * — a hook cannot be called from outside a component. It used to be
 * `todayDateOnlyForTimeZone()`, which reads `APP_TIME_ZONE`; the shape is
 * unchanged and only the authority moved. It matters because two treasurers in
 * two countries exporting the same figures must file them under the same club
 * day, or the club's own records disagree with each other.
 */
function downloadCsv(model: FinanceDashboardPageModel, today: string) {
  const csv = buildCsv(model);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `finance-${model.selection.view}-${today}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function toneVariant(tone: FinanceDashboardPageModel["syncStatus"]["tone"]) {
  if (tone === "success") return "success";
  if (tone === "warning") return "warning";
  if (tone === "destructive") return "destructive";
  return "secondary";
}

export function FinanceDashboardClient({
  model,
  currentSearch,
}: FinanceDashboardClientProps) {
  const router = useRouter();
  const clubTime = useClubTime();
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const reportRef = useRef<HTMLDivElement>(null);
  // Ratios picks its range client-side; sync health has no time window.
  const hideRangeControls =
    model.selection.view === "ratios" || model.selection.view === "sync-health";
  const isDatasetDefault = isFinanceDashboardDatasetDefault(model.selection);

  function resetDataset() {
    const params = resetFinanceDashboardDatasetSearchParams(currentSearch);
    const query = params.toString();
    router.replace(query ? `/finance?${query}` : "/finance", { scroll: false });
  }

  async function downloadPdf() {
    if (!reportRef.current) return;

    setGeneratingPdf(true);
    try {
      const { generateReportPDF } = await import("@/lib/report-pdf");
      // The club's persisted zone decides the cover date and the filename day
      // (#3123); this component already holds the binding.
      await generateReportPDF(
        reportRef.current,
        {
          from: model.selection.primary.from,
          to: model.selection.primary.to,
        },
        clubTime,
        {
          title: `Finance - ${model.selectionLabels.view}`,
        },
      );
    } catch (error) {
      console.error("Finance PDF generation failed", error);
      window.print();
    } finally {
      setGeneratingPdf(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card className="print:hidden">
        <CardHeader className="space-y-4">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">Finance dashboard</Badge>
                <Badge variant={toneVariant(model.syncStatus.tone)}>
                  {model.syncStatus.label}
                </Badge>
              </div>
              <CardTitle className="text-2xl text-card-foreground">
                {model.selectionLabels.view}
              </CardTitle>
              <CardDescription className="max-w-3xl text-sm leading-6 text-muted-foreground">
                {model.selectionLabels.primaryWindow} compared with{" "}
                {model.selectionLabels.comparisonWindow}. Forward window:{" "}
                {model.selectionLabels.forwardWindow}.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              {model.isManager ? (
                <form action="/api/finance/sync/run" method="post">
                  <Button type="submit" size="sm">
                    <RefreshCw className="h-4 w-4" />
                    Run Finance Sync Now
                  </Button>
                </form>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => downloadCsv(model, clubTime.today())}
              >
                <Download className="h-4 w-4" />
                CSV
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={downloadPdf}
                disabled={generatingPdf}
              >
                <FileDown className="h-4 w-4" />
                {generatingPdf ? "Generating" : "PDF"}
              </Button>
            </div>
          </div>

          <div className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
            {model.syncStatus.detail}
          </div>
        </CardHeader>
        <CardContent>
          <form
            key={currentSearch}
            className="grid gap-4 lg:grid-cols-4 xl:grid-cols-5"
            method="get"
          >
            <div className="space-y-1.5">
              <Label htmlFor="finance-view">View</Label>
              <select
                id="finance-view"
                name="view"
                defaultValue={model.selection.view}
                className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm"
              >
                {FINANCE_DASHBOARD_VIEWS.map((view) => (
                  <option key={view} value={view}>
                    {FINANCE_DASHBOARD_VIEW_LABELS[view]}
                  </option>
                ))}
              </select>
            </div>
            {/* The lodge scope applies to booking-derived reads only, so the
                selector appears on exactly those views — the same rule the
                server reads when it scopes the seasons (#2919). */}
            {model.lodges.length > 0 &&
            financeDashboardViewUsesLodgeScope(model.selection.view) ? (
              <div className="space-y-1.5">
                <Label htmlFor="finance-lodge">Lodge (occupancy)</Label>
                <select
                  id="finance-lodge"
                  name="lodgeId"
                  defaultValue={model.selectedLodgeId ?? ""}
                  className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm"
                >
                  <option value="">All lodges</option>
                  {model.lodges.map((lodge) => (
                    <option key={lodge.id} value={lodge.id}>
                      {lodge.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {!hideRangeControls ? (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="finance-range">Range</Label>
                  <select
                    id="finance-range"
                    name="range"
                    defaultValue={model.selection.range}
                    className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm"
                  >
                    {FINANCE_DASHBOARD_RANGE_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {FINANCE_DASHBOARD_RANGE_LABELS[option]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="finance-compare">Compare</Label>
                  <select
                    id="finance-compare"
                    name="compare"
                    defaultValue={model.selection.compare}
                    className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm"
                  >
                    {FINANCE_DASHBOARD_COMPARE_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {FINANCE_DASHBOARD_COMPARE_LABELS[option]}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            ) : null}
            {model.selection.view === "bookings" ? (
              <div className="space-y-1.5">
                <Label htmlFor="finance-forward">Forward</Label>
                <select
                  id="finance-forward"
                  name="forward"
                  defaultValue={model.selection.forward}
                  className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm"
                >
                  {FINANCE_DASHBOARD_FORWARD_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {FINANCE_DASHBOARD_FORWARD_LABELS[option]}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <div className="flex items-end gap-2">
              <Button type="submit" className="flex-1">
                <Filter className="h-4 w-4" />
                Apply
              </Button>
              <DatasetResetButton
                disabled={isDatasetDefault}
                onReset={resetDataset}
              />
            </div>

            {!hideRangeControls ? (
              <>
                {/* Start a new grid row so Apply stays the last control on the
                    first row and the month range inputs wrap beneath it (the
                    5-column layout otherwise placed "From month" after Apply on
                    the same row). */}
                <div className="space-y-1.5 xl:col-start-1">
                  <Label htmlFor="finance-from">From month</Label>
                  <Input
                    id="finance-from"
                    name="from"
                    type="month"
                    defaultValue={model.selection.primary.fromMonth}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="finance-to">To month</Label>
                  <Input
                    id="finance-to"
                    name="to"
                    type="month"
                    defaultValue={model.selection.primary.toMonth}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="finance-compare-from">Compare from month</Label>
                  <Input
                    id="finance-compare-from"
                    name="compareFrom"
                    type="month"
                    defaultValue={model.selection.comparison?.fromMonth ?? ""}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="finance-compare-to">Compare to month</Label>
                  <Input
                    id="finance-compare-to"
                    name="compareTo"
                    type="month"
                    defaultValue={model.selection.comparison?.toMonth ?? ""}
                  />
                </div>
              </>
            ) : null}
            {model.selection.view === "bookings" ? (
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="finance-forward-from">Forward from</Label>
                  <Input
                    id="finance-forward-from"
                    name="forwardFrom"
                    type="month"
                    defaultValue={model.selection.forwardWindow.from?.slice(0, 7) ?? ""}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="finance-forward-to">Forward to</Label>
                  <Input
                    id="finance-forward-to"
                    name="forwardTo"
                    type="month"
                    defaultValue={model.selection.forwardWindow.to?.slice(0, 7) ?? ""}
                  />
                </div>
              </div>
            ) : null}

            {model.costFilters ? (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="expense-category">Expense Category</Label>
                  <select
                    id="expense-category"
                    name="expenseCategoryId"
                    defaultValue={model.selection.expenseCategoryId ?? ""}
                    className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm"
                  >
                    <option value="">All categories</option>
                    {model.costFilters.categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="expense-line">Expense Line</Label>
                  <select
                    id="expense-line"
                    name="expenseLine"
                    defaultValue={model.selection.expenseLine ?? ""}
                    className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm"
                  >
                    <option value="">All lines</option>
                    {model.costFilters.lines.map((line) => (
                      <option
                        key={`${line.categoryId}:${line.value}`}
                        value={line.value}
                      >
                        {line.label}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            ) : null}
          </form>
        </CardContent>
      </Card>

      {model.warnings.length > 0 ? (
        <div className="space-y-2">
          {model.warnings.map((warning) => (
            <div
              key={warning}
              className="rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-11"
            >
              {warning}
            </div>
          ))}
        </div>
      ) : null}

      <div ref={reportRef} className="reports-print-root space-y-6">
        <div className="hidden print:block">
          <h1 className="text-2xl font-bold text-foreground">
            Finance - {model.selectionLabels.view}
          </h1>
          <p className="text-sm text-muted-foreground">
            {model.selectionLabels.primaryWindow}; generated {model.generatedOn}
          </p>
        </div>

        {model.ratios ? (
          <RatioExplorer
            matrix={model.ratios.matrix}
            initialNumeratorId={model.ratios.initialNumeratorId}
            initialDenominatorId={model.ratios.initialDenominatorId}
            initialRangeKey={model.ratios.initialRangeKey}
          />
        ) : null}

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {model.cards.map((card) => (
            <KpiStatCard key={card.title} {...card} />
          ))}
        </section>

        <section className="grid gap-4 xl:grid-cols-2">
          {model.trends.map((trend) => (
            <Card key={trend.title} className="reports-print-card">
              <CardHeader>
                <CardTitle className="text-lg text-card-foreground">
                  {trend.title}
                </CardTitle>
                <CardDescription>{trend.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <TrendChart
                  variant={trend.variant}
                  data={trend.data}
                  series={trend.series}
                  xKey={trend.xKey}
                />
              </CardContent>
            </Card>
          ))}

          {model.mix ? (
            <Card className="reports-print-card">
              <CardHeader>
                <CardTitle className="text-lg text-card-foreground">
                  {model.mix.title}
                </CardTitle>
                <CardDescription>{model.mix.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <MixPieChart
                  data={model.mix.data}
                  valueType={model.mix.valueType}
                />
              </CardContent>
            </Card>
          ) : null}
        </section>

        {model.statusPanels.length > 0 ? (
          <section className="grid gap-4 xl:grid-cols-2">
            {model.statusPanels.map((panel) => (
              <Card key={panel.title} className="reports-print-card">
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <CardTitle className="text-lg text-card-foreground">
                        {panel.title}
                      </CardTitle>
                      <CardDescription>{panel.description}</CardDescription>
                    </div>
                    {panel.badgeLabel ? (
                      <Badge variant={panel.badgeTone ?? "secondary"}>
                        {panel.badgeLabel}
                      </Badge>
                    ) : null}
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  {panel.items.map((item, itemIndex) => (
                    <div
                      key={`${panel.title}:${itemIndex}:${item.label}`}
                      className={
                        item.emphasis
                          ? "flex items-center justify-between gap-4 rounded-md border border-border bg-muted px-3 py-2 text-sm"
                          : "flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2 text-sm"
                      }
                    >
                      <div>
                        <p
                          className={
                            item.emphasis
                              ? "text-xs font-semibold uppercase tracking-[0.12em] text-foreground"
                              : "font-medium text-card-foreground"
                          }
                        >
                          {item.label}
                        </p>
                        {item.detail ? (
                          <p className="text-xs text-muted-foreground">
                            {item.detail}
                          </p>
                        ) : null}
                        {item.href ? (
                          <a
                            href={item.href}
                            className="text-xs text-info-11 hover:underline"
                          >
                            {item.linkLabel ?? "Open"}
                          </a>
                        ) : null}
                      </div>
                      <p className="font-semibold text-card-foreground">
                        {item.value}
                      </p>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}
          </section>
        ) : null}

        <section className="rounded-md border border-border bg-card p-4 text-card-foreground">
          <div className="mb-3 flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Sources
            </h2>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {model.sourceNotes.map((note) => (
              <div key={note.label}>
                <p className="text-sm font-medium text-card-foreground">
                  {note.label}
                </p>
                <p className="text-sm leading-6 text-muted-foreground">
                  {note.description}
                </p>
                {note.href ? (
                  <a
                    href={note.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-info-11 hover:underline"
                  >
                    {note.linkLabel ?? "Open in Xero"}
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
