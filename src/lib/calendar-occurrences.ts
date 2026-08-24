import { randomUUID } from "crypto";
import type { CalendarEventSeries, Prisma } from "@prisma/client";

import type { RecurrenceRule } from "@/lib/calendar-recurrence";
import {
  clubCalendarDateOf,
  clubWallTimeOf,
  instantForClubWallTime,
  type CalendarDate,
  type ClubTimeZone,
  type Instant,
} from "@/lib/club-time";

/**
 * What a recurring calendar event's occurrence ROWS look like, and the club-time
 * rules that decide it (CT-4 group F5, #2870).
 *
 * Extracted from `calendar-service.ts`, which keeps the database half — the
 * per-series advisory lock, the transactions, and the create/update/delete entry
 * points. The extraction was a PURE MOVE, and it is worth saying what that is
 * measured against: byte-identical to these functions as they stood at
 * `ee596dd50`, the commit that finished migrating them onto club time, differing
 * only by the added `export` keywords. It is NOT byte-identical to the epic base
 * ref — `clubDayKey`, `withClubTimeOfDay` and `seriesMatchesRule` were rewritten
 * by that earlier commit, which is the change this file's docblock explains. Nothing in this module reads or writes anything: it takes a template
 * plus the club's zone and answers "which club day is this occurrence on, what
 * wall-clock time does it keep, and what row does it become". That is the half
 * every zone-dependent decision but one lives in, which is why the reasoning
 * below came with it rather than being left behind at the seam.
 *
 * ## THE CLUB'S TIMEZONE IS THE PERSISTED ONE, NOT THE CONTAINER'S (CT-4, #2870)
 *
 * Three questions in this subsystem have a different answer in different zones:
 * which club day an occurrence lands on, what wall-clock time it keeps, and
 * whether an edit changed the anchor DAY (which is what decides
 * propagate-versus-regenerate). All three used to be answered with host-local
 * `Date` component APIs, justified by the docker `TZ=Pacific/Auckland` pin — the
 * second civil-time authority `INV-CONFIG-002` forbids, and one an operator
 * cannot move from the admin panel.
 *
 * The zone is now resolved ONCE per exported entry point with `clubTimeZone()`
 * (request-memoised) and threaded down as an argument, so no helper in this
 * module or in `calendar-service.ts` can silently reach for a different one. It
 * matters that they agree: a generator on the club's calendar beside a
 * `withClubTimeOfDay` on the container's would MOVE every occurrence of a series
 * on a details-only edit — the "frame pair" failure this epic has already
 * produced three times by correcting one side of a comparison and not the other.
 *
 * The first two of those three questions are {@link clubDayKey} and
 * {@link withClubTimeOfDay} below. The third is the `dateChanged` comparison in
 * `calendar-service.ts`'s `updateCalendarEvent`, which is where the zone is
 * resolved; it uses {@link clubDayKey} from here, so the two cannot drift apart.
 *
 * ## Why this is a module and not a folder of one-liners
 *
 * `durationMsOf`, `nextMeetingRoom` and the two `series*` readers look trivial
 * on their own and are not separable from the rest: every one of them is read by
 * {@link buildOccurrenceRows} or by the row comparison that decides whether a
 * series needs regenerating, and splitting them further would put the row shape
 * and the rules that produce it in different files.
 */
/** Field/time template shared by all occurrences of one create/edit. */
export interface ResolvedEventData {
  title: string;
  location: string | null;
  details: string | null;
  allDay: boolean;
  isMeeting: boolean;
  startsAt: Date;
  endsAt: Date | null;
  recurrence: RecurrenceRule | null;
}

export function durationMsOf(startsAt: Date, endsAt: Date | null): number | null {
  return endsAt ? endsAt.getTime() - startsAt.getTime() : null;
}

export function nextMeetingRoom(
  isMeeting: boolean,
  existingRoom: string | null,
): string | null {
  if (!isMeeting) return null;
  return existingRoom ?? randomUUID();
}

/** The CLUB calendar day an instant falls on — "which day is this occurrence?". */
export function clubDayKey(instant: Instant, zone: ClubTimeZone): CalendarDate {
  return clubCalendarDateOf(instant, zone);
}

/**
 * Combine a target day with a template's club time-of-day (or the start of the
 * club day, all-day).
 *
 * Both projections are the club's, taken once each: the day comes out of `day`
 * and the wall time out of `time`, and the result is re-derived through the
 * club's zone with its DST rules. So a 7pm series stays 7pm across a transition
 * rather than sliding by an hour, and an all-day occurrence starts at the first
 * instant of the club day even in a zone where midnight does not exist.
 */
export function withClubTimeOfDay(
  day: Instant,
  time: Instant,
  allDay: boolean,
  zone: ClubTimeZone,
): Instant {
  const date = clubCalendarDateOf(day, zone);
  if (allDay) {
    return instantForClubWallTime(date, { hour: 0 }, zone, {
      skipped: "nextExistingInstant",
      ambiguous: "earliest",
    });
  }
  const wall = clubWallTimeOf(time, zone);
  return instantForClubWallTime(
    date,
    {
      hour: wall.hour,
      minute: wall.minute,
      second: wall.second,
      millisecond: wall.millisecond,
    },
    zone,
    { skipped: "nextExistingInstant", ambiguous: "earliest" },
  );
}

export function seriesUntil(rule: RecurrenceRule): Date | null {
  return rule.endMode === "until" && rule.until ? new Date(rule.until) : null;
}

export function seriesCount(rule: RecurrenceRule): number | null {
  return rule.endMode === "count" && rule.count ? rule.count : null;
}

/** Does a stored series row already match this rule (frequency/interval/end)? */
export function seriesMatchesRule(
  series: CalendarEventSeries,
  rule: RecurrenceRule,
  zone: ClubTimeZone,
): boolean {
  const storedUntilKey = series.until ? clubDayKey(series.until, zone) : null;
  const ruleUntil = seriesUntil(rule);
  const ruleUntilKey = ruleUntil ? clubDayKey(ruleUntil, zone) : null;
  return (
    series.frequency === rule.frequency &&
    series.interval === rule.interval &&
    storedUntilKey === ruleUntilKey &&
    (series.count ?? null) === seriesCount(rule)
  );
}

export function buildOccurrenceRows(
  starts: Date[],
  data: ResolvedEventData,
  seriesId: string,
  actorId: string,
  // E2: a regenerate reuses the room slug of any occurrence that lands on the
  // same start instant it had before (keyed by startsAt.getTime()), so editing a
  // series' pattern does not silently break the join links of unchanged dates.
  // Genuinely-new dates still get a fresh, unguessable room.
  preservedRooms?: Map<number, string>,
): Prisma.CalendarEventCreateManyInput[] {
  const durationMs = durationMsOf(data.startsAt, data.endsAt);
  return starts.map((start) => ({
    title: data.title,
    location: data.location,
    details: data.details,
    allDay: data.allDay,
    startsAt: start,
    endsAt:
      data.allDay || durationMs == null
        ? null
        : new Date(start.getTime() + durationMs),
    isMeeting: data.isMeeting,
    // Each occurrence gets its own unguessable room, so a leaked link never
    // opens a different week's meeting. A preserved room is reused only for an
    // instant that already existed (never minted for a new date).
    meetingRoom: data.isMeeting
      ? (preservedRooms?.get(start.getTime()) ?? randomUUID())
      : null,
    createdById: actorId,
    seriesId,
    detachedFromSeries: false,
  }));
}
