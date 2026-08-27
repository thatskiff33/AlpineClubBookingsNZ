/**
 * Club-local wall time -> instant, and the boundaries of a club day
 * (CT-2, #2990; epic #2988).
 *
 * This is the third of the epic's three concepts: a wall-clock reading plus the
 * club's named zone, whose actual moment is DERIVED with that zone's DST rules.
 * "Noon on the day the party arrives" and "the job runs at 08:00 club time" are
 * both this, and both are wrong if computed as `dayCount * 24h`.
 *
 * ## The defect this replaces, measured
 *
 * `startOfDateOnlyForTimeZone` in `src/lib/date-only.ts` resolves a wall time by
 * applying the zone offset twice — the standard trick, and almost right. On Node
 * 24.15.0, `America/Havana` springs forward AT MIDNIGHT on 8 March:
 *
 *     requested 2026-03-08 00:00 -> 2026-03-08T04:00:00Z, which reads back as
 *                                   2026-03-07 23:00   <- THE PREVIOUS DAY
 *
 * `endOfDateOnlyForTimeZone` is built on top of it, so an activity window for
 * 8 March started on 7 March and the window for 7 March lost its last hour.
 * When this was written that pair had **31 production call sites in 16 files** —
 * an earlier draft of this sentence said "fifty-eight", which no predicate
 * reproduces; `date-only.ts` carries the measurement, the predicate and the
 * command, and is the one place either figure should be read from.
 *
 * Swept across every one of the 418 zones this runtime knows, 2015-2036, the
 * old algorithm returns the WRONG CALENDAR DAY in **eleven** of them —
 * Asuncion, Campo Grande, Coyhaique, Cuiaba, Havana, Punta Arenas, Santiago,
 * Sao Paulo, Scoresbysund, Palmer and the Azores — and differs from the answer
 * below in sixteen. It is unreachable for a `Pacific/Auckland` club, and
 * reachable precisely because CT-1 makes any IANA zone selectable.
 *
 * ## Why three probes and not two
 *
 * The two-pass trick probes the offset at the UTC reading of the wall time and
 * then at its own first answer. Both probes can land on the same side of a
 * transition, and then it cannot see that the wall time happens TWICE. Measured:
 * `Asia/Amman` on 2015-10-30, where midnight occurs at 21:00Z (+3) and again at
 * 22:00Z (+2); the two-pass returns the later one, so "the start of 30 October"
 * misses its own first hour.
 *
 * So the offsets in force a day BEFORE, AT and a day AFTER are all probed, every
 * distinct candidate is read back, and the ones that really say what was asked
 * for are kept. Nothing is inferred from the offsets themselves — a candidate
 * counts only if the runtime agrees it reads back as the requested wall time.
 *
 * ## The two edge cases, both named rather than assumed
 *
 * - **Skipped** (nothing valid): the clocks jumped over that reading. Default is
 *   to throw {@link SkippedClubWallTimeError}; a day boundary asks for
 *   `nextExistingInstant` instead, which BISECTS for the transition instant —
 *   see below.
 * - **Ambiguous** (two valid): the clocks went back over it. Default is the
 *   earliest occurrence.
 *
 * ## Why the skipped answer is bisected rather than computed
 *
 * The obvious answer for a skipped reading is the request shifted forward by the
 * size of the gap (`wall - offsetBefore`), which is what `Temporal`'s
 * `compatible` disambiguation does. It is right when the request is the FIRST
 * skipped reading and late by the distance into the gap otherwise, and this
 * kernel's consumers need "the moment the clock jumped to" rather than "the
 * request, slid along". Measured on Node 24.15.0:
 *
 * | request                             | shifted   | transition | out by  |
 * | ----------------------------------- | --------- | ---------- | ------- |
 * | `America/Havana` 2026-03-08 00:00    | 05:00Z    | 05:00Z     | 0       |
 * | `America/Havana` 2026-03-08 00:30    | 05:30Z    | 05:00Z     | 30 min  |
 * | `America/Toronto` 1919-03-31 00:00   | 05:00Z    | 04:30Z     | 30 min  |
 * | `Pacific/Apia` 2011-12-30 12:00      | 22:00Z    | 10:00Z     | 12 h    |
 *
 * The Toronto row is the one that matters, because there the gap SPANS midnight
 * (23:30 on the 30th jumps to 00:30 on the 31st): the shifted answer reads 01:00
 * on 31 March, so `startOfClubDay` was not the first instant of its own day and
 * the half-hour from 00:30 to 01:00 was counted into 30 March. `America/Nassau`
 * has the identical transition and they are the ONLY two occurrences in the
 * whole 418-zone, 2015-2036 sweep — zero of them inside it, so nothing shipping
 * today is affected. It is fixed rather than documented because a day partition
 * that is right "except for these two dates" is a partition somebody has to
 * remember, and CT-1 makes any IANA zone selectable over any historical range.
 *
 * The bisection costs about thirty `formatToParts` reads and runs ONLY on a
 * reading that does not exist — never for `Pacific/Auckland`, and never at noon
 * in any zone.
 *
 * THE ONE THING IT STILL CANNOT DO. When a zone skips a WHOLE CALENDAR DAY —
 * `Pacific/Apia` crossing the date line on 2011-12-30 — no instant reads as that
 * day at all, so `startOfClubDay` returns the transition instant, whose club
 * date is the following day. There is no better answer; the day does not exist.
 *
 * Measured across all 418 zones, 2015-2036: local midnight is skipped in 19
 * zones and ambiguous in 8. **Local NOON is neither, in any zone, on any day.**
 * That is a real argument for the epic's noon-to-noon stay boundary beyond
 * domain convenience: a midday boundary sidesteps the entire skipped-time class
 * that a midnight boundary walks straight into.
 *
 * ## The property that is actually asserted
 *
 * `startOfClubDay(D)` is the FIRST INSTANT whose club calendar date is `D`, and
 * `endOfClubDayExclusive(D)` is `startOfClubDay(D + 1)`, so consecutive day
 * ranges partition the timeline with no gap and no overlap. Verified over all
 * 418 zones for every transition-adjacent day 2015-2036, and over every single
 * day of that span for Pacific/Auckland, Pacific/Chatham, UTC and
 * America/Denver: zero failures. The one exception is a day the zone does not
 * have at all, named at the end of the previous section.
 */

