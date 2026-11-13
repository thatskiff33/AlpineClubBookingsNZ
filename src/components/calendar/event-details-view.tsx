"use client";

import { Video, MapPin, ExternalLink, Repeat } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useClubTime } from "@/components/club-time-provider";
import type { CalendarEventDTO } from "@/lib/calendar-events";
import { parseInstant } from "@/lib/club-time";
import { formatEventDateLong, formatInstantTime } from "@/lib/calendar-client";
import { describeRecurrence } from "@/lib/calendar-recurrence";

/**
 * Where a work party's calendar entry points (fork #118): the admin Work
 * Parties page, the member work party page, or nowhere (a viewer who can open
 * neither).
 */
export type CalendarWorkPartyLink = "admin" | "member" | null;

function workPartyHref(
  mode: CalendarWorkPartyLink,
  workPartyEventId: string,
): string | null {
  if (mode === "admin") return "/admin/work-parties";
  if (mode === "member") {
    return `/work-parties/${encodeURIComponent(workPartyEventId)}`;
  }
  return null;
}

/**
 * The calendar event dialog's read-only detail view, split out of
 * `event-dialog.tsx` (fork #118). Shown to ordinary members, to managers on
 * the member calendar (where existing events are not editable), and to
 * everyone for a work party's entry, which is managed from Work Parties. A
 * meeting shows "Join meeting" only to managers (committee members / admins):
 * an ordinary member sees the event details but cannot join the meeting.
 */
export function EventDetailsView({
  open,
  onOpenChange,
  event,
  canManage,
  workPartyLink,
  joining,
  joinError,
  onJoinMeeting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  event: CalendarEventDTO;
  canManage: boolean;
  workPartyLink: CalendarWorkPartyLink;
  joining: boolean;
  joinError: string | null;
  onJoinMeeting: (eventId: string) => void;
}) {
  const club = useClubTime();
  const managedHref = event.workPartyEventId
    ? workPartyHref(workPartyLink, event.workPartyEventId)
    : null;
  // The series summary describes a pattern anchored at a real instant, so it
  // is rendered only when that instant parses. There is nothing honest to say
  // about the shape of a series whose anchor is unreadable, and a placeholder
  // date would be a confident lie.
  const anchorInstant = parseInstant(event.startsAt);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {event.isMeeting && (
              <Video aria-hidden className="h-4 w-4 text-primary" />
            )}
            {event.title}
          </DialogTitle>
          <DialogDescription>
            {formatEventDateLong(event, club.zone, club.format)}
            {!event.allDay && (
              <>
                {" · "}
                {formatInstantTime(event.startsAt, club.zone, club.format)}
                {event.endsAt
                  ? ` – ${formatInstantTime(event.endsAt, club.zone, club.format)}`
                  : ""}
              </>
            )}
            {event.allDay && " · All day"}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {event.recurrence && anchorInstant && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Repeat aria-hidden className="h-4 w-4" />
              {describeRecurrence(
                {
                  frequency: event.recurrence.frequency,
                  interval: event.recurrence.interval,
                  endMode: event.recurrence.endMode,
                  until: event.recurrence.until,
                  count: event.recurrence.count,
                },
                anchorInstant,
                club.zone,
                club.format,
              )}
            </p>
          )}
          {event.location && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <MapPin aria-hidden className="h-4 w-4" />
              {event.location}
            </p>
          )}
          {event.details && (
            <p className="whitespace-pre-wrap text-foreground">
              {event.details}
            </p>
          )}
          {!event.location &&
            !event.details &&
            !event.recurrence &&
            !event.workPartyEventId && (
              <p className="text-muted-foreground">No further details.</p>
            )}
          {event.workPartyEventId && (
            <p className="text-muted-foreground">
              This work party is managed from Work Parties.
              {managedHref && (
                <>
                  {" "}
                  <a
                    href={managedHref}
                    className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
                  >
                    Open the work party
                    <ExternalLink aria-hidden className="h-3 w-3" />
                  </a>
                </>
              )}
            </p>
          )}
          {joinError && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {joinError}
            </p>
          )}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {canManage && event.isMeeting ? (
            <Button
              type="button"
              onClick={() => onJoinMeeting(event.id)}
              disabled={joining}
            >
              <Video aria-hidden className="mr-2 h-4 w-4" />
              {joining ? "Opening…" : "Join meeting"}
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
