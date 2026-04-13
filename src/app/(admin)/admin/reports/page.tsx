"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { format, subMonths, startOfMonth, endOfMonth } from "date-fns";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { formatCents } from "@/lib/utils";
import { bookingStatusLabel } from "@/lib/status-colors";
import { DateRangeControls } from "@/components/admin/date-range-controls";
import { reportsDateRangePresets } from "@/lib/date-range-presets";

interface ReportData {
  summary: {
    totalBookings: number;
    totalRevenueCents: number;
    totalGuests: number;
    avgOccupancyRate: number;
    memberGuests: number;
    nonMemberGuests: number;
  };
  statusBreakdown: {
    confirmed: number;
    paid: number;
    completed: number;
    pending: number;
    cancelled: number;
    bumped: number;
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
    confirmed: number;
    cancelled: number;
    bumped: number;
    pending: number;
  }>;
}

const PIE_COLORS = ["#3b82f6", "#ef4444"];
const STATUS_COLORS = ["#22c55e", "#3b82f6", "#8b5cf6", "#f59e0b", "#ef4444", "#f97316"];

function getRevenueDescription(granularity: RevenueGranularity): string {
  if (granularity === "daily") {
    return "Daily totals for date ranges up to 14 days.";
  }
  if (granularity === "weekly") {
    return "Weekly totals for date ranges from 15 to 90 days.";
  }
  return "Monthly totals for date ranges longer than 90 days.";
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
        <CardTitle className="text-sm font-medium text-slate-500">{title}</CardTitle>
        <Icon className="h-4 w-4 text-slate-400" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold text-slate-900">{value}</div>
        {subtitle ? <p className="mt-1 text-xs text-slate-500">{subtitle}</p> : null}
      </CardContent>
    </Card>
  );
}

