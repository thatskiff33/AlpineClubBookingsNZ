/**
 * The club's temporal API with its zone already supplied (CT-2, #2990).
 *
 * Every zone-taking function in this kernel is deliberately explicit, which is
 * right at a boundary and tedious inside a component that formats fifteen
 * timestamps. `bindClubTime(zone)` hands back the same operations with the zone
 * closed over.
 *
 * THE SAME INTERFACE ON BOTH SIDES OF THE NETWORK. A server module gets one from
 * `clubTime()` in `./server`, which resolves the persisted zone once per render
 * pass. A client module gets one by calling `bindClubTime` on a zone it received
 * as data — a prop, or a payload field. The method names are identical, so a
 * component that moves between server and client changes the line that obtains
 * the binding and nothing else.
 *
 * A CLIENT MUST NEVER OBTAIN THE ZONE FROM ITS OWN HOST.
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` is the viewer's clock, and
 * the epic's first rule is that a viewer in London sees the same club time as a
 * viewer in Ohakune. The zone travels as data from the server that read it.
 */

import {
  endOfClubDayExclusive,
  instantForClubWallTime,
  noonOfClubDay,
  startOfClubDay,
} from "./boundaries";
import { clubToday, systemClubClock } from "./clock";
import {
  formatClubInstantDate,
  formatClubInstantDateTime,
  formatClubInstantLongDate,
  formatClubInstantMonthYear,
  formatClubInstantTime,
  formatClubInstantWeekdayDate,
} from "./format";
import { clubCalendarDateOf, clubWallTimeOf } from "./instant";
import { stayWindow } from "./stay-window";
import type {
  CalendarDate,
  ClubClock,
  ClubTimeOfDay,
  ClubTimeZone,
  ClubWallTime,
  Instant,
  StayWindow,
  WallTimePolicy,
} from "./types";

export interface BoundClubTime {
  readonly zone: ClubTimeZone;
  today(clock?: ClubClock): CalendarDate;
  calendarDateOf(instant: Instant): CalendarDate;
  wallTimeOf(instant: Instant): ClubWallTime;
  instantDate(instant: Instant): string;
  instantDateTime(instant: Instant): string;
  instantLongDate(instant: Instant): string;
  instantTime(instant: Instant): string;
  instantMonthYear(instant: Instant): string;
  instantWeekdayDate(instant: Instant): string;
  startOfDay(date: CalendarDate): Instant;
  endOfDayExclusive(date: CalendarDate): Instant;
  noon(date: CalendarDate): Instant;
  atWallTime(
    date: CalendarDate,
    time: ClubTimeOfDay,
    policy?: WallTimePolicy,
  ): Instant;
  stayWindow(checkIn: CalendarDate, checkOut: CalendarDate): StayWindow;
}

/** The kernel's zone-taking operations, with `zone` closed over. */
export function bindClubTime(zone: ClubTimeZone): BoundClubTime {
  return {
    zone,
    today: (clock: ClubClock = systemClubClock) => clubToday(zone, clock),
    calendarDateOf: (instant) => clubCalendarDateOf(instant, zone),
    wallTimeOf: (instant) => clubWallTimeOf(instant, zone),
    instantDate: (instant) => formatClubInstantDate(instant, zone),
    instantDateTime: (instant) => formatClubInstantDateTime(instant, zone),
    instantLongDate: (instant) => formatClubInstantLongDate(instant, zone),
    instantTime: (instant) => formatClubInstantTime(instant, zone),
    instantMonthYear: (instant) => formatClubInstantMonthYear(instant, zone),
    instantWeekdayDate: (instant) =>
      formatClubInstantWeekdayDate(instant, zone),
    startOfDay: (date) => startOfClubDay(date, zone),
    endOfDayExclusive: (date) => endOfClubDayExclusive(date, zone),
    noon: (date) => noonOfClubDay(date, zone),
    atWallTime: (date, time, policy) =>
      instantForClubWallTime(date, time, zone, policy),
    stayWindow: (checkIn, checkOut) => stayWindow(checkIn, checkOut, zone),
  };
}
