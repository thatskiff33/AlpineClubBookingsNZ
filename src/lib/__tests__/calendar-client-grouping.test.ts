import { beforeEach, describe, expect, it } from "vitest";

import {
  addCalendarDays,
  clubCalendarDateOf,
  requireClubTimeZone,
  requireInstant,
  type CalendarDate,
  type ClubTimeZone,
} from "@/lib/club-time";
import type { CalendarEventDTO } from "@/lib/calendar-events";
import { groupEventsByDay } from "@/lib/calendar-client";
import { divergentClubZone } from "./helpers/club-time-zone";

/**
 * CT-4 group F5 (#2870). `groupEventsByDay` decides which CELL an event renders
 * in, which is a question about the club's calendar day — and it used to answer
 * it with `getFullYear`/`getMonth`/`getDate`, i.e. the viewer's. A member in
 * London saw a Saturday-evening club event on Saturday morning's cell, or on the
 * wrong cell entirely.
 *
 * Fixtures are written as offset-bearing ISO instants, because that is what the
 * DTO carries (`serializeCalendarEvent` calls `toISOString()`), and every
 * expectation is read back through the zone under test.
 */

const RULE_ZONE = requireClubTimeZone("Pacific/Auckland");

function makeEvent(overrides: Partial<CalendarEventDTO>): CalendarEventDTO {
  return {
    id: "evt",
    title: "Event",
    location: null,
    details: null,
    allDay: false,
    startsAt: "2026-08-15T09:00:00.000Z",
    endsAt: null,
    isMeeting: false,
    seriesId: null,
    detachedFromSeries: false,
    recurrence: null,
    ...overrides,
  };
}

/** Day keys whose bucket contains the event with the given id. */
function daysContaining(
  byDay: Map<CalendarDate, CalendarEventDTO[]>,
  id: string,
): string[] {
  return [...byDay.entries()]
    .filter(([, events]) => events.some((e) => e.id === id))
    .map(([key]) => key)
    .sort();
}

describe("groupEventsByDay — the CLUB's day decides the cell", () => {
  /*
    10:30 UTC on 15 Aug 2026, and the HOUR is chosen rather than incidental:
    while the UTC hour is 10 there are THREE calendar days on earth at once
    (UTC+14 has turned over, UTC-11 has not), so a zone whose answer differs from
    both `APP_TIME_ZONE`'s and the host's always exists. At any other hour there
    are only two and `divergentClubZone` can be left with nothing to pick — it
    refuses out loud rather than certifying a blind assertion. Its own docblock
    carries the measurement.
  */
  const startsAt = "2026-08-15T10:30:00.000Z";
  let zone: ClubTimeZone;
  let expectedDay: CalendarDate;
  let environmentDay: CalendarDate;
  let hostDay: CalendarDate;

  beforeEach(() => {
    const chosen = divergentClubZone((z) =>
      clubCalendarDateOf(requireInstant(startsAt), z),
    );
    zone = chosen.zone;
    expectedDay = chosen.expected;
    environmentDay = chosen.environmentAnswer;
    hostDay = chosen.hostAnswer;
  });

  it("buckets a single event on the club's calendar day", () => {
    const byDay = groupEventsByDay([makeEvent({ id: "evening", startsAt })], zone);
    expect(daysContaining(byDay, "evening")).toEqual([expectedDay]);
    // Both wrong answers really are different cells, so the assertion above
    // cannot be satisfied by an implementation that ignores `zone`.
    expect(expectedDay).not.toBe(environmentDay);
    expect(expectedDay).not.toBe(hostDay);
  });

  it("spans a two-day event over exactly the club days it covers", () => {
    const endsAt = "2026-08-16T22:00:00.000Z";
    const byDay = groupEventsByDay(
      [makeEvent({ id: "camp", startsAt, endsAt })],
      zone,
    );
    // The expectation is derived from the kernel for the CHOSEN zone rather than
    // written as a literal, so it follows whichever zone was picked and cannot
    // be satisfied by a shorter or shifted span.
    const lastDay = clubCalendarDateOf(requireInstant(endsAt), zone);
    const expectedDays: string[] = [];
    for (
      let day = expectedDay;
      day <= lastDay;
      day = addCalendarDays(day, 1)
    ) {
      expectedDays.push(day);
    }
    expect(expectedDays.length).toBeGreaterThan(1);
    expect(daysContaining(byDay, "camp")).toEqual(expectedDays);
  });
});

