import Link from "next/link";
import {
  ArrowLeft,
  CalendarRange,
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
import { FinanceTechnicalDetails } from "@/components/finance/technical-details";
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
  buildFinanceBookingsReportPageModel,
  type FinanceBookingsReportDailyRow,
  type FinanceBookingsReportSection,
  type FinanceBookingsReportStatusRow,
} from "@/lib/finance-bookings-report-page";
import { requireFinanceViewer } from "@/lib/finance-auth";
import { CLUB_NAME } from "@/config/club-identity";

type FinanceBookingsPageSearchParams = Promise<
  Record<string, string | string[] | undefined>
>;

function SummarySection({
  section,
  icon: Icon,
}: {
  section: FinanceBookingsReportSection;
  icon: typeof Database;
}) {
  return (
    <section className="space-y-5">
      <div className="flex items-start gap-3">
        <div className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-700">
          <Icon className="h-5 w-5" />
        </div>
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
            Bookings report
          </p>
          <h2 className="text-2xl font-semibold text-slate-900">{section.title}</h2>
          <p className="text-sm leading-6 text-slate-600">{section.description}</p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {section.cards.map((card) => (
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

function RealizedDailyTable({ rows }: { rows: FinanceBookingsReportDailyRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead className="text-right">Bookings</TableHead>
          <TableHead className="text-right">Guest nights</TableHead>
          <TableHead className="text-right">Occupied beds</TableHead>
          <TableHead className="text-right">Occupancy</TableHead>
          <TableHead className="text-right">Booked revenue</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.date}>
            <TableCell className="font-medium text-slate-900">{row.date}</TableCell>
            <TableCell className="text-right">{row.bookingCount}</TableCell>
            <TableCell className="text-right">{row.guestNights}</TableCell>
            <TableCell className="text-right">{row.occupiedBeds}</TableCell>
            <TableCell className="text-right">{row.occupancyRate}</TableCell>
            <TableCell className="text-right font-medium text-slate-900">
              {row.bookedRevenue}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ForwardDailyTable({ rows }: { rows: FinanceBookingsReportDailyRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead className="text-right">Committed bookings</TableHead>
          <TableHead className="text-right">Committed nights</TableHead>
          <TableHead className="text-right">At-risk bookings</TableHead>
          <TableHead className="text-right">At-risk nights</TableHead>
          <TableHead className="text-right">Pipeline occupancy</TableHead>
          <TableHead className="text-right">Pipeline revenue</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.date}>
            <TableCell className="font-medium text-slate-900">{row.date}</TableCell>
            <TableCell className="text-right">{row.committedBookingCount}</TableCell>
            <TableCell className="text-right">{row.committedGuestNights}</TableCell>
            <TableCell className="text-right">{row.atRiskBookingCount}</TableCell>
            <TableCell className="text-right">{row.atRiskGuestNights}</TableCell>
            <TableCell className="text-right">{row.occupancyRate}</TableCell>
            <TableCell className="text-right font-medium text-slate-900">
              {row.bookedRevenue}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function StatusBreakdownTable({
  rows,
  includePipeline,
}: {
  rows: FinanceBookingsReportStatusRow[];
  includePipeline: boolean;
}) {
  function DrilldownLink({
    href,
    children,
    className = "",
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) {
    return (
      <Link
        href={href}
        className={`block rounded-sm text-blue-700 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-500 ${className}`}
      >
        {children}
      </Link>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {includePipeline ? <TableHead>Bucket</TableHead> : null}
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Bookings</TableHead>
          <TableHead className="text-right">Booking nights</TableHead>
          <TableHead className="text-right">Guest nights</TableHead>
          <TableHead className="text-right">Booked revenue</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={`${row.pipeline}-${row.status}`}>
            {includePipeline ? (
              <TableCell>
                <DrilldownLink href={row.drilldownHref}>{row.pipeline}</DrilldownLink>
              </TableCell>
            ) : null}
            <TableCell className="font-medium">
              <DrilldownLink href={row.drilldownHref} className="text-slate-900">
                {row.status}
              </DrilldownLink>
            </TableCell>
            <TableCell className="text-right">
              <DrilldownLink href={row.drilldownHref}>{row.bookingCount}</DrilldownLink>
            </TableCell>
            <TableCell className="text-right">
              <DrilldownLink href={row.drilldownHref}>{row.bookingNights}</DrilldownLink>
            </TableCell>
            <TableCell className="text-right">
              <DrilldownLink href={row.drilldownHref}>{row.guestNights}</DrilldownLink>
            </TableCell>
            <TableCell className="text-right font-medium text-slate-900">
              <DrilldownLink href={row.drilldownHref} className="text-slate-900">
                {row.bookedRevenue}
              </DrilldownLink>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function DetailTables({
  section,
  dailyTable,
  statusTable,
}: {
  section: FinanceBookingsReportSection;
  dailyTable: React.ReactNode;
  statusTable: React.ReactNode;
}) {
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(22rem,0.85fr)]">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg text-slate-900">Daily detail</CardTitle>
          <CardDescription className="text-sm text-slate-600">
            Requested window: {section.requestedWindow}. Effective window:{" "}
            {section.effectiveWindow}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {section.emptyMessage ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-600">
              {section.emptyMessage}
            </div>
          ) : (
            dailyTable
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg text-slate-900">
            Status breakdown
          </CardTitle>
          <CardDescription className="text-sm text-slate-600">
            Status totals stay explicit so realized and pipeline views can be
            reconciled back to {CLUB_NAME} booking states. Open a row
            to view the finance-scoped source bookings behind it.
          </CardDescription>
        </CardHeader>
        <CardContent>{statusTable}</CardContent>
      </Card>
    </div>
  );
}

export default async function FinanceBookingsPage({
  searchParams,
}: {
  searchParams?: FinanceBookingsPageSearchParams;
}) {
  const member = await requireFinanceViewer("/finance/bookings");
  const model = await buildFinanceBookingsReportPageModel({
    member,
    searchParams: searchParams ? await searchParams : undefined,
  });

  return (
    <div className="space-y-8">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(22rem,0.85fr)]">
        <Card>
          <CardHeader className="space-y-3">
            <Badge variant="outline" className="w-fit">
              Finance bookings report
            </Badge>
            <div className="space-y-2">
              <CardTitle className="text-2xl text-slate-900">
                Realized stays and forward booking pipeline
              </CardTitle>
              <CardDescription className="max-w-3xl text-sm leading-6 text-slate-600">
                Review realized stays, forward demand, and payment coverage
                using booking data from TACBookings.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              Generated {model.generatedOn} from a live TACBookings query.
              Booked revenue comes from TACBookings bookings. Net collected cash
              comes from TACBookings payments. Xero-backed finance snapshots do
              not appear on this page.
            </div>

            <form action="/finance/bookings" className="space-y-4">
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="space-y-3 rounded-xl border border-slate-200 p-4">
                  <div className="flex items-center gap-2">
                    <Filter className="h-4 w-4 text-slate-500" />
                    <p className="text-sm font-semibold text-slate-900">
                      Realized window
                    </p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-2">
                      <Label htmlFor="realizedFrom">From</Label>
                      <Input
                        id="realizedFrom"
                        name="realizedFrom"
                        type="date"
                        defaultValue={model.filters.realizedFrom}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="realizedTo">To</Label>
                      <Input
                        id="realizedTo"
                        name="realizedTo"
                        type="date"
                        defaultValue={model.filters.realizedTo}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="realizedCutoff">Cutoff</Label>
                      <Input
                        id="realizedCutoff"
                        name="realizedCutoff"
                        type="date"
                        defaultValue={model.filters.realizedCutoff}
                      />
                    </div>
                  </div>
                </div>

                <div className="space-y-3 rounded-xl border border-slate-200 p-4">
                  <div className="flex items-center gap-2">
                    <CalendarRange className="h-4 w-4 text-slate-500" />
                    <p className="text-sm font-semibold text-slate-900">
                      Forward window
                    </p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-2">
                      <Label htmlFor="forwardFrom">From</Label>
                      <Input
                        id="forwardFrom"
                        name="forwardFrom"
                        type="date"
                        defaultValue={model.filters.forwardFrom}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="forwardTo">To</Label>
                      <Input
                        id="forwardTo"
                        name="forwardTo"
                        type="date"
                        defaultValue={model.filters.forwardTo}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="forwardAsOf">As of</Label>
                      <Input
                        id="forwardAsOf"
                        name="forwardAsOf"
                        type="date"
                        defaultValue={model.filters.forwardAsOf}
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button type="submit">Apply report windows</Button>
                <Button asChild variant="outline">
                  <Link href="/finance/bookings">Reset defaults</Link>
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg text-slate-900">
              About this report
            </CardTitle>
            <CardDescription className="text-sm text-slate-600">
              This report uses TACBookings booking and payment data rather than finance snapshots.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {model.isManager ? (
              <FinanceTechnicalDetails
                actions={[
                  {
                    href: model.rawMetricsHref,
                    label: "Open booking metrics JSON",
                    description:
                      "Technical export for the active report windows.",
                  },
                ]}
              />
            ) : null}

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
          <SummarySection section={model.realized} icon={Database} />
          <DetailTables
            section={model.realized}
            dailyTable={<RealizedDailyTable rows={model.realized.dailyRows} />}
            statusTable={
              <StatusBreakdownTable
                rows={model.realized.statusRows}
                includePipeline={false}
              />
            }
          />

          <SummarySection section={model.forward} icon={TrendingUp} />
          <DetailTables
            section={model.forward}
            dailyTable={<ForwardDailyTable rows={model.forward.dailyRows} />}
            statusTable={
              <StatusBreakdownTable
                rows={model.forward.statusRows}
                includePipeline
              />
            }
          />
        </>
      )}
    </div>
  );
}
