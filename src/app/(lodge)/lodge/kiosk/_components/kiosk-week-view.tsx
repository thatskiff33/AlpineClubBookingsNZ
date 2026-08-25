"use client";

import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Users,
} from "lucide-react";
import type { RosterDayStatus } from "@/lib/roster-status";
import {
  addCalendarDays,
  calendarDayOfWeek,
  formatClubDate,
  formatClubDayMonth,
  formatClubLongWeekdayDayMonth,
  formatClubWeekdayDayMonth,
  requireCalendarDate,
} from "@/lib/club-time";
import { formatDateOnly } from "@/lib/date-only";

/*
  EVERY DATE ON THIS STRIP IS A CALENDAR DAY, SO NOTHING HERE READS A TIMEZONE
  (CT-4, #2870).

  All four labels are now kernel shapes and this file keeps no formatter of its
  own. The strip is scanned by day of the week and deliberately drops the year,
  and every label is rendered verbatim into an accessible button label, so each
  had to stay byte-identical: `longWeekdayDayMonth` and `weekdayDayMonth` are the
  same option bags in the same locale the local formatters carried, and
  `dayMonth` — which F3 (#3079) declared — is the week range's start.

  The shapes pin `UTC` over the kernel's own UTC-midnight encoding, which is
  provably the identity for every club. Before CT-4 the local formatters were
  pinned to `APP_TIME_ZONE`, which cancelled only because New Zealand happens to
  be east of Greenwich; for a club that is not, the strip labelled each column
  with the previous night.

  The week range reads "13 Apr - 19 Apr 2026": the year is carried once, by the
  end date, so printing it on both halves would just be noise.
*/

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
    className: "border-kiosk-border bg-kiosk-chip text-kiosk-fg",
  },
  "needs-roster": {
    label: "Needs roster",
    className: "border-kiosk-danger-border bg-kiosk-danger-bg text-kiosk-danger-fg",
  },
  suggested: {
    label: "Suggested",
    className: "border-kiosk-warning-border bg-kiosk-warning-bg text-kiosk-warning-fg",
  },
  "needs-attention": {
    label: "Needs chores",
    className: "border-kiosk-orange-border bg-kiosk-orange-bg text-kiosk-orange-fg",
  },
  confirmed: {
    label: "Confirmed",
    className: "border-kiosk-success-border bg-kiosk-success-bg text-kiosk-success-fg",
  },
};

/*
  #2264 — these four helpers carry a lodge-night date KEY ("2026-04-15") in and
  out of a `Date`, and they now do it at UTC midnight rather than at the
  browser's local midnight.

  They used to build a local-midnight instant and read it back with local
  getters, which round-tripped exactly — but only because the labels were also
  rendered without a time zone. Now that the labels are pinned to club time
  (the point of this issue), a local-midnight instant is no longer guaranteed to
  land on the same calendar day when read in New Zealand: for a browser far
  enough west, local midnight on the 15th is already the 16th in Auckland, and
  the strip would label a column with the wrong night.

  UTC midnight has no such edge, and the reason is NOT the one this block used to
  give. It said "New Zealand is UTC+12/+13, so a UTC-midnight instant is always
  midday-ish the SAME calendar day in club time" — the accident INV-DATE-010
  records as holding only for a club at or ahead of Greenwich, and false for one
  behind it. What actually removes the edge is that nothing here projects: the key
  and the label are both read in UTC over the UTC-midnight encoding, so the key,
  the arithmetic and the rendered label can never disagree, for any club.

  The way BACK is `formatDateOnly` from `@/lib/date-only`, called by name at each
  site. There used to be a `formatDateKey` helper here that assembled the string
  from `getUTCFullYear()` / `getUTCMonth()` / `getUTCDate()` — the date-only
  encoding written a fourth way, in an EXPORTED function, which is precisely the
  shape that put roughly eighteen Xero document dates beyond the reach of #2682's
  census (#2684). Every value it was handed is a `parseDateKey` result, so it is
  a date-only value and the canonical encoder reads back the day it encodes —
  INV-DATE-019's first exact boundary, with INV-DATE-026, which are the citation
  for that decode rather than INV-DATE-010 (#3080).

  Deliberately NOT `formatDateOnlyForTimeZone`: the key and the
  instant are two spellings of the same abstract calendar day, and converting one
  into the club's zone would reintroduce the very drift this block removed.
*/
export function parseDateKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function addDaysToDateKey(dateKey: string, days: number): string {
  const date = parseDateKey(dateKey);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateOnly(date);
}

