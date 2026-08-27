import { beforeEach, describe, expect, it } from "vitest";

import { APP_TIME_ZONE } from "@/config/operational";
import {
  clubCalendarDateOf,
  clubWallTimeOf,
  clubZoneOffsetMs,
  requireClubTimeZone,
  requireInstant,
  type ClubTimeZone,
} from "@/lib/club-time";
import type { RecurrenceRule } from "@/lib/calendar-recurrence";
import {
  buildOccurrenceRows,
  clubDayKey,
  durationMsOf,
  nextMeetingRoom,
  seriesMatchesRule,
  withClubTimeOfDay,
  type ResolvedEventData,
} from "@/lib/calendar-occurrences";
import { divergentClubZone } from "./helpers/club-time-zone";

/**
 * The occurrence-shape half of the calendar service (CT-4 group F5, #2870).
 *
 * These functions were inside `calendar-service.ts` until the extraction that
 * brought that file back under its size budget, and reaching them meant standing
 * up the in-memory Prisma fake in `calendar-service-mutations.test.ts` and
 * inferring their behaviour from the rows it ended up holding. They read and
 * write nothing, so they can be asked directly — which is most of the point of
 * the seam, and is why the DST property `withClubTimeOfDay`'s docblock claims now
 * has a test that states it rather than an integration that implies it.
 *
 * `divergentClubZone` supplies a club zone that answers differently from both
 * `APP_TIME_ZONE` and the host's own resolved zone, so a helper that ignored the
 * `zone` argument could not pass. The DST block pins `America/Denver` instead,
 * because "this zone's clocks change on this date" is not something a
 * zone-agnostic chooser can know; its premise is asserted rather than assumed.
 */

/** A zone for the blocks whose subject is a zone-independent rule. */
const RULE_ZONE = requireClubTimeZone("Pacific/Auckland");

function template(overrides: Partial<ResolvedEventData> = {}): ResolvedEventData {
  return {
    title: "Committee meeting",
    location: null,
    details: null,
    allDay: false,
    isMeeting: false,
    startsAt: requireInstant("2026-07-21T10:30:00.000Z"),
    endsAt: requireInstant("2026-07-21T11:30:00.000Z"),
    recurrence: null,
    ...overrides,
  };
}

describe("clubDayKey", () => {
  it("names the CLUB's calendar day, not the environment's or the host's", () => {
    const instant = requireInstant("2026-07-21T10:30:00.000Z");
    const { zone, expected, environmentAnswer, hostAnswer } = divergentClubZone(
      (z) => clubCalendarDateOf(instant, z),
    );
    expect(clubDayKey(instant, zone)).toBe(expected);
    expect(clubDayKey(instant, zone)).not.toBe(environmentAnswer);
    expect(clubDayKey(instant, zone)).not.toBe(hostAnswer);
  });
});

describe("withClubTimeOfDay", () => {
  it("keeps the occurrence's club DAY and the template's club TIME", () => {
    const occurrence = requireInstant("2026-08-18T10:30:00.000Z");
    const { zone } = divergentClubZone((z) =>
      clubCalendarDateOf(occurrence, z),
    );
    const templateTime = requireInstant("2026-07-21T06:15:00.000Z");
    const result = withClubTimeOfDay(occurrence, templateTime, false, zone);
    const wall = clubWallTimeOf(result, zone);
    const templateWall = clubWallTimeOf(templateTime, zone);
    expect(wall.date).toBe(clubCalendarDateOf(occurrence, zone));
    expect({ hour: wall.hour, minute: wall.minute }).toEqual({
      hour: templateWall.hour,
      minute: templateWall.minute,
    });
    // The two source instants are on different club days AND different club
    // times, so a version that took either half from the wrong one would show.
    expect(clubCalendarDateOf(occurrence, zone)).not.toBe(
      clubCalendarDateOf(templateTime, zone),
    );
    expect(templateWall.hour).not.toBe(clubWallTimeOf(occurrence, zone).hour);
  });

  it("starts an all-day occurrence at the first instant of the club day", () => {
    const occurrence = requireInstant("2026-08-18T10:30:00.000Z");
    const { zone } = divergentClubZone((z) =>
      clubCalendarDateOf(occurrence, z),
    );
    const result = withClubTimeOfDay(
      occurrence,
      requireInstant("2026-07-21T06:15:00.000Z"),
      true,
      zone,
    );
    const wall = clubWallTimeOf(result, zone);
    expect(wall.date).toBe(clubCalendarDateOf(occurrence, zone));
    expect({ hour: wall.hour, minute: wall.minute, second: wall.second }).toEqual(
      { hour: 0, minute: 0, second: 0 },
    );
  });
});

