"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { format } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useClubIdentity } from "@/components/club-identity-provider";
import { useLodgeOptions } from "@/components/lodge-select";
import {
  CalendarRange,
  DollarSign,
  Users,
  TrendingUp,
  BarChart2,
  Download,
  FileDown,
  CheckCircle2,
  AlertTriangle,
  UserPlus,
} from "lucide-react";
import type { RevenueGranularity } from "@/lib/admin-reports";
import { getRevenueGranularityLabel } from "@/lib/admin-reports";
import { bookingStatusLabel } from "@/lib/status-colors";
import { DateRangeControls } from "@/components/admin/date-range-controls";
import { DatasetResetButton } from "@/components/admin/dataset-reset-button";
import { reportsDateRangePresets } from "@/lib/date-range-presets";
import { useClubTime } from "@/components/club-time-provider";
import { calendarDayAsLocalDate } from "./_components/host-local-day";
import { formatClubDate, parseCalendarDate } from "@/lib/club-time";
import { escapeCsvCell } from "@/lib/csv";
import { formatCents } from "@/lib/utils";
import {
  getReportsDatasetDefaults,
  resetReportsDatasetState,
} from "@/lib/admin-dataset-reset-state";

// Charts load on demand (#1147): recharts is ~139kB gz, so the trees live in
// _components/report-charts and mount after the page shell. The placeholders
// render inside the existing fixed-height wrappers, so layout is stable.
const chartLoading = () => <div className="h-full" />;
const OccupancyAreaChart = dynamic(
  () => import("./_components/report-charts").then((m) => m.OccupancyAreaChart),
  { ssr: false, loading: chartLoading }
);
const RevenueBarChart = dynamic(
  () => import("./_components/report-charts").then((m) => m.RevenueBarChart),
  { ssr: false, loading: chartLoading }
);
const TrendsLineChart = dynamic(
  () => import("./_components/report-charts").then((m) => m.TrendsLineChart),
  { ssr: false, loading: chartLoading }
);
const MemberSplitPieChart = dynamic(
  () => import("./_components/report-charts").then((m) => m.MemberSplitPieChart),
  { ssr: false, loading: chartLoading }
);
const StatusPieChart = dynamic(
  () => import("./_components/report-charts").then((m) => m.StatusPieChart),
  { ssr: false, loading: chartLoading }
);

interface ReportData {
  summary: {
    totalBookings: number;
    totalRevenueCents: number;
    // Booking-level net cash from captured Payment.amountCents less refunds;
    // unlike booked revenue, this is not allocated across stay nights.
    netCollectedCents: number;
    // #2408: aggregate warning only. The API never exposes transaction rows or
    // affected booking ids to this page.
    additionalLedgerGapCents: number;
    additionalLedgerGapBookings: number;
    // #2350: how much of the booked revenue above has not been collected —
    // upward booking changes whose extra is still PENDING or FAILED.
    outstandingAdditionalCents: number;
    outstandingAdditionalBookings: number;
    totalGuests: number;
    avgOccupancyRate: number;
    memberGuests: number;
    nonMemberGuests: number;
  };
  statusBreakdown: {
    pending: number;
    paymentPending: number;
    confirmed: number;
    paid: number;
    awaitingReview: number;
    completed: number;
  };
  memberStats: {
    totalActiveMembers: number;
    paidMembers: number;
    unpaidMembers: number;
    overdueMembers: number;
    newMembers: number;
    currentSeasonYear: number;
    currentSeasonLabel: string;
  };
  occupancy: Array<{
    date: string;
    occupiedBeds: number;
    availableBeds: number;
    occupancyRate: number;
  }>;
  revenueGranularity: RevenueGranularity;
  revenue: Array<{
    periodStart: string;
    periodEnd: string;
    label: string;
    tooltipLabel: string;
    revenueCents: number;
    bookingCount: number;
  }>;
  trends: Array<{
    week: string;
    total: number;
    pending: number;
    paymentPending: number;
    confirmed: number;
    paid: number;
    awaitingReview: number;
    completed: number;
  }>;
}