import { addCalendarDays } from "./calendar-date";
import { clubWallTimeOf, clubZoneOffsetMs } from "./instant";
import {
  SkippedClubWallTimeError,
  type CalendarDate,
  type ClubTimeOfDay,
  type ClubTimeZone,
  type Instant,
  type WallTimePolicy,
} from "./types";

const MS_PER_DAY = 86_400_000;

/**
 * How far either side of the requested reading the transition search may look.
 *
 * Every real UTC offset is inside +/-16 hours, and a date-line change moves the
 * clock by at most about a day, so two days each way brackets any gap this can
 * be asked about while staying narrow enough that a NEIGHBOURING transition
 * cannot get inside the bracket and break the search's monotonicity.
 */
const TRANSITION_SEARCH_WINDOW_MS = 2 * MS_PER_DAY;

/** The club day's own midnight — the reading, not the instant. */
const MIDNIGHT: ClubTimeOfDay = { hour: 0 };

/** Midday club time — the lodge stay boundary (INV-DATE-002). */
export const CLUB_STAY_BOUNDARY_HOUR = 12;

const NOON: ClubTimeOfDay = { hour: CLUB_STAY_BOUNDARY_HOUR };

/**
 * How a wall-clock reading in the club's zone resolves to a real moment.
 * `earliest`/`latest` differ only for an ambiguous reading; `candidates` is what
 * the runtime agreed reads back as the request.
 */
interface WallTimeResolution {
  readonly kind: "exact" | "ambiguous" | "skipped";
  readonly earliest: Instant;
  readonly latest: Instant;
  /** For a skipped reading: the moment the clock jumped TO. */
  readonly nextExisting: Instant;
}

/**
 * A wall-clock reading is four whole numbers in range, and nothing else.
 *
 * `setUTCHours` ROLLS, so without this an `{ hour: 24 }` — the natural spelling
 * of "the end of the day" — silently became midnight on the FOLLOWING day under
 * `nextExistingInstant`, and under the default policy threw
 * {@link SkippedClubWallTimeError}, whose message says the clocks jumped forward
 * over the reading. Neither is true and the second actively misleads, so a
 * programmer error is named as one. `{ hour: -1 }`, `{ minute: 90 }` and
 * `{ hour: 12.5 }` all behaved the same way.
 */
function requireClubTimeOfDay(time: ClubTimeOfDay): void {
  const fields: [keyof ClubTimeOfDay, number, number][] = [
    ["hour", time.hour, 23],
    ["minute", time.minute ?? 0, 59],
    ["second", time.second ?? 0, 59],
    ["millisecond", time.millisecond ?? 0, 999],
  ];
  for (const [name, value, max] of fields) {
    if (!Number.isInteger(value) || value < 0 || value > max) {
      throw new RangeError(
        `A club wall-clock time needs a whole ${String(name)} from 0 to ${max}: got ${String(value)}. ` +
          "A time of day is a reading on a clock, not an offset — for the end of a day use " +
          "endOfClubDayExclusive, which is the first instant of the NEXT day.",
      );
    }
  }
}

