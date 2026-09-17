/**
 * The decode-and-order policy both season screens share (#2938).
 *
 * This module exists because that policy was written out twice, once per
 * screen, and had already begun to drift. The cases below are the parts a
 * screen test cannot state cheaply: the two payload spellings a `@db.Date`
 * column arrives in, what happens to a season whose edges cannot be read, and
 * the fact that "today" is an argument rather than a clock.
 *
 * `season-timeline.test.ts` owns the boundary arithmetic underneath and is not
 * repeated here. Dates are written against the frozen clock's 2026-07-01.
 */

import { describe, expect, it } from "vitest";

import { requireCalendarDate, type CalendarDate } from "@/lib/club-time";
import { readSeasonSchedule } from "../season-schedule";

const day = (iso: string): CalendarDate => requireCalendarDate(iso);
const TODAY = day("2026-07-01");

interface TestSeason {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  active: boolean;
  /** Something only the CALLER knows about, to prove its object comes back. */
  rates?: number;
}

function season(overrides: Partial<TestSeason> = {}): TestSeason {
  return {
    id: "winter",
    name: "Winter 2026",
    startDate: "2026-06-01T00:00:00.000Z",
    endDate: "2026-09-30T00:00:00.000Z",
    active: true,
    ...overrides,
  };
}

/** The names in rendered order, with each gap spelt where it falls. */
function shape(entries: ReturnType<typeof readSeasonSchedule<TestSeason>>) {
  return entries.timeline.map((entry) =>
    entry.kind === "gap"
      ? `gap:${entry.gap.firstUncoveredNight}..${entry.gap.lastUncoveredNight}`
      : entry.season.name,
  );
}

describe("readSeasonSchedule: order", () => {
  it("puts the seasons in date order whatever order they arrived in", () => {
    const schedule = readSeasonSchedule({
      today: TODAY,
      seasons: [
        season({
          id: "summer",
          name: "Summer 2026-27",
          startDate: "2026-10-01T00:00:00.000Z",
          endDate: "2027-04-30T00:00:00.000Z",
        }),
        season(),
      ],
    });

    expect(shape(schedule)).toEqual(["Winter 2026", "Summer 2026-27"]);
  });

  it("hands back the CALLER's own season objects, not decoded stand-ins", () => {
    // The screens render their card from the payload they already hold. A
    // schedule that returned its internal `{ id, name, startDate, endDate }`
    // rows would silently strip every field a card needs — rates, badges, the
    // flat whole-lodge amount.
    const winter = season({ rates: 4505 });
    const schedule = readSeasonSchedule({ today: TODAY, seasons: [winter] });

    const entry = schedule.timeline[0];
    expect(entry?.kind).toBe("season");
    expect(entry?.kind === "season" && entry.season).toBe(winter);
  });
});

describe("readSeasonSchedule: the two payload spellings", () => {
  it("reads a UTC-midnight instant and a bare day as the same calendar day", () => {
    // `INV-DATE-019`: the `@db.Date` column reaches the browser as UTC
    // midnight from one route and as `2026-06-01` from another. Reading either
    // through a zone names the day before for a club behind UTC.
    const viaInstant = readSeasonSchedule({
      today: TODAY,
      seasons: [season({ startDate: "2026-06-01T00:00:00.000Z" })],
    });
    const viaBareDay = readSeasonSchedule({
      today: TODAY,
      seasons: [season({ startDate: "2026-06-01" })],
    });

    expect(viaInstant.undatedSeasons).toEqual([]);
    expect(viaBareDay.undatedSeasons).toEqual([]);
    expect(shape(viaInstant)).toEqual(shape(viaBareDay));
  });
});