// `calendarDayOfWeek` numbers Sunday 0 .. Saturday 6, so Monday-first is `+6 % 7`.
// The kernel answers both halves from the `yyyy-MM-dd` text and builds no `Date`
// at all, which is what removes the `getDay()`-instead-of-`getUTCDay()` slip the
// block above spends a paragraph warning about (CT-4, #2870).
export function getWeekStartDateKey(dateKey: string): string {
  const day = requireCalendarDate(dateKey);
  const mondayOffset = (calendarDayOfWeek(day) + 6) % 7;
  return addCalendarDays(day, -mondayOffset);
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
  return formatClubLongWeekdayDayMonth(requireCalendarDate(dateKey));
}

function displayShortDay(dateKey: string): string {
  return formatClubWeekdayDayMonth(requireCalendarDate(dateKey));
}

function displayWeekRange(weekStart: string): string {
  const weekEnd = addDaysToDateKey(weekStart, 6);
  return `${formatClubDayMonth(requireCalendarDate(weekStart))} - ${formatClubDate(requireCalendarDate(weekEnd))}`;
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
            <p className="text-sm font-medium uppercase text-kiosk-muted-fg">
              {lodgeName}
            </p>
          )}
          <h1 className="text-2xl font-bold text-kiosk-fg">Week View</h1>
          <p className="text-lg text-kiosk-fg">{displayWeekRange(weekStart)}</p>
          {readOnly && (
            <p className="mt-1 text-sm font-medium text-kiosk-accent">
              Read-only view
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onChangeWeek(-1)}
            disabled={!canGoToPreviousWeek}
            className="inline-flex min-h-[48px] min-w-[48px] items-center justify-center rounded-xl border border-kiosk-border bg-kiosk-card text-kiosk-fg transition-colors hover:bg-kiosk-hover active:bg-kiosk-hover disabled:cursor-not-allowed disabled:border-kiosk-border-muted disabled:bg-kiosk-page disabled:text-kiosk-faint-fg"
            aria-label="Previous week"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={onToday}
            className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl bg-kiosk-accent px-4 py-2 text-sm font-semibold text-kiosk-accent-fg transition-colors hover:bg-kiosk-accent-hover active:bg-kiosk-accent-active"
          >
            <CalendarDays className="h-4 w-4" />
            Today
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl border border-kiosk-border bg-kiosk-card px-4 py-2 text-sm font-semibold text-kiosk-fg transition-colors hover:bg-kiosk-hover active:bg-kiosk-hover disabled:cursor-wait disabled:text-kiosk-faint-fg"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            {refreshing ? "Refreshing" : "Refresh"}
          </button>
          <button
            type="button"
            onClick={() => onChangeWeek(1)}
            disabled={!canGoToNextWeek}
            className="inline-flex min-h-[48px] min-w-[48px] items-center justify-center rounded-xl border border-kiosk-border bg-kiosk-card text-kiosk-fg transition-colors hover:bg-kiosk-hover active:bg-kiosk-hover disabled:cursor-not-allowed disabled:border-kiosk-border-muted disabled:bg-kiosk-page disabled:text-kiosk-faint-fg"
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
                className={`min-h-[160px] rounded-xl border border-kiosk-border bg-kiosk-page p-4 text-kiosk-muted-fg ${
                  isToday ? "ring-2 ring-kiosk-accent/60" : ""
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
              className={`min-h-[160px] rounded-xl border p-4 text-left text-kiosk-fg transition-colors hover:bg-kiosk-hover active:bg-kiosk-hover ${
                isSelected
                  ? "border-kiosk-accent bg-kiosk-card"
                  : "border-kiosk-border bg-kiosk-card"
              } ${isToday ? "ring-2 ring-kiosk-accent ring-offset-2 ring-offset-kiosk-page" : ""}`}
              aria-label={`Open ${displayDay(day.date)}`}
            >
              <div className="flex min-h-[48px] items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold uppercase text-kiosk-fg">
                    {displayShortDay(day.date)}
                  </p>
                  {isToday && (
                    <p className="mt-1 text-xs font-semibold uppercase text-kiosk-accent">
                      Today
                    </p>
                  )}
                </div>
                <span className={`rounded-full border px-2 py-1 text-xs font-semibold ${status.className}`}>
                  {status.label}
                </span>
              </div>

              <div className="mt-5 flex items-center gap-2 text-kiosk-fg">
                <Users className="h-5 w-5 text-kiosk-accent" />
                <span className="text-3xl font-bold">{day.guestCount}</span>
                <span className="text-sm text-kiosk-fg">
                  guest{day.guestCount !== 1 ? "s" : ""}
                </span>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-lg border border-kiosk-border bg-kiosk-page px-3 py-2">
                  <p className="text-kiosk-fg">Arriving</p>
                  <p className="text-lg font-semibold text-kiosk-success-fg">
                    {day.arrivingCount}
                  </p>
                </div>
                <div className="rounded-lg border border-kiosk-border bg-kiosk-page px-3 py-2">
                  <p className="text-kiosk-fg">Departing</p>
                  <p className="text-lg font-semibold text-kiosk-warning-fg">
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
