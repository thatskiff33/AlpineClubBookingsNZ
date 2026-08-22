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
 * Fifty-eight call sites in sixteen files use that pair.
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
 *   `nextExistingInstant` instead.
 * - **Ambiguous** (two valid): the clocks went back over it. Default is the
 *   earliest occurrence.
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
 * America/Denver: zero failures.
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

function resolveClubWallTime(
  date: CalendarDate,
  time: ClubTimeOfDay,
  zone: ClubTimeZone,
): WallTimeResolution {
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

  const candidates = [...new Set(
    [wallAsUtc - MS_PER_DAY, wallAsUtc, wallAsUtc + MS_PER_DAY].map(
      (probe) => wallAsUtc - clubZoneOffsetMs(new Date(probe), zone),
    ),
  )].sort((left, right) => left - right);

  const valid = candidates.filter((candidate) => {
    const read = clubWallTimeOf(new Date(candidate), zone);
    return (
      read.date === date &&
      read.hour === hour &&
      read.minute === minute &&
      read.second === second
    );
  });

  if (valid.length === 0) {
    // Every candidate landed outside the requested reading, so the reading does
    // not exist. The moment the clock jumped to is the LATEST candidate: it is
    // the one computed with the offset in force BEFORE the jump, which for a
    // reading at the very start of the gap is the transition instant itself.
    const nextExisting = new Date(candidates[candidates.length - 1] ?? wallAsUtc);
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
 * Midday club time on a calendar day — the lodge stay boundary (INV-DATE-002).
 *
 * `nextExistingInstant` rather than `reject`, so a booking screen can never fail
 * to render because of a DST rule. It is belt and braces: local noon is neither
 * skipped nor ambiguous in any of the 418 zones this runtime knows, on any day
 * from 2015 to 2036.
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