describe("readSeasonSchedule: a season whose edges cannot be read", () => {
  it("lists it, and judges it by nothing", () => {
    // An unreadable edge is not evidence of a gap. Guessing one would put a
    // hole on screen that is not in the data; dropping the season would hide a
    // window an officer needs to see and fix.
    const broken = season({ id: "broken", name: "Mystery", endDate: "" });
    const schedule = readSeasonSchedule({
      today: TODAY,
      seasons: [season(), broken],
    });

    expect(schedule.undatedSeasons).toEqual([broken]);
    expect(shape(schedule)).toEqual(["Winter 2026"]);
    expect(schedule.coverageGaps).toEqual([]);
  });

  it("does not let an unreadable window close a real hole either", () => {
    // The symmetric half: the hole between winter and summer stands whether or
    // not something unreadable claims to sit in it.
    const schedule = readSeasonSchedule({
      today: TODAY,
      seasons: [
        season(),
        season({ id: "broken", name: "Mystery", startDate: "not-a-date" }),
        season({
          id: "summer",
          name: "Summer 2026-27",
          startDate: "2026-12-01T00:00:00.000Z",
          endDate: "2027-04-30T00:00:00.000Z",
        }),
      ],
    });

    expect(schedule.coverageGaps).toHaveLength(1);
    expect(schedule.coverageGaps[0]?.nights).toBe(61);
  });
});

describe("readSeasonSchedule: the holes, and where they sit", () => {
  it("puts each gap immediately before the season that resumes cover", () => {
    const schedule = readSeasonSchedule({
      today: TODAY,
      seasons: [
        season(),
        season({
          id: "summer",
          name: "Summer 2026-27",
          startDate: "2026-12-01T00:00:00.000Z",
          endDate: "2027-04-30T00:00:00.000Z",
        }),
      ],
    });

    expect(shape(schedule)).toEqual([
      "Winter 2026",
      "gap:2026-10-01..2026-11-30",
      "Summer 2026-27",
    ]);
    expect(schedule.coverageGaps).toHaveLength(1);
  });

  it("reports the same gaps in `coverageGaps` as it marks in the timeline", () => {
    // The summary above the list and the notices inside it must agree: a count
    // that disagreed with what is marked below is worse than no count.
    const schedule = readSeasonSchedule({
      today: TODAY,
      seasons: [
        season(),
        season({
          id: "summer",
          name: "Summer 2026-27",
          startDate: "2026-12-01T00:00:00.000Z",
          endDate: "2027-04-30T00:00:00.000Z",
        }),
        season({
          id: "winter-27",
          name: "Winter 2027",
          startDate: "2027-06-01T00:00:00.000Z",
          endDate: "2027-09-30T00:00:00.000Z",
        }),
      ],
    });

    const marked = schedule.timeline.flatMap((entry) =>
      entry.kind === "gap" ? [entry.gap] : [],
    );
    expect(marked).toEqual(schedule.coverageGaps);
    expect(marked).toHaveLength(2);
  });
});

describe("readSeasonSchedule: today is an argument", () => {
  it("drops a hole that is wholly in the past, and keeps one that is not", () => {
    // Same scope the missing-rates warning applies: a hole in last year's
    // schedule is not work anybody can do. The clock is the CLUB's, passed in —
    // a browser's host clock is not it (`INV-DATE-019`).
    const seasons = [
      season({
        id: "old",
        name: "Old",
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-02-28T00:00:00.000Z",
      }),
      season(),
      season({
        id: "summer",
        name: "Summer 2026-27",
        startDate: "2026-12-01T00:00:00.000Z",
        endDate: "2027-04-30T00:00:00.000Z",
      }),
    ];

    const fromToday = readSeasonSchedule({ today: TODAY, seasons });
    expect(fromToday.coverageGaps.map((found) => found.nights)).toEqual([61]);

    // Wind the same data back and the March-to-May hole becomes present work.
    const fromJanuary = readSeasonSchedule({
      today: day("2026-01-15"),
      seasons,
    });
    expect(fromJanuary.coverageGaps.map((found) => found.nights)).toEqual([
      92, 61,
    ]);
  });
});
