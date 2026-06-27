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
import { KpiStatCard } from "@/components/finance/charts/kpi-stat-card";
import { MixPieChart } from "@/components/finance/charts/mix-pie-chart";
import { TrendChart } from "@/components/finance/charts/trend-chart";
import {
  FINANCE_DASHBOARD_COMPARE_LABELS,
  FINANCE_DASHBOARD_COMPARE_OPTIONS,
  FINANCE_DASHBOARD_FORWARD_LABELS,
  FINANCE_DASHBOARD_FORWARD_OPTIONS,
  FINANCE_DASHBOARD_RANGE_LABELS,
  FINANCE_DASHBOARD_RANGE_OPTIONS,
  FINANCE_DASHBOARD_VIEW_LABELS,
  FINANCE_DASHBOARD_VIEWS,
} from "@/lib/finance-dashboard-ranges";
import type { FinanceDashboardPageModel } from "@/lib/finance-dashboard-page";

interface FinanceDashboardClientProps {
  model: FinanceDashboardPageModel;
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

function downloadCsv(model: FinanceDashboardPageModel) {
  const csv = buildCsv(model);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `finance-${model.selection.view}-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function toneVariant(tone: FinanceDashboardPageModel["syncStatus"]["tone"]) {
  if (tone === "success") return "success";
  if (tone === "warning") return "warning";
  if (tone === "destructive") return "destructive";
  return "secondary";
}

export function FinanceDashboardClient({ model }: FinanceDashboardClientProps) {
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const reportRef = useRef<HTMLDivElement>(null);

  async function downloadPdf() {
    if (!reportRef.current) return;

    setGeneratingPdf(true);
    try {
      const { generateReportPDF } = await import("@/lib/report-pdf");
      await generateReportPDF(
        reportRef.current,
        {
          from: model.selection.primary.from,
          to: model.selection.primary.to,
        },
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
              <CardTitle className="text-2xl text-slate-900">
                {model.selectionLabels.view}
              </CardTitle>
              <CardDescription className="max-w-3xl text-sm leading-6 text-slate-600">
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
                onClick={() => downloadCsv(model)}
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

          <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
            {model.syncStatus.detail}
          </div>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 lg:grid-cols-4 xl:grid-cols-5" method="get">
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
            <div className="flex items-end">
              <Button type="submit" className="w-full">
                <Filter className="h-4 w-4" />
                Apply
              </Button>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="finance-from">From</Label>
              <Input
                id="finance-from"
                name="from"
                type="date"
                defaultValue={model.selection.primary.from}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="finance-to">To</Label>
              <Input
                id="finance-to"
                name="to"
                type="date"
                defaultValue={model.selection.primary.to}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="finance-compare-from">Compare From</Label>
              <Input
                id="finance-compare-from"
                name="compareFrom"
                type="date"
                defaultValue={model.selection.comparison.from}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="finance-compare-to">Compare To</Label>
              <Input
                id="finance-compare-to"
                name="compareTo"
                type="date"
                defaultValue={model.selection.comparison.to}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="finance-forward-from">Forward From</Label>
                <Input
                  id="finance-forward-from"
                  name="forwardFrom"
                  type="date"
                  defaultValue={model.selection.forwardWindow.from ?? ""}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="finance-forward-to">Forward To</Label>
                <Input
                  id="finance-forward-to"
                  name="forwardTo"
                  type="date"
                  defaultValue={model.selection.forwardWindow.to ?? ""}
                />
              </div>
            </div>

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
              className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
            >
              {warning}
            </div>
          ))}
        </div>
      ) : null}

      <div ref={reportRef} className="reports-print-root space-y-6">
        <div className="hidden print:block">
          <h1 className="text-2xl font-bold text-slate-900">
            Finance - {model.selectionLabels.view}
          </h1>
          <p className="text-sm text-slate-600">
            {model.selectionLabels.primaryWindow}; generated {model.generatedOn}
          </p>
        </div>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {model.cards.map((card) => (
            <KpiStatCard key={card.title} {...card} />
          ))}
        </section>

        <section className="grid gap-4 xl:grid-cols-2">
          {model.trends.map((trend) => (
            <Card key={trend.title} className="reports-print-card">
              <CardHeader>
                <CardTitle className="text-lg text-slate-900">
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
                <CardTitle className="text-lg text-slate-900">
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
                      <CardTitle className="text-lg text-slate-900">
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
                  {panel.items.map((item) => (
                    <div
                      key={`${panel.title}:${item.label}`}
                      className="flex items-center justify-between gap-4 rounded-md border border-slate-200 px-3 py-2 text-sm"
                    >
                      <div>
                        <p className="font-medium text-slate-900">
                          {item.label}
                        </p>
                        {item.detail ? (
                          <p className="text-xs text-slate-500">
                            {item.detail}
                          </p>
                        ) : null}
                      </div>
                      <p className="font-semibold text-slate-900">
                        {item.value}
                      </p>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}
          </section>
        ) : null}

        <section className="rounded-md border border-slate-200 bg-white p-4">
          <div className="mb-3 flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-slate-500" />
            <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-600">
              Sources
            </h2>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {model.sourceNotes.map((note) => (
              <div key={note.label}>
                <p className="text-sm font-medium text-slate-900">
                  {note.label}
                </p>
                <p className="text-sm leading-6 text-slate-600">
                  {note.description}
                </p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
