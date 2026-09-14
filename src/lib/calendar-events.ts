import { z } from "zod";
import type { CalendarEvent, CalendarEventSeries } from "@prisma/client";
import {
  CALENDAR_RECURRENCE_FREQUENCIES,
  MAX_OCCURRENCES,
  type RecurrenceEndMode,
} from "@/lib/calendar-recurrence";

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
};

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
    recurrence: event.series
      ? recurrenceSummaryFromSeries(event.series)
      : null,
  };
}
