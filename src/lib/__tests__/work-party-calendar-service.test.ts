import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clubCalendarDateOf,
  clubWallTimeOf,
  requireCalendarDate,
  requireClubTimeZone,
} from "@/lib/club-time";

/**
 * Fork #118: `replaceWorkPartyCalendarEvents` (calendar-work-party-entries.ts) is the one writer of
 * `CalendarEvent.workPartyEventId`, and the calendar's own update and delete
 * refuse a linked entry. Prisma is a recording fake: the transaction callback
 * runs against `tx`, so each case asserts the exact writes.
 */
const h = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    calendarEvent: {
      findMany: vi.fn(),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async ({ data }: { data: unknown }) => data),
      createMany: vi.fn(async ({ data }: { data: unknown[] }) => ({
        count: data.length,
      })),
    },
    calendarEventSeries: {
      create: vi.fn(async () => ({ id: "series-1" })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    calendarEvent: { findUnique: vi.fn() },
  };
  return { tx, prisma };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/club-time/server", () => ({
  clubTimeZone: vi.fn(async () => requireClubTimeZone("Pacific/Auckland")),
}));

import {
  deleteCalendarEvent,
  updateCalendarEvent,
  WorkPartyManagedCalendarEventError,
} from "@/lib/calendar-service";
import { replaceWorkPartyCalendarEvents } from "@/lib/calendar-work-party-entries";
import { MAX_OCCURRENCES } from "@/lib/calendar-recurrence";

const zone = requireClubTimeZone("Pacific/Auckland");

const days = (...isoDays: string[]) => isoDays.map(requireCalendarDate);

beforeEach(() => {
  vi.clearAllMocks();
  h.tx.calendarEvent.findMany.mockResolvedValue([]);
});

