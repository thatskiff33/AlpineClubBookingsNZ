/**
 * A season list as it arrives from the admin API, read as a SCHEDULE (#2938).
 *
 * ## Why this is a module and not a `useMemo` in each screen
 *
 * Two admin screens list seasons — Fees → Hut Fees, which creates them, and
 * Seasons, which moves their windows — and both must answer the same two
 * questions from the same payload: what order do these run in, and which nights
 * does nothing price. The steps between the payload and that answer are a
 * POLICY, not markup:
 *
 * 1. decode each season's two edges out of the payload's `@db.Date` encoding;
 * 2. a season either edge cannot be decoded from is **not evidence of
 *    anything** — it is held out of the analysis rather than judged by it;
 * 3. the rest go through {@link buildSeasonTimeline}, bounded by the club's
 *    today so a hole wholly in the past is not reported as work; and
 * 4. the gaps are collected for the count that sits above the list.
 *
 * That policy was written out twice, once per screen, and the two copies had
 * already begun to drift in the commit that created them: one screen's comment
 * explained why a past hole is dropped and said nothing about undecodable
 * edges, the other explained undecodable edges and said nothing about past
 * holes, so a reader landing on either learned half of it. Which is exactly the
 * argument `season-coverage-warning.tsx` makes for itself one import away —
 * "two screens render this, so it is one component" — and it applies to a rule
 * with more force than to a sentence (`INV-SSOT-001`).
 *
 * ## Why here and not in `src/lib/season-timeline.ts`
 *
 * `season-timeline.ts` holds the date arithmetic and knows nothing about
 * payloads. This is the seam where an admin API's wire encoding meets it, and
 * the decoder it composes (`calendar-day.ts`) is admin-scoped for a reason
 * written in its own docblock. Putting a `src/app` import into `src/lib` to
 * avoid one small module would invert that.
 *
 * ## It holds no clock
 *
 * "Today" arrives as an argument, exactly as it does for `buildSeasonTimeline`
 * and `seasonRequiresRates`. Both callers are `"use client"`, and a browser's
 * host clock is not the club's day (`INV-DATE-019`).
 */

import type { CalendarDate } from "@/lib/club-time";
import {
  buildSeasonTimeline,
  type SeasonCoverageGap,
  type SeasonTimelineEntry,
} from "@/lib/season-timeline";

import { calendarDayFromPayload } from "./calendar-day";

/** What the schedule needs of a season, as the admin API spells it. */
export interface SeasonSchedulePayload {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  active: boolean;
}

/** The schedule a screen renders: the ordered list, the holes, and the rest. */
export interface SeasonSchedule<T> {
  /** Every decodable season in date order, each gap before the season that resumes cover. */
  timeline: Array<SeasonTimelineEntry<T>>;
  /** Every hole the timeline found, for the count above the list. */
  coverageGaps: SeasonCoverageGap[];
  /** Seasons whose edges this screen could not decode: listed, never judged. */
  undatedSeasons: T[];
}

/**
 * Read a season payload list as a schedule.
 *
 * The returned timeline carries the caller's OWN season objects, not the
 * decoded stand-ins built here, so a screen renders its card from the payload
 * it already holds.
 */
export function readSeasonSchedule<T extends SeasonSchedulePayload>(input: {
  seasons: readonly T[];
  today: CalendarDate;
}): SeasonSchedule<T> {
  const dated: Array<{
    id: string;
    name: string;
    active: boolean;
    startDate: CalendarDate;
    endDate: CalendarDate;
    season: T;
  }> = [];
  const undatedSeasons: T[] = [];

  for (const season of input.seasons) {
    const startDate = calendarDayFromPayload(season.startDate);
    const endDate = calendarDayFromPayload(season.endDate);
    // An edge this screen cannot read is not evidence of a gap, and a season
    // built from a guessed edge would put a hole on screen that is not there.
    if (startDate === null || endDate === null) {
      undatedSeasons.push(season);
      continue;
    }
    dated.push({
      id: season.id,
      name: season.name,
      active: season.active,
      startDate,
      endDate,
      season,
    });
  }

  const entries = buildSeasonTimeline({
    seasons: dated,
    notBefore: input.today,
  });

  const timeline: Array<SeasonTimelineEntry<T>> = entries.map((entry) =>
    entry.kind === "gap"
      ? entry
      : { kind: "season", season: entry.season.season },
  );

  return {
    timeline,
    coverageGaps: entries.flatMap((entry) =>
      entry.kind === "gap" ? [entry.gap] : [],
    ),
    undatedSeasons,
  };
}