function getRevenueDescription(granularity: RevenueGranularity): string {
  if (granularity === "daily") {
    return "Booked revenue allocated across each selected stay night for ranges up to 14 days.";
  }
  if (granularity === "weekly") {
    return "Booked revenue allocated across selected stay nights and grouped by week for ranges from 15 to 90 days.";
  }
  return "Booked revenue allocated across selected stay nights and grouped by month for ranges longer than 90 days.";
}

function getAdditionalLedgerGapWarning(summary: {
  additionalLedgerGapCents: number;
  additionalLedgerGapBookings: number;
}): string | null {
  if (summary.additionalLedgerGapBookings === 0) return null;

  const singular = summary.additionalLedgerGapBookings === 1;
  return `Net Collected Cash may understate by ${formatCents(summary.additionalLedgerGapCents)}: ${summary.additionalLedgerGapBookings} overlapping booking${singular ? "" : "s"} record${singular ? "s" : ""} an additional payment as collected without a matching captured additional-payment record. Ask a developer to reconcile ${singular ? "that payment's ledger" : "those payments' ledgers"} before trusting this figure.`;
}

/**
 * A range bound (`yyyy-MM-dd`) in the house medium shape — "16 Apr 2026".
 *
 * WHICH FORMATTER, and the rule that decides it (CT-4 review, #2870). The
 * kernel's shapes are LOCALE-AWARE: `formatClubDate` formats through
 * `APP_LOCALE`, while a date-fns pattern string hard-codes English month names
 * whatever the deployment is configured for. So a value in a house shape belongs
 * on the kernel — which is also what `payments/page.tsx` and
 * `subscriptions/page.tsx` did with this same "d MMM yyyy" shape, and leaving
 * this one behind would have put two contradictory rules in one change. For
 * `en-NZ` the two are byte-identical, so nothing visible changes here.
 *
 * The patterns that are NOT house shapes — the chart axes' `"MMM d"`,
 * `"EEE, MMM d yyyy"`, `"MMM d, yyyy"`, and the `"d MMM"` below — stay on
 * date-fns because the kernel has no equivalent to bend them onto. That IS a
 * locale limitation and it is a pre-existing one; this change neither adds to it
 * nor pretends it away.
 *
 * The bounds come from the URL, so an unusable one renders as itself rather
 * than throwing a `RangeError` that blanks the report.
 */
function formatRangeDay(value: string): string {
  const day = parseCalendarDate(value);
  return day === null ? value : formatClubDate(day);
}

/**
 * The same bounds through a date-fns pattern that is NOT a house shape. See
 * {@link formatRangeDay} for why these two exist side by side.
 */
function formatRangeDayPattern(value: string, pattern: string): string {
  const day = calendarDayAsLocalDate(value);
  return day === null ? value : format(day, pattern);
}

function StatCard({
  title,
  value,
  subtitle,
  icon: Icon,
}: {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: typeof Users;
}) {
  return (
    <Card className="reports-print-card print:border-slate-300 print:shadow-none">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold text-foreground">{value}</div>
        {subtitle ? <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p> : null}
      </CardContent>
    </Card>
  );
}

