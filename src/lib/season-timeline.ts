/**
 * The season schedule read as a TIMELINE: what order the seasons run in, and
 * which nights no season prices (#2938).
 *
 * ## What this is for
 *
 * A club's seasons are a schedule, and the admin screens listed them as an
 * unordered pile of cards. Nothing on either screen answered the two questions
 * an officer actually has when they open it in autumn — *what runs after what*,
 * and *is next winter covered yet* — so the way a hole in the schedule was
 * found was a member's booking failing to price on the one night nothing
 * covered. This module answers both, once, for every screen that shows seasons.
 *
 * ## The canonical date semantics, and why a naive comparison gets them wrong
 *
 * A season window is **inclusive at both edges, counted in nights**. That is
 * not a choice made here: it is what the resolver does. `findRateForNight`
 * (`src/lib/policies/pricing.ts`) matches a night when
 * `season.startDate <= night <= season.endDate`, and a stay's nights are the
 * half-open `[checkIn, checkOut)` expansion (`INV-DATE-003`) — so the last
 * night a season prices is `endDate` itself, and the first night the NEXT
 * season must price is the day after it.
 *
 * Written half-open, a season covers `[startDate, endDate + 1 day)`. Two
 * seasons are therefore contiguous when the later one starts the day AFTER the
 * earlier one ends, and a comparison that asks only `next.startDate >
 * previous.endDate` reports a gap between every correctly abutting pair a club
 * has — the false alarm that makes a warning panel worth less than no panel at
 * all. The day-after step below is the whole point of the function.
 *
 * ## Only ACTIVE seasons are coverage
 *
 * Every pricing path loads seasons with `active: true` — `booking-create.ts`,
 * `booking-request.ts`, `group-booking.ts`, `loadSeasonRateData` and the rest.
 * An inactive season prices nothing, so for this question it is not a season at
 * all: a night it "covers" is a night a booking is refused for want of a
 * season. It stays in the timeline, because an officer looking at a hole needs
 * to see the deactivated window sitting in it — that is usually the cause — but
 * it closes no gap.
 *
 * ## A warning, never a price
 *
 * Nothing here invents coverage, extends a window, or fills a hole. A gap is
 * something to tell the officer about while they are on the screen that can fix
 * it; the booking that lands in one is still refused, and that refusal stays
 * the safety property.
 *
 * ## Isomorphic on purpose, and holding no clock
 *
 * No Prisma, no `node:fs`, no zod, and no clock: the admin screens that render
 * this are `"use client"`. "Today" arrives as an argument (`notBefore`) so a
 * caller cannot take the club's day from the browser's host clock by accident
 * (`INV-DATE-019`), exactly as `seasonRequiresRates` does for the missing-rate
 * warning next door.
 */

import {
  addCalendarDays,
  compareCalendarDates,
  countClubNights,
  type CalendarDate,
} from "@/lib/club-time";

/** One season as the timeline reads it. Both edges are calendar days. */
export interface TimelineSeason {
  id: string;
  name: string;
  startDate: CalendarDate;
  endDate: CalendarDate;
  active: boolean;
}

/**
 * A run of nights between two active seasons that no active season prices.
 *
 * `lastUncoveredNight` is INCLUSIVE — it is a night, and the last one — so the
 * pair reads the way the officer's own sentence does ("nothing covers 1 October
 * to 30 November"). `nights` is how many there are, which is what makes a
 * one-night rounding error visible rather than plausible.
 */
export interface SeasonCoverageGap {
  /** The active season whose coverage ends the day before the gap starts. */
  afterSeasonId: string;
  afterSeasonName: string;
  /** The next active season, which resumes coverage the day after it ends. */
  beforeSeasonId: string;
  beforeSeasonName: string;
  firstUncoveredNight: CalendarDate;
  lastUncoveredNight: CalendarDate;
  nights: number;
}

/** One row of the rendered timeline: a season, or the hole before it. */
export type SeasonTimelineEntry<T> =
  | { kind: "season"; season: T }
  | { kind: "gap"; gap: SeasonCoverageGap };

/**
 * Chronological order, earliest first, and TOTAL — start date, then end date,
 * then name, then id.
 *
 * The tail-breakers are not decoration. Two seasons may share a start date (a
 * deactivated window and its replacement, most often), and a sort that leaves
 * them tied renders them in whatever order the API happened to return, which
 * moves under the officer between one refresh and the next.
 */
