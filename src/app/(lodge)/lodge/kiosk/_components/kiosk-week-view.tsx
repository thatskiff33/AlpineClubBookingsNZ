"use client";

import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Users,
} from "lucide-react";
import type { RosterDayStatus } from "@/lib/roster-status";

type DateRange = { minDate: string; maxDate: string } | null;

export type KioskWeekDaySummary =
  | {
      date: string;
      accessible: false;
    }
  | {
      date: string;
      accessible: true;
      guestCount: number;
      arrivingCount: number;
      departingCount: number;
      rosterStatus: RosterDayStatus;
    };

interface KioskWeekViewProps {
  days: KioskWeekDaySummary[];
  weekStart: string;
  todayDate: string;
  selectedDate: string;
  lodgeName?: string | null;
  readOnly: boolean;
  refreshing: boolean;
  canGoToPreviousWeek: boolean;
  canGoToNextWeek: boolean;
  onSelectDate: (date: string) => void;
  onChangeWeek: (deltaWeeks: number) => void;
  onToday: () => void;
  onRefresh: () => void;
}

const rosterStatusMeta: Record<
  RosterDayStatus,
  { label: string; className: string }
> = {
  "no-guests": {
    label: "No guests",
    className: "border-[#475569] bg-[#334155] text-[#cbd5e1]",
  },
  "needs-roster": {
    label: "Needs roster",
    className: "border-red-500/50 bg-[#7f1d1d] text-[#fecaca]",
  },
  suggested: {
    label: "Suggested",
    className: "border-amber-500/50 bg-[#78350f] text-[#fde68a]",
  },
  "needs-attention": {
    label: "Needs chores",
    className: "border-orange-500/50 bg-[#7c2d12] text-[#fed7aa]",
  },
  confirmed: {
    label: "Confirmed",
    className: "border-emerald-500/50 bg-[#064e3b] text-[#a7f3d0]",
  },
};

export function parseDateKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDaysToDateKey(dateKey: string, days: number): string {
  const date = parseDateKey(dateKey);
  date.setDate(date.getDate() + days);
  return formatDateKey(date);
}

export function getWeekStartDateKey(dateKey: string): string {
  const date = parseDateKey(dateKey);
  const mondayOffset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - mondayOffset);
  return formatDateKey(date);
}

export function buildWeekDateKeys(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, index) =>
    addDaysToDateKey(weekStart, index)
  );
}

export function weekHasAccessibleDay(
  weekStart: string,
  range: DateRange
): boolean {
  if (!range) return true;
  return buildWeekDateKeys(weekStart).some(
    (date) => date >= range.minDate && date <= range.maxDate
  );
}

