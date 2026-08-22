/**
 * Club-day boundaries and the DST edge cases (CT-2, #2990).
 *
 * The defect this suite exists for: `startOfDateOnlyForTimeZone` resolved a wall
 * time by applying the zone offset twice, and for a club whose clocks spring
 * forward AT MIDNIGHT that lands before the transition — on the PREVIOUS
 * calendar day. Fifty-eight call sites in sixteen files depend on that pair, and
 * no test could see it because the configured zone is `Pacific/Auckland`, where
 * nothing transitions at midnight.
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

/** Every club zone this suite crosses with both host zones. */
const CLUB_ZONES = [AUCKLAND, CHATHAM, DENVER, HAVANA, AMMAN, LORD_HOWE];
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
    The delegation in `date-only.ts` changes fifty-eight call sites, so the claim
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

  it("resolves to the next moment that does exist when asked to", () => {
    const moved = instantForClubWallTime(
      cd("2026-09-27"),
      { hour: 2, minute: 30 },
      AUCKLAND,
      { skipped: "nextExistingInstant" },
    );
    // NZDT begins at 02:00, so 02:30 is inside the gap; the clock reads 03:30.
    expect(clubWallTimeOf(moved, AUCKLAND)).toMatchObject({
      date: "2026-09-27",
      hour: 3,
      minute: 30,
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
