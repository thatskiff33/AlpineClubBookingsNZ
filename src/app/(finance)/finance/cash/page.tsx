import Link from "next/link";
import {
  ArrowLeft,
  ArrowUpRight,
  Database,
  Filter,
  ShieldAlert,
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
  buildFinanceCashReportPageModel,
  type FinanceCashReportAccountRow,
  type FinanceCashReportSnapshotRow,
  type FinanceCashReportSummaryCard,
} from "@/lib/finance-cash-report-page";

type FinanceCashPageSearchParams = Promise<
  Record<string, string | string[] | undefined>
>;

function SummaryCards({
  cards,
}: {
  cards: FinanceCashReportSummaryCard[];
}) {
  return (
    <section className="space-y-5">
      <div className="flex items-start gap-3">
        <div className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-700">
          <Database className="h-5 w-5" />
        </div>
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
            Cash report
          </p>
          <h2 className="text-2xl font-semibold text-slate-900">
            Stored bank balance detail
          </h2>
          <p className="text-sm leading-6 text-slate-600">
            Stored finance bank summary snapshots now surface closing bank
            positions directly inside TACBookings for finance viewers and
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

function CashSnapshotTable({
  rows,
}: {
  rows: FinanceCashReportSnapshotRow[];
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>As of</TableHead>
          <TableHead>Source window</TableHead>
          <TableHead className="text-right">Total balance</TableHead>
          <TableHead className="text-right">Accounts</TableHead>
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
              {row.totalBalance}
            </TableCell>
            <TableCell className="text-right">{row.accountCount}</TableCell>
            <TableCell className="text-right">{row.sourceUpdatedAtLabel}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function CashAccountTable({
  rows,
}: {
  rows: FinanceCashReportAccountRow[];
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Bank account</TableHead>
          <TableHead className="text-right">Latest snapshot</TableHead>
          <TableHead className="text-right">Selected average</TableHead>
          <TableHead className="text-right">Selected range</TableHead>
          <TableHead className="text-right">Snapshots present</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.accountName}>
            <TableCell className="font-medium text-slate-900">
              {row.accountName}
            </TableCell>
            <TableCell className="text-right">{row.latestBalance}</TableCell>
            <TableCell className="text-right">{row.selectedAverage}</TableCell>
            <TableCell className="text-right font-medium text-slate-900">
              {row.selectedRange}
            </TableCell>
            <TableCell className="text-right">{row.periodsPresent}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default async function FinanceCashPage({
  searchParams,
}: {
  searchParams?: FinanceCashPageSearchParams;
}) {
  const member = await requireFinanceViewer("/finance/cash");
  const model = await buildFinanceCashReportPageModel({
    member,
    searchParams: searchParams ? await searchParams : undefined,
  });

  return (
    <div className="space-y-8">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(22rem,0.85fr)]">
        <Card>
          <CardHeader className="space-y-3">
            <Badge variant="outline" className="w-fit">
              Native cash report
            </Badge>
            <div className="space-y-2">
              <CardTitle className="text-2xl text-slate-900">
                Stored bank balances from durable finance snapshots
              </CardTitle>
              <CardDescription className="max-w-3xl text-sm leading-6 text-slate-600">
                This page turns the landed `BANK_BALANCES` finance snapshot
                dataset into a native `/finance/cash` report with summary cards,
                stored snapshot detail, and bank account balance comparisons for
                the selected stored periods.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              Generated {model.generatedOn}. Cash balances on this page come
              from stored finance bank-balance snapshots synced through the
              finance-only Xero boundary. No TACBookings payment rows,
              working-capital rollups, or live Xero reads are used here.
            </div>

            <form action="/finance/cash" className="space-y-4">
              <div className="space-y-3 rounded-xl border border-slate-200 p-4">
                <div className="flex items-center gap-2">
                  <Filter className="h-4 w-4 text-slate-500" />
                  <p className="text-sm font-semibold text-slate-900">
                    Stored cash snapshots
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
                      max={31}
                      defaultValue={model.filters.periods}
                    />
                    <p className="text-xs leading-5 text-slate-500">
                      Choose how many of the latest stored bank-balance
                      snapshots to include.
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button type="submit">Apply period selection</Button>
                <Button asChild variant="outline">
                  <Link href="/finance/cash">Reset defaults</Link>
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
              Cash stays explicitly finance-snapshot-backed here so it is not
              conflated with TACBookings payment-derived cash collections.
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
                      Snapshot cash detail
                    </CardTitle>
                    <CardDescription className="text-sm text-slate-600">
                      {model.coverageSummary}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <CashSnapshotTable rows={model.snapshotRows} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg text-slate-900">
                  Bank account positions
                </CardTitle>
                <CardDescription className="text-sm text-slate-600">
                  Account balances stay grouped by the stored bank summary
                  labels so the page remains aligned with the finance snapshot
                  source.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {model.accountRows.length > 0 ? (
                  <CashAccountTable rows={model.accountRows} />
                ) : (
                  <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-600">
                    No bank account detail rows were available in the selected
                    stored snapshots.
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