/**
 * The property the docblock claims and the integration only implied: a 7pm
 * series stays 7pm across the CLUB zone's own clock change rather than sliding
 * by an hour. A fixed-offset recombination gives 18:00 or 20:00 here.
 *
 * The premise is asserted, not assumed: the club zone must not be the one
 * `APP_TIME_ZONE` already claims (or an implementation reading the environment
 * would pass), and the HOST's offset must not move across the window (or a
 * host-local implementation would shift in step and also pass). A premise
 * failure is a FAILURE, never a skip (owner decision, #2870).
 */
describe("withClubTimeOfDay across the club zone's DST transition", () => {
  const CLUB_ZONE = "America/Denver";
  const zone = requireClubTimeZone(CLUB_ZONE);
  // 19:00 Denver on 20 Oct 2026, before the 1 Nov fall-back.
  const templateTime = requireInstant("2026-10-21T01:00:00.000Z");
  // An occurrence three weeks later, after it.
  const occurrence = requireInstant("2026-11-11T02:00:00.000Z");

  beforeEach(() => {
    expect(
      APP_TIME_ZONE,
      `This block proves the CLUB's zone drives the recombination, so the club zone must not be the one APP_TIME_ZONE already claims. APP_TIME_ZONE is ${APP_TIME_ZONE} — set TZ to something other than ${CLUB_ZONE}, or unset it. See docs/TESTING.md rule 6.`,
    ).not.toBe(CLUB_ZONE);
    const before = templateTime.getTimezoneOffset();
    const after = occurrence.getTimezoneOffset();
    expect(
      before,
      `This block proves the recombination follows the CLUB zone's clock change and not the host's, so the HOST's offset has to stay put across the window. This process moves from ${before} to ${after} minutes, which would let a host-local implementation pass.`,
    ).toBe(after);
  });

  it("re-derives 19:00 club time on the later day, not a fixed offset", () => {
    const result = withClubTimeOfDay(occurrence, templateTime, false, zone);
    const wall = clubWallTimeOf(result, zone);
    expect({ hour: wall.hour, minute: wall.minute }).toEqual({
      hour: 19,
      minute: 0,
    });
    expect(wall.date).toBe(clubCalendarDateOf(occurrence, zone));
  });

  it("really did cross the transition, so the assertion above is not vacuous", () => {
    expect(
      clubZoneOffsetMs(templateTime, zone),
      "The window must contain the club zone's clock change, or nothing here is being tested. Check that 1 Nov 2026 is still the US fall-back date in this runtime's tz data.",
    ).not.toBe(clubZoneOffsetMs(occurrence, zone));
    /*
      And the arithmetic says which implementation produced it. Denver's clocks
      go BACK on 1 Nov, so keeping 19:00 club time means the later occurrence is
      one hour further from the template in REAL time than a whole number of
      24-hour days. A fixed-24-hour stepper leaves a remainder of zero; this one
      leaves exactly an hour.
    */
    const result = withClubTimeOfDay(occurrence, templateTime, false, zone);
    const elapsed = result.getTime() - templateTime.getTime();
    const DAY_MS = 24 * 60 * 60 * 1000;
    expect(elapsed % DAY_MS).toBe(60 * 60 * 1000);
  });
});

