import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  calendarDayOfWeek,
  clubCalendarDateOf,
  clubWallTimeOf,
  requireInstant,
  type ClubTimeZone,
} from "@/lib/club-time";
import type { RecurrenceRule } from "@/lib/calendar-recurrence";
import { weekdayOrdinalInMonth } from "@/lib/calendar-recurrence";
import { divergentClubZone } from "./helpers/club-time-zone";

const mocks = vi.hoisted(() => ({
  seriesCreate: vi.fn(),
  eventCreate: vi.fn(),
  eventCreateMany: vi.fn(),
  eventFindFirst: vi.fn(),
  clubTimeZone: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    calendarEventSeries: { create: mocks.seriesCreate },
    calendarEvent: {
      create: mocks.eventCreate,
      createMany: mocks.eventCreateMany,
      findFirst: mocks.eventFindFirst,
    },
  },
}));

/**
 * The club's PERSISTED zone, mocked at the seam the service reads it from
 * (CT-4 group F5, #2870). Before this migration the service had no such read at
 * all: it stepped host-local `Date` components, so the calendar a series was
 * materialised on was the container's `TZ` rather than
 * `ClubTimeSettings.timeZone` — the second civil-time authority
 * `INV-CONFIG-002` forbids, and one an operator cannot change from the admin
 * panel.
 */
vi.mock("@/lib/club-time/server", () => ({
  clubTimeZone: mocks.clubTimeZone,
}));

import { createCalendarEvent } from "@/lib/calendar-service";

/*
  10:30 UTC on 21 Jul 2026, and the hour is deliberate: three calendar days exist
  on earth at once only while the UTC hour is 10, which is what guarantees
  `divergentClubZone` can find a club zone whose day differs from BOTH
  `APP_TIME_ZONE`'s and the host's. Its docblock carries the measurement.
*/
const ANCHOR = requireInstant("2026-07-21T10:30:00.000Z");

const baseData = {
  title: "Monthly Committee Meeting",
  location: null,
  details: null,
  allDay: false,
  isMeeting: true,
  startsAt: ANCHOR,
  endsAt: requireInstant("2026-07-21T11:30:00.000Z"),
};

describe("createCalendarEvent — recurrence materialisation (regression)", () => {
  let zone: ClubTimeZone;

  beforeEach(() => {
    vi.clearAllMocks();
    const chosen = divergentClubZone((z) => clubCalendarDateOf(ANCHOR, z));
    zone = chosen.zone;
    mocks.clubTimeZone.mockResolvedValue(zone);
    mocks.seriesCreate.mockResolvedValue({ id: "series-1" });
    mocks.eventCreateMany.mockResolvedValue({ count: 6 });
    mocks.eventFindFirst.mockResolvedValue({
      id: "anchor",
      title: baseData.title,
      startsAt: baseData.startsAt,
      isMeeting: true,
    });
  });

  it("materialises MANY occurrences for an nth-weekday monthly rule, on the CLUB's calendar", async () => {
    const rule: RecurrenceRule = {
      frequency: "MONTHLY_NTH_WEEKDAY",
      interval: 1,
      endMode: "count",
      count: 6,
    };

    await createCalendarEvent({ ...baseData, recurrence: rule }, "member-1");

    expect(mocks.clubTimeZone).toHaveBeenCalled();
    expect(mocks.seriesCreate).toHaveBeenCalledOnce();
    expect(mocks.eventCreate).not.toHaveBeenCalled(); // recurring path, not single
    expect(mocks.eventCreateMany).toHaveBeenCalledOnce();

    const rows = mocks.eventCreateMany.mock.calls[0][0].data as Array<{
      startsAt: Date;
      seriesId: string;
      isMeeting: boolean;
      meetingRoom: string | null;
    }>;

    // The core regression: a recurrence rule must produce MORE THAN ONE row.
    expect(rows.length).toBe(6);

    const anchorDay = clubCalendarDateOf(baseData.startsAt, zone);
    const anchorWall = clubWallTimeOf(baseData.startsAt, zone);
    for (const row of rows) {
      expect(row.seriesId).toBe("series-1");
      const day = clubCalendarDateOf(row.startsAt, zone);
      // Every occurrence lands on the same nth weekday of the CLUB's calendar…
      expect(calendarDayOfWeek(day)).toBe(calendarDayOfWeek(anchorDay));
      expect(weekdayOrdinalInMonth(day)).toBe(
        weekdayOrdinalInMonth(anchorDay),
      );
      // …and keeps the club wall-clock time the officer typed.
      const wall = clubWallTimeOf(row.startsAt, zone);
      expect({ hour: wall.hour, minute: wall.minute }).toEqual({
        hour: anchorWall.hour,
        minute: anchorWall.minute,
      });
      // A meeting series gives each occurrence its own room.
      expect(row.isMeeting).toBe(true);
      expect(row.meetingRoom).toBeTruthy();
    }

    // Distinct rooms per occurrence (no shared/guessable link).
    const rooms = new Set(rows.map((r) => r.meetingRoom));
    expect(rooms.size).toBe(rows.length);
  });

  it("uses the persisted zone and not the environment's or the host's", async () => {
    const { zone: chosenZone, environmentAnswer, hostAnswer } =
      divergentClubZone((z) => clubCalendarDateOf(ANCHOR, z));
    mocks.clubTimeZone.mockResolvedValue(chosenZone);

    await createCalendarEvent(
      {
        ...baseData,
        recurrence: {
          frequency: "MONTHLY_DAY_OF_MONTH",
          interval: 1,
          endMode: "count",
          count: 3,
        },
      },
      "member-1",
    );

    const rows = mocks.eventCreateMany.mock.calls[0][0].data as Array<{
      startsAt: Date;
    }>;
    // The day-of-month the series repeats on is the club's, and the two wrong
    // answers name a different day, so this cannot pass by accident.
    const clubDayOfMonth = clubCalendarDateOf(ANCHOR, chosenZone).slice(8);
    expect(clubDayOfMonth).not.toBe(environmentAnswer.slice(8));
    expect(clubDayOfMonth).not.toBe(hostAnswer.slice(8));
    for (const row of rows) {
      expect(clubCalendarDateOf(row.startsAt, chosenZone).slice(8)).toBe(
        clubDayOfMonth,
      );
    }
  });

  it("creates a single row (no series) for a non-recurring event", async () => {
    mocks.eventCreate.mockResolvedValue({ id: "one-off" });

    await createCalendarEvent({ ...baseData, recurrence: null }, "member-1");

    expect(mocks.eventCreate).toHaveBeenCalledOnce();
    expect(mocks.seriesCreate).not.toHaveBeenCalled();
    expect(mocks.eventCreateMany).not.toHaveBeenCalled();
    // A one-off stores the instant it was handed, so it does no calendar
    // arithmetic and resolves no zone.
    expect(mocks.clubTimeZone).not.toHaveBeenCalled();
    expect(mocks.eventCreate.mock.calls[0][0].data.startsAt).toBe(
      baseData.startsAt,
    );
  });
});
