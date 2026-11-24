/**
 * The club events calendar's officer side: creating, changing and deleting
 * events, as on `/admin/calendar`. Part of the Lodge Operations officer
 * actions (ALP-722), in `catalogue/lodge.ts`.
 *
 * These routes sit outside `/api/admin`, so the path names no area; each entry
 * carries `requires` Lodge Operations edit, the admin leg of the calendar's
 * write gate (`hasCalendarManageViaAdmin`). The route census pins the
 * predicate each handler calls beside it. A committee member without that
 * area creates events on the website only.
 *
 * Kinds: every change is `destructive`. The calendar is club-wide and every
 * member reads it, and a series edit or delete reaches many entries at once.
 * Minting a meeting's host link stays on the website (`access-secrets`).
 */
import {
  calendarEventDeleteQuerySchema,
  calendarEventInputSchema,
  calendarEventUpdateSchema,
} from "@/lib/calendar-events";
import {
  ADMIN_CALENDAR_EVENT_CREATED_CONNECTION_SHAPE,
  ADMIN_CALENDAR_EVENT_DELETED_CONNECTION_SHAPE,
  ADMIN_CALENDAR_EVENT_UPDATED_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/lodge-calendar";
import { routeIdParamsSchema } from "@/lib/route-id-params";

import type { McpAction } from "../catalogue";

const LODGE_EDIT = { area: "lodge", level: "edit" } as const;

const EVENT_FIELDS =
  "`title`, optional `location` and `details`, `allDay`, `startsAt` and optional `endsAt` as ISO date-times (an all-day event has no end), `isMeeting` (the website gives a meeting its online room), and an optional `recurrence` (`frequency`, `interval`, `endMode` never, until or count, with `until` or `count`)";

export const LODGE_CALENDAR_MCP_ACTIONS: readonly McpAction[] = [
  {
    id: "create_calendar_event",
    title: "Add an event to the club calendar",
    summary: `Officer: adds an event every member sees on the club calendar: ${EVENT_FIELDS}. Answers the saved event. The meeting link is never sent; members join from the website.`,
    method: "POST",
    path: "/api/calendar/events",
    body: calendarEventInputSchema,
    kind: "destructive",
    returns: ADMIN_CALENDAR_EVENT_CREATED_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_EDIT,
  },
  {
    id: "update_calendar_event",
    title: "Change a club calendar event",
    summary: `Officer: changes an event (\`id\` from \`list_club_events\`), sending every field again: ${EVENT_FIELDS}. \`scope: series\` changes every occurrence of a repeating event. An entry a work party manages is changed from its work party instead (\`update_work_party\`). Answers the saved event and the scope applied.`,
    method: "PATCH",
    path: "/api/calendar/events/[id]",
    params: routeIdParamsSchema,
    body: calendarEventUpdateSchema,
    kind: "destructive",
    returns: ADMIN_CALENDAR_EVENT_UPDATED_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_EDIT,
  },
  {
    id: "delete_calendar_event",
    title: "Delete a club calendar event",
    summary:
      "Officer: deletes an event (`id` from `list_club_events`), or with `scope: series` every occurrence of a repeating event. It cannot be undone. An entry a work party manages is removed from its work party instead. Answers `success` and the scope applied.",
    method: "DELETE",
    path: "/api/calendar/events/[id]",
    params: routeIdParamsSchema,
    query: calendarEventDeleteQuerySchema,
    kind: "destructive",
    returns: ADMIN_CALENDAR_EVENT_DELETED_CONNECTION_SHAPE,
    core: false,
    requires: LODGE_EDIT,
  },
];
