"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useClubTime } from "@/components/club-time-provider";
import type { CalendarEventDTO } from "@/lib/calendar-events";
import {
  addCalendarMonths,
  formatClubMonthYear,
  startOfCalendarMonth,
} from "@/lib/club-time";
import type { CalendarDate } from "@/lib/club-time";
import { groupEventsByDay, monthGridRange } from "@/lib/calendar-client";
import { MonthCalendar } from "./month-calendar";
import { EventDialog } from "./event-dialog";
import { DayEventsDialog } from "./day-events-dialog";

interface CalendarViewProps {
  /** Whether the current member may add/edit/delete (committee or lodge admin). */
  canManage: boolean;
  /**
   * When false, existing events are read-only even for a manager — new events
   * can still be created. The member calendar (/calendar) passes false so it is
   * create-and-view only; /admin/calendar leaves it true for full editing.
   */
  allowEditExisting?: boolean;
}

export function CalendarView({
  canManage,
  allowEditExisting = true,
}: CalendarViewProps) {
  const canCreate = canManage;
  const canEditExisting = canManage && allowEditExisting;
  /*
    The club's timezone, delivered as data by `ClubTimeProvider` (CT-4, #2870).
    Everything below that touches a real instant — the fetch window, the day
    buckets, "today" in the grid — reads it from here. A browser must never
    answer "what day is it at the club?" from its own clock, which is exactly
    what this view used to do: it opened on the READER's current month, asked the
    API for the reader's own day window, and bucketed each event onto the reader's
    calendar day. A member abroad was shown a grid a day out of step with the one
    the lodge is on.
  */
  const club = useClubTime();
  /*
    The month on screen, held as the CALENDAR DAY it starts on rather than as a
    `Date`. A month heading and a 42-cell grid are statements about calendar
    days; carrying a `Date` here is what made `getFullYear()`/`getMonth()` look
    reasonable, and it also removes the 0-based-month footgun that came with it.
  */
  const [monthStart, setMonthStart] = useState<CalendarDate>(() =>
    startOfCalendarMonth(club.today()),
  );
  const [events, setEvents] = useState<CalendarEventDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEventDTO | null>(
    null,
  );
  const [createDate, setCreateDate] = useState<CalendarDate | null>(null);

  // Day-detail overflow list ("+N more"): the day whose full event list is open.
  const [dayDetailKey, setDayDetailKey] = useState<CalendarDate | null>(null);

  const monthTitle = formatClubMonthYear(monthStart);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    const { from, to } = monthGridRange(monthStart, club.zone);
    try {
      const params = new URLSearchParams({
        from: from.toISOString(),
        to: to.toISOString(),
      });
      const res = await fetch(`/api/calendar/events?${params.toString()}`);
      if (res.ok) {
        const data = (await res.json()) as { events: CalendarEventDTO[] };
        setEvents(data.events);
      } else {
        // A non-OK response would otherwise leave a silent, stale/empty grid.
        setLoadError(true);
      }
    } catch {
      // Surface the failure (with a retry) instead of a silent empty grid.
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [monthStart, club.zone]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  const eventsByDay = useMemo(
    () => groupEventsByDay(events, club.zone),
    [events, club.zone],
  );

  function openCreate(dayKey: CalendarDate | null) {
    setSelectedEvent(null);
    setCreateDate(dayKey);
    setDialogOpen(true);
  }

  function openEvent(event: CalendarEventDTO) {
    setSelectedEvent(event);
    setCreateDate(null);
    setDialogOpen(true);
  }

  // Selecting an event from the day-detail list swaps that dialog for the
  // single-event view; creating from it swaps for the create form.
  function openEventFromDay(event: CalendarEventDTO) {
    setDayDetailKey(null);
    openEvent(event);
  }

  function createFromDay(dayKey: CalendarDate) {
    setDayDetailKey(null);
    openCreate(dayKey);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            aria-label="Previous month"
            onClick={() => setMonthStart((m) => addCalendarMonths(m, -1))}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="Next month"
            onClick={() => setMonthStart((m) => addCalendarMonths(m, 1))}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMonthStart(startOfCalendarMonth(club.today()))}
          >
            Today
          </Button>
          <h2 className="ml-1 text-lg font-semibold text-foreground">
            {monthTitle}
          </h2>
          {loading && (
            <span className="text-xs text-muted-foreground">Loading…</span>
          )}
          {/* Announce month changes (and load state) to screen readers, since the
              grid re-renders without moving focus. */}
          <span className="sr-only" role="status" aria-live="polite">
            {loading
              ? `Loading ${monthTitle}`
              : loadError
                ? `Could not load events for ${monthTitle}`
                : `Showing ${monthTitle}`}
          </span>
        </div>

        {canCreate && (
          <Button size="sm" onClick={() => openCreate(null)}>
            <Plus className="mr-2 h-4 w-4" />
            New event
          </Button>
        )}
      </div>

      {loadError && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-foreground"
        >
          <span>Couldn’t load calendar events. Please try again.</span>
          <Button variant="outline" size="sm" onClick={fetchEvents}>
            Retry
          </Button>
        </div>
      )}

      <MonthCalendar
        monthStart={monthStart}
        eventsByDay={eventsByDay}
        canCreate={canCreate}
        onSelectEvent={openEvent}
        onSelectDay={(dayKey) => openCreate(dayKey)}
        onOpenDay={(dayKey) => setDayDetailKey(dayKey)}
      />

      <DayEventsDialog
        open={dayDetailKey !== null}
        onOpenChange={(v) => {
          if (!v) setDayDetailKey(null);
        }}
        dayKey={dayDetailKey}
        events={dayDetailKey ? (eventsByDay.get(dayDetailKey) ?? []) : []}
        canCreate={canCreate}
        onSelectEvent={openEventFromDay}
        onCreate={createFromDay}
      />

      <EventDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        event={selectedEvent}
        initialDate={createDate}
        canCreate={canCreate}
        canManage={canManage}
        canEditExisting={canEditExisting}
        onSaved={fetchEvents}
      />
    </div>
  );
}
