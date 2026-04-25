import Link from "next/link";
import {
  ArrowLeft,
  ArrowUpRight,
  Database,
  Filter,
  ShieldAlert,
  TrendingDown,
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
import { requireFinanceViewer } from "@/lib/finance-auth";
import {
  buildFinanceCostsReportPageModel,
  type FinanceCostsReportLineItemRow,
  type FinanceCostsReportMonthlyRow,
  type FinanceCostsReportSummaryCard,
} from "@/lib/finance-costs-report-page";

type FinanceCostsPageSearchParams = Promise<
  Record<string, string | string[] | undefined>
>;

function SummaryCards({
  cards,
}: {
  cards: FinanceCostsReportSummaryCard[];
}) {
  return (
    <section className="space-y-5">
      <div className="flex items-start gap-3">
        <div className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-700">
          <TrendingDown className="h-5 w-5" />
        </div>
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
            Costs report
          </p>
          <h2 className="text-2xl font-semibold text-slate-900">
            Monthly finance snapshot cost detail
          </h2>
          <p className="text-sm leading-6 text-slate-600">
            Stored monthly profit-and-loss snapshots now surface cost totals
            and expense mix directly inside Tokoroa Alpine Club - Bookings for finance viewers and
            managers.
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

function MonthlyCostsTable({
  rows,
}: {
  rows: FinanceCostsReportMonthlyRow[];
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Period</TableHead>
          <TableHead>Source window</TableHead>
          <TableHead className="text-right">Costs total</TableHead>
          <TableHead className="text-right">Cost lines</TableHead>
          <TableHead className="text-right">Snapshot updated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.snapshotId}>
            <TableCell className="font-medium text-slate-900">
              <div>{row.periodLabel}</div>
              <div className="text-xs font-normal text-slate-500">
                As of {row.asOfDateLabel}
              </div>
            </TableCell>
            <TableCell>{row.sourceWindow}</TableCell>
            <TableCell className="text-right font-medium text-slate-900">
              {row.totalCosts}
            </TableCell>
            <TableCell className="text-right">{row.lineItemCount}</TableCell>
            <TableCell className="text-right">{row.sourceUpdatedAtLabel}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function CostsLineItemTable({
  rows,
}: {
  rows: FinanceCostsReportLineItemRow[];
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Cost section</TableHead>
          <TableHead>Cost line</TableHead>
          <TableHead className="text-right">Latest period</TableHead>
          <TableHead className="text-right">Selected periods total</TableHead>
          <TableHead className="text-right">Periods present</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={`${row.section}:${row.lineItem}`}>
            <TableCell className="font-medium text-slate-900">
              {row.section}
            </TableCell>
            <TableCell>{row.lineItem}</TableCell>
            <TableCell className="text-right">{row.latestPeriodAmount}</TableCell>
            <TableCell className="text-right font-medium text-slate-900">
              {row.selectedPeriodsAmount}
            </TableCell>
            <TableCell className="text-right">{row.periodsPresent}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default async function FinanceCostsPage({
  searchParams,
}: {
  searchParams?: FinanceCostsPageSearchParams;
}) {
  const member = await requireFinanceViewer("/finance/costs");
  const model = await buildFinanceCostsReportPageModel({
    member,
    searchParams: searchParams ? await searchParams : undefined,
  });

  return (
    <div className="space-y-8">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(22rem,0.85fr)]">
        <Card>
          <CardHeader className="space-y-3">
            <Badge variant="outline" className="w-fit">
              Native costs report
            </Badge>
            <div className="space-y-2">
              <CardTitle className="text-2xl text-slate-900">
                Monthly costs from durable finance snapshots
              </CardTitle>
              <CardDescription className="max-w-3xl text-sm leading-6 text-slate-600">
                This page turns the landed profit-and-loss monthly finance
                snapshot dataset into a native `/finance/costs` report with
                summary cards, monthly detail, and expense line breakdowns for
                the selected stored periods.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              Generated {model.generatedOn}. Cost totals on this page come from
              stored finance snapshots synced through the finance-only Xero
              boundary. No Tokoroa Alpine Club booking metrics, payment-derived cash,
              or live Xero reads are used here.
            </div>

            <form action="/finance/costs" className="space-y-4">
              <div className="space-y-3 rounded-xl border border-slate-200 p-4">
                <div className="flex items-center gap-2">
                  <Filter className="h-4 w-4 text-slate-500" />
                  <p className="text-sm font-semibold text-slate-900">
                    Stored costs periods
                  </p>
                </div>
                <div className="grid gap-3 sm:max-w-xs">
                  <div className="space-y-2">
                    <Label htmlFor="periods">Monthly snapshots</Label>
                    <Input
                      id="periods"
                      name="periods"
                      type="number"
                      min={1}
                      max={24}
                      defaultValue={model.filters.periods}
                    />
                    <p className="text-xs leading-5 text-slate-500">
                      Choose how many of the latest stored monthly
                      profit-and-loss snapshots to include.
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button type="submit">Apply period selection</Button>
                <Button asChild variant="outline">
                  <Link href="/finance/costs">Reset defaults</Link>
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg text-slate-900">
              Report actions and source notes
            </CardTitle>
            <CardDescription className="text-sm text-slate-600">
              Costs stay explicitly finance-snapshot-backed here so they are not
              conflated with Tokoroa Alpine Club booking, cash, or balance-sheet totals.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {model.isManager ? (
              <Button asChild variant="outline" className="w-full justify-between">
                <Link href="/api/finance/sync/status" target="_blank" rel="noreferrer">
                  <span className="text-left">
                    <span className="block text-sm font-medium">
                      Open sync diagnostics JSON
                    </span>
                    <span className="block text-xs text-slate-500">
                      Manager-only detail for the latest durable finance sync.
                    </span>
                  </span>
                  <ArrowUpRight className="ml-3 h-4 w-4 shrink-0" />
                </Link>
              </Button>
            ) : (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-600">
                Finance viewer access does not expose manager-only finance sync
                diagnostics here.
              </div>
            )}

            <Button asChild variant="ghost" className="w-full justify-between">
              <Link href="/finance">
                Back to finance landing page
                <ArrowLeft className="h-4 w-4" />
              </Link>
            </Button>

            <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
              {model.sourceNotes.map((note) => (
                <div key={note.label} className="space-y-1">
                  <p className="text-sm font-medium text-slate-900">
                    {note.label}
                  </p>
                  <p className="text-sm leading-6 text-slate-600">
                    {note.description}
                  </p>
                </div>
              ))}
            </div>
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
              Report unavailable
            </CardTitle>
            <CardDescription className="text-amber-900">
              {model.loadError}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <SummaryCards cards={model.summaryCards} />

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(22rem,1fr)]">
            <Card>
              <CardHeader>
                <div className="flex items-start gap-3">
                  <div className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-700">
                    <Database className="h-5 w-5" />
                  </div>
                  <div className="space-y-1">
                    <CardTitle className="text-lg text-slate-900">
                      Snapshot cost positions
                    </CardTitle>
                    <CardDescription className="text-sm text-slate-600">
                      {model.coverageSummary}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <MonthlyCostsTable rows={model.monthlyRows} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg text-slate-900">
                  Stored cost line items
                </CardTitle>
                <CardDescription className="text-sm text-slate-600">
                  Line items stay grouped by the stored profit-and-loss section
                  labels so the page remains aligned with the finance snapshot
                  source.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {model.lineItemRows.length > 0 ? (
                  <CostsLineItemTable rows={model.lineItemRows} />
                ) : (
                  <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-600">
                    No cost detail rows were available in the selected stored
                    snapshots.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
