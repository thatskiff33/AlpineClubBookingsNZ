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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  CalendarRange,
  DollarSign,
  Users,
  TrendingUp,
  BarChart2,
  Download,
  FileDown,
} from "lucide-react";

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
    completed: number;
    pending: number;
    cancelled: number;
    bumped: number;
  };
  occupancy: Array<{
    date: string;
    occupiedBeds: number;
    availableBeds: number;
    occupancyRate: number;
  }>;
  revenue: Array<{
    month: string;
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
const STATUS_COLORS = ["#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6"];

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
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
        { name: "Confirmed", value: data.statusBreakdown.confirmed },
        { name: "Completed", value: data.statusBreakdown.completed },
        { name: "Pending", value: data.statusBreakdown.pending },
        { name: "Cancelled", value: data.statusBreakdown.cancelled },
        { name: "Bumped", value: data.statusBreakdown.bumped },
      ].filter((d) => d.value > 0)
    : [];

  // Downsample occupancy data if too many points (show every Nth day)
  const occupancyData = data?.occupancy ?? [];
  const sampledOccupancy =
    occupancyData.length > 60
      ? occupancyData.filter((_, i) => i % Math.ceil(occupancyData.length / 60) === 0)
      : occupancyData;


  function exportCSV() {
    if (!data) return;
    const rows: string[][] = [];
    rows.push(["TAC Bookings Report", from + " to " + to]);
    rows.push([]);
    rows.push(["Summary"]);
    rows.push(["Total Bookings", String(data.summary.totalBookings)]);
    rows.push(["Total Revenue", (data.summary.totalRevenueCents / 100).toFixed(2)]);
    rows.push(["Total Guests", String(data.summary.totalGuests)]);
    rows.push(["Avg Occupancy Rate", data.summary.avgOccupancyRate + "%"]);
    rows.push(["Member Guests", String(data.summary.memberGuests)]);
    rows.push(["Non-Member Guests", String(data.summary.nonMemberGuests)]);
    rows.push([]);
    rows.push(["Occupancy by Date"]);
    rows.push(["Date", "Occupied Beds", "Available Beds", "Occupancy Rate"]);
    for (const d of data.occupancy) {
      rows.push([d.date, String(d.occupiedBeds), String(d.availableBeds), d.occupancyRate + "%"]);
    }
    rows.push([]);
    rows.push(["Revenue by Month"]);
    rows.push(["Month", "Revenue", "Bookings"]);
    for (const r of data.revenue) {
      rows.push([r.month, (r.revenueCents / 100).toFixed(2), String(r.bookingCount)]);
    }
    rows.push([]);
    rows.push(["Booking Trends by Week"]);
    rows.push(["Week", "Total", "Confirmed", "Cancelled", "Bumped", "Pending"]);
    for (const t of data.trends) {
      rows.push([t.week, String(t.total), String(t.confirmed), String(t.cancelled), String(t.bumped), String(t.pending)]);
    }
    const csvContent = rows.map(row => row.map(cell => {
      if (cell.includes(",") || cell.includes('"') || cell.includes("\n")) {
        return '"' + cell.replace(/"/g, '""') + '"';
      }
      return cell;
    }).join(",")).join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const dateStr = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = "tac-report-" + dateStr + ".csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function downloadPDF() {
    if (!reportRef.current) return;
    setGeneratingPDF(true);
    try {
      const { generateReportPDF } = await import("@/lib/report-pdf");
      await generateReportPDF(reportRef.current, { from, to });
    } catch {
      // silent — PDF generation may fail if html2canvas has issues
    } finally {
      setGeneratingPDF(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Reports</h1>
          <p className="text-sm text-slate-500 mt-1">
            Occupancy, revenue, and booking analytics
          </p>
        </div>
        <div className="flex items-end gap-3 ml-auto">
          <div>
            <Label htmlFor="from" className="text-xs">From</Label>
            <Input
              id="from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-40"
            />
          </div>
          <div>
            <Label htmlFor="to" className="text-xs">To</Label>
            <Input
              id="to"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-40"
            />
          </div>
          <Button onClick={fetchReports} disabled={loading}>
            {loading ? "Loading..." : "Update"}
          </Button>
          <Button variant="outline" onClick={exportCSV} disabled={!data} className="print:hidden">
            <Download className="h-4 w-4 mr-1" /> CSV
          </Button>
          <Button variant="outline" onClick={downloadPDF} disabled={!data || generatingPDF} className="print:hidden">
            <FileDown className="h-4 w-4 mr-1" /> {generatingPDF ? "Generating..." : "Download PDF"}
          </Button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 text-red-700 p-4 rounded-lg">{error}</div>
      )}

      {data && (
        <div ref={reportRef}>
          {/* Summary cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-slate-500">
                  Total Bookings
                </CardTitle>
                <CalendarRange className="h-4 w-4 text-slate-400" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {data.summary.totalBookings}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-slate-500">
                  Total Revenue
                </CardTitle>
                <DollarSign className="h-4 w-4 text-slate-400" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {formatCents(data.summary.totalRevenueCents)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-slate-500">
                  Total Guests
                </CardTitle>
                <Users className="h-4 w-4 text-slate-400" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {data.summary.totalGuests}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-slate-500">
                  Avg Occupancy
                </CardTitle>
                <TrendingUp className="h-4 w-4 text-slate-400" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {data.summary.avgOccupancyRate}%
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Occupancy chart */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BarChart2 className="h-5 w-5" />
                Occupancy Rate
              </CardTitle>
            </CardHeader>
            <CardContent>
              {sampledOccupancy.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <AreaChart data={sampledOccupancy}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 12 }}
                      tickFormatter={(d) => format(new Date(d + "T00:00:00"), "MMM d")}
                    />
                    <YAxis
                      domain={[0, 100]}
                      tick={{ fontSize: 12 }}
                      tickFormatter={(v) => `${v}%`}
                    />
                    <Tooltip
                      formatter={(value) => [`${value}%`, "Occupancy"]}
                      labelFormatter={(d) =>
                        format(new Date(d + "T00:00:00"), "EEE, MMM d yyyy")
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
              ) : (
                <p className="text-slate-500 text-center py-8">
                  No occupancy data for this period
                </p>
              )}
            </CardContent>
          </Card>

          {/* Revenue chart */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <DollarSign className="h-5 w-5" />
                Revenue by Month
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.revenue.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={data.revenue}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                      dataKey="month"
                      tick={{ fontSize: 12 }}
                      tickFormatter={(m) => {
                        const [y, mo] = m.split("-");
                        return format(new Date(Number(y), Number(mo) - 1), "MMM yyyy");
                      }}
                    />
                    <YAxis
                      tick={{ fontSize: 12 }}
                      tickFormatter={(v) => `$${(v / 100).toFixed(0)}`}
                    />
                    <Tooltip
                      formatter={(value, name) => {
                        if (name === "revenueCents") return [formatCents(Number(value)), "Revenue"];
                        return [value, "Bookings"];
                      }}
                    />
                    <Bar dataKey="revenueCents" fill="#22c55e" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-slate-500 text-center py-8">
                  No revenue data for this period
                </p>
              )}
            </CardContent>
          </Card>

          {/* Booking trends */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5" />
                Booking Trends (by week)
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.trends.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={data.trends}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                      dataKey="week"
                      tick={{ fontSize: 12 }}
                      tickFormatter={(w) => format(new Date(w + "T00:00:00"), "MMM d")}
                    />
                    <YAxis tick={{ fontSize: 12 }} />
                    <Tooltip
                      labelFormatter={(w) =>
                        `Week of ${format(new Date(w + "T00:00:00"), "MMM d, yyyy")}`
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
                      name="Confirmed"
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
              ) : (
                <p className="text-slate-500 text-center py-8">
                  No trend data for this period
                </p>
              )}
            </CardContent>
          </Card>

          {/* Pie charts row */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Member vs Non-Member Guests</CardTitle>
              </CardHeader>
              <CardContent>
                {data.summary.memberGuests + data.summary.nonMemberGuests > 0 ? (
                  <ResponsiveContainer width="100%" height={250}>
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
                            key={`cell-${index}`}
                            fill={PIE_COLORS[index % PIE_COLORS.length]}
                          />
                        ))}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="text-slate-500 text-center py-8">No guest data</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Booking Status Breakdown</CardTitle>
              </CardHeader>
              <CardContent>
                {statusPieData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={250}>
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
                            key={`cell-${index}`}
                            fill={STATUS_COLORS[index % STATUS_COLORS.length]}
                          />
                        ))}
                      </Pie>
                      <Tooltip />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="text-slate-500 text-center py-8">
                    No booking data
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
