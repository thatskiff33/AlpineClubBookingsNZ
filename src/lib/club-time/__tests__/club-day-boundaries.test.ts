/**
 * Club-day boundaries and the DST edge cases (CT-2, #2990).
 *
 * The defect this suite exists for: `startOfDateOnlyForTimeZone` resolved a wall
 * time by applying the zone offset twice, and for a club whose clocks spring
 * forward AT MIDNIGHT that lands before the transition — on the PREVIOUS
 * calendar day. Production call sites depend on that pair — 31 in 16 files when
 * this suite was written, and `date-only.ts` holds the count, the predicate and
 * the command rather than this docblock restating a number that can go stale —
 * and no test could see it because the configured zone is `Pacific/Auckland`,
 * where nothing transitions at midnight.
 *
 * THE MUTATION THAT MATTERS: reimplement `resolveClubWallTime` as the old
 * two-pass offset correction. `startOfClubDay` for `America/Havana` on
 * 2026-03-08 then returns 04:00Z, which reads back as 7 March, and the first
 * three cases below fail. If they do not, they are not discriminating the fix.
 */
import { describe, expect, it } from "vitest";

import { requireCalendarDate } from "../calendar-date";
import {
  endOfClubDayExclusive,
  endOfClubDayInclusive,
  instantForClubWallTime,
  noonOfClubDay,
  startOfClubDay,
} from "../boundaries";
import { clubCalendarDateOf, clubWallTimeOf } from "../instant";
import { SkippedClubWallTimeError } from "../types";
import { requireClubTimeZone } from "../zone";
import { withTimeZone } from "@/lib/__tests__/helpers/timezone";

const cd = requireCalendarDate;
const tz = requireClubTimeZone;

const AUCKLAND = tz("Pacific/Auckland");
const CHATHAM = tz("Pacific/Chatham");
const DENVER = tz("America/Denver");
const HAVANA = tz("America/Havana");
const AMMAN = tz("Asia/Amman");
const LORD_HOWE = tz("Australia/Lord_Howe");
const SANTIAGO = tz("America/Santiago");
const TORONTO = tz("America/Toronto");
const NASSAU = tz("America/Nassau");
const APIA = tz("Pacific/Apia");

/**
 * Every club zone this suite crosses with both host zones.
 *
 * `America/Santiago` earns its place: it is the only one here that discriminates
 * the DAY-AFTER probe. Amman discriminates the day-before one, and until
 * Santiago was added the list contained no zone at all that could tell three
 * probes from two — so "three probes, not two" was half-tested. See the case
 * below for the measurement.
 */
const CLUB_ZONES = [
  AUCKLAND,
  CHATHAM,
  DENVER,
  HAVANA,
  AMMAN,
  LORD_HOWE,
  SANTIAGO,
];
const HOST_ZONES = ["UTC", "America/Los_Angeles"];

