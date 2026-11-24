import { z } from "zod";
import type {
  CalendarEvent,
  CalendarEventSeries,
  Prisma,
} from "@prisma/client";
import {
  CALENDAR_RECURRENCE_FREQUENCIES,
  MAX_OCCURRENCES,
  type RecurrenceEndMode,
} from "@/lib/calendar-recurrence";
import { OPEN_WORK_PARTY_EVENT_WHERE } from "@/lib/work-party-rules";
import { canViewWorkParties } from "@/lib/work-party-access";

/**
 * Request body for creating / updating a calendar event. Dates arrive as ISO
 * strings the client builds from the date + time (or all-day) inputs; they are
 * range-validated in {@link resolveCalendarEventDates}, not here, so a bad
 * end-before-start pairing yields a specific message rather than a generic zod
 * failure.
 */
/** Recurrence rule sent with a create / series-edit request; null = one-off. */
export const recurrenceInputSchema = z.object({
  frequency: z.enum(CALENDAR_RECURRENCE_FREQUENCIES),
  interval: z.number().int().min(1).max(52),
  endMode: z.enum(["never", "until", "count"]),
  until: z.string().nullish(),
  count: z.number().int().min(1).max(MAX_OCCURRENCES).nullish(),
});

/**
 * The query of `GET /api/calendar/events`: the window to list, as ISO date-time
 * bounds. Shared with the AI app action `list_club_events` (ALP-796,
 * `INV-SSOT`). A bound that is not a date is ignored and its default used,
 * as the calendar page has always been answered.
 */
/** The days before now `GET /api/calendar/events` lists when `from` is absent. */
export const CALENDAR_EVENT_LIST_DEFAULT_DAYS_BACK = 90;
/** The days after now it lists when `to` is absent. */
export const CALENDAR_EVENT_LIST_DEFAULT_DAYS_AHEAD = 275;

export const calendarEventListQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

export const calendarEventInputSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  location: z.string().trim().max(200).nullish(),
  details: z.string().trim().max(5000).nullish(),
  allDay: z.boolean(),
  startsAt: z.string().min(1, "Start date is required"),
  endsAt: z.string().nullish(),
  isMeeting: z.boolean(),
  recurrence: recurrenceInputSchema.nullish(),
});

export type CalendarEventInput = z.infer<typeof calendarEventInputSchema>;

/** Which occurrences a series-event edit or delete applies to. */
export const calendarEditScopeSchema = z.enum(["single", "series"]);
export type CalendarEditScope = z.infer<typeof calendarEditScopeSchema>;

/**
 * Parse and range-check the ISO date strings. Returns concrete Dates, or an
 * `error` message for the 400. An all-day event keeps `endsAt` null; a timed
 * event may carry an end that must not precede the start.
 */
export function resolveCalendarEventDates(
  input: Pick<CalendarEventInput, "startsAt" | "endsAt" | "allDay">,
): { startsAt: Date; endsAt: Date | null } | { error: string } {
  const startsAt = new Date(input.startsAt);
  if (Number.isNaN(startsAt.getTime())) {
    return { error: "Invalid start date/time" };
  }

  if (input.allDay || !input.endsAt) {
    return { startsAt, endsAt: null };
  }

  const endsAt = new Date(input.endsAt);
  if (Number.isNaN(endsAt.getTime())) {
    return { error: "Invalid end date/time" };
  }
  if (endsAt.getTime() < startsAt.getTime()) {
    return { error: "End time must be on or after the start time" };
  }
  return { startsAt, endsAt };
}

/** The recurrence rule of the event's series, in the client's input shape. */
export type RecurrenceSummaryDTO = {
  frequency: (typeof CALENDAR_RECURRENCE_FREQUENCIES)[number];
  interval: number;
  endMode: RecurrenceEndMode;
  until: string | null;
  count: number | null;
};

export function recurrenceSummaryFromSeries(
  series: CalendarEventSeries,
): RecurrenceSummaryDTO {
  const endMode: RecurrenceEndMode = series.until
    ? "until"
    : series.count != null
      ? "count"
      : "never";
  return {
    frequency: series.frequency,
    interval: series.interval,
    endMode,
    until: series.until ? series.until.toISOString() : null,
    count: series.count,
  };
}

/**
 * Wire shape a calendar event takes on the client.
 *
 * NOTE: there is deliberately NO meeting URL / token field. The MiroTalk join
 * token embeds shared host credentials, so it is minted per click on
 * `POST /api/calendar/events/[id]/join` — gated to calendar managers and
 * audited — never served to every member in the list response. The client
 * shows a "Join" affordance off `isMeeting` alone and fetches the URL on
 * click. The link itself is built by `buildMeetingJoinUrl` in
 * `mirotalk-config.ts`, which is where the club's own meeting configuration
 * is resolved (#2940); this module knows nothing about MiroTalk.
 */
