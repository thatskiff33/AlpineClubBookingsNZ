"use client";

import { Video, Repeat, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { useClubTime } from "@/components/club-time-provider";
import type { CalendarEventDTO } from "@/lib/calendar-events";
import { calendarDateParts, type CalendarDate } from "@/lib/club-time";
import {
  buildMonthGrid,
  formatDayKeyLong,
  formatEventTime,
  isSameCalendarMonth,
  weekdayLabels,
} from "@/lib/calendar-client";

interface MonthCalendarProps {
  /** The first CALENDAR DAY of the month being displayed. */
  monthStart: CalendarDate;
  eventsByDay: Map<CalendarDate, CalendarEventDTO[]>;
  canCreate: boolean;
  onSelectEvent: (event: CalendarEventDTO) => void;
  /** Called with the calendar day when an empty cell is clicked (managers only). */
  onSelectDay: (dayKey: CalendarDate) => void;
  /**
   * Called with the calendar day to open the full day-detail list — every
   * viewer, triggered by the "+N more" overflow so the 4th event onward is
   * reachable.
   */
  onOpenDay: (dayKey: CalendarDate) => void;
}

const MAX_CHIPS_PER_DAY = 3;

export function MonthCalendar({
  monthStart,
  eventsByDay,
  canCreate,
  onSelectEvent,
  onSelectDay,
  onOpenDay,
}: MonthCalendarProps) {
  /*
    CT-4 (#2870). The grid itself is CALENDAR DAYS and needs no zone — 16 April
    2026 is a Thursday in every browser. The two things here that DO need one are
    the club's "today" ring and an event's start time, because both come from a
    real instant — and they were wrong in two DIFFERENT ways, which is worth
    keeping straight because the fix reads the same for both.

    The ring came from the VIEWER's clock: `isToday` was `dateKey(new Date())`
    on host-local getters, so a member reading the calendar from London had the
    ring on the wrong cell.

    The chip time did NOT. It went through `formatNZTime`, which pins
    `APP_TIME_ZONE` — and `next.config.ts` passes no timezone into the client
    bundle, so in a browser that resolves to the shipped default at BUILD time
    and never to the reader's clock. A member abroad saw the club's own time. What
    was wrong there is authority, not arithmetic: `INV-CONFIG-002` makes the
    persisted `ClubTimeSettings.timeZone` the club's civil-time authority, and a
    constant compiled into the bundle cannot follow an operator changing it in the
    admin panel without a redeploy.

    #2870 comment 11 records that the browser framing was over-applied to this
    class six times in the earlier groups and asks group F not to copy it; both
    halves are stated separately here for that reason.
  */
  const club = useClubTime();
  const today = club.today();
  const days = buildMonthGrid(monthStart);

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      {/* Weekday header */}
      <div className="grid grid-cols-7 border-b border-border bg-muted">
        {weekdayLabels().map((label) => (
          <div
            key={label}
            className="px-2 py-2 text-center text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            {label}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7">
        {days.map((day) => {
          const inMonth = isSameCalendarMonth(day, monthStart);
          const isToday = day === today;
          const dayEvents = eventsByDay.get(day) ?? [];
          const shown = dayEvents.slice(0, MAX_CHIPS_PER_DAY);
          const overflow = dayEvents.length - shown.length;
          const dayLabel = formatDayKeyLong(day);

          return (
            <div
              key={day}
              className={cn(
                "group min-h-[104px] border-b border-r border-border p-1.5 last:border-r-0 [&:nth-child(7n)]:border-r-0",
                inMonth ? "bg-background" : "bg-muted",
                canCreate && "cursor-pointer transition-colors hover:bg-accent",
              )}
              onClick={(e) => {
                // Mouse convenience only: a click on the empty cell (not a chip)
                // starts a new event. Keyboard users get the per-cell "Add event"
                // button below, so this div is never the sole path.
                if (canCreate && e.target === e.currentTarget) {
                  onSelectDay(day);
                }
              }}
            >
              <div className="mb-1 flex items-center justify-between">
                <span
                  className={cn(
                    "inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium",
                    isToday && "bg-primary text-primary-foreground",
                    !isToday && inMonth && "text-foreground",
                    !isToday && !inMonth && "text-muted-foreground",
                  )}
                >
                  {/* Screen readers announce the full date; sighted users see the
                      day number. */}
                  <span className="sr-only">{dayLabel}</span>
                  <span aria-hidden>{calendarDateParts(day).day}</span>
                </span>
                {canCreate && (
                  <button
                    type="button"
                    aria-label={`Add event on ${dayLabel}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectDay(day);
                    }}
                    className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
              </div>

              <div className="space-y-1">
                {shown.map((event) => (
                  <button
                    key={event.id}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectEvent(event);
                    }}
                    className={cn(
                      "flex w-full items-center gap-1 truncate rounded px-1.5 py-0.5 text-left text-xs transition-colors",
                      event.isMeeting
                        ? "bg-primary text-primary-foreground hover:opacity-90"
                        : "bg-accent text-accent-foreground hover:opacity-90",
                    )}
                    title={event.title}
                  >
                    {event.isMeeting && (
                      <Video aria-hidden className="h-3 w-3 shrink-0" />
                    )}
                    {event.seriesId && !event.isMeeting && (
                      <Repeat aria-hidden className="h-3 w-3 shrink-0 opacity-70" />
                    )}
                    <span className="truncate">
                      {!event.allDay && (
                        <span className="mr-1 tabular-nums opacity-70">
                          {formatEventTime(event, club.zone)}
                        </span>
                      )}
                      {event.title}
                    </span>
                  </button>
                ))}
                {overflow > 0 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenDay(day);
                    }}
                    className="rounded px-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                    aria-label={`Show all ${dayEvents.length} events on this day`}
                  >
                    +{overflow} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
