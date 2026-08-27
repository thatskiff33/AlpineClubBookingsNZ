"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { bookingStatusLabel } from "@/lib/status-colors";
import { buildHrefWithReturnTo, buildPathWithSearch } from "@/lib/internal-return-path";
import { getAdminCalendarBookingDayRange } from "@/lib/admin-booking-calendar-ranges";
import { useClubTime } from "@/components/club-time-provider";
import {
  calendarDateFromParts,
  calendarDateParts,
  calendarDayOfWeek,
  daysInCalendarMonth,
  formatClubDate,
  requireCalendarDate,
} from "@/lib/club-time";

interface CalendarBooking {
  id: string;
  memberName: string;
  checkIn: string;
  checkOut: string;
  status: string;
  guestCount: number;
}

// Solid calendar swatches: one step-9 categorical/semantic fill per status (the
// bars carry white text, so every fill is a mode-independent saturated step-9 or
// a mode-inverting neutral surface that stays dark under white text in dark
// mode). #2190 P4 evicts the last two raw utilities: DRAFT's raw light-grey
// utility becomes the theme-following `bg-muted` (a faint, de-emphasised draft
// surface in both modes), and WAITLIST_OFFERED's raw Tailwind teal fill becomes
// the categorical `bg-cat6-9` (#2218 — the same teal 6th scale its chip uses,
// mode-consistent, distinct from WAITLISTED's cat1-9). The file no longer needs a
// neutral- or teal-allowlist entry.
export const STATUS_COLORS: Record<string, string> = {
  DRAFT: "bg-muted",
  PENDING: "bg-warning-9",
  PAYMENT_PENDING: "bg-warning-9",
  CONFIRMED: "bg-success-9",
  PAID: "bg-info-9",
  COMPLETED: "bg-cat1-9",
  CANCELLED: "bg-danger-9",
  BUMPED: "bg-warning-9",
  WAITLISTED: "bg-cat1-9",
  WAITLIST_OFFERED: "bg-cat6-9",
};

const ALL_STATUSES = Object.keys(STATUS_COLORS);

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// CELL_HEIGHT is the MINIMUM week-row height. Rows grow past it when a busy week
// stacks more lanes than fit (issue #2088); quiet months keep the original 80px.
const CELL_HEIGHT = 80;
const BAR_HEIGHT = 18;
const BAR_TOP_OFFSET = 22; // space for day number row
const LANE_GAP = 2;
const LANE_STRIDE = BAR_HEIGHT + LANE_GAP; // vertical pitch of one lane
const ROW_BOTTOM_PADDING = 4; // breathing room below the deepest bar in a row
// Ceiling on stacked lanes per week. Beyond this a row shows (MAX_LANES - 1) bar
// lanes and collapses the surplus into a per-day "+N more" affordance so a very
// busy week never grows without bound.
const MAX_LANES = 6;

// Both facts are CALENDAR-DAY facts, so the kernel answers both and no `Date` is
// built (CT-4, #2870). The spelling this replaces was host-local-midnight in and
// host-local out — self-consistent, and therefore right — but it is the shape from
// which the next author reaches for a UTC-midnight value and keeps `.getDay()`,
// shifting the whole grid by a column for every viewer west of Greenwich.
// `booking-calendar.tsx` carries the same note over the same change.
function getMonthDays(year: number, month: number) {
  // `month` stays 0-based, matching `Date.getMonth()`; the kernel counts 1-12.
  const weekday = calendarDayOfWeek(calendarDateFromParts(year, month + 1, 1));
  // 0=Sun..6=Sat converted to Mon-based (0=Mon..6=Sun).
  const startDow = weekday === 0 ? 6 : weekday - 1;
  return { startDow, daysInMonth: daysInCalendarMonth(year, month + 1) };
}

const ENABLED_STATUSES_STORAGE_KEY = "admin-calendar-enabled-statuses";

