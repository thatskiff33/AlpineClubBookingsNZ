"use client";

/**
 * Recharts trees for the admin reports page, extracted verbatim (#1147) so the
 * ~139kB gz recharts chunk loads on demand via next/dynamic instead of inside
 * the route's First Load JS. Rendering, formatters, and colours are unchanged.
 *
 * CT-4 (#2870) changed one thing here and nothing visible: every axis and
 * tooltip label below is a CALENDAR DAY — a bucket key, not a moment — so it
 * takes no timezone. The hand-rolled `new Date(key + "T00:00:00")` local-midnight
 * parse is now `calendarDayAsLocalDate`, which validates the key and cannot
 * throw a `RangeError` into a chart render. See that module for why host-local
 * is the right encoding to hand a date-fns formatter.
 */

import { format } from "date-fns";
import { calendarDayAsLocalDate } from "./host-local-day";
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
import type { RevenueGranularity } from "@/lib/admin-reports";
import { formatCents } from "@/lib/utils";
import { bookingStatusLabel } from "@/lib/status-colors";

const PIE_COLORS = ["#3b82f6", "#ef4444"];
const STATUS_COLORS = ["#22c55e", "#3b82f6", "#8b5cf6", "#f59e0b", "#ef4444", "#f97316"];

/**
 * A bucket key (`yyyy-MM-dd`) through one of the chart's date-fns patterns.
 * An unparseable key renders as itself rather than throwing into the chart.
 */
function formatDayKey(key: unknown, pattern: string): string {
  if (typeof key !== "string") return String(key);
  const day = calendarDayAsLocalDate(key);
  return day === null ? key : format(day, pattern);
}

export function OccupancyAreaChart({
  data,
}: {
  data: Array<{ date: string; occupancyRate: number }>;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 12 }}
          tickFormatter={(date) => formatDayKey(date, "MMM d")}
        />
        <YAxis
          domain={[0, 100]}
          tick={{ fontSize: 12 }}
          tickFormatter={(value) => `${value}%`}
        />
        <Tooltip
          formatter={(value) => [`${value}%`, "Occupancy"]}
          labelFormatter={(date) => formatDayKey(date, "EEE, MMM d yyyy")}
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
  );
}

export function RevenueBarChart({
  data,
  granularity,
}: {
  data: Array<{ label: string; revenueCents: number; tooltipLabel?: string }>;
  granularity: RevenueGranularity;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 12 }}
          interval="preserveStartEnd"
          angle={granularity === "daily" ? -20 : 0}
          textAnchor={granularity === "daily" ? "end" : "middle"}
          height={granularity === "daily" ? 56 : 30}
        />
        <YAxis
          tick={{ fontSize: 12 }}
          tickFormatter={(value) => formatCents(Number(value))}
        />
        <Tooltip
          labelFormatter={(_value, payload) =>
            payload?.[0]?.payload?.tooltipLabel ?? ""
          }
          formatter={(value) => [formatCents(Number(value)), "Booked revenue"]}
        />
        <Bar dataKey="revenueCents" fill="#22c55e" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function TrendsLineChart({
  data,
}: {
  data: Array<{
    week: string;
    total: number;
    pending: number;
    paymentPending: number;
    confirmed: number;
    paid: number;
    awaitingReview: number;
    completed: number;
  }>;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis
          dataKey="week"
          tick={{ fontSize: 12 }}
          tickFormatter={(week) => formatDayKey(week, "MMM d")}
        />
        <YAxis tick={{ fontSize: 12 }} />
        <Tooltip
          labelFormatter={(week) => `Week of ${formatDayKey(week, "MMM d, yyyy")}`}
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
          dataKey="paid"
          stroke="#3b82f6"
          strokeWidth={2}
          name={bookingStatusLabel("PAID")}
        />
        <Line
          type="monotone"
          dataKey="completed"
          stroke="#8b5cf6"
          strokeWidth={2}
          name={bookingStatusLabel("COMPLETED")}
        />
        <Line
          type="monotone"
          dataKey="paymentPending"
          stroke="#f59e0b"
          strokeWidth={1}
          strokeDasharray="5 5"
          name={bookingStatusLabel("PAYMENT_PENDING")}
        />
        <Line
          type="monotone"
          dataKey="pending"
          stroke="#f97316"
          strokeWidth={1}
          strokeDasharray="5 5"
          name={bookingStatusLabel("PENDING")}
        />
        <Line
          type="monotone"
          dataKey="awaitingReview"
          stroke="#ec4899"
          strokeWidth={1}
          strokeDasharray="5 5"
          name={bookingStatusLabel("AWAITING_REVIEW")}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function MemberSplitPieChart({
  data,
}: {
  data: Array<{ name: string; value: number }>;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={data}
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
          {data.map((_, index) => (
            <Cell
              key={`member-split-${index}`}
              fill={PIE_COLORS[index % PIE_COLORS.length]}
            />
          ))}
        </Pie>
        <Tooltip />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function StatusPieChart({
  data,
}: {
  data: Array<{ name: string; value: number }>;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={50}
          outerRadius={80}
          paddingAngle={5}
          dataKey="value"
          label={({ name, value }) => `${name}: ${value}`}
        >
          {data.map((_, index) => (
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
  );
}
