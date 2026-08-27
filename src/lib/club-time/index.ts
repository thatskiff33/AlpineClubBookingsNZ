/**
 * `@/lib/club-time` — the canonical temporal subsystem (CT-2, #2990; epic #2988).
 *
 * ONE PUBLIC TEMPORAL API. No page, component or service designs its own
 * timezone behaviour; nothing outside this directory constructs an
 * `Intl.DateTimeFormat` for a date or reads the host's zone to decide anything.
 * The three domain concepts are distinct in the type system, not merely in prose
 * — see `./types`.
 *
 * ## Which function do I want?
 *
 * | I am holding                            | I want                                    |
 * | --------------------------------------- | ----------------------------------------- |
 * | a lodge night / DOB / season edge        | `CalendarDate` + `formatClubDate` and friends — no zone |
 * | a `@db.Date` that crossed a JSON boundary | `calendarDateOfSerialisedDbDate` — or the `OrNull` form in a client render |
 * | a `createdAt` / `paidAt` / audit stamp   | `Instant` + `formatClubInstant*` — zone required        |
 * | "the club day D starts/ends when?"       | `startOfClubDay` / `endOfClubDayExclusive`              |
 * | "08:00 club time on D is when?"          | `instantForClubWallTime`                                |
 * | "when does this stay arrive and depart?" | `stayWindow` — and NOT for deciding occupancy           |
 * | "what day is it for the club?"           | `clubToday`                                             |
 *
 * ## This barrel is isomorphic
 *
 * No `server-only`, no Prisma, no `process.env` read of the zone. The admin
 * panel needs the zone list and 112 of the 400 files on the legacy temporal
 * surfaces are `"use client"`, so the barrel has to be reachable from the
 * browser bundle. The server binding lives in `./server`, which carries
 * `import "server-only"`; `client-server-boundary-census.test.ts`
 * (`INV-OPS-013`) is the guard that keeps it off the client graph.
 *
 * ## The implementation is replaceable
 *
 * Everything crossing this boundary is a branded string, a `Date`, a number or a
 * plain object. Nothing exposes `Intl`, and nothing exposes a library type. When
 * `Temporal` is available across the product baseline, swapping the internals is
 * a change inside `src/lib/club-time/**` and nowhere else.
 *
 * WHY NOT `Temporal` NOW, measured on this tree: Node 24.15.0 has it only behind
 * `--harmony-temporal`, which V8 itself labels "in progress / experimental";
 * Next 16.3's `MODERN_BROWSERSLIST_TARGET` includes `safari 16.4`, and
 * `caniuse-lite` 1.0.30001800 records NO supporting Safari version at all. The
 * `@js-temporal/polyfill` is ~36 KB gzipped on a graph 112 client files reach,
 * and is a `0.x` dependency, for three small functions that `formatToParts`
 * already answers. Revisit against a moved baseline; do not revisit by adding
 * the polyfill to a call site.
 */

export {
  addCalendarDays,
  addCalendarMonths,
  calendarDateFromParts,
  calendarDateParts,
  calendarDayOfWeek,
  calendarMonthOf,
  compareCalendarDates,
  countClubNights,
  daysInCalendarMonth,
  eachCalendarDate,
  isCalendarDate,
  parseCalendarDate,
  requireCalendarDate,
  startOfCalendarMonth,
} from "./calendar-date";

export {
  calendarDateOfDateOnlyInstant,
  calendarDateOfSerialisedDbDate,
  calendarDateOfSerialisedDbDateOrNull,
  clubCalendarDateOf,
  clubWallTimeOf,
  clubZoneOffsetMs,
  dateOnlyInstantOf,
  isInstant,
  parseInstant,
  requireInstant,
  requireStoredCalendarDay,
} from "./instant";

export {
  CLUB_STAY_BOUNDARY_HOUR,
  endOfClubDayExclusive,
  endOfClubDayInclusive,
  instantForClubWallTime,
  noonOfClubDay,
  startOfClubDay,
} from "./boundaries";

export { stayWindow } from "./stay-window";

export { clubToday, fixedClubClock, systemClubClock } from "./clock";

export {
  formatClubDate,
  formatClubDayMonth,
  formatClubInstantDate,
  formatClubInstantDateTime,
  formatClubInstantDayMonth,
  formatClubInstantLongDate,
  formatClubInstantMonthYear,
  formatClubInstantTime,
  formatClubInstantWeekdayDate,
  formatClubInstantWeekdayDayMonth,
  formatClubLongDate,
  formatClubLongWeekday,
  formatClubLongWeekdayDate,
  formatClubLongWeekdayDayMonth,
  formatClubMonthYear,
  formatClubShortMonth,
  formatClubShortMonthYear,
  formatClubWeekday,
  formatClubWeekdayDate,
  formatClubWeekdayDay,
  formatClubWeekdayDayMonth,
} from "./format";

export { bindClubTime, type BoundClubTime } from "./bound";

export {
  asClubTimeZone,
  requireClubTimeZone,
  unvalidatedLegacyClubTimeZone,
} from "./zone";

export {
  SkippedClubWallTimeError,
  type AmbiguousWallTimePolicy,
  type CalendarDate,
  type ClubClock,
  type ClubTimeOfDay,
  type ClubTimeZone,
  type ClubWallTime,
  type Instant,
  type SkippedWallTimePolicy,
  type StayWindow,
  type WallTimePolicy,
} from "./types";