export function AdminBookingCalendar() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const statusParam = searchParams.get("status");
  const deletedParam = searchParams.get("deleted");
  const lodgeParam = searchParams.get("lodgeId");

  /**
   * "Today" is the CLUB's calendar day (CT-4, #2870; INV-CONFIG-002), so the
   * default month and the "today" highlight below stay consistent for an admin
   * whose browser clock trails the club's. A raw `new Date()` here could open the
   * previous month post-midnight.
   *
   * WHAT CHANGED IS THE AUTHORITY, not the shape. `getTodayDateOnly()` asked
   * `APP_TIME_ZONE` - the container's `TZ`; `clubTime.today()` asks the club's
   * recorded setting, and returns the day as a `CalendarDate` string rather than
   * a UTC-midnight `Date`, so the month and year are read off the calendar day
   * itself instead of through `getUTC*`.
   */
  const clubTime = useClubTime();
  const todayStr = clubTime.today();
  const todayParts = calendarDateParts(todayStr);
  const [year, setYear] = useState(todayParts.year);
  const [month, setMonth] = useState(todayParts.month - 1); // 0-indexed
  const [bookings, setBookings] = useState<CalendarBooking[]>([]);
  const [availability, setAvailability] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  // The day whose full booking list is open in the "+N more" dialog (or null).
  const [openDay, setOpenDay] = useState<string | null>(null);
  // Cancelled bookings are hidden by default to reduce noise; the CANCELLED
  // toggle pill below re-enables them (filtering is purely client-side). The
  // admin's last choice persists across visits (#1039 item 5).
  const [enabledStatuses, setEnabledStatuses] = useState<Set<string>>(() => {
    const defaults = ALL_STATUSES.filter((status) => status !== "CANCELLED");
    if (typeof window === "undefined") return new Set(defaults);
    try {
      const stored = window.localStorage.getItem(ENABLED_STATUSES_STORAGE_KEY);
      if (!stored) return new Set(defaults);
      const parsed: unknown = JSON.parse(stored);
      if (!Array.isArray(parsed)) return new Set(defaults);
      const valid = parsed.filter(
        (status): status is string =>
          typeof status === "string" &&
          (ALL_STATUSES as readonly string[]).includes(status)
      );
      return new Set(valid.length > 0 ? valid : defaults);
    } catch {
      return new Set(defaults);
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(
        ENABLED_STATUSES_STORAGE_KEY,
        JSON.stringify([...enabledStatuses])
      );
    } catch {
      // Storage unavailable (private mode, quota): the toggle still works
      // for the session, it just will not persist.
    }
  }, [enabledStatuses]);

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
      if (deletedParam && deletedParam !== "hide") {
        params.set("deleted", deletedParam);
      }
      // Multi-lodge: scope the calendar to the selected lodge (matches the list).
      // "all"/absent leaves it club-wide; the API decides the bed-count treatment.
      if (lodgeParam && lodgeParam !== "all") {
        params.set("lodgeId", lodgeParam);
      }
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
  }, [deletedParam, monthKey, statusParam, lodgeParam]);

  useEffect(() => {
    fetchBookings();
  }, [fetchBookings]);

  // Closing the "+N more" dialog whenever the visible month changes keeps a
  // stale day from a previous month out of view after navigating.
  useEffect(() => {
    setOpenDay(null);
  }, [monthKey]);

  const goToday = () => {
    const today = calendarDateParts(clubTime.today());
    setYear(today.year);
    setMonth(today.month - 1);
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

  // Build the day cells grid
  const totalCells = startDow + daysInMonth;
  const rows = Math.ceil(totalCells / 7);

  // Map a flat grid-cell index to its yyyy-MM-dd string, or "" for a padding
  // cell outside the current month.
  const cellDateStr = (cellIdx: number): string => {
    const dayNum = cellIdx - startDow + 1;
    if (dayNum < 1 || dayNum > daysInMonth) return "";
    return `${year}-${String(month + 1).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
  };

  // Group bookings into lanes to avoid overlap
  type Lane = Array<{ booking: CalendarBooking; start: number; end: number }>;
  const lanes: Lane[] = [];

  for (const b of filteredBookings) {
    const range = getAdminCalendarBookingDayRange(b, year, month);
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

  // --- Per-week vertical layout (issue #2088) --------------------------------
  // The lane packing above assigns each booking a global lane index; bars are
  // painted in an absolute overlay. With a fixed 80px cell a busy week's lane 3+
  // bars used to spill over and paint across the week row below. Each row now
  // grows to fit its own deepest lane, so bars never leave their own week band,
  // and rows past the ceiling collapse the surplus into a per-day "+N more".
  type BarSegment = {
    booking: CalendarBooking;
    laneIdx: number;
    row: number;
    colStart: number;
    colEnd: number;
    spanDays: number;
  };
  const barSegments: BarSegment[] = [];
  lanes.forEach((lane, laneIdx) => {
    for (const { booking, start, end } of lane) {
      const startCell = startDow + start - 1;
      const endCell = startDow + end - 1;
      const startCol = startCell % 7;
      const startRow = Math.floor(startCell / 7);
      const endCol = endCell % 7;
      const endRow = Math.floor(endCell / 7);
      const spanDays = end - start + 1;
      for (let r = startRow; r <= endRow; r++) {
        barSegments.push({
          booking,
          laneIdx,
          row: r,
          colStart: r === startRow ? startCol : 0,
          colEnd: r === endRow ? endCol : 6,
          spanDays,
        });
      }
    }
  });

  // Deepest lane occupied in each week row.
  const maxLaneByRow = Array.from({ length: rows }, () => -1);
  for (const seg of barSegments) {
    if (seg.laneIdx > maxLaneByRow[seg.row]) {
      maxLaneByRow[seg.row] = seg.laneIdx;
    }
  }

  // A row overflows when it needs more than MAX_LANES lanes. Overflowing rows
  // render (MAX_LANES - 1) bar lanes and reserve the last lane for "+N more".
  const rowIsOverflow = maxLaneByRow.map((maxLane) => maxLane + 1 > MAX_LANES);
  const barLaneCapByRow = rowIsOverflow.map((overflow) =>
    overflow ? MAX_LANES - 1 : Number.POSITIVE_INFINITY
  );
  const lanesUsedByRow = maxLaneByRow.map((maxLane, r) =>
    maxLane < 0 ? 0 : rowIsOverflow[r] ? MAX_LANES : maxLane + 1
  );
  const rowHeights = lanesUsedByRow.map((laneCount) =>
    Math.max(
      CELL_HEIGHT,
      BAR_TOP_OFFSET + laneCount * LANE_STRIDE + ROW_BOTTOM_PADDING
    )
  );
  const rowOffsets: number[] = [];
  {
    let acc = 0;
    for (let r = 0; r < rows; r++) {
      rowOffsets.push(acc);
      acc += rowHeights[r];
    }
  }

  // Overflow is decided per ROW while lanes are global, so a booking whose first
  // segment is hidden under a "+N more" cap (laneIdx >= cap in that row) can still
  // render a continuation segment in a later, non-overflow week. The member name
  // must therefore ride the first *visible* segment of each booking — not strictly
  // its first segment — or that continuation renders as a nameless orphan bar
  // (#2088 review). barSegments is built in ascending row order per booking.
  const isSegmentHidden = (seg: BarSegment) =>
    rowIsOverflow[seg.row] && seg.laneIdx >= barLaneCapByRow[seg.row];
  const firstVisibleRowByBooking = new Map<string, number>();
  for (const seg of barSegments) {
    if (isSegmentHidden(seg)) continue;
    const prev = firstVisibleRowByBooking.get(seg.booking.id);
    if (prev === undefined || seg.row < prev) {
      firstVisibleRowByBooking.set(seg.booking.id, seg.row);
    }
  }

  // Count the bookings hidden under the cap on each day so the "+N more" chip
  // can label itself; the dialog then opens the complete day list.
  const hiddenCountByCell = new Map<number, number>();
  for (const seg of barSegments) {
    if (!rowIsOverflow[seg.row] || seg.laneIdx < barLaneCapByRow[seg.row]) {
      continue;
    }
    for (let col = seg.colStart; col <= seg.colEnd; col++) {
      const cellIdx = seg.row * 7 + col;
      hiddenCountByCell.set(cellIdx, (hiddenCountByCell.get(cellIdx) ?? 0) + 1);
    }
  }

  // Every booking staying the open night (checkIn inclusive, checkOut exclusive
  // — one date-only night), sorted for a stable list.
  const openDayBookings = openDay
    ? filteredBookings
        .filter((b) => b.checkIn <= openDay && openDay < b.checkOut)
        .sort(
          (a, b) =>
            a.checkIn.localeCompare(b.checkIn) ||
            a.memberName.localeCompare(b.memberName)
        )
    : [];

  // How many of the open day's bookings the calendar actually painted as bars
  // (total minus the ones collapsed under the cap for that cell). Lets the dialog
  // spell out that it lists ALL bookings, not just the "+N more" remainder — the
  // chip count and the dialog count otherwise read as a mismatch (#2088 review).
  const openDayHidden = (() => {
    if (!openDay) return 0;
    for (let i = 0; i < rows * 7; i++) {
      if (cellDateStr(i) === openDay) return hiddenCountByCell.get(i) ?? 0;
    }
    return 0;
  })();
  const openDayShown = Math.max(0, openDayBookings.length - openDayHidden);

  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  return (
    <div className="rounded-lg border bg-card shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={goPrev} aria-label="Previous month">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <h2 className="text-sm font-semibold min-w-[140px] text-center">
            {monthNames[month]} {year}
          </h2>
          <Button variant="outline" size="sm" onClick={goNext} aria-label="Next month">
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={goToday} className="text-xs">
            Today
          </Button>
        </div>
        {loading && <span className="text-xs text-muted-foreground">Loading...</span>}
      </div>

      {/* Status toggle filters */}
      <div className="flex flex-wrap gap-1.5 px-3 py-2 border-b">
        {ALL_STATUSES.map((status) => {
          const isOn = enabledStatuses.has(status);
          return (
            <button
              key={status}
              type="button"
              aria-pressed={isOn}
              onClick={() => toggleStatus(status)}
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors border ${
                isOn
                  ? `${STATUS_COLORS[status]} text-white border-transparent`
                  : "bg-card text-muted-foreground border-border"
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
          <div key={d} className="text-center text-xs font-medium text-muted-foreground py-1.5 border-r last:border-r-0">
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
            const dayStr = isValidDay ? cellDateStr(i) : "";
            const isToday = dayStr === todayStr;
            // NZ date-only: a day greys only once it has fully finished; today
            // itself stays live (D-G2).
            const isPast = isValidDay && dayStr < todayStr;
            const beds = isValidDay ? availability[dayStr] : undefined;
            const bedsBg = beds === undefined ? "" : beds === 0 ? "bg-danger-3" : beds <= 5 ? "bg-danger-3/50" : beds <= 15 ? "bg-warning-3/50" : "";
            const cellBg = !isValidDay ? "bg-card" : isPast ? "bg-muted" : bedsBg;
            return (
              <div
                key={i}
                data-day={dayStr || undefined}
                data-past={isPast ? "true" : undefined}
                className={`border-r border-b last:border-r-0 relative ${cellBg}`}
                style={{ minHeight: `${rowHeights[Math.floor(i / 7)]}px` }}
              >
                {isValidDay && (
                  <div className="flex items-center justify-between px-1.5 pt-1">
                    <span
                      className={`text-xs leading-none ${
                        isToday
                          ? "font-bold text-info-11 bg-info-3 rounded-full px-1.5 py-0.5"
                          : isPast
                            ? "text-muted-foreground"
                            : "text-muted-foreground"
                      }`}
                    >
                      {dayNum}
                    </span>
                    {beds !== undefined && (
                      <span
                        className={`text-[11px] leading-none font-medium ${
                          isPast ? "opacity-60 " : ""
                        }${
                          beds === 0 ? "text-danger-11" : beds <= 5 ? "text-danger-11" : beds <= 15 ? "text-warning-11" : "text-success-11"
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
          {barSegments.map((seg) => {
            // Lanes past the cap are hidden here and surface via "+N more".
            if (isSegmentHidden(seg)) {
              return null;
            }
            const { booking } = seg;
            const leftPct = (seg.colStart / 7) * 100;
            const widthPct = ((seg.colEnd - seg.colStart + 1) / 7) * 100;
            const rowTop = rowOffsets[seg.row];
            const rowHeight = rowHeights[seg.row];
            const top = rowTop + BAR_TOP_OFFSET + seg.laneIdx * LANE_STRIDE;
            // A segment fully in the past dims with its cells; a segment that
            // still reaches today or the future stays at full strength.
            const lastDayStr = cellDateStr(seg.row * 7 + seg.colEnd);
            const isPastSeg = lastDayStr !== "" && lastDayStr < todayStr;

            return (
              <div
                key={`${booking.id}-${seg.row}`}
                data-booking-id={booking.id}
                data-row-index={seg.row}
                data-row-top={rowTop}
                data-row-height={rowHeight}
                className={`absolute rounded pointer-events-auto cursor-pointer hover:brightness-110 transition-all flex items-center overflow-hidden ${
                  isPastSeg ? "opacity-50 " : ""
                }${STATUS_COLORS[booking.status] || "bg-muted"}`}
                style={{
                  left: `calc(${leftPct}% + 2px)`,
                  width: `calc(${widthPct}% - 4px)`,
                  top: `${top}px`,
                  height: `${BAR_HEIGHT}px`,
                }}
                title={`${booking.memberName} (${booking.status}) — ${booking.checkIn} to ${booking.checkOut}, ${booking.guestCount} guest(s)`}
                onClick={() => router.push(buildHrefWithReturnTo(`/bookings/${booking.id}`, currentBookingsPath))}
              >
                {firstVisibleRowByBooking.get(booking.id) === seg.row && (
                  <span className="text-white text-[11px] font-medium leading-none truncate px-1.5">
                    {booking.memberName}
                    {seg.spanDays > 2 && ` · ${booking.guestCount}g`}
                  </span>
                )}
              </div>
            );
          })}

          {/* "+N more" affordances for days whose bookings exceed the cap. */}
          {[...hiddenCountByCell.entries()].map(([cellIdx, hidden]) => {
            const row = Math.floor(cellIdx / 7);
            const col = cellIdx % 7;
            const dayStr = cellDateStr(cellIdx);
            if (!dayStr) return null;
            const leftPct = (col / 7) * 100;
            const widthPct = (1 / 7) * 100;
            const top =
              rowOffsets[row] + BAR_TOP_OFFSET + (MAX_LANES - 1) * LANE_STRIDE;
            const isPastCell = dayStr < todayStr;
            return (
              <button
                key={`more-${cellIdx}`}
                type="button"
                data-more-day={dayStr}
                className={`absolute pointer-events-auto flex items-center justify-center rounded border border-border bg-card text-[11px] font-medium text-muted-foreground hover:bg-accent ${
                  isPastCell ? "opacity-60" : ""
                }`}
                style={{
                  left: `calc(${leftPct}% + 2px)`,
                  width: `calc(${widthPct}% - 4px)`,
                  top: `${top}px`,
                  height: `${BAR_HEIGHT}px`,
                }}
                title={`Show all bookings on ${dayStr}`}
                onClick={() => setOpenDay(dayStr)}
              >
                +{hidden} more
              </button>
            );
          })}
        </div>
      </div>

      {/* Full day list for a "+N more" cell */}
      <Dialog
        open={openDay !== null}
        onOpenChange={(open) => {
          if (!open) setOpenDay(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Bookings on {openDay ? formatClubDate(requireCalendarDate(openDay)) : ""}
            </DialogTitle>
            <DialogDescription>
              All {openDayBookings.length} booking
              {openDayBookings.length === 1 ? "" : "s"} staying this night
              {openDayHidden > 0 ? ` (${openDayShown} shown on the calendar)` : ""}.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] divide-y overflow-y-auto">
            {openDayBookings.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => {
                  setOpenDay(null);
                  router.push(
                    buildHrefWithReturnTo(`/bookings/${b.id}`, currentBookingsPath)
                  );
                }}
                className="flex w-full items-center justify-between gap-2 px-1 py-2 text-left text-sm hover:bg-accent"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className={`inline-block h-2.5 w-2.5 shrink-0 rounded-sm ${
                      STATUS_COLORS[b.status] || "bg-muted"
                    }`}
                  />
                  <span className="truncate font-medium">{b.memberName}</span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {bookingStatusLabel(b.status)} · {b.guestCount}g
                </span>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Legend (click toggles above to filter) */}
      <div className="flex flex-wrap gap-4 px-3 py-2.5 border-t text-xs">
        {Object.entries(STATUS_COLORS).map(([status, color]) => (
          <div key={status} className={`flex items-center gap-1.5 ${enabledStatuses.has(status) ? "" : "opacity-30"}`}>
            <div className={`w-3.5 h-2.5 rounded-sm ${color}`} />
            <span className="text-muted-foreground">{bookingStatusLabel(status)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