export default function ReportsPage() {
  const club = useClubIdentity();
  const {
    lodges,
    failed: lodgeOptionsFailed,
    forbidden: lodgeOptionsForbidden,
  } = useLodgeOptions("admin");
  // The reports API interprets from/to in the club time zone, so anchor the
  // default range on the club-timezone "today" rather than the browser's local
  // date (a browser trailing NZ across a month boundary would otherwise seed a
  // window a whole month behind).
  // The club's day, from the PERSISTED zone rather than APP_TIME_ZONE or the
  // browser (CT-4, #2870; INV-CONFIG-002).
  const clubTime = useClubTime();
  const clubToday = clubTime.today();
  const { from: defaultFrom, to: defaultTo } =
    getReportsDatasetDefaults(clubToday);

  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [deleted, setDeleted] = useState("hide");
  // Reporting lodge scope: "" = all active lodges (occupancy uses the summed
  // active-lodge capacity); a lodge id scopes metrics to that lodge (ADR-002:
  // the selector only appears once a second active lodge exists).
  const [lodgeId, setLodgeId] = useState<string>("");
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatingPDF, setGeneratingPDF] = useState(false);
  const reportRef = useRef<HTMLDivElement>(null);
  /*
    #2887: the qualifier disappeared in exactly the state where a reader most
    needs it. `lodges.length > 1` is false for a FAILED or FORBIDDEN list too,
    and `/admin/reports` is in the FINANCE area — `FINANCE_ADMIN`,
    `FINANCE_USER` and `ADMIN_MEMBERSHIP` all hold no `lodge` entry, so
    `/api/admin/lodges` 403'd for them until #2925 relaxed it — the card then
    read "Occupancy Rate" with no scope. The handling below stays regardless:
    `failed` is unchanged, and a role with `overview: "none"` is still refused.

    Unknown plurality is labelled as unknown rather than left blank. The
    selector is not rendered in that state, so the scope really is whatever the
    API defaults to — all active lodges — and saying so is honest; saying
    nothing is not.
  */
  const lodgeCountUnknown = lodgeOptionsFailed || lodgeOptionsForbidden;
  const occupancyScopeLabel =
    lodges.length > 1
      ? lodgeId
        ? (lodges.find((lodge) => lodge.id === lodgeId)?.name ?? "Selected lodge")
        : "All lodges"
      : lodgeCountUnknown
        ? "All lodges"
        : null;

  // Monotonic ticket for the LATEST query. Every filter change refires the effect
  // below while earlier fetches are still in flight, and without this guard the
  // screen belongs to whichever response lands LAST, not to the query the operator
  // asked — the mount-time default-range response overwriting the narrowed range's
  // figures a moment after they rendered. Found as a deterministic-looking
  // Playwright failure on PR #2817 (the cards showed the default range's $315
  // against the selected range's $135), but it is a live product defect: nothing
  // marked the figures as belonging to a different range than the inputs showed.
  const fetchSeq = useRef(0);

  const fetchReports = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ from, to });
      if (deleted !== "hide") {
        params.set("deleted", deleted);
      }
      if (lodgeId) {
        params.set("lodgeId", lodgeId);
      }
      const res = await fetch(`/api/admin/reports?${params.toString()}`);
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || "Failed to fetch reports");
      }
      const json = await res.json();
      // A response for a superseded query changes nothing — not the data, not the
      // error, not the spinner. The latest query owns all three.
      if (seq !== fetchSeq.current) return;
      setData(json);
    } catch (err) {
      if (seq !== fetchSeq.current) return;
      setError(err instanceof Error ? err.message : "Failed to fetch reports");
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  }, [deleted, from, to, lodgeId]);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  const memberPieData = data
    ? [
        { name: "Members", value: data.summary.memberGuests },
        { name: "Non-Members", value: data.summary.nonMemberGuests },
      ]
    : [];

  const statusPieData = data
    ? [
        { name: bookingStatusLabel("PENDING"), value: data.statusBreakdown.pending },
        { name: bookingStatusLabel("PAYMENT_PENDING"), value: data.statusBreakdown.paymentPending },
        { name: bookingStatusLabel("CONFIRMED"), value: data.statusBreakdown.confirmed },
        { name: bookingStatusLabel("PAID"), value: data.statusBreakdown.paid },
        { name: bookingStatusLabel("AWAITING_REVIEW"), value: data.statusBreakdown.awaitingReview },
        { name: bookingStatusLabel("COMPLETED"), value: data.statusBreakdown.completed },
      ].filter((entry) => entry.value > 0)
    : [];

  const occupancyData = data?.occupancy ?? [];
  const additionalLedgerGapWarning = data
    ? getAdditionalLedgerGapWarning(data.summary)
    : null;
  const sampledOccupancy =
    occupancyData.length > 60
      ? occupancyData.filter((_, index) => index % Math.ceil(occupancyData.length / 60) === 0)
      : occupancyData;

  function exportCSV() {
    if (!data) return;

    const revenueGranularityLabel = getRevenueGranularityLabel(data.revenueGranularity);
    const rows: string[][] = [];
    rows.push([`${club.bookingsName} Report`, `${from} to ${to}`]);
    rows.push([]);
    rows.push(["Summary"]);
    rows.push(["Total Bookings", String(data.summary.totalBookings)]);
    rows.push(["Booked Revenue", (data.summary.totalRevenueCents / 100).toFixed(2)]);
    rows.push(["Net Collected Cash", (data.summary.netCollectedCents / 100).toFixed(2)]);
    if (additionalLedgerGapWarning) {
      rows.push(["Net Collected Cash Warning", additionalLedgerGapWarning]);
      rows.push([
        "Possible Additional Ledger Gap",
        (data.summary.additionalLedgerGapCents / 100).toFixed(2),
      ]);
      rows.push([
        "Bookings With An Additional Ledger Gap",
        String(data.summary.additionalLedgerGapBookings),
      ]);
    }
    rows.push([
      "Outstanding Additions",
      (data.summary.outstandingAdditionalCents / 100).toFixed(2),
    ]);
    rows.push([
      "Bookings With An Outstanding Addition",
      String(data.summary.outstandingAdditionalBookings),
    ]);
    rows.push(["Total Guests", String(data.summary.totalGuests)]);
    rows.push(["Avg Occupancy Rate", `${data.summary.avgOccupancyRate}%`]);
    rows.push(["Member Guests", String(data.summary.memberGuests)]);
    rows.push(["Non-Member Guests", String(data.summary.nonMemberGuests)]);
    rows.push([]);
    rows.push(["Member Statistics"]);
    rows.push(["Total Active Members", String(data.memberStats.totalActiveMembers)]);
    rows.push([`Paid-Up Members (${data.memberStats.currentSeasonLabel})`, String(data.memberStats.paidMembers)]);
    rows.push([`Unpaid Members (${data.memberStats.currentSeasonLabel})`, String(data.memberStats.unpaidMembers)]);
    rows.push([`Overdue Members (${data.memberStats.currentSeasonLabel})`, String(data.memberStats.overdueMembers)]);
    rows.push([`New Members (${from} to ${to})`, String(data.memberStats.newMembers)]);
    rows.push([]);
    rows.push(["Occupancy by Date"]);
    rows.push(["Date", "Occupied Beds", "Available Beds", "Occupancy Rate"]);
    for (const entry of data.occupancy) {
      rows.push([
        entry.date,
        String(entry.occupiedBeds),
        String(entry.availableBeds),
        `${entry.occupancyRate}%`,
      ]);
    }
    rows.push([]);
    rows.push([`Booked Revenue by ${revenueGranularityLabel}`]);
    rows.push([revenueGranularityLabel, "Booked Revenue", "Distinct Bookings"]);
    for (const entry of data.revenue) {
      rows.push([
        entry.tooltipLabel,
        (entry.revenueCents / 100).toFixed(2),
        String(entry.bookingCount),
      ]);
    }
    rows.push([]);
    rows.push(["Booking Trends by Week"]);
    rows.push([
      "Week",
      "Total",
      bookingStatusLabel("PENDING"),
      bookingStatusLabel("PAYMENT_PENDING"),
      bookingStatusLabel("CONFIRMED"),
      bookingStatusLabel("PAID"),
      bookingStatusLabel("AWAITING_REVIEW"),
      bookingStatusLabel("COMPLETED"),
    ]);
    for (const entry of data.trends) {
      rows.push([
        entry.week,
        String(entry.total),
        String(entry.pending),
        String(entry.paymentPending),
        String(entry.confirmed),
        String(entry.paid),
        String(entry.awaitingReview),
        String(entry.completed),
      ]);
    }

    const csvContent = rows
      .map((row) => row.map(escapeCsvCell).join(","))
      .join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const dateStr = clubTime.today();
    anchor.href = url;
    anchor.download = `tac-report-${dateStr}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function downloadPDF() {
    if (!reportRef.current) return;

    setGeneratingPDF(true);
    try {
      const { generateReportPDF } = await import("@/lib/report-pdf");
      // The club's persisted zone decides the cover date and the filename day
      // (#3123); this component already holds the binding.
      await generateReportPDF(reportRef.current, { from, to }, clubTime, {
        title: `${club.name} — Reports`,
      });
    } catch (err) {
      console.error("PDF generation failed:", err);
      window.print();
    } finally {
      setGeneratingPDF(false);
    }
  }

  return (
    <div className="space-y-6 print:space-y-4">
      <div className="flex flex-col gap-4 print:hidden">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Reports</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Occupancy, revenue, booking, and member analytics
          </p>
        </div>
        <div
          role="group"
          aria-label="Report filters and exports"
          className="flex w-full flex-wrap items-end gap-3"
        >
          <DateRangeControls
            presets={reportsDateRangePresets}
            from={from}
            to={to}
            onFromChange={setFrom}
            onToChange={setTo}
          />
          {lodges.length > 1 ? (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Lodge</label>
              <select
                value={lodgeId}
                onChange={(event) => setLodgeId(event.target.value)}
                className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
              >
                <option value="">All lodges</option>
                {lodges.map((lodge) => (
                  <option key={lodge.id} value={lodge.id}>
                    {lodge.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Deleted</label>
            <select
              value={deleted}
              onChange={(event) => setDeleted(event.target.value)}
              className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
            >
              <option value="hide">Hide deleted</option>
              <option value="include">Include deleted</option>
              <option value="only">Deleted only</option>
            </select>
          </div>
          <DatasetResetButton
            disabled={
              from === defaultFrom && to === defaultTo && deleted === "hide"
            }
            onReset={() => {
              const reset = resetReportsDatasetState({ lodgeId }, clubToday);
              setFrom(reset.from);
              setTo(reset.to);
              setDeleted(reset.deleted);
            }}
          />
          <Button onClick={fetchReports} disabled={loading}>
            {loading ? "Loading..." : "Update"}
          </Button>
          <Button
            variant="outline"
            onClick={exportCSV}
            disabled={!data}
            className="print:hidden"
          >
            <Download className="mr-1 h-4 w-4" /> CSV
          </Button>
          <Button
            variant="outline"
            onClick={downloadPDF}
            disabled={!data || generatingPDF}
            className="print:hidden"
          >
            <FileDown className="mr-1 h-4 w-4" />{" "}
            {generatingPDF ? "Generating..." : "Download PDF"}
          </Button>
        </div>
      </div>

      {error ? <div className="rounded-lg bg-danger-3 p-4 text-danger-11">{error}</div> : null}

      {data ? (
        <div ref={reportRef} className="reports-print-root space-y-6 print:space-y-4">
          <div className="hidden print:block">
            <h1 className="text-2xl font-bold text-foreground">Reports</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Date range: {formatRangeDay(from)} to{" "}
              {formatRangeDay(to)}
            </p>
            <p className="text-xs text-muted-foreground">
              Member subscription cards use current season data ({data.memberStats.currentSeasonLabel}
              ).
            </p>
          </div>

          {additionalLedgerGapWarning ? (
            <div
              role="alert"
              className="reports-print-card rounded-lg border border-warning-6 bg-warning-3 p-4 text-sm text-warning-11 print:border-warning-6"
            >
              <p className="font-semibold">Net Collected Cash needs reconciliation</p>
              <p className="mt-1">{additionalLedgerGapWarning}</p>
            </div>
          ) : null}

          <section className="reports-print-section space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 print:gap-3">
              <StatCard
                title="Total Bookings"
                value={data.summary.totalBookings}
                subtitle="Distinct bookings with at least one selected stay night"
                icon={CalendarRange}
              />
              <StatCard
                title="Booked Revenue"
                value={formatCents(data.summary.totalRevenueCents)}
                subtitle="Price allocated to selected stay nights; not collected cash"
                icon={DollarSign}
              />
              <StatCard
                title="Net Collected Cash"
                value={formatCents(data.summary.netCollectedCents)}
                subtitle="Captured payment cash less refunds for overlapping bookings; not allocated by night"
                icon={DollarSign}
              />
              <StatCard
                title="Outstanding Additions"
                value={formatCents(data.summary.outstandingAdditionalCents)}
                subtitle={`Still owing across ${data.summary.outstandingAdditionalBookings} overlapping booking${data.summary.outstandingAdditionalBookings === 1 ? "" : "s"}; shown separately from cash`}
                icon={AlertTriangle}
              />
              <StatCard
                title="Total Guests"
                value={data.summary.totalGuests}
                subtitle="Distinct guest rows staying at least one selected night"
                icon={Users}
              />
              <StatCard
                title="Avg Occupancy"
                value={`${data.summary.avgOccupancyRate}%`}
                subtitle={
                  occupancyScopeLabel
                    ? `Average bed occupancy for the selected dates · ${occupancyScopeLabel}`
                    : "Average bed occupancy for the selected dates"
                }
                icon={TrendingUp}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 print:grid-cols-2 print:gap-3">
              <StatCard
                title="Active Members"
                value={data.memberStats.totalActiveMembers}
                subtitle="Currently active members"
                icon={Users}
              />
              <StatCard
                title="Paid-Up Members"
                value={data.memberStats.paidMembers}
                subtitle={`Current season (${data.memberStats.currentSeasonLabel})`}
                icon={CheckCircle2}
              />
              <StatCard
                title="Unpaid Members"
                value={data.memberStats.unpaidMembers}
                subtitle={`Current season (${data.memberStats.currentSeasonLabel})`}
                icon={CalendarRange}
              />
              <StatCard
                title="Overdue Members"
                value={data.memberStats.overdueMembers}
                subtitle={`Current season (${data.memberStats.currentSeasonLabel})`}
                icon={AlertTriangle}
              />
              <StatCard
                title="New Members"
                value={data.memberStats.newMembers}
                subtitle={`Joined between ${formatRangeDayPattern(from, "d MMM")} and ${formatRangeDay(to)}`}
                icon={UserPlus}
              />
            </div>

            <Card className="reports-print-card print:border-slate-300 print:shadow-none">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <BarChart2 className="h-5 w-5" />
                  Occupancy Rate{occupancyScopeLabel ? ` · ${occupancyScopeLabel}` : ""}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {sampledOccupancy.length > 0 ? (
                  <div className="h-[300px] print:h-[220px]">
                    <OccupancyAreaChart data={sampledOccupancy} />
                  </div>
                ) : (
                  <p className="py-8 text-center text-muted-foreground">No occupancy data for this period</p>
                )}
              </CardContent>
            </Card>
          </section>

          <section className="reports-print-section space-y-4">
            <Card className="reports-print-card print:border-slate-300 print:shadow-none">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <DollarSign className="h-5 w-5" />
                  {`Booked Revenue by ${getRevenueGranularityLabel(data.revenueGranularity)}`}
                </CardTitle>
                <p className="text-sm text-muted-foreground">
                  {getRevenueDescription(data.revenueGranularity)}
                </p>
              </CardHeader>
              <CardContent>
                {data.revenue.length > 0 ? (
                  <div className="h-[300px] print:h-[220px]">
                    <RevenueBarChart
                      data={data.revenue}
                      granularity={data.revenueGranularity}
                    />
                  </div>
                ) : (
                  <p className="py-8 text-center text-muted-foreground">No booked revenue data for this period</p>
                )}
              </CardContent>
            </Card>

            <Card className="reports-print-card print:border-slate-300 print:shadow-none">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="h-5 w-5" />
                  Booking Trends (by week)
                </CardTitle>
              </CardHeader>
              <CardContent>
                {data.trends.length > 0 ? (
                  <div className="h-[300px] print:h-[220px]">
                    <TrendsLineChart data={data.trends} />
                  </div>
                ) : (
                  <p className="py-8 text-center text-muted-foreground">No trend data for this period</p>
                )}
              </CardContent>
            </Card>
          </section>

          <section className="reports-print-section">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 print:grid-cols-2 print:gap-3">
              <Card className="reports-print-card print:border-slate-300 print:shadow-none">
                <CardHeader>
                  <CardTitle>Member vs Non-Member Guests</CardTitle>
                </CardHeader>
                <CardContent>
                  {data.summary.memberGuests + data.summary.nonMemberGuests > 0 ? (
                    <div className="h-[250px] print:h-[220px]">
                      <MemberSplitPieChart data={memberPieData} />
                    </div>
                  ) : (
                    <p className="py-8 text-center text-muted-foreground">No guest data</p>
                  )}
                </CardContent>
              </Card>

              <Card className="reports-print-card print:border-slate-300 print:shadow-none">
                <CardHeader>
                  <CardTitle>Booking Status Breakdown</CardTitle>
                </CardHeader>
                <CardContent>
                  {statusPieData.length > 0 ? (
                    <div className="h-[250px] print:h-[220px]">
                      <StatusPieChart data={statusPieData} />
                    </div>
                  ) : (
                    <p className="py-8 text-center text-muted-foreground">No booking data</p>
                  )}
                </CardContent>
              </Card>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
