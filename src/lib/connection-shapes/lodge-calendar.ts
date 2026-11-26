/**
 * What the Lodge Operations calendar officer actions return (ALP-722,
 * `INV-MCP-006`): the event an officer created or changed, with the series
 * fields that say whether `scope` matters, and which occurrences a delete
 * removed. The catalogue entry and the route's `connectionJson` both read
 * these (`INV-SSOT`). There is never a meeting link: that is minted per click
 * on the website (`POST /api/calendar/events/[id]/join`, `access-secrets`).
 *
 * Types only: nothing here reaches the database.
 */
import type { CalendarEditScope, CalendarEventDTO } from "@/lib/calendar-events";
import { connectionShapeFor, type CompleteConnectionShapeFor } from "@/lib/connection-projection";

// Every field of the event: an officer edits what the calendar page shows.
const CALENDAR_EVENT_SHAPE = {
  id: true,
  title: true,
  location: true,
  details: true,
  allDay: true,
  startsAt: true,
  endsAt: true,
  isMeeting: true,
  seriesId: true,
  detachedFromSeries: true,
  recurrence: { frequency: true, interval: true, endMode: true, until: true, count: true },
  workPartyEventId: true,
} as const satisfies CompleteConnectionShapeFor<CalendarEventDTO>;

export const ADMIN_CALENDAR_EVENT_CREATED_CONNECTION_SHAPE = connectionShapeFor<{ event: CalendarEventDTO }>({
  event: CALENDAR_EVENT_SHAPE,
});

export const ADMIN_CALENDAR_EVENT_UPDATED_CONNECTION_SHAPE = connectionShapeFor<{
  event: CalendarEventDTO;
  scope: CalendarEditScope;
}>({
  event: CALENDAR_EVENT_SHAPE,
  scope: true,
});

export const ADMIN_CALENDAR_EVENT_DELETED_CONNECTION_SHAPE = connectionShapeFor<{
  success: boolean;
  scope: CalendarEditScope;
}>({
  success: true,
  scope: true,
});