export function orderSeasonsChronologically<T extends TimelineSeason>(
  seasons: readonly T[],
): T[] {
  return [...seasons].sort(
    (left, right) =>
      compareCalendarDates(left.startDate, right.startDate) ||
      compareCalendarDates(left.endDate, right.endDate) ||
      (left.name < right.name ? -1 : left.name > right.name ? 1 : 0) ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
}

/**
 * The holes between active seasons, in chronological order.
 *
 * Overlapping and nested windows are handled by sweeping a running
 * `coveredThrough` rather than by comparing each season with the one printed
 * above it: a long season that swallows a short one leaves no gap after the
 * short one, and comparing neighbours pairwise would report one.
 *
 * `notBefore` drops a gap whose last night is already in the past — a hole in
 * last year's schedule is not work an officer can do anything about, the same
 * scope `seasonRequiresRates` applies to the missing-rate warning. A gap that
 * STRADDLES that day is reported in full, because its real extent is what the
 * officer has to close. Omit `notBefore` to get every gap, which is what a test
 * or a report wants.
 *
 * **Gaps are bounded holes only.** The stretch after the last configured season
 * is not reported: every club has one, it is the end of the schedule rather
 * than a mistake in it, and a warning that is true of every installation for
 * ever teaches officers to ignore the panel.
 */
export function computeSeasonCoverageGaps(input: {
  seasons: readonly TimelineSeason[];
  notBefore?: CalendarDate;
}): SeasonCoverageGap[] {
  const active = orderSeasonsChronologically(
    input.seasons.filter((season) => season.active),
  );
  const gaps: SeasonCoverageGap[] = [];
  let covering = active[0];
  if (covering === undefined) return gaps;
  let coveredThrough = covering.endDate;

  for (const season of active.slice(1)) {
    // The day AFTER the last covered night — the canonical half-open boundary.
    // A season starting exactly here abuts the previous one and leaves nothing
    // uncovered.
    const firstUncoveredNight = addCalendarDays(coveredThrough, 1);
    if (compareCalendarDates(season.startDate, firstUncoveredNight) > 0) {
      const gap: SeasonCoverageGap = {
        afterSeasonId: covering.id,
        afterSeasonName: covering.name,
        beforeSeasonId: season.id,
        beforeSeasonName: season.name,
        firstUncoveredNight,
        lastUncoveredNight: addCalendarDays(season.startDate, -1),
        nights: countClubNights(firstUncoveredNight, season.startDate),
      };
      if (
        input.notBefore === undefined ||
        compareCalendarDates(gap.lastUncoveredNight, input.notBefore) >= 0
      ) {
        gaps.push(gap);
      }
    }
    if (compareCalendarDates(season.endDate, coveredThrough) > 0) {
      coveredThrough = season.endDate;
      covering = season;
    }
  }

  return gaps;
}

/**
 * The whole timeline in one list: every season in chronological order, with
 * each gap sitting immediately before the season that resumes coverage.
 *
 * That placement is chronological rather than arbitrary — a gap's last night is
 * the day before `beforeSeason` starts — and it puts a deactivated window that
 * happens to sit inside the hole ABOVE the warning, where it reads as the
 * explanation it usually is.
 */
export function buildSeasonTimeline<T extends TimelineSeason>(input: {
  seasons: readonly T[];
  notBefore?: CalendarDate;
}): Array<SeasonTimelineEntry<T>> {
  const ordered = orderSeasonsChronologically(input.seasons);
  const gapsBeforeSeason = new Map<string, SeasonCoverageGap[]>();
  for (const gap of computeSeasonCoverageGaps(input)) {
    const existing = gapsBeforeSeason.get(gap.beforeSeasonId);
    if (existing) existing.push(gap);
    else gapsBeforeSeason.set(gap.beforeSeasonId, [gap]);
  }

  const entries: Array<SeasonTimelineEntry<T>> = [];
  for (const season of ordered) {
    for (const gap of gapsBeforeSeason.get(season.id) ?? []) {
      entries.push({ kind: "gap", gap });
    }
    entries.push({ kind: "season", season });
  }
  return entries;
}