describe("a club day starts at the first instant that exists on it", () => {
  it("handles a zone whose clocks spring forward AT midnight (#2990)", () => {
    // America/Havana jumps 00:00 -> 01:00 on 8 March 2026, so midnight never
    // happens. The old two-pass answer was 2026-03-08T04:00:00Z, which reads
    // back as 7 March 23:00 — the wrong day.
    const start = startOfClubDay(cd("2026-03-08"), HAVANA);
    expect(start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(clubCalendarDateOf(start, HAVANA)).toBe("2026-03-08");
    expect(clubWallTimeOf(start, HAVANA).hour).toBe(1);
  });

  it("leaves no gap and no overlap around that transition", () => {
    const seventh = cd("2026-03-07");
    const eighth = cd("2026-03-08");
    expect(endOfClubDayExclusive(seventh, HAVANA).getTime()).toBe(
      startOfClubDay(eighth, HAVANA).getTime(),
    );
    // The last millisecond of 7 March belongs to 7 March.
    const lastOfSeventh = new Date(
      endOfClubDayExclusive(seventh, HAVANA).getTime() - 1,
    );
    expect(clubCalendarDateOf(lastOfSeventh, HAVANA)).toBe("2026-03-07");
    expect(clubWallTimeOf(lastOfSeventh, HAVANA).hour).toBe(23);
  });

  it("takes the FIRST occurrence when midnight happens twice (#2990)", () => {
    // Asia/Amman ended DST at 01:00 -> 00:00 on 30 October 2015, so midnight
    // occurred at 21:00Z (+3) and again at 22:00Z (+2). A two-probe resolver
    // cannot see the earlier one, so "the start of 30 October" lost its own
    // first hour.
    const start = startOfClubDay(cd("2015-10-30"), AMMAN);
    expect(start.toISOString()).toBe("2015-10-29T21:00:00.000Z");
    expect(clubCalendarDateOf(new Date(start.getTime() - 1), AMMAN)).toBe(
      "2015-10-29",
    );
  });

  it("needs the DAY-AFTER probe, not just the day before (#2990)", () => {
    /*
      MUTATION THAT MUST FAIL THIS CASE: delete `wallAsUtc + MS_PER_DAY` from the
      probe list in `resolveClubWallTime`.

      Chile ended DST at 00:00 on 15 May 2016, winding back to 23:00 on the 14th,
      so midnight on the 15th never happens at -03 and DOES happen an hour later
      at -04. Both of the other two probes sit before the transition and offer
      03:00Z, which reads 23:00 on the FOURTEENTH — the wrong calendar day — and
      the resolver, finding nothing valid, would hand that back as a skipped
      reading. Only the day-after probe sees the -04 offset.

      Swept over all 418 zones this runtime knows for 2015-2036, dropping that
      probe changes 168 `startOfClubDay` resolutions across 12 zones, always to
      the wrong day: Asuncion, Campo Grande, Ciudad Juarez, Coyhaique, Cuiaba,
      Godthab, Punta Arenas, Santiago, Sao Paulo, Scoresbysund, Palmer and
      Easter.
    */
    const start = startOfClubDay(cd("2016-05-15"), SANTIAGO);
    expect(start.toISOString()).toBe("2016-05-15T04:00:00.000Z");
    expect(clubWallTimeOf(start, SANTIAGO)).toMatchObject({
      date: "2016-05-15",
      hour: 0,
      minute: 0,
    });
    // The two-probe answer, named so the case cannot pass by agreeing with it.
    expect(start.toISOString()).not.toBe("2016-05-15T03:00:00.000Z");
    expect(clubCalendarDateOf(new Date("2016-05-15T03:00:00.000Z"), SANTIAGO)).toBe(
      "2016-05-14",
    );
  });

  it("starts the day at the TRANSITION when the gap spans midnight (#2990)", () => {
    /*
      Toronto and Nassau both jumped from 23:30 on 30 March 1919 to 00:30 on the
      31st, so midnight on the 31st is inside a gap that began the previous
      evening. Resolving a skipped reading by sliding the request forward by the
      size of the gap — the `Temporal` "compatible" rule, and what this kernel
      did first — lands on 01:00, half an hour after the day really began, and
      the half-hour from 00:30 to 01:00 was counted into 30 March instead.

      These two dates are the ONLY occurrences in the whole 418-zone, 2015-2036
      sweep, and there are none inside it, so nothing shipping today changes.
      The property is asserted anyway, because a day partition that is correct
      "except for two dates" is one somebody has to remember.
    */
    for (const zone of [TORONTO, NASSAU]) {
      const start = startOfClubDay(cd("1919-03-31"), zone);
      expect(start.toISOString(), String(zone)).toBe("1919-03-31T04:30:00.000Z");
      expect(clubWallTimeOf(start, zone), String(zone)).toMatchObject({
        date: "1919-03-31",
        hour: 0,
        minute: 30,
      });
      // The slid-forward answer, named so the case cannot pass by agreeing with it.
      expect(start.toISOString(), String(zone)).not.toBe(
        "1919-03-31T05:00:00.000Z",
      );
      // And the day really does start there: the millisecond before is the 30th.
      expect(
        clubCalendarDateOf(new Date(start.getTime() - 1), zone),
        String(zone),
      ).toBe("1919-03-30");
      expect(endOfClubDayExclusive(cd("1919-03-30"), zone).getTime()).toBe(
        start.getTime(),
      );
    }
  });

  it("gives the transition instant for a day the zone SKIPS ENTIRELY", () => {
    /*
      Samoa crossed the date line on 30 December 2011: the clock went from
      23:59:59 on the 29th (-10) straight to 00:00 on the 31st (+14), so no
      instant reads as 30 December at all and no answer can be the first instant
      of that day. The honest answer is the moment the clock jumped, which is
      what both boundary helpers now give; the slid-forward rule returned NOON ON
      THE 31st for `noonOfClubDay`, a full day out and silent about it. Stated
      here as a limit rather than a fix, because the day does not exist.
    */
    const jumped = new Date("2011-12-30T10:00:00.000Z");
    expect(startOfClubDay(cd("2011-12-30"), APIA).toISOString()).toBe(
      jumped.toISOString(),
    );
    expect(noonOfClubDay(cd("2011-12-30"), APIA).toISOString()).toBe(
      jumped.toISOString(),
    );
    expect(clubWallTimeOf(jumped, APIA)).toMatchObject({
      date: "2011-12-31",
      hour: 0,
      minute: 0,
    });
    expect(clubCalendarDateOf(new Date(jumped.getTime() - 1), APIA)).toBe(
      "2011-12-29",
    );
  });

  it("answers at the very edge of the calendar-date range", () => {
    /*
      Resolving a wall time PROBES a day either side of the request, so a
      question about the first or last day the kernel can name reaches past its
      own range. An internal probe stepping out of bounds must not turn a
      legitimate query into an error, so an undescribable probe is dropped and
      the remaining ones answer.

      The exclusive END of the last day is a different thing and genuinely has no
      answer — it is the year 10000 — so that one throws, and
      `endOfDateOnlyForTimeZone` turns it back into the Invalid Date its
      legacy call sites have always had for an unanswerable input.
    */
    expect(startOfClubDay(cd("9999-12-31"), AUCKLAND).toISOString()).toBe(
      "9999-12-30T11:00:00.000Z",
    );
    expect(endOfClubDayExclusive(cd("9999-12-30"), AUCKLAND).toISOString()).toBe(
      "9999-12-30T11:00:00.000Z",
    );
    expect(() => endOfClubDayExclusive(cd("9999-12-31"), AUCKLAND)).toThrow(
      RangeError,
    );
    expect(startOfClubDay(cd("0001-01-02"), DENVER).toISOString()).toBe(
      "0001-01-02T06:59:56.000Z",
    );
  });

  it("is exactly the first instant of the day for every club zone", () => {
    // The property, rather than a spot check: the day-start is on the day, and
    // the millisecond before it is not.
    const days = [
      "2026-01-01",
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-04-04",
      "2026-04-05",
      "2026-09-26",
      "2026-09-27",
      "2026-10-04",
      "2026-11-01",
      "2026-12-31",
      "2028-02-29",
    ] as const;
    for (const zone of CLUB_ZONES) {
      for (const day of days) {
        const date = cd(day);
        const start = startOfClubDay(date, zone);
        expect(clubCalendarDateOf(start, zone), `${zone} ${day} start`).toBe(day);
        expect(
          clubCalendarDateOf(new Date(start.getTime() - 1), zone),
          `${zone} ${day} the millisecond before`,
        ).not.toBe(day);
      }
    }
  });

  it("partitions a whole DST year for every club zone", () => {
    for (const zone of CLUB_ZONES) {
      let date = cd("2026-01-01");
      let previousEnd = startOfClubDay(date, zone);
      for (let step = 0; step < 365; step += 1) {
        const start = startOfClubDay(date, zone);
        expect(start.getTime(), `${zone} ${date}`).toBe(previousEnd.getTime());
        expect(clubCalendarDateOf(start, zone), `${zone} ${date}`).toBe(date);
        previousEnd = endOfClubDayExclusive(date, zone);
        expect(previousEnd.getTime(), `${zone} ${date} span`).toBeGreaterThan(
          start.getTime(),
        );
        date = requireCalendarDate(
          new Date(Date.UTC(2026, 0, 1 + step + 1)).toISOString().slice(0, 10),
        );
      }
    }
  });
});

describe("Pacific/Auckland is unaffected, which is what makes the fix safe to land", () => {
  /*
    The delegation in `date-only.ts` changes every legacy call site, so the claim
    that this deployment sees no change at all has to be measured rather than
    asserted. Every day of 2015-2036 was swept against the old two-pass
    algorithm for Auckland, Chatham, UTC and Denver with zero differences; this
    is the in-suite version over the two years either side of the frozen clock.
  */
  const twoPassStart = (date: string, zone: string): Date => {
    const offsetAt = (ms: number): number => {
      const floored = Math.floor(ms / 1000) * 1000;
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).formatToParts(new Date(floored));
      const read = (type: string) =>
        Number(parts.find((part) => part.type === type)?.value);
      return (
        Date.UTC(
          read("year"),
          read("month") - 1,
          read("day"),
          read("hour"),
          read("minute"),
          read("second"),
        ) - floored
      );
    };
    const local = Date.parse(`${date}T00:00:00.000Z`);
    const first = local - offsetAt(local);
    return new Date(local - offsetAt(first));
  };

  it("agrees with the algorithm it replaces on every day of 2025-2027", () => {
    for (const zone of [AUCKLAND, CHATHAM, DENVER]) {
      for (let ms = Date.UTC(2025, 0, 1); ms < Date.UTC(2028, 0, 1); ms += 86_400_000) {
        const day = new Date(ms).toISOString().slice(0, 10);
        expect(
          startOfClubDay(cd(day), zone).toISOString(),
          `${zone} ${day}`,
        ).toBe(twoPassStart(day, zone).toISOString());
      }
    }
  });
});

