import Link from "next/link";
import {
  ArrowLeft,
  ArrowUpRight,
  Database,
  Filter,
  ShieldAlert,
  Wallet,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  buildDefaultFinanceBalanceSheetReportFilters,
  buildFinanceBalanceSheetReportHref,
} from "@/lib/finance-balance-sheet-report-page";
import {
  buildDefaultFinanceCashReportFilters,
  buildFinanceCashReportHref,
} from "@/lib/finance-cash-report-page";
import { requireFinanceViewer } from "@/lib/finance-auth";
import {
  buildFinanceWorkingCapitalReportPageModel,
  type FinanceWorkingCapitalReportPeriodRow,
  type FinanceWorkingCapitalReportSummaryCard,
} from "@/lib/finance-working-capital-report-page";

type FinanceWorkingCapitalPageSearchParams = Promise<
  Record<string, string | string[] | undefined>
>;

function SummaryCards({
  cards,
}: {
  cards: FinanceWorkingCapitalReportSummaryCard[];
}) {
  return (
    <section className="space-y-5">
      <div className="flex items-start gap-3">
        <div className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-700">
          <Wallet className="h-5 w-5" />
        </div>
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
            Working capital
          </p>
          <h2 className="text-2xl font-semibold text-slate-900">
            Current-position detail from stored balance-sheet snapshots
          </h2>
          <p className="text-sm leading-6 text-slate-600">
            This page derives current assets, current liabilities, working
            capital, and current-assets coverage from stored finance
            balance-sheet snapshots inside Tokoroa Alpine Club - Bookings.
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => (
          <Card key={card.title}>
            <CardHeader className="pb-3">
              <CardDescription>{card.title}</CardDescription>
              <CardTitle className="text-3xl text-slate-900">
                {card.value}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-sm leading-6 text-slate-600">
                {card.description}
              </p>
              {card.footnote ? (
                <p className="text-xs font-medium text-slate-500">
                  {card.footnote}
                </p>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

function WorkingCapitalPeriodTable({
  rows,
}: {
  rows: FinanceWorkingCapitalReportPeriodRow[];
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>As of</TableHead>
          <TableHead>Source window</TableHead>
          <TableHead className="text-right">Current assets</TableHead>
          <TableHead className="text-right">Current liabilities</TableHead>
          <TableHead className="text-right">Working capital</TableHead>
          <TableHead className="text-right">Current ratio</TableHead>
          <TableHead className="text-right">Current-asset lines</TableHead>
          <TableHead className="text-right">Current-liability lines</TableHead>
          <TableHead className="text-right">Snapshot updated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.snapshotId}>
            <TableCell className="font-medium text-slate-900">
              {row.asOfDateLabel}
            </TableCell>
            <TableCell>{row.sourceWindow}</TableCell>
            <TableCell className="text-right font-medium text-slate-900">
              {row.currentAssets}
            </TableCell>
            <TableCell className="text-right">
              {row.currentLiabilities}
            </TableCell>
            <TableCell className="text-right font-medium text-slate-900">
              {row.workingCapital}
            </TableCell>
            <TableCell className="text-right">{row.currentRatio}</TableCell>
            <TableCell className="text-right">
              {row.currentAssetLineItemCount}
            </TableCell>
            <TableCell className="text-right">
              {row.currentLiabilityLineItemCount}
            </TableCell>
            <TableCell className="text-right">
              {row.sourceUpdatedAtLabel}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default async function FinanceWorkingCapitalPage({
  searchParams,
}: {
  searchParams?: FinanceWorkingCapitalPageSearchParams;
}) {
  const member = await requireFinanceViewer("/finance/working-capital");
  const model = await buildFinanceWorkingCapitalReportPageModel({
    member,
    searchParams: searchParams ? await searchParams : undefined,
  });
  const balanceSheetReportHref = buildFinanceBalanceSheetReportHref(
    buildDefaultFinanceBalanceSheetReportFilters(),
  );
  const cashReportHref = buildFinanceCashReportHref(
    buildDefaultFinanceCashReportFilters(),
  );

  return (
    <div className="space-y-8">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(22rem,0.85fr)]">
        <Card>
          <CardHeader className="space-y-3">
            <Badge variant="outline" className="w-fit">
              Native working-capital report
            </Badge>
            <div className="space-y-2">
              <CardTitle className="text-2xl text-slate-900">
                Current working-capital coverage from durable finance snapshots
              </CardTitle>
              <CardDescription className="max-w-3xl text-sm leading-6 text-slate-600">
                This page turns the landed `BALANCE_SHEET` finance snapshot
                dataset into a native `/finance/working-capital` report with
                explicit current-section assumptions, summary cards, and stored
                period comparisons.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              Generated {model.generatedOn}. Working-capital figures on this
              page come from stored balance-sheet snapshots only. No Tokoroa Alpine Club
              booking totals, payment-derived cash summaries, live Xero reads,
              or forecasting calculations are used here.
            </div>

            <form action="/finance/working-capital" className="space-y-4">
              <div className="space-y-3 rounded-xl border border-slate-200 p-4">
                <div className="flex items-center gap-2">
                  <Filter className="h-4 w-4 text-slate-500" />
                  <p className="text-sm font-semibold text-slate-900">
                    Stored balance-sheet snapshots
                  </p>
                </div>
                <div className="grid gap-3 sm:max-w-xs">
                  <div className="space-y-2">
                    <Label htmlFor="periods">Snapshots</Label>
                    <Input
                      id="periods"
                      name="periods"
                      type="number"
                      min={1}
                      max={24}
                      defaultValue={model.filters.periods}
                    />
                    <p className="text-xs leading-5 text-slate-500">
                      Choose how many of the latest stored balance-sheet
                      snapshots to include in the working-capital view.
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button type="submit">Apply period selection</Button>
                <Button asChild variant="outline">
                  <Link href="/finance/working-capital">Reset defaults</Link>
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-1">
                <CardTitle className="text-lg text-slate-900">
                  Working-capital actions
                </CardTitle>
                <CardDescription className="text-sm text-slate-600">
                  Cross-check current-position assumptions against the adjacent
                  finance reports without mixing source ownership.
                </CardDescription>
              </div>
              <Badge variant={model.isManager ? "secondary" : "outline"}>
                {model.isManager ? "Manager view" : "Viewer view"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button
              asChild
              variant="outline"
              className="w-full justify-between"
            >
              <Link href={balanceSheetReportHref}>
                <span className="text-left">
                  <span className="block text-sm font-medium">
                    Open balance-sheet report
                  </span>
                  <span className="block text-xs text-slate-500">
                    Inspect the full stored balance-sheet positions behind these
                    current-section totals.
                  </span>
                </span>
                <ArrowUpRight className="ml-3 h-4 w-4 shrink-0" />
              </Link>
            </Button>

            <Button
              asChild
              variant="outline"
              className="w-full justify-between"
            >
              <Link href={cashReportHref}>
                <span className="text-left">
                  <span className="block text-sm font-medium">
                    Open cash report
                  </span>
                  <span className="block text-xs text-slate-500">
                    Compare stored bank balances without conflating them with
                    working-capital totals.
                  </span>
                </span>
                <ArrowUpRight className="ml-3 h-4 w-4 shrink-0" />
              </Link>
            </Button>

            <Button asChild variant="ghost" className="w-full justify-between">
              <Link href="/finance">
                Back to finance landing page
                <ArrowLeft className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      {model.filterWarnings.length > 0 ? (
        <Card className="border-amber-200 bg-amber-50/60">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg text-amber-950">
              <ShieldAlert className="h-5 w-5" />
              Some filters were reset
            </CardTitle>
            <CardDescription className="space-y-2 text-amber-900">
              {model.filterWarnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {model.loadError ? (
        <Card className="border-amber-200 bg-amber-50/60">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg text-amber-950">
              <ShieldAlert className="h-5 w-5" />
              Working capital unavailable
            </CardTitle>
            <CardDescription className="text-amber-900">
              {model.loadError}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <SummaryCards cards={model.summaryCards} />

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            <Card>
              <CardHeader>
                <div className="flex items-start gap-3">
                  <div className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-700">
                    <Database className="h-5 w-5" />
                  </div>
                  <div className="space-y-1">
                    <CardTitle className="text-xl text-slate-900">
                      Working-capital comparison detail
                    </CardTitle>
                    <CardDescription className="text-sm leading-6 text-slate-600">
                      {model.coverageSummary}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <WorkingCapitalPeriodTable rows={model.periodRows} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-start gap-3">
                  <div className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-700">
                    <Database className="h-5 w-5" />
                  </div>
                  <div className="space-y-1">
                    <CardTitle className="text-xl text-slate-900">
                      Source notes
                    </CardTitle>
                    <CardDescription className="text-sm leading-6 text-slate-600">
                      The page stays tied to stored balance-sheet current
                      sections and explicit non-goals.
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {model.sourceNotes.map((note) => (
                  <div
                    key={note.label}
                    className="rounded-xl border border-slate-200 p-4"
                  >
                    <p className="text-sm font-semibold text-slate-900">
                      {note.label}
                    </p>
                    <p className="mt-1 text-sm leading-6 text-slate-600">
                      {note.description}
                    </p>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
