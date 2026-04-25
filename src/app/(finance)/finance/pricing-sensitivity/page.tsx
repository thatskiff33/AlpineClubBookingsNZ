import Link from "next/link";
import {
  ArrowLeft,
  ArrowUpRight,
  Calculator,
  Database,
  Filter,
  ShieldAlert,
  TrendingUp,
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
  buildDefaultFinanceCostsReportFilters,
  buildFinanceCostsReportHref,
} from "@/lib/finance-costs-report-page";
import { requireFinanceViewer } from "@/lib/finance-auth";
import {
  buildFinancePricingSensitivityPageModel,
  type FinancePricingSensitivityPeriodRow,
  type FinancePricingSensitivityScenarioRow,
  type FinancePricingSensitivitySummaryCard,
} from "@/lib/finance-pricing-sensitivity-page";

type FinancePricingSensitivityPageSearchParams = Promise<
  Record<string, string | string[] | undefined>
>;

function SummaryCards({
  cards,
}: {
  cards: FinancePricingSensitivitySummaryCard[];
}) {
  return (
    <section className="space-y-5">
      <div className="flex items-start gap-3">
        <div className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-700">
          <Calculator className="h-5 w-5" />
        </div>
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
            Pricing sensitivity
          </p>
          <h2 className="text-2xl font-semibold text-slate-900">
            Break-even pricing assumptions from landed finance seams
          </h2>
          <p className="text-sm leading-6 text-slate-600">
            This page combines stored monthly cost snapshots with Tokoroa Alpine Club
            realized booking metrics so finance viewers and managers can inspect
            explicit pricing sensitivity assumptions inside Tokoroa Alpine Club - Bookings.
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

function MonthlyComparisonTable({
  rows,
}: {
  rows: FinancePricingSensitivityPeriodRow[];
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Period</TableHead>
          <TableHead>Matched window</TableHead>
          <TableHead className="text-right">Costs total</TableHead>
          <TableHead className="text-right">Guest nights</TableHead>
          <TableHead className="text-right">Occupancy</TableHead>
          <TableHead className="text-right">Actual rev / guest night</TableHead>
          <TableHead className="text-right">Break-even / guest night</TableHead>
          <TableHead className="text-right">Booked rev less costs</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.snapshotId}>
            <TableCell className="font-medium text-slate-900">
              {row.periodLabel}
            </TableCell>
            <TableCell>{row.sourceWindow}</TableCell>
            <TableCell className="text-right font-medium text-slate-900">
              {row.totalCosts}
            </TableCell>
            <TableCell className="text-right">{row.guestNights}</TableCell>
            <TableCell className="text-right">{row.occupancyRate}</TableCell>
            <TableCell className="text-right">
              {row.averageRevenuePerGuestNight}
            </TableCell>
            <TableCell className="text-right">
              {row.breakEvenRevenuePerGuestNight}
            </TableCell>
            <TableCell className="text-right font-medium text-slate-900">
              {row.bookedRevenueLessCosts}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ScenarioTable({
  rows,
}: {
  rows: FinancePricingSensitivityScenarioRow[];
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Occupancy assumption</TableHead>
          <TableHead className="text-right">Implied guest nights / month</TableHead>
          <TableHead className="text-right">Required rev / guest night</TableHead>
          <TableHead className="text-right">Revenue at actual rate</TableHead>
          <TableHead className="text-right">Booked rev less costs</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.occupancyAssumption}>
            <TableCell className="font-medium text-slate-900">
              {row.occupancyAssumption}
            </TableCell>
            <TableCell className="text-right">{row.impliedGuestNights}</TableCell>
            <TableCell className="text-right font-medium text-slate-900">
              {row.requiredRevenuePerGuestNight}
            </TableCell>
            <TableCell className="text-right">
              {row.impliedRevenueAtActualRate}
            </TableCell>
            <TableCell className="text-right font-medium text-slate-900">
              {row.bookedRevenueLessCosts}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default async function FinancePricingSensitivityPage({
  searchParams,
}: {
  searchParams?: FinancePricingSensitivityPageSearchParams;
}) {
  const member = await requireFinanceViewer("/finance/pricing-sensitivity");
  const model = await buildFinancePricingSensitivityPageModel({
    member,
    searchParams: searchParams ? await searchParams : undefined,
  });
  const costsReportHref = buildFinanceCostsReportHref(
    buildDefaultFinanceCostsReportFilters()
  );

  return (
    <div className="space-y-8">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(22rem,0.85fr)]">
        <Card>
          <CardHeader className="space-y-3">
            <Badge variant="outline" className="w-fit">
              Native pricing-sensitivity report
            </Badge>
            <div className="space-y-2">
              <CardTitle className="text-2xl text-slate-900">
                Break-even pricing from costs and realized demand
              </CardTitle>
              <CardDescription className="max-w-3xl text-sm leading-6 text-slate-600">
                This page turns the landed monthly costs snapshots and
                Tokoroa Alpine Club realized booking metrics into a native
                pricing-sensitivity surface with explicit assumptions. It keeps
                costs, booked revenue, and payment-derived cash distinct.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              Generated {model.generatedOn}. Monthly costs come from stored
              finance snapshots. Guest nights and booked revenue come from
              Tokoroa Alpine Club realized booking metrics for the same monthly windows.
              No live Xero reads, payment cash, or working-capital calculations
              are used here.
            </div>

            <form action="/finance/pricing-sensitivity" className="space-y-4">
              <div className="space-y-3 rounded-xl border border-slate-200 p-4">
                <div className="flex items-center gap-2">
                  <Filter className="h-4 w-4 text-slate-500" />
                  <p className="text-sm font-semibold text-slate-900">
                    Matched monthly periods
                  </p>
                </div>
                <div className="grid gap-3 sm:max-w-xs">
                  <div className="space-y-2">
                    <Label htmlFor="periods">Monthly periods</Label>
                    <Input
                      id="periods"
                      name="periods"
                      type="number"
                      min={1}
                      max={24}
                      defaultValue={model.filters.periods}
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button type="submit">Apply periods</Button>
                    <Button asChild variant="outline" type="button">
                      <Link
                        href="/finance/pricing-sensitivity"
                        prefetch={false}
                      >
                        Reset
                      </Link>
                    </Button>
                  </div>
                </div>
              </div>
            </form>

            {model.filterWarnings.length > 0 ? (
              <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50/70 p-4 text-sm leading-6 text-amber-950">
                {model.filterWarnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </div>
            ) : null}

            {model.loadError ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4 text-sm leading-6 text-amber-950">
                {model.loadError}
              </div>
            ) : (
              <p className="text-sm leading-6 text-slate-600">
                {model.coverageSummary}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-1">
                <CardTitle className="text-lg text-slate-900">
                  Pricing-sensitivity actions
                </CardTitle>
                <CardDescription className="text-sm text-slate-600">
                  Use the supporting finance reports to cross-check the same
                  source boundaries.
                </CardDescription>
              </div>
              <Badge variant={model.isManager ? "secondary" : "outline"}>
                {model.isManager ? "Manager view" : "Viewer view"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button asChild variant="outline" className="w-full justify-between">
              <Link href={costsReportHref}>
                <span className="text-left">
                  <span className="block text-sm font-medium">
                    Open costs report
                  </span>
                  <span className="block text-xs text-slate-500">
                    Inspect the stored monthly cost line items behind these
                    scenarios.
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

      {model.loadError ? null : (
        <>
          <SummaryCards cards={model.summaryCards} />

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            <Card>
              <CardHeader>
                <div className="flex items-start gap-3">
                  <div className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-700">
                    <TrendingUp className="h-5 w-5" />
                  </div>
                  <div className="space-y-1">
                    <CardTitle className="text-xl text-slate-900">
                      Scenario table
                    </CardTitle>
                    <CardDescription className="text-sm leading-6 text-slate-600">
                      Required average revenue per guest night at explicit
                      occupancy assumptions, using the selected periods&apos;
                      average monthly costs and average monthly capacity.
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <ScenarioTable rows={model.scenarioRows} />
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
                      Each sensitivity number stays tied to a declared source
                      boundary and explicit non-goals.
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

          <Card>
            <CardHeader>
              <div className="flex items-start gap-3">
                <div className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-700">
                  <Database className="h-5 w-5" />
                </div>
                <div className="space-y-1">
                  <CardTitle className="text-xl text-slate-900">
                    Monthly comparison detail
                  </CardTitle>
                  <CardDescription className="text-sm leading-6 text-slate-600">
                    Each selected period compares stored monthly costs against
                    the same period&apos;s realized Tokoroa Alpine Club guest nights,
                    occupancy, and booked revenue rate.
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <MonthlyComparisonTable rows={model.periodRows} />
            </CardContent>
          </Card>
        </>
      )}

      {model.loadError ? (
        <Card className="border-amber-200 bg-amber-50/60">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg text-amber-950">
              <ShieldAlert className="h-5 w-5" />
              Pricing sensitivity unavailable
            </CardTitle>
            <CardDescription className="text-amber-900">
              The page stayed on a safe fallback state instead of exposing raw
              loading failures to finance viewers.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}
    </div>
  );
}
