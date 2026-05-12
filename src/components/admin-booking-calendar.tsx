"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { bookingStatusLabel } from "@/lib/status-colors";
import { buildHrefWithReturnTo, buildPathWithSearch } from "@/lib/internal-return-path";

interface CalendarBooking {
  id: string;
  memberName: string;
  checkIn: string;
  checkOut: string;
  status: string;
  guestCount: number;
}

const STATUS_COLORS: Record<string, string> = {
  DRAFT: "bg-gray-300",
  PENDING: "bg-yellow-400",
  PAYMENT_PENDING: "bg-amber-500",
  CONFIRMED: "bg-green-500",
  PAID: "bg-blue-500",
  COMPLETED: "bg-purple-500",
  CANCELLED: "bg-red-500",
  BUMPED: "bg-orange-500",
  WAITLISTED: "bg-purple-400",
  WAITLIST_OFFERED: "bg-teal-500",
};

const ALL_STATUSES = Object.keys(STATUS_COLORS);

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const CELL_HEIGHT = 80;
const BAR_HEIGHT = 18;
const BAR_TOP_OFFSET = 22; // space for day number row

function getMonthDays(year: number, month: number) {
  // month is 0-indexed
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  // Get day of week (0=Sun..6=Sat), convert to Mon-based (0=Mon..6=Sun)
  let startDow = firstDay.getDay() - 1;
  if (startDow < 0) startDow = 6;
  const daysInMonth = lastDay.getDate();
  return { startDow, daysInMonth };
}

function dateToStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function AdminBookingCalendar() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const statusParam = searchParams.get("status");

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth()); // 0-indexed
  const [bookings, setBookings] = useState<CalendarBooking[]>([]);
  const [availability, setAvailability] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [enabledStatuses, setEnabledStatuses] = useState<Set<string>>(new Set(ALL_STATUSES));

  const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;
  const currentPageParams = new URLSearchParams(searchParams.toString());
  currentPageParams.set("month", monthKey);
  const currentBookingsPath = buildPathWithSearch("/admin/bookings", currentPageParams);

  const fetchBookings = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ calendarMonth: monthKey });
      // Always pass status=all so the API returns every status (including CANCELLED);
      // the calendar's client-side toggle buttons handle visibility filtering.
      params.set("status", statusParam && statusParam !== "all" ? statusParam : "all");
      const res = await fetch(`/api/admin/bookings?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setBookings(data.bookings ?? []);
        setAvailability(data.availability ?? {});
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [monthKey, statusParam]);

  useEffect(() => {
    fetchBookings();
  }, [fetchBookings]);

  const goToday = () => {
    setYear(now.getFullYear());
    setMonth(now.getMonth());
  };

  const goPrev = () => {
    if (month === 0) { setMonth(11); setYear(year - 1); }
    else setMonth(month - 1);
  };

  const goNext = () => {
    if (month === 11) { setMonth(0); setYear(year + 1); }
    else setMonth(month + 1);
  };

  function toggleStatus(status: string) {
    setEnabledStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }

  const filteredBookings = bookings.filter((b) => enabledStatuses.has(b.status));

  const { startDow, daysInMonth } = getMonthDays(year, month);
  const monthStart = new Date(year, month, 1);
  const monthEnd = new Date(year, month + 1, 0);
  const todayStr = dateToStr(now);

  // Build the day cells grid
  const totalCells = startDow + daysInMonth;
  const rows = Math.ceil(totalCells / 7);

  // For each booking, determine which days it covers in this month
  function getBookingDayRange(b: CalendarBooking): { start: number; end: number } | null {
    const ci = parseDate(b.checkIn);
    const co = parseDate(b.checkOut);
    if (co < monthStart || ci > monthEnd) return null;
    const start = Math.max(1, ci < monthStart ? 1 : ci.getDate());
    const end = Math.min(daysInMonth, co > monthEnd ? daysInMonth : co.getDate());
    return { start, end };
  }

  // Group bookings into lanes to avoid overlap
  type Lane = Array<{ booking: CalendarBooking; start: number; end: number }>;
  const lanes: Lane[] = [];

  for (const b of filteredBookings) {
    const range = getBookingDayRange(b);
    if (!range) continue;
    // Find the first lane that doesn't overlap
    let placed = false;
    for (const lane of lanes) {
      const overlaps = lane.some(
        (item) => range.start <= item.end && range.end >= item.start
      );
      if (!overlaps) {
        lane.push({ booking: b, ...range });
        placed = true;
        break;
      }
    }
    if (!placed) {
      lanes.push([{ booking: b, ...range }]);
    }
  }

  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  return (
    <div className="rounded-lg border bg-white shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={goPrev}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <h2 className="text-sm font-semibold min-w-[140px] text-center">
            {monthNames[month]} {year}
          </h2>
          <Button variant="outline" size="sm" onClick={goNext}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={goToday} className="text-xs">
            Today
          </Button>
        </div>
        {loading && <span className="text-xs text-slate-400">Loading...</span>}
      </div>

      {/* Status toggle filters */}
      <div className="flex flex-wrap gap-1.5 px-3 py-2 border-b">
        {ALL_STATUSES.map((status) => {
          const isOn = enabledStatuses.has(status);
          return (
            <button
              key={status}
              type="button"
              onClick={() => toggleStatus(status)}
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors border ${
                isOn
                  ? `${STATUS_COLORS[status]} text-white border-transparent`
                  : "bg-white text-slate-500 border-slate-300"
              }`}
            >
              {bookingStatusLabel(status)}
            </button>
          );
        })}
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 border-b">
        {DAY_LABELS.map((d) => (
          <div key={d} className="text-center text-xs font-medium text-slate-500 py-1.5 border-r last:border-r-0">
            {d}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="relative">
        {/* Day number grid */}
        <div className="grid grid-cols-7">
          {Array.from({ length: rows * 7 }, (_, i) => {
            const dayNum = i - startDow + 1;
            const isValidDay = dayNum >= 1 && dayNum <= daysInMonth;
            const dayStr = isValidDay ? `${year}-${String(month + 1).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}` : "";
            const isToday = dayStr === todayStr;
            const beds = isValidDay ? availability[dayStr] : undefined;
            const bedsBg = beds === undefined ? "" : beds === 0 ? "bg-red-50" : beds <= 5 ? "bg-red-50/50" : beds <= 15 ? "bg-amber-50/50" : "";
            return (
              <div
                key={i}
                className={`border-r border-b last:border-r-0 relative ${
                  isValidDay ? bedsBg : "bg-slate-50"
                }`}
                style={{ minHeight: `${CELL_HEIGHT}px` }}
              >
                {isValidDay && (
                  <div className="flex items-center justify-between px-1.5 pt-1">
                    <span
                      className={`text-xs leading-none ${
                        isToday
                          ? "font-bold text-blue-600 bg-blue-100 rounded-full px-1.5 py-0.5"
                          : "text-slate-500"
                      }`}
                    >
                      {dayNum}
                    </span>
                    {beds !== undefined && (
                      <span
                        className={`text-[11px] leading-none font-medium ${
                          beds === 0 ? "text-red-600" : beds <= 5 ? "text-red-500" : beds <= 15 ? "text-amber-600" : "text-green-600"
                        }`}
                      >
                        {beds} bed{beds !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Booking bars overlay */}
        <div className="absolute inset-0 pointer-events-none">
          {lanes.map((lane, laneIdx) =>
            lane.map(({ booking, start, end }) => {
              // Calculate grid position
              const startCell = startDow + start - 1;
              const endCell = startDow + end - 1;
              const startCol = startCell % 7;
              const startRow = Math.floor(startCell / 7);
              const endCol = endCell % 7;
              const endRow = Math.floor(endCell / 7);

              // If booking spans multiple rows, render segments per row
              const segments: Array<{ row: number; colStart: number; colEnd: number; isFirst: boolean }> = [];
              for (let r = startRow; r <= endRow; r++) {
                segments.push({
                  row: r,
                  colStart: r === startRow ? startCol : 0,
                  colEnd: r === endRow ? endCol : 6,
                  isFirst: r === startRow,
                });
              }

              const spanDays = end - start + 1;

              return segments.map((seg, si) => {
                const leftPct = (seg.colStart / 7) * 100;
                const widthPct = ((seg.colEnd - seg.colStart + 1) / 7) * 100;
                const top = seg.row * CELL_HEIGHT + BAR_TOP_OFFSET + laneIdx * (BAR_HEIGHT + 2);

                return (
                  <div
                    key={`${booking.id}-${si}`}
                    className={`absolute rounded pointer-events-auto cursor-pointer hover:brightness-110 transition-all flex items-center overflow-hidden ${
                      STATUS_COLORS[booking.status] || "bg-gray-400"
                    }`}
                    style={{
                      left: `calc(${leftPct}% + 2px)`,
                      width: `calc(${widthPct}% - 4px)`,
                      top: `${top}px`,
                      height: `${BAR_HEIGHT}px`,
                    }}
                    title={`${booking.memberName} (${booking.status}) — ${booking.checkIn} to ${booking.checkOut}, ${booking.guestCount} guest(s)`}
                    onClick={() => router.push(buildHrefWithReturnTo(`/bookings/${booking.id}`, currentBookingsPath))}
                  >
                    {seg.isFirst && (
                      <span className="text-white text-[11px] font-medium leading-none truncate px-1.5">
                        {booking.memberName}
                        {spanDays > 2 && ` · ${booking.guestCount}g`}
                      </span>
                    )}
                  </div>
                );
              });
            })
          )}
        </div>
      </div>

      {/* Legend (click toggles above to filter) */}
      <div className="flex flex-wrap gap-4 px-3 py-2.5 border-t text-xs">
        {Object.entries(STATUS_COLORS).map(([status, color]) => (
          <div key={status} className={`flex items-center gap-1.5 ${enabledStatuses.has(status) ? "" : "opacity-30"}`}>
            <div className={`w-3.5 h-2.5 rounded-sm ${color}`} />
            <span className="text-slate-600">{bookingStatusLabel(status)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