function displayDay(dateKey: string): string {
  return parseDateKey(dateKey).toLocaleDateString("en-NZ", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

function displayShortDay(dateKey: string): string {
  return parseDateKey(dateKey).toLocaleDateString("en-NZ", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function displayWeekRange(weekStart: string): string {
  const weekEnd = addDaysToDateKey(weekStart, 6);
  const start = parseDateKey(weekStart);
  const end = parseDateKey(weekEnd);
  return `${start.toLocaleDateString("en-NZ", {
    day: "numeric",
    month: "short",
  })} - ${end.toLocaleDateString("en-NZ", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })}`;
}

export function KioskWeekView({
  days,
  weekStart,
  todayDate,
  selectedDate,
  lodgeName,
  readOnly,
  refreshing,
  canGoToPreviousWeek,
  canGoToNextWeek,
  onSelectDate,
  onChangeWeek,
  onToday,
  onRefresh,
}: KioskWeekViewProps) {
  const dayByDate = new Map(days.map((day) => [day.date, day]));
  const weekDays = buildWeekDateKeys(weekStart).map(
    (date) => dayByDate.get(date) ?? { date, accessible: false as const }
  );

  return (
    <section aria-label="Lodge kiosk week view">
      <header className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          {lodgeName && (
            <p className="text-sm font-medium uppercase text-[#94a3b8]">
              {lodgeName}
            </p>
          )}
          <h1 className="text-2xl font-bold text-[#f8fafc]">Week View</h1>
          <p className="text-lg text-[#cbd5e1]">{displayWeekRange(weekStart)}</p>
          {readOnly && (
            <p className="mt-1 text-sm font-medium text-blue-300">
              Read-only view
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onChangeWeek(-1)}
            disabled={!canGoToPreviousWeek}
            className="inline-flex min-h-[48px] min-w-[48px] items-center justify-center rounded-xl border border-[#334155] bg-[#1e293b] text-[#f8fafc] transition-colors hover:bg-[#334155] active:bg-[#475569] disabled:cursor-not-allowed disabled:border-[#1f2937] disabled:bg-[#111827] disabled:text-[#475569]"
            aria-label="Previous week"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={onToday}
            className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-500 active:bg-blue-400"
          >
            <CalendarDays className="h-4 w-4" />
            Today
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl border border-[#334155] bg-[#1e293b] px-4 py-2 text-sm font-semibold text-[#f8fafc] transition-colors hover:bg-[#334155] active:bg-[#475569] disabled:cursor-wait disabled:text-[#64748b]"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            {refreshing ? "Refreshing" : "Refresh"}
          </button>
          <button
            type="button"
            onClick={() => onChangeWeek(1)}
            disabled={!canGoToNextWeek}
            className="inline-flex min-h-[48px] min-w-[48px] items-center justify-center rounded-xl border border-[#334155] bg-[#1e293b] text-[#f8fafc] transition-colors hover:bg-[#334155] active:bg-[#475569] disabled:cursor-not-allowed disabled:border-[#1f2937] disabled:bg-[#111827] disabled:text-[#475569]"
            aria-label="Next week"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-2 lg:grid-cols-7">
        {weekDays.map((day) => {
          const isToday = day.date === todayDate;
          const isSelected = day.date === selectedDate;

          if (!day.accessible) {
            return (
              <div
                key={day.date}
                className={`min-h-[160px] rounded-xl border border-[#334155] bg-[#111827] p-4 text-[#94a3b8] ${
                  isToday ? "ring-2 ring-blue-500/60" : ""
                }`}
                aria-label={`${displayDay(day.date)} outside access`}
              >
                <p className="text-sm font-semibold uppercase">
                  {displayShortDay(day.date)}
                </p>
                <p className="mt-8 text-sm font-medium">Outside access</p>
              </div>
            );
          }

          const status = rosterStatusMeta[day.rosterStatus];

          return (
            <button
              key={day.date}
              type="button"
              onClick={() => onSelectDate(day.date)}
              className={`min-h-[160px] rounded-xl border p-4 text-left text-[#f8fafc] transition-colors hover:bg-[#334155] active:bg-[#475569] ${
                isSelected
                  ? "border-blue-400 bg-[#1e293b]"
                  : "border-[#334155] bg-[#1e293b]"
              } ${isToday ? "ring-2 ring-blue-400 ring-offset-2 ring-offset-slate-900" : ""}`}
              aria-label={`Open ${displayDay(day.date)}`}
            >
              <div className="flex min-h-[48px] items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold uppercase text-[#cbd5e1]">
                    {displayShortDay(day.date)}
                  </p>
                  {isToday && (
                    <p className="mt-1 text-xs font-semibold uppercase text-[#93c5fd]">
                      Today
                    </p>
                  )}
                </div>
                <span className={`rounded-full border px-2 py-1 text-xs font-semibold ${status.className}`}>
                  {status.label}
                </span>
              </div>

              <div className="mt-5 flex items-center gap-2 text-[#f8fafc]">
                <Users className="h-5 w-5 text-[#93c5fd]" />
                <span className="text-3xl font-bold">{day.guestCount}</span>
                <span className="text-sm text-[#cbd5e1]">
                  guest{day.guestCount !== 1 ? "s" : ""}
                </span>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-lg border border-[#334155] bg-[#0f172a] px-3 py-2">
                  <p className="text-[#cbd5e1]">Arriving</p>
                  <p className="text-lg font-semibold text-[#86efac]">
                    {day.arrivingCount}
                  </p>
                </div>
                <div className="rounded-lg border border-[#334155] bg-[#0f172a] px-3 py-2">
                  <p className="text-[#cbd5e1]">Departing</p>
                  <p className="text-lg font-semibold text-[#fde68a]">
                    {day.departingCount}
                  </p>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