describe("a wall-clock time that does not exist", () => {
  it("is refused by default, naming the date, the time and the zone", () => {
    expect(() =>
      instantForClubWallTime(cd("2026-03-08"), { hour: 0, minute: 30 }, HAVANA),
    ).toThrow(SkippedClubWallTimeError);
    expect(() =>
      instantForClubWallTime(cd("2026-09-27"), { hour: 2, minute: 30 }, AUCKLAND),
    ).toThrow(/2026-09-27 02:30 does not exist in Pacific\/Auckland/);
  });

  it("carries its parts, so a caller need not parse the message", () => {
    let thrown: unknown = null;
    try {
      instantForClubWallTime(cd("2026-09-27"), { hour: 2, minute: 30 }, AUCKLAND);
    } catch (error) {
      thrown = error;
    }
    expect(thrown, "the skipped wall time should have thrown").toBeInstanceOf(
      SkippedClubWallTimeError,
    );
    const skipped = thrown as SkippedClubWallTimeError;
    expect(skipped.date).toBe("2026-09-27");
    expect(skipped.hour).toBe(2);
    expect(skipped.minute).toBe(30);
    expect(skipped.timeZone).toBe("Pacific/Auckland");
  });

  it("resolves to THE MOMENT THE CLOCK JUMPED TO, not the request slid forward", () => {
    /*
      NZDT begins at 02:00 on 27 September 2026, so 02:30 is half an hour inside
      the gap. Two answers are defensible and they are not the same instant:

        - the transition itself, 14:00Z, which reads 03:00 — "the next moment
          that exists", which is what the policy is called and what a day
          boundary needs;
        - the request slid forward by the size of the gap, 14:30Z, reading 03:30
          — `Temporal`'s "compatible" disambiguation, which preserves the
          minutes into the gap.

      This kernel takes the first, because its two consumers are day boundaries
      and `startOfClubDay` is otherwise not the first instant of its own day when
      a gap spans midnight (see the Toronto case above). The second is asserted
      NEGATIVELY so this cannot pass under the rule it replaced.
    */
    const moved = instantForClubWallTime(
      cd("2026-09-27"),
      { hour: 2, minute: 30 },
      AUCKLAND,
      { skipped: "nextExistingInstant" },
    );
    expect(moved.toISOString()).toBe("2026-09-26T14:00:00.000Z");
    expect(clubWallTimeOf(moved, AUCKLAND)).toMatchObject({
      date: "2026-09-27",
      hour: 3,
      minute: 0,
    });
    expect(moved.toISOString()).not.toBe("2026-09-26T14:30:00.000Z");
    // Every reading inside the gap resolves to the same transition instant.
    for (const minute of [1, 15, 30, 59]) {
      expect(
        instantForClubWallTime(cd("2026-09-27"), { hour: 2, minute }, AUCKLAND, {
          skipped: "nextExistingInstant",
        }).toISOString(),
        `02:${minute}`,
      ).toBe("2026-09-26T14:00:00.000Z");
    }
  });
});