describe("replaceWorkPartyCalendarEvents", () => {
  it("creates one all-day occurrence per day, as a daily series, across a month boundary", async () => {
    const count = await replaceWorkPartyCalendarEvents(
      "wp-1",
      async () => ({
        title: "Work party: Spring",
        location: "Main Lodge",
        details: "Bring gloves",
        days: days("2026-09-30", "2026-10-01", "2026-10-02"),
      }),
      "admin-1",
    );

    expect(count).toBe(3);
    expect(h.tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(h.tx.calendarEventSeries.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ frequency: "DAILY", interval: 1, count: 3 }),
    });
    const rows = h.tx.calendarEvent.createMany.mock.calls[0][0].data as Array<{
      startsAt: Date;
      allDay: boolean;
      endsAt: Date | null;
      isMeeting: boolean;
      seriesId: string;
      workPartyEventId: string;
      title: string;
      location: string | null;
    }>;
    expect(rows.map((row) => clubCalendarDateOf(row.startsAt, zone))).toEqual([
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
    ]);
    for (const row of rows) {
      // The first instant of the CLUB day, not of the UTC day.
      expect(clubWallTimeOf(row.startsAt, zone)).toMatchObject({
        hour: 0,
        minute: 0,
      });
      expect(row).toMatchObject({
        allDay: true,
        endsAt: null,
        isMeeting: false,
        seriesId: "series-1",
        workPartyEventId: "wp-1",
        title: "Work party: Spring",
        location: "Main Lodge",
      });
    }
  });

  it("stores a one-night work party as a standalone entry, not a series", async () => {
    await replaceWorkPartyCalendarEvents(
      "wp-1",
      async () => ({ title: "Work party: Day", location: null, details: null, days: days("2026-07-04") }),
      "admin-1",
    );
    expect(h.tx.calendarEventSeries.create).not.toHaveBeenCalled();
    expect(h.tx.calendarEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        allDay: true,
        workPartyEventId: "wp-1",
        meetingRoom: null,
      }),
    });
  });

  it("removes the previous entries and their emptied series before writing", async () => {
    h.tx.calendarEvent.findMany.mockResolvedValue([
      { seriesId: "old-series" },
      { seriesId: "old-series" },
    ]);
    await replaceWorkPartyCalendarEvents(
      "wp-1",
      async () => ({ title: "t", location: null, details: null, days: days("2026-07-04") }),
      "admin-1",
    );
    expect(h.tx.calendarEvent.deleteMany).toHaveBeenCalledWith({
      where: { workPartyEventId: "wp-1" },
    });
    expect(h.tx.calendarEventSeries.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["old-series"] }, events: { none: {} } },
    });
    const deleteOrder = h.tx.calendarEvent.deleteMany.mock.invocationCallOrder[0];
    const createOrder = h.tx.calendarEvent.create.mock.invocationCallOrder[0];
    expect(deleteOrder).toBeLessThan(createOrder);
  });

  it("with no entry, only removes", async () => {
    const count = await replaceWorkPartyCalendarEvents("wp-1", async () => null, "admin-1");
    expect(count).toBe(0);
    expect(h.tx.calendarEvent.deleteMany).toHaveBeenCalledTimes(1);
    expect(h.tx.calendarEvent.create).not.toHaveBeenCalled();
    expect(h.tx.calendarEvent.createMany).not.toHaveBeenCalled();
  });

  it("reads the work party after the lock, and skips an unlinked one with onlyIfLinked", async () => {
    const resolve = vi.fn(async () => null);
    await expect(
      replaceWorkPartyCalendarEvents("wp-1", resolve, "admin-1", { onlyIfLinked: true }),
    ).resolves.toBe(0);
    expect(resolve).not.toHaveBeenCalled();
    expect(h.tx.calendarEvent.deleteMany).not.toHaveBeenCalled();

    h.tx.calendarEvent.findMany.mockResolvedValue([{ seriesId: null }]);
    await replaceWorkPartyCalendarEvents("wp-1", resolve, "admin-1", { onlyIfLinked: true });
    expect(resolve).toHaveBeenCalledWith(h.tx);
    expect(h.tx.$executeRaw.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      resolve.mock.invocationCallOrder[0],
    );
  });

  it("takes the calendar-series lock under a work-party key", async () => {
    await replaceWorkPartyCalendarEvents("wp-9", async () => null, "admin-1");
    const [strings, key] = h.tx.$executeRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      string,
    ];
    expect(strings.join("?")).toContain("pg_advisory_xact_lock");
    expect(key).toBe("calendar-series:work-party:wp-9");
  });

  it("caps a very long window at the calendar's series limit", async () => {
    const many = Array.from({ length: MAX_OCCURRENCES + 10 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 6, 1 + i));
      return requireCalendarDate(d.toISOString().slice(0, 10));
    });
    const count = await replaceWorkPartyCalendarEvents(
      "wp-1",
      async () => ({ title: "t", location: null, details: null, days: many }),
      "admin-1",
    );
    expect(count).toBe(MAX_OCCURRENCES);
  });
});

describe("the calendar refuses to change a work party's entry", () => {
  const linked = {
    id: "evt-1",
    seriesId: "series-1",
    series: null,
    workPartyEventId: "wp-1",
    startsAt: new Date("2026-07-04T12:00:00.000Z"),
  };

  it("update throws WorkPartyManagedCalendarEventError and writes nothing", async () => {
    h.prisma.calendarEvent.findUnique.mockResolvedValue(linked);
    await expect(
      updateCalendarEvent(
        "evt-1",
        {
          title: "x",
          location: null,
          details: null,
          allDay: true,
          isMeeting: false,
          startsAt: new Date(),
          endsAt: null,
          recurrence: null,
        },
        "series",
        "admin-1",
      ),
    ).rejects.toBeInstanceOf(WorkPartyManagedCalendarEventError);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("delete throws WorkPartyManagedCalendarEventError and writes nothing", async () => {
    h.prisma.calendarEvent.findUnique.mockResolvedValue(linked);
    await expect(deleteCalendarEvent("evt-1", "series")).rejects.toBeInstanceOf(
      WorkPartyManagedCalendarEventError,
    );
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
});