describe("groupEventsByDay — multi-day / midnight-spanning events", () => {
  /*
    A pinned club zone, because the subject of this block is the SPAN rule rather
    than which zone decides it — the block above covers that. Instants are
    written at 00:00Z so the New Zealand club day is the day the string names.
  */
  const at = (day: string, hour = 0): string =>
    `${day}T${String(hour).padStart(2, "0")}:00:00.000Z`;

  it("renders a 22:00 -> 01:00 event on both club days", () => {
    // 15 Aug 2026 22:00 NZ is 10:00Z; 16 Aug 01:00 NZ is 13:00Z on the 15th.
    const event = makeEvent({
      id: "overnight",
      startsAt: "2026-08-15T10:00:00.000Z",
      endsAt: "2026-08-15T13:00:00.000Z",
    });
    const byDay = groupEventsByDay([event], RULE_ZONE);
    expect(daysContaining(byDay, "overnight")).toEqual([
      "2026-08-15",
      "2026-08-16",
    ]);
  });

  it("renders a 3-day all-day event on all three days", () => {
    const event = makeEvent({
      id: "camp",
      allDay: true,
      startsAt: at("2026-08-10"),
      endsAt: at("2026-08-12"),
    });
    const byDay = groupEventsByDay([event], RULE_ZONE);
    expect(daysContaining(byDay, "camp")).toEqual([
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
    ]);
  });

  it("keeps a same-day timed event in a single bucket", () => {
    const event = makeEvent({
      id: "meeting",
      startsAt: at("2026-08-20", 0),
      endsAt: at("2026-08-20", 1),
    });
    const byDay = groupEventsByDay([event], RULE_ZONE);
    expect(daysContaining(byDay, "meeting")).toEqual(["2026-08-20"]);
  });

  it("keeps an event with a null endsAt in a single bucket", () => {
    const event = makeEvent({
      id: "open-ended",
      startsAt: at("2026-08-25"),
      endsAt: null,
    });
    const byDay = groupEventsByDay([event], RULE_ZONE);
    expect(daysContaining(byDay, "open-ended")).toEqual(["2026-08-25"]);
  });

  it("keeps the per-bucket ordering (all-day first, then by time) on shared days", () => {
    const allDaySpan = makeEvent({
      id: "span",
      allDay: true,
      startsAt: "2026-08-15T00:00:00.000Z",
      endsAt: "2026-08-16T00:00:00.000Z",
    });
    const timed = makeEvent({
      id: "timed",
      startsAt: "2026-08-15T09:00:00.000Z",
      endsAt: "2026-08-15T10:00:00.000Z",
    });
    const byDay = groupEventsByDay([timed, allDaySpan], RULE_ZONE);
    const sat = byDay.get("2026-08-15" as CalendarDate) ?? [];
    // The all-day span sorts ahead of the timed event on the shared Saturday.
    expect(sat.map((e) => e.id)).toEqual(["span", "timed"]);
  });

  it("caps a pathological span so a malformed endsAt cannot blow up the grid", () => {
    const event = makeEvent({
      id: "runaway",
      startsAt: at("2026-08-01"),
      // A malformed end centuries in the future.
      endsAt: at("3000-01-01"),
    });
    const byDay = groupEventsByDay([event], RULE_ZONE);
    // Expansion is bounded (MAX_EVENT_SPAN_DAYS + 1 day cells at most).
    expect(daysContaining(byDay, "runaway").length).toBeLessThanOrEqual(371);
    expect(daysContaining(byDay, "runaway").length).toBeGreaterThan(0);
  });

  it("drops an event whose start is not a usable instant rather than keying it under garbage", () => {
    // The host-local version bucketed this under the literal string
    // "NaN-NaN-NaN", which no cell ever reads.
    const byDay = groupEventsByDay(
      [
        makeEvent({ id: "broken", startsAt: "not-an-instant" }),
        makeEvent({ id: "fine", startsAt: at("2026-08-20") }),
      ],
      RULE_ZONE,
    );
    expect(daysContaining(byDay, "broken")).toEqual([]);
    expect(daysContaining(byDay, "fine")).toEqual(["2026-08-20"]);
    expect([...byDay.keys()]).toEqual(["2026-08-20"]);
  });

  it("treats an unparseable endsAt as no end at all", () => {
    const byDay = groupEventsByDay(
      [
        makeEvent({
          id: "half-broken",
          startsAt: at("2026-08-20"),
          endsAt: "not-an-instant",
        }),
      ],
      RULE_ZONE,
    );
    expect(daysContaining(byDay, "half-broken")).toEqual(["2026-08-20"]);
  });
});