export default function ReportsPage() {
  const defaultFrom = format(startOfMonth(subMonths(new Date(), 3)), "yyyy-MM-dd");
  const defaultTo = format(endOfMonth(new Date()), "yyyy-MM-dd");

  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatingPDF, setGeneratingPDF] = useState(false);
  const reportRef = useRef<HTMLDivElement>(null);

  const fetchReports = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/reports?from=${from}&to=${to}`);
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || "Failed to fetch reports");
      }
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch reports");
    } finally {
      setLoading(false);
    }
  }, [from, to]);

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
        { name: bookingStatusLabel("CONFIRMED"), value: data.statusBreakdown.confirmed },
        { name: "Paid", value: data.statusBreakdown.paid },
        { name: "Completed", value: data.statusBreakdown.completed },
        { name: "Pending", value: data.statusBreakdown.pending },
        { name: "Cancelled", value: data.statusBreakdown.cancelled },
        { name: "Bumped", value: data.statusBreakdown.bumped },
      ].filter((entry) => entry.value > 0)
    : [];

  const occupancyData = data?.occupancy ?? [];
  const sampledOccupancy =
    occupancyData.length > 60
      ? occupancyData.filter((_, index) => index % Math.ceil(occupancyData.length / 60) === 0)
      : occupancyData;

  function exportCSV() {
    if (!data) return;

    const revenueGranularityLabel = getRevenueGranularityLabel(data.revenueGranularity);
    const rows: string[][] = [];
    rows.push(["TAC Bookings Report", `${from} to ${to}`]);
    rows.push([]);
    rows.push(["Summary"]);
    rows.push(["Total Bookings", String(data.summary.totalBookings)]);
    rows.push(["Total Revenue", (data.summary.totalRevenueCents / 100).toFixed(2)]);
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
    rows.push([`Revenue by ${revenueGranularityLabel}`]);
    rows.push([revenueGranularityLabel, "Revenue", "Bookings"]);
    for (const entry of data.revenue) {
      rows.push([
        entry.tooltipLabel,
        (entry.revenueCents / 100).toFixed(2),
        String(entry.bookingCount),
      ]);
    }
    rows.push([]);
    rows.push(["Booking Trends by Week"]);
    rows.push(["Week", "Total", bookingStatusLabel("CONFIRMED"), "Cancelled", "Bumped", "Pending"]);
    for (const entry of data.trends) {
      rows.push([
        entry.week,
        String(entry.total),
        String(entry.confirmed),
        String(entry.cancelled),
        String(entry.bumped),
        String(entry.pending),
      ]);
    }

    const csvContent = rows
      .map((row) =>
        row
          .map((cell) => {
            if (cell.includes(",") || cell.includes('"') || cell.includes("\n")) {
              return `"${cell.replace(/"/g, '""')}"`;
            }
            return cell;
          })
          .join(",")
      )
      .join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const dateStr = new Date().toISOString().slice(0, 10);
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
      await generateReportPDF(reportRef.current, { from, to });
    } catch (err) {
      console.error("PDF generation failed:", err);
      window.print();
    } finally {
      setGeneratingPDF(false);
    }
  }

  return (
    <div className="space-y-6 print:space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end print:hidden">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Reports</h1>
          <p className="mt-1 text-sm text-slate-500">
            Occupancy, revenue, booking, and member analytics
          </p>
        </div>
        <div className="ml-auto flex items-end gap-3">
          <DateRangeControls
            presets={reportsDateRangePresets}
            from={from}
            to={to}
            onFromChange={setFrom}
            onToChange={setTo}
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

      {error ? <div className="rounded-lg bg-red-50 p-4 text-red-700">{error}</div> : null}

      {data ? (
        <div ref={reportRef} className="reports-print-root space-y-6 print:space-y-4">
          <div className="hidden print:block">
            <h1 className="text-2xl font-bold text-slate-900">Reports</h1>
            <p className="mt-1 text-sm text-slate-500">
              Date range: {format(new Date(from + "T00:00:00"), "d MMM yyyy")} to{" "}
              {format(new Date(to + "T00:00:00"), "d MMM yyyy")}
            </p>
            <p className="text-xs text-slate-500">
              Member subscription cards use current season data ({data.memberStats.currentSeasonLabel}
              ).
            </p>
          </div>

          <section className="reports-print-section space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 print:gap-3">
              <StatCard
                title="Total Bookings"
                value={data.summary.totalBookings}
                subtitle="Active bookings in selected range"
                icon={CalendarRange}
              />
              <StatCard
                title="Total Revenue"
                value={formatCents(data.summary.totalRevenueCents)}
                subtitle="Excludes cancelled and bumped bookings"
                icon={DollarSign}
              />
              <StatCard
                title="Total Guests"
                value={data.summary.totalGuests}
                subtitle="Guests across active bookings"
                icon={Users}
              />
              <StatCard
                title="Avg Occupancy"
                value={`${data.summary.avgOccupancyRate}%`}
                subtitle="Average bed occupancy for the selected dates"
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
                subtitle={`Joined between ${format(new Date(from + "T00:00:00"), "d MMM")} and ${format(new Date(to + "T00:00:00"), "d MMM yyyy")}`}
                icon={UserPlus}
              />
            </div>

            <Card className="reports-print-card print:border-slate-300 print:shadow-none">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <BarChart2 className="h-5 w-5" />
                  Occupancy Rate
                </CardTitle>
              </CardHeader>
              <CardContent>
                {sampledOccupancy.length > 0 ? (
                  <div className="h-[300px] print:h-[220px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={sampledOccupancy}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis
                          dataKey="date"
                          tick={{ fontSize: 12 }}
                          tickFormatter={(date) => format(new Date(date + "T00:00:00"), "MMM d")}
                        />
                        <YAxis
                          domain={[0, 100]}
                          tick={{ fontSize: 12 }}
                          tickFormatter={(value) => `${value}%`}
                        />
                        <Tooltip
                          formatter={(value) => [`${value}%`, "Occupancy"]}
                          labelFormatter={(date) =>
                            format(new Date(date + "T00:00:00"), "EEE, MMM d yyyy")
                          }
                        />
                        <Area
                          type="monotone"
                          dataKey="occupancyRate"
                          stroke="#3b82f6"
                          fill="#3b82f6"
                          fillOpacity={0.2}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <p className="py-8 text-center text-slate-500">No occupancy data for this period</p>
                )}
              </CardContent>
            </Card>
          </section>

          <section className="reports-print-section space-y-4">
            <Card className="reports-print-card print:border-slate-300 print:shadow-none">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <DollarSign className="h-5 w-5" />
                  {`Revenue by ${getRevenueGranularityLabel(data.revenueGranularity)}`}
                </CardTitle>
                <p className="text-sm text-slate-500">
                  {getRevenueDescription(data.revenueGranularity)}
                </p>
              </CardHeader>
              <CardContent>
                {data.revenue.length > 0 ? (
                  <div className="h-[300px] print:h-[220px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={data.revenue}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis
                          dataKey="label"
                          tick={{ fontSize: 12 }}
                          interval="preserveStartEnd"
                          angle={data.revenueGranularity === "daily" ? -20 : 0}
                          textAnchor={data.revenueGranularity === "daily" ? "end" : "middle"}
                          height={data.revenueGranularity === "daily" ? 56 : 30}
                        />
                        <YAxis
                          tick={{ fontSize: 12 }}
                          tickFormatter={(value) => `$${(value / 100).toFixed(0)}`}
                        />
                        <Tooltip
                          labelFormatter={(_value, payload) =>
                            payload?.[0]?.payload?.tooltipLabel ?? ""
                          }
                          formatter={(value) => [formatCents(Number(value)), "Revenue"]}
                        />
                        <Bar dataKey="revenueCents" fill="#22c55e" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <p className="py-8 text-center text-slate-500">No revenue data for this period</p>
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
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={data.trends}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis
                          dataKey="week"
                          tick={{ fontSize: 12 }}
                          tickFormatter={(week) =>
                            format(new Date(week + "T00:00:00"), "MMM d")
                          }
                        />
                        <YAxis tick={{ fontSize: 12 }} />
                        <Tooltip
                          labelFormatter={(week) =>
                            `Week of ${format(new Date(week + "T00:00:00"), "MMM d, yyyy")}`
                          }
                        />
                        <Legend />
                        <Line
                          type="monotone"
                          dataKey="total"
                          stroke="#3b82f6"
                          strokeWidth={2}
                          name="Total"
                        />
                        <Line
                          type="monotone"
                          dataKey="confirmed"
                          stroke="#22c55e"
                          strokeWidth={2}
                          name={bookingStatusLabel("CONFIRMED")}
                        />
                        <Line
                          type="monotone"
                          dataKey="cancelled"
                          stroke="#ef4444"
                          strokeWidth={1}
                          strokeDasharray="5 5"
                          name="Cancelled"
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <p className="py-8 text-center text-slate-500">No trend data for this period</p>
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
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={memberPieData}
                            cx="50%"
                            cy="50%"
                            innerRadius={50}
                            outerRadius={80}
                            paddingAngle={5}
                            dataKey="value"
                            label={({ name, percent }) =>
                              `${name} (${((percent ?? 0) * 100).toFixed(0)}%)`
                            }
                          >
                            {memberPieData.map((_, index) => (
                              <Cell
                                key={`member-split-${index}`}
                                fill={PIE_COLORS[index % PIE_COLORS.length]}
                              />
                            ))}
                          </Pie>
                          <Tooltip />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <p className="py-8 text-center text-slate-500">No guest data</p>
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
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={statusPieData}
                            cx="50%"
                            cy="50%"
                            innerRadius={50}
                            outerRadius={80}
                            paddingAngle={5}
                            dataKey="value"
                            label={({ name, value }) => `${name}: ${value}`}
                          >
                            {statusPieData.map((_, index) => (
                              <Cell
                                key={`status-split-${index}`}
                                fill={STATUS_COLORS[index % STATUS_COLORS.length]}
                              />
                            ))}
                          </Pie>
                          <Tooltip />
                          <Legend />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <p className="py-8 text-center text-slate-500">No booking data</p>
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
