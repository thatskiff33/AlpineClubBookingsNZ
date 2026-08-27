"use client";

import { Video, Repeat, Plus, MapPin } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useClubTime } from "@/components/club-time-provider";
import type { CalendarEventDTO } from "@/lib/calendar-events";
import type { CalendarDate } from "@/lib/club-time";
import { formatDayKeyLong, formatEventTime } from "@/lib/calendar-client";

interface DayEventsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The calendar day being shown, or null when closed. */
  dayKey: CalendarDate | null;
  /** Every event on this day, already sorted (all-day first, then by time). */
  events: CalendarEventDTO[];
  /** Whether the current member may create new events (managers only). */
  canCreate: boolean;
  /** Open a single event's detail (closes this dialog first). */
  onSelectEvent: (event: CalendarEventDTO) => void;
  /** Start creating a new event on this day (managers only). */
  onCreate: (dayKey: CalendarDate) => void;
}

/**
 * Full list of a day's events — the day-detail view reached from a cell's
 * "+N more" overflow. A month cell only renders the first few events; this
 * lists every one so members (and managers) can reach the 4th onward. Every
 * viewer gets it; only managers also get an "Add event" action.
 *
 * CT-4 (#2870): the heading is a CALENDAR DAY and needs no zone, but each row's
 * time comes from a real instant and so reads the club's persisted zone from
 * `ClubTimeProvider`. It used to read `APP_TIME_ZONE` — the environment's — which
 * a club that changes its timezone in the admin panel cannot move.
 */
export function DayEventsDialog({
  open,
  onOpenChange,
  dayKey,
  events,
  canCreate,
  onSelectEvent,
  onCreate,
}: DayEventsDialogProps) {
  const club = useClubTime();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{dayKey ? formatDayKeyLong(dayKey) : "Events"}</DialogTitle>
          <DialogDescription>
            {events.length === 1
              ? "1 event on this day."
              : `${events.length} events on this day.`}
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-1.5">
          {events.map((event) => (
            <li key={event.id}>
              <button
                type="button"
                onClick={() => onSelectEvent(event)}
                className={cn(
                  "flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                  event.isMeeting
                    ? "bg-primary text-primary-foreground hover:opacity-90"
                    : "bg-accent text-accent-foreground hover:opacity-90",
                )}
              >
                <span className="mt-0.5 flex shrink-0 items-center gap-1">
                  {event.isMeeting && <Video aria-hidden className="h-4 w-4" />}
                  {event.seriesId && !event.isMeeting && (
                    <Repeat aria-hidden className="h-4 w-4 opacity-70" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{event.title}</span>
                  <span className="block text-xs opacity-80">
                    {formatEventTime(event, club.zone)}
                    {event.location && (
                      <span className="ml-1 inline-flex items-center gap-0.5">
                        <MapPin aria-hidden className="h-3 w-3" />
                        {event.location}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            </li>
          ))}
          {events.length === 0 && (
            <li className="px-1 py-2 text-sm text-muted-foreground">
              No events on this day.
            </li>
          )}
        </ul>

        <DialogFooter className="gap-2 sm:justify-between">
          {canCreate && dayKey ? (
            <Button size="sm" onClick={() => onCreate(dayKey)}>
              <Plus aria-hidden className="mr-2 h-4 w-4" />
              Add event
            </Button>
          ) : (
            <span />
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