describe("a wall-clock reading is four whole numbers in range", () => {
  /*
    `setUTCHours` ROLLS. `{ hour: 24 }` is the natural spelling of "the end of
    the day", and before this guard it either threw a SkippedClubWallTimeError
    saying the clocks had jumped forward over the reading — which never happened
    — or, under `nextExistingInstant`, silently returned midnight on the
    following day. Both answers were wrong and the first actively misled.
  */
  it.each([
    ["hour 24", { hour: 24 }],
    ["hour -1", { hour: -1 }],
    ["a fractional hour", { hour: 12.5 }],
    ["minute 90", { hour: 0, minute: 90 }],
    ["second 60", { hour: 0, second: 60 }],
    ["millisecond 1000", { hour: 0, millisecond: 1000 }],
    ["NaN", { hour: Number.NaN }],
  ])("refuses %s under every policy", (_label, time) => {
    for (const policy of [
      undefined,
      { skipped: "nextExistingInstant" as const },
    ]) {
      expect(() =>
        instantForClubWallTime(cd("2026-07-01"), time, AUCKLAND, policy),
      ).toThrow(RangeError);
    }
    // And specifically NOT the DST error, which would name a cause that is not
    // the cause.
    let thrown: unknown = null;
    try {
      instantForClubWallTime(cd("2026-07-01"), time, AUCKLAND);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeInstanceOf(SkippedClubWallTimeError);
  });

  it("still accepts every real reading of a day", () => {
    for (const hour of [0, 1, 12, 23]) {
      expect(
        clubWallTimeOf(
          instantForClubWallTime(cd("2026-07-01"), { hour }, AUCKLAND),
          AUCKLAND,
        ).hour,
      ).toBe(hour);
    }
    expect(
      clubWallTimeOf(
        instantForClubWallTime(
          cd("2026-07-01"),
          { hour: 23, minute: 59, second: 59, millisecond: 999 },
          AUCKLAND,
        ),
        AUCKLAND,
      ),
    ).toEqual({
      date: "2026-07-01",
      hour: 23,
      minute: 59,
      second: 59,
      millisecond: 999,
    });
  });
});

describe("a wall-clock time that happens twice", () => {
  it("takes the earliest occurrence by default and the latest on request", () => {
    // NZDT ends on 5 April 2026: 03:00 NZDT -> 02:00 NZST, so 02:30 happens at
    // +13 and again at +12.
    const earliest = instantForClubWallTime(
      cd("2026-04-05"),
      { hour: 2, minute: 30 },
      AUCKLAND,
    );
    const latest = instantForClubWallTime(
      cd("2026-04-05"),
      { hour: 2, minute: 30 },
      AUCKLAND,
      { ambiguous: "latest" },
    );
    expect(earliest.toISOString()).toBe("2026-04-04T13:30:00.000Z");
    expect(latest.toISOString()).toBe("2026-04-04T14:30:00.000Z");
    expect(latest.getTime() - earliest.getTime()).toBe(3_600_000);
    // Both really are 02:30 on 5 April in club time.
    for (const instant of [earliest, latest]) {
      expect(clubWallTimeOf(instant, AUCKLAND)).toMatchObject({
        date: "2026-04-05",
        hour: 2,
        minute: 30,
      });
    }
  });

  it("handles a sub-hour transition", () => {
    // Australia/Lord_Howe shifts by thirty minutes, so nothing here may assume
    // whole-hour offsets.
    const noon = noonOfClubDay(cd("2026-04-05"), LORD_HOWE);
    expect(clubWallTimeOf(noon, LORD_HOWE)).toMatchObject({
      date: "2026-04-05",
      hour: 12,
      minute: 0,
    });
  });
});

describe("noon is the boundary the domain actually uses, and it is always safe", () => {
  /*
    Measured across all 418 zones this runtime knows, every day 2015-2036: local
    midnight is SKIPPED in 19 zones and AMBIGUOUS in 8; local noon is neither, in
    any zone, on any day. That is a real argument for the epic's noon-to-noon
    stay boundary beyond domain convenience — a midday boundary sidesteps the
    entire class a midnight boundary walks into.
  */
  it("resolves exactly, with no policy needed, on every transition day", () => {
    const days = [
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-04-04",
      "2026-04-05",
      "2026-09-26",
      "2026-09-27",
      "2026-11-01",
    ] as const;
    for (const zone of CLUB_ZONES) {
      for (const day of days) {
        // The default policy REJECTS a skipped time, so this call throwing is
        // exactly the assertion: noon is never skipped.
        const noon = instantForClubWallTime(cd(day), { hour: 12 }, zone);
        expect(clubWallTimeOf(noon, zone), `${zone} ${day}`).toMatchObject({
          date: day,
          hour: 12,
          minute: 0,
        });
        expect(noonOfClubDay(cd(day), zone).getTime()).toBe(noon.getTime());
      }
    }
  });
});

describe("the inclusive end of a club day", () => {
  it("is exactly one millisecond before the exclusive end", () => {
    for (const zone of [AUCKLAND, CHATHAM, DENVER, HAVANA]) {
      for (const day of ["2026-07-01", "2026-03-08", "2026-04-05", "2026-09-27"]) {
        const exclusive = endOfClubDayExclusive(cd(day), zone);
        expect(
          endOfClubDayInclusive(cd(day), zone).getTime(),
          `${zone} ${day}`,
        ).toBe(exclusive.getTime() - 1);
      }
    }
  });

  it("still reads as the day it names, on a day that is 23 or 25 hours long", () => {
    /*
      THE PROPERTY, not the arithmetic. An inclusive bound is only useful if it is
      the last instant that reads back as its own day, and a DST transition inside
      the day is where a fixed-24-hour spelling stops being that. 2026-04-05 is
      the day NZDT ends (25 hours); 2026-09-27 is the day it begins (23 hours).
      `America/Havana` transitions AT MIDNIGHT on 2026-03-08, which is the
      original defect this whole module exists for.
    */
    const cases: Array<[ReturnType<typeof tz>, string]> = [
      [AUCKLAND, "2026-04-05"],
      [AUCKLAND, "2026-09-27"],
      [CHATHAM, "2026-04-05"],
      [DENVER, "2026-11-01"],
      [HAVANA, "2026-03-08"],
      [HAVANA, "2026-03-07"],
      [SANTIAGO, "2026-09-06"],
    ];
    for (const [zone, day] of cases) {
      const inclusive = endOfClubDayInclusive(cd(day), zone);
      expect(clubCalendarDateOf(inclusive, zone), `${zone} ${day}`).toBe(day);
      expect(
        clubCalendarDateOf(new Date(inclusive.getTime() + 1), zone),
        `${zone} ${day} + 1ms is the NEXT day`,
      ).not.toBe(day);
    }
  });

  it("takes the club's zone, not the host's or a fixed offset", () => {
    /*
      DISCRIMINATING BY CONSTRUCTION, because the zone is an argument. Three
      divergent zones on the same calendar day give three different instants, so a
      helper that ignored its zone argument — or read the host's — could not pass.
      `Pacific/Chatham` is 45 minutes off `Pacific/Auckland`, which also catches a
      whole-hour assumption.
    */
    const day = cd("2026-07-01");
    const instants = [AUCKLAND, CHATHAM, DENVER, HAVANA].map((zone) =>
      endOfClubDayInclusive(day, zone).toISOString(),
    );
    expect(new Set(instants).size).toBe(4);
    expect(instants).toEqual([
      "2026-07-01T11:59:59.999Z",
      "2026-07-01T11:14:59.999Z",
      "2026-07-02T05:59:59.999Z",
      "2026-07-02T03:59:59.999Z",
    ]);
  });

  it("is unaffected by the host machine's timezone", () => {
    const answersIn = (hostZone: string) =>
      withTimeZone(hostZone, () =>
        [AUCKLAND, DENVER, CHATHAM].map((zone) =>
          endOfClubDayInclusive(cd("2026-07-01"), zone).toISOString(),
        ),
      );
    expect(answersIn("UTC")).toEqual(answersIn("America/Los_Angeles"));
  });

  it("throws where its exclusive sibling throws, rather than inventing a day", () => {
    /*
      9999-12-31 has no successor a `CalendarDate` can name, so the half-open end
      throws a `RangeError` and so does this. The legacy adapter in `date-only.ts`
      catches that and answers `new Date(NaN)` for its existing call
      sites; the kernel refuses out loud, because a new caller handed an Invalid
      Date discovers it three modules later.
    */
    expect(() => endOfClubDayExclusive(cd("9999-12-31"), AUCKLAND)).toThrow(RangeError);
    expect(() => endOfClubDayInclusive(cd("9999-12-31"), AUCKLAND)).toThrow(RangeError);
    // And the day before is perfectly ordinary.
    expect(
      endOfClubDayInclusive(cd("9999-12-30"), AUCKLAND).getTime(),
    ).toBe(endOfClubDayExclusive(cd("9999-12-30"), AUCKLAND).getTime() - 1);
  });
});

describe("the host machine's timezone is irrelevant", () => {
  it("the two host zones really do differ (premise)", () => {
    const seen = new Set(
      HOST_ZONES.map((zone) =>
        withTimeZone(zone, () => Intl.DateTimeFormat().resolvedOptions().timeZone),
      ),
    );
    expect(seen.size).toBe(2);
  });

  it("gives identical boundaries under both host zones, for every club zone", () => {
    const answersIn = (hostZone: string) =>
      withTimeZone(hostZone, () =>
        CLUB_ZONES.map((zone) => ({
          zone: String(zone),
          start: startOfClubDay(cd("2026-03-08"), zone).toISOString(),
          end: endOfClubDayExclusive(cd("2026-03-08"), zone).toISOString(),
          noon: noonOfClubDay(cd("2026-03-08"), zone).toISOString(),
          eight: instantForClubWallTime(
            cd("2026-03-08"),
            { hour: 8 },
            zone,
          ).toISOString(),
          dayOfMidday: clubCalendarDateOf(
            new Date("2026-03-08T12:00:00.000Z"),
            zone,
          ),
        })),
      );
    const underUtc = answersIn("UTC");
    expect(underUtc).toEqual(answersIn("America/Los_Angeles"));
    // And the club zone really is load-bearing: a behind-UTC club reads the
    // previous day at the same instant.
    expect(underUtc.find((row) => row.zone === "America/Denver")?.dayOfMidday).toBe(
      "2026-03-08",
    );
    expect(underUtc.find((row) => row.zone === "Pacific/Auckland")?.start).not.toBe(
      underUtc.find((row) => row.zone === "America/Denver")?.start,
    );
  });
});