export type CalendarEventDTO = {
  id: string;
  title: string;
  location: string | null;
  details: string | null;
  allDay: boolean;
  startsAt: string;
  endsAt: string | null;
  isMeeting: boolean;
  seriesId: string | null;
  detachedFromSeries: boolean;
  /** The series rule when this event recurs (null for a one-off). */
  recurrence: RecurrenceSummaryDTO | null;
  /**
   * The work party that manages this entry (#5148), or null. A linked entry
   * opens read-only and points at the work party instead.
   */
  workPartyEventId: string | null;
};

/**
 * Who is reading the calendar: the session user, as the members-only rule
 * (`canViewWorkParties`) reads it.
 */
export type CalendarViewer = Parameters<typeof canViewWorkParties>[0];

/** What the calendar visibility rule needs to know about the read. */
export type CalendarVisibilityContext = {
  modules: { workParties: boolean };
  viewer: CalendarViewer;
};

/**
 * Whether this read may show ANY work party's entries: the viewer is a member
 * and the Work parties module is on. The first two conditions of
 * {@link whereVisibleCalendarEvent}, which applies them; a reader uses this
 * only to skip a work-party read the rule would empty anyway.
 */
export function showsWorkPartyCalendarEntries(
  context: CalendarVisibilityContext,
): boolean {
  return context.modules.workParties && canViewWorkParties(context.viewer);
}

/**
 * Which calendar rows a reader shows (#5148): every ordinary event, and a work
 * party's entries only when ALL of these hold:
 *
 * - the viewer is a member (`canViewWorkParties`, owner decision of 20 Nov
 *   2026: members only, like the dashboard card, the work-party page and
 *   Join), so a non-member login, a lodge kiosk, an admin-only account and an
 *   organisation account never see a work party's name, lodge or description
 *   on the calendar (the booking form's working-bee list is a separate reader);
 * - the Work parties module is on. With it off nobody can manage the entries
 *   (the work-party routes answer 404 and the calendar refuses linked
 *   entries), so they must not show;
 * - that work party is open (active, with its internal promo active —
 *   `OPEN_WORK_PARTY_EVENT_WHERE`).
 *
 * Deactivating a work party, or switching the module off, hides its entries
 * rather than deleting them, so turning either back on brings them back
 * unchanged.
 *
 * The viewer is a required argument, so a reader cannot apply the rule without
 * saying who is reading. Every calendar read that shows events — the list API
 * and the dashboard's Events card — goes through this.
 *
 * The rule joins the caller's filter as one more `AND` clause (after any the
 * caller already has), never spread into it: the visibility rule is an `OR`,
 * and a spread would be silently overwritten by an `OR` in the caller's query
 * (or overwrite it). The caller's own fields stay where it put them.
 */
export function whereVisibleCalendarEvent(
  where: Prisma.CalendarEventWhereInput,
  context: CalendarVisibilityContext,
): Prisma.CalendarEventWhereInput {
  const visible: Prisma.CalendarEventWhereInput = showsWorkPartyCalendarEntries(
    context,
  )
    ? {
        OR: [
          { workPartyEventId: null },
          { workPartyEvent: OPEN_WORK_PARTY_EVENT_WHERE },
        ],
      }
    : { workPartyEventId: null };
  const callerAnd =
    where.AND === undefined ? [] : Array.isArray(where.AND) ? where.AND : [where.AND];
  return { ...where, AND: [...callerAnd, visible] };
}

/**
 * Serialise a stored event for the API. Builds NO meeting join URL: the host
 * token is never placed in a list/serialise payload (see
 * {@link CalendarEventDTO}, and `buildMeetingJoinUrl` in `mirotalk-config.ts`).
 */
export function serializeCalendarEvent(
  event: CalendarEvent & { series?: CalendarEventSeries | null },
): CalendarEventDTO {
  return {
    id: event.id,
    title: event.title,
    location: event.location,
    details: event.details,
    allDay: event.allDay,
    startsAt: event.startsAt.toISOString(),
    endsAt: event.endsAt ? event.endsAt.toISOString() : null,
    isMeeting: event.isMeeting,
    seriesId: event.seriesId,
    detachedFromSeries: event.detachedFromSeries,
    // A work party's nights are stored as a daily series only so they move
    // together (#5148); they are one event, not a repeating one, so no
    // "Daily, 3 times" line is offered for them.
    recurrence:
      event.series && !event.workPartyEventId
        ? recurrenceSummaryFromSeries(event.series)
        : null,
    workPartyEventId: event.workPartyEventId ?? null,
  };
}