describe("seriesMatchesRule compares `until` by CLUB day", () => {
  it("matches two instants that are the same club day but different UTC days", () => {
    // 10:30Z and 22:30Z on 11 Aug: one club day in a zone far enough east or
    // west, two UTC days apart from each other by twelve hours.
    const stored = requireInstant("2026-08-11T10:30:00.000Z");
    const { zone } = divergentClubZone((z) => clubCalendarDateOf(stored, z));
    const sameClubDay = requireInstant("2026-08-11T12:30:00.000Z");
    expect(clubCalendarDateOf(sameClubDay, zone)).toBe(
      clubCalendarDateOf(stored, zone),
    );
    const rule: RecurrenceRule = {
      frequency: "WEEKLY",
      interval: 1,
      endMode: "until",
      until: sameClubDay.toISOString(),
    };
    expect(
      seriesMatchesRule(
        {
          id: "s1",
          frequency: "WEEKLY",
          interval: 1,
          until: stored,
          count: null,
          createdById: "m1",
          createdAt: stored,
          updatedAt: stored,
        },
        rule,
        zone,
      ),
    ).toBe(true);
  });

  it("refuses a rule whose frequency, interval or count differs", () => {
    const stored = requireInstant("2026-08-11T10:30:00.000Z");
    const series = {
      id: "s1",
      frequency: "WEEKLY" as const,
      interval: 1,
      until: null,
      count: 5,
      createdById: "m1",
      createdAt: stored,
      updatedAt: stored,
    };
    const base: RecurrenceRule = {
      frequency: "WEEKLY",
      interval: 1,
      endMode: "count",
      count: 5,
    };
    expect(seriesMatchesRule(series, base, RULE_ZONE)).toBe(true);
    expect(
      seriesMatchesRule(series, { ...base, interval: 2 }, RULE_ZONE),
    ).toBe(false);
    expect(
      seriesMatchesRule(series, { ...base, count: 6 }, RULE_ZONE),
    ).toBe(false);
    expect(
      seriesMatchesRule(series, { ...base, frequency: "DAILY" }, RULE_ZONE),
    ).toBe(false);
  });
});

describe("buildOccurrenceRows", () => {
  const starts = [
    requireInstant("2026-07-21T10:30:00.000Z"),
    requireInstant("2026-07-28T10:30:00.000Z"),
  ];

  it("carries the template's duration onto every occurrence", () => {
    const data = template();
    const rows = buildOccurrenceRows(starts, data, "series-1", "member-1");
    const durationMs = durationMsOf(data.startsAt, data.endsAt);
    expect(durationMs).toBe(3_600_000);
    for (const [i, row] of rows.entries()) {
      expect(row.startsAt).toBe(starts[i]);
      expect((row.endsAt as Date).getTime() - starts[i].getTime()).toBe(
        durationMs,
      );
      expect(row.seriesId).toBe("series-1");
      expect(row.detachedFromSeries).toBe(false);
    }
  });

  it("leaves an all-day occurrence with no end", () => {
    const rows = buildOccurrenceRows(
      starts,
      template({ allDay: true }),
      "series-1",
      "member-1",
    );
    for (const row of rows) expect(row.endsAt).toBeNull();
  });

  it("mints a distinct room per meeting occurrence and preserves one by instant", () => {
    const data = template({ isMeeting: true });
    const preserved = new Map([[starts[0].getTime(), "kept-room"]]);
    const rows = buildOccurrenceRows(
      starts,
      data,
      "series-1",
      "member-1",
      preserved,
    );
    expect(rows[0].meetingRoom).toBe("kept-room");
    expect(rows[1].meetingRoom).toBeTruthy();
    expect(rows[1].meetingRoom).not.toBe("kept-room");
  });

  it("gives a non-meeting series no rooms at all", () => {
    const rows = buildOccurrenceRows(starts, template(), "series-1", "member-1");
    for (const row of rows) expect(row.meetingRoom).toBeNull();
  });
});

describe("nextMeetingRoom", () => {
  it("keeps an existing room, mints one when there is none, and clears a non-meeting", () => {
    expect(nextMeetingRoom(true, "existing")).toBe("existing");
    expect(nextMeetingRoom(true, null)).toBeTruthy();
    expect(nextMeetingRoom(false, "existing")).toBeNull();
  });
});

describe("durationMsOf", () => {
  it("is null for an open-ended event", () => {
    expect(
      durationMsOf(requireInstant("2026-07-21T10:30:00.000Z"), null),
    ).toBeNull();
  });
});

/**
 * The zone this module is handed is a `ClubTimeZone`, so a caller cannot pass
 * `process.env.TZ` or a browser's `resolvedOptions().timeZone` without going
 * through CT-1's validator first. Asserted here because the brand is the
 * enforcement, and a `zone: string` signature would look identical in review.
 */
describe("the zone argument is the branded club zone", () => {
  it("is satisfied by a validated zone", () => {
    const zone: ClubTimeZone = requireClubTimeZone("Pacific/Auckland");
    expect(clubDayKey(requireInstant("2026-07-21T10:30:00.000Z"), zone)).toBe(
      "2026-07-21",
    );
  });
});