/**
 * The first instant whose club reading is strictly LATER than the requested one
 * — the moment the clock jumped to, for a reading that never happens.
 *
 * Bisection rather than arithmetic, because the answer is a fact about the
 * zone's transition table and nothing about the offsets on either side of the
 * gap locates it. Returns `null` when the window does not bracket a transition,
 * which leaves the caller on its previous answer rather than on a worse one.
 */
function findTransitionAfter(
  wallAsUtc: number,
  target: string,
  zone: ClubTimeZone,
): Instant | null {
  const readsLater = (candidate: number): boolean | null => {
    const key = readingKeyOrNull(new Date(candidate), zone);
    return key === null ? null : key > target;
  };
  let low = wallAsUtc - TRANSITION_SEARCH_WINDOW_MS;
  let high = wallAsUtc + TRANSITION_SEARCH_WINDOW_MS;
  if (readsLater(low) !== false || readsLater(high) !== true) return null;
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    const later = readsLater(middle);
    if (later === null) return null;
    if (later) high = middle;
    else low = middle;
  }
  return new Date(high);
}

/**
 * A club reading as one sortable string, to the SECOND — or `null` for an
 * instant the projection refuses.
 *
 * Seconds because that is all `Intl` reports; a transition lands on a whole
 * minute in every zone this runtime knows, so the bisection above still
 * converges on the exact millisecond of the jump.
 *
 * NULL RATHER THAN A THROW, because every reader here is a PROBE. Resolving a
 * wall time reads instants a day either side of the request and the transition
 * search reads two, so a question about the very first or very last day the
 * kernel can name reaches past its own range — and an internal probe stepping
 * out of bounds must not turn a legitimate query into an error.
 * `endOfDateOnlyForTimeZone("9999-12-30")` is exactly that: a perfectly ordinary
 * day whose successor's probe lands in the year 10000.
 */
function readingKeyOrNull(instant: Instant, zone: ClubTimeZone): string | null {
  const read = readingOrNull(instant, zone);
  return read === null
    ? null
    : wallKey(read.date, read.hour, read.minute, read.second);
}

function readingOrNull(
  instant: Instant,
  zone: ClubTimeZone,
): ReturnType<typeof clubWallTimeOf> | null {
  try {
    return clubWallTimeOf(instant, zone);
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/** {@link clubZoneOffsetMs} for a probe, `null` where the projection refuses. */
function probeOffsetMs(instant: Instant, zone: ClubTimeZone): number | null {
  try {
    return clubZoneOffsetMs(instant, zone);
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

function wallKey(
  date: string,
  hour: number,
  minute: number,
  second: number,
): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date} ${two(hour)}:${two(minute)}:${two(second)}`;
}

function resolveClubWallTime(
  date: CalendarDate,
  time: ClubTimeOfDay,
  zone: ClubTimeZone,
): WallTimeResolution {
  requireClubTimeOfDay(time);
  const hour = time.hour;
  const minute = time.minute ?? 0;
  const second = time.second ?? 0;
  const millisecond = time.millisecond ?? 0;

  // NOT `Date.UTC`, which applies the legacy two-digit-year rule and would read
  // the year 0047 as 1947 (the same reason `dateOnlyFromParts` avoids it).
  const wall = new Date(0);
  wall.setUTCFullYear(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  );
  wall.setUTCHours(hour, minute, second, millisecond);
  const wallAsUtc = wall.getTime();

  const candidates = [
    ...new Set(
      [wallAsUtc - MS_PER_DAY, wallAsUtc, wallAsUtc + MS_PER_DAY]
        .map((probe) => probeOffsetMs(new Date(probe), zone))
        .filter((offset): offset is number => offset !== null)
        .map((offset) => wallAsUtc - offset),
    ),
  ].sort((left, right) => left - right);

  const valid = candidates.filter((candidate) => {
    const read = readingOrNull(new Date(candidate), zone);
    return (
      read !== null &&
      read.date === date &&
      read.hour === hour &&
      read.minute === minute &&
      read.second === second
    );
  });

  if (valid.length === 0) {
    /*
      Every candidate landed outside the requested reading, so the reading does
      not exist and the answer is the instant the clock jumped to. The LATEST
      candidate is the request slid forward by the size of the gap, which is the
      transition only when the request is the gap's first skipped reading — so it
      is the fallback, and the bisection above is the answer. See the module doc
      for the measured difference and the two dates it has ever mattered on.
    */
    const nextExisting =
      findTransitionAfter(wallAsUtc, wallKey(date, hour, minute, second), zone) ??
      new Date(candidates[candidates.length - 1] ?? wallAsUtc);
    return {
      kind: "skipped",
      earliest: nextExisting,
      latest: nextExisting,
      nextExisting,
    };
  }

  const earliest = new Date(valid[0] as number);
  const latest = new Date(valid[valid.length - 1] as number);
  return {
    kind: valid.length > 1 ? "ambiguous" : "exact",
    earliest,
    latest,
    nextExisting: earliest,
  };
}

/**
 * The moment a club wall-clock reading names.
 *
 * `policy.skipped` defaults to `reject` and `policy.ambiguous` to `earliest`;
 * see {@link SkippedWallTimePolicy} for why each default is what it is.
 */
export function instantForClubWallTime(
  date: CalendarDate,
  time: ClubTimeOfDay,
  zone: ClubTimeZone,
  policy: WallTimePolicy = {},
): Instant {
  const resolution = resolveClubWallTime(date, time, zone);
  if (resolution.kind === "skipped") {
    if ((policy.skipped ?? "reject") === "reject") {
      throw new SkippedClubWallTimeError(
        date,
        time.hour,
        time.minute ?? 0,
        zone,
      );
    }
    return resolution.nextExisting;
  }
  return (policy.ambiguous ?? "earliest") === "latest"
    ? resolution.latest
    : resolution.earliest;
}

/**
 * The FIRST INSTANT of a club calendar day — not "midnight", because in 19 of
 * this runtime's 418 zones there are days on which midnight never happens.
 *
 * Use this as the inclusive lower bound of a day-scoped query. Its upper bound
 * is {@link endOfClubDayExclusive}, which is the same function on the next day,
 * so the two never leave a gap and never overlap.
 *
 * When midnight is skipped the answer is the transition instant, which really is
 * the day's first instant even when the gap started the evening BEFORE — see the
 * module doc. The single case it cannot satisfy is a calendar day the zone skips
 * entirely, where no instant reads as that day at all.
 */
export function startOfClubDay(
  date: CalendarDate,
  zone: ClubTimeZone,
): Instant {
  return instantForClubWallTime(date, MIDNIGHT, zone, {
    skipped: "nextExistingInstant",
    ambiguous: "earliest",
  });
}

/**
 * The exclusive upper bound of a club calendar day: the first instant of the
 * NEXT day.
 *
 * Half-open, never "the previous instant minus one millisecond". That matches
 * `[checkIn, checkOut)` everywhere else in the domain and removes a class of
 * off-by-one-millisecond range bugs — a row written in that last millisecond
 * belongs to the day, and an inclusive bound built by subtraction has to
 * remember which resolution to subtract at.
 */
export function endOfClubDayExclusive(
  date: CalendarDate,
  zone: ClubTimeZone,
): Instant {
  return startOfClubDay(addCalendarDays(date, 1), zone);
}

/**
 * The last instant of a club calendar day, INCLUSIVE — the millisecond before
 * {@link endOfClubDayExclusive}.
 *
 * PREFER THE HALF-OPEN BOUND. This exists because five call sites across three
 * lanes had each written `new Date(endOfClubDayExclusive(d, zone).getTime() - 1)`
 * by hand, and a subtraction repeated by hand is a subtraction somebody
 * eventually writes with the wrong resolution — `- 1000` for a seconds-precision
 * column reads as thoughtful and is wrong by 999 milliseconds. One
 * implementation, named for what it produces, is what stops that.
 *
 * WHERE IT IS THE RIGHT ANSWER: a bound that is already inclusive because
 * something else decided so — Prisma's `lte`, a provider's `to` parameter, a
 * user-facing "up to and including" filter. Reaching for it anywhere a `lt` will
 * do is choosing the shape `INV-DATE-003` and the rest of this domain do not
 * use.
 *
 * IT THROWS WHERE ITS EXCLUSIVE SIBLING THROWS, which is the one day whose
 * successor has no `CalendarDate`: `9999-12-31`. `date-only.ts`'s legacy adapter
 * catches that `RangeError` and answers `new Date(NaN)`, because its call sites
 * already behave correctly against an Invalid Date; the kernel does
 * not, because a new caller should be told rather than handed a value that
 * fails silently three modules later.
 */
export function endOfClubDayInclusive(
  date: CalendarDate,
  zone: ClubTimeZone,
): Instant {
  return new Date(endOfClubDayExclusive(date, zone).getTime() - 1);
}

/**
 * Midday club time on a calendar day — the lodge stay boundary (INV-DATE-002).
 *
 * `nextExistingInstant` rather than `reject`, so a booking screen can never fail
 * to render because of a DST rule. It is belt and braces: local noon is neither
 * skipped nor ambiguous in any of the 418 zones this runtime knows, on any day
 * from 2015 to 2036. Where a zone HAS skipped noon — a date-line change that
 * removes a whole calendar day, `Pacific/Apia` in 2011 — the answer is the
 * transition instant rather than the following day's noon, which is as close to
 * right as a day that never happened allows.
 */
export function noonOfClubDay(
  date: CalendarDate,
  zone: ClubTimeZone,
): Instant {
  return instantForClubWallTime(date, NOON, zone, {
    skipped: "nextExistingInstant",
    ambiguous: "earliest",
  });
}
