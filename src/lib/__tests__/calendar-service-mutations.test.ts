import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RecurrenceRule } from "@/lib/calendar-recurrence";
import {
  clubCalendarDateOf,
  requireClubTimeZone,
  requireInstant,
} from "@/lib/club-time";
import { withTimeZoneAsync } from "./helpers/timezone";

// In-memory Prisma fake for CalendarEvent / CalendarEventSeries. It implements
// just the query surface calendar-service.ts uses, with enough where-clause
// semantics (id, seriesId, detachedFromSeries, id:{not}) to exercise the real
// single-vs-series edit logic — including the headline "edit one occurrence,
// then edit the whole series, and the single-occurrence exception survives"
// promise, which had no coverage. $transaction runs the interactive callback
// against the same store; $executeRaw (the per-series advisory lock) is a no-op.
const h = vi.hoisted(() => {
  interface EventRow {
    id: string;
    title: string;
    location: string | null;
    details: string | null;
    allDay: boolean;
    startsAt: Date;
    endsAt: Date | null;
    isMeeting: boolean;
    meetingRoom: string | null;
    createdById: string;
    createdAt: Date;
    updatedAt: Date;
    seriesId: string | null;
    detachedFromSeries: boolean;
    idempotencyKey: string | null;
  }
  interface SeriesRow {
    id: string;
    frequency: string;
    interval: number;
    until: Date | null;
    count: number | null;
    createdById: string;
    createdAt: Date;
    updatedAt: Date;
  }

  const events = new Map<string, EventRow>();
  const series = new Map<string, SeriesRow>();
  let seq = 0;
  const nextId = (p: string) => `${p}-${(seq += 1)}`;

  function matchEvent(row: EventRow, where: Record<string, unknown> = {}): boolean {
    if (where.id !== undefined) {
      if (typeof where.id === "object" && where.id !== null) {
        if (row.id === (where.id as { not: string }).not) return false;
      } else if (row.id !== where.id) {
        return false;
      }
    }
    if (where.seriesId !== undefined && row.seriesId !== where.seriesId) {
      return false;
    }
    if (
      where.detachedFromSeries !== undefined &&
      row.detachedFromSeries !== where.detachedFromSeries
    ) {
      return false;
    }
    if (
      where.idempotencyKey !== undefined &&
      row.idempotencyKey !== where.idempotencyKey
    ) {
      return false;
    }
    return true;
  }

  // A Prisma-shaped error carrying a code, matching the service's code-based
  // detection (P2002 unique violation, P2025 record-not-found).
  function prismaError(code: string): Error & { code: string } {
    return Object.assign(new Error(`Prisma error ${code}`), { code });
  }

  // Enforce the CalendarEvent.idempotencyKey unique index. Postgres treats NULL
  // keys as distinct, so only a non-null duplicate collides.
  function assertKeyFree(key: string | null, ignoreId?: string) {
    if (!key) return;
    for (const row of events.values()) {
      if (row.idempotencyKey === key && row.id !== ignoreId) {
        throw prismaError("P2002");
      }
    }
  }

  function makeEventRow(data: Record<string, unknown>): EventRow {
    const now = new Date();
    return {
      id: (data.id as string) ?? nextId("evt"),
      title: data.title as string,
      location: (data.location as string | null) ?? null,
      details: (data.details as string | null) ?? null,
      allDay: (data.allDay as boolean) ?? false,
      startsAt: data.startsAt as Date,
      endsAt: (data.endsAt as Date | null) ?? null,
      isMeeting: (data.isMeeting as boolean) ?? false,
      meetingRoom: (data.meetingRoom as string | null) ?? null,
      createdById: data.createdById as string,
      createdAt: now,
      updatedAt: now,
      seriesId: (data.seriesId as string | null) ?? null,
      detachedFromSeries: (data.detachedFromSeries as boolean) ?? false,
      idempotencyKey: (data.idempotencyKey as string | null) ?? null,
    };
  }

  const calendarEvent = {
    findUnique: async ({
      where,
      include,
    }: {
      where: { id?: string; idempotencyKey?: string };
      include?: { series?: boolean };
    }) => {
      const row =
        where.id !== undefined
          ? events.get(where.id)
          : [...events.values()].find(
              (r) => r.idempotencyKey === where.idempotencyKey,
            );
      if (!row) return null;
      const clone: Record<string, unknown> = { ...row };
      if (include?.series) {
        clone.series = row.seriesId ? { ...series.get(row.seriesId)! } : null;
      }
      return clone;
    },
    findFirst: async ({
      where,
      orderBy,
    }: {
      where?: Record<string, unknown>;
      orderBy?: { startsAt?: "asc" | "desc" };
    }) => {
      let rows = [...events.values()].filter((r) => matchEvent(r, where));
      if (orderBy?.startsAt) {
        rows = rows.sort(
          (a, b) =>
            (a.startsAt.getTime() - b.startsAt.getTime()) *
            (orderBy.startsAt === "desc" ? -1 : 1),
        );
      }
      return rows[0] ? { ...rows[0] } : null;
    },
    findMany: async ({ where }: { where?: Record<string, unknown> }) =>
      [...events.values()].filter((r) => matchEvent(r, where)).map((r) => ({ ...r })),
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = makeEventRow(data);
      assertKeyFree(row.idempotencyKey);
      events.set(row.id, row);
      return { ...row };
    },
    createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
      const rows = data.map(makeEventRow);
      // Enforce the unique idempotencyKey across the batch + existing rows.
      for (const row of rows) assertKeyFree(row.idempotencyKey);
      for (const row of rows) events.set(row.id, row);
      return { count: rows.length };
    },
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      const existing = events.get(where.id);
      // Prisma throws P2025 when the target row is gone — the service treats
      // that as "already deleted" and 404s.
      if (!existing) throw prismaError("P2025");
      const updated: EventRow = { ...existing, ...data, updatedAt: new Date() } as EventRow;
      events.set(where.id, updated);
      return { ...updated };
    },
    updateMany: async ({
      where,
      data,
    }: {
      where?: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      let count = 0;
      for (const [id, row] of [...events.entries()]) {
        if (matchEvent(row, where)) {
          events.set(id, { ...row, ...data, updatedAt: new Date() } as EventRow);
          count += 1;
        }
      }
      return { count };
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const existing = events.get(where.id);
      if (!existing) throw prismaError("P2025");
      events.delete(where.id);
      return { ...existing };
    },
    deleteMany: async ({ where }: { where?: Record<string, unknown> }) => {
      let count = 0;
      for (const [id, row] of [...events.entries()]) {
        if (matchEvent(row, where)) {
          events.delete(id);
          count += 1;
        }
      }
      return { count };
    },
    count: async ({ where }: { where?: Record<string, unknown> }) =>
      [...events.values()].filter((r) => matchEvent(r, where)).length,
  };

  const calendarEventSeries = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const now = new Date();
      const row: SeriesRow = {
        id: (data.id as string) ?? nextId("series"),
        frequency: data.frequency as string,
        interval: (data.interval as number) ?? 1,
        until: (data.until as Date | null) ?? null,
        count: (data.count as number | null) ?? null,
        createdById: data.createdById as string,
        createdAt: now,
        updatedAt: now,
      };
      series.set(row.id, row);
      return { ...row };
    },
    // Prisma throws P2025 on a missing series row just as it does for events —
    // the service maps that to "already gone" (404), never a 500.
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      const existing = series.get(where.id);
      if (!existing) throw prismaError("P2025");
      const updated = { ...existing, ...data, updatedAt: new Date() } as SeriesRow;
      series.set(where.id, updated);
      return { ...updated };
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const existing = series.get(where.id);
      if (!existing) throw prismaError("P2025");
      series.delete(where.id);
      return { ...existing };
    },
  };

  const prisma: Record<string, unknown> = {
    calendarEvent,
    calendarEventSeries,
    // Advisory-lock statement — a no-op against the in-memory store.
    $executeRaw: async () => 0,
  };
  prisma.$transaction = async (arg: unknown) => {
    if (typeof arg === "function") {
      return (arg as (tx: unknown) => Promise<unknown>)(prisma);
    }
    return Promise.all(arg as Promise<unknown>[]);
  };

  return { prisma, events, series, reset: () => { events.clear(); series.clear(); seq = 0; } };
});

vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));

/**
 * The club's PERSISTED zone, pinned rather than left to fall out of the fake
 * Prisma above (CT-4 group F5, #2870).
 *
 * `clubTimeZone()` falls back to the environment seed when there is no
 * `ClubTimeSettings` row, and this fake has no such table — so without this mock
 * the suite's club zone would silently be `APP_TIME_ZONE`, which is exactly the
 * "cannot tell the persisted zone from the environment" trap the epic keeps
 * finding. `America/Denver` is deliberately BEHIND UTC: this suite's subject is
 * the single-versus-series edit semantics, and pinning a behind-UTC club proves
 * those hold for the deployments where this epic's date defects show. Zone
 * AUTHORITY is asserted in `calendar-service.test.ts`, which uses a zone chosen
 * to diverge from both wrong answers.
 */
const CLUB_ZONE = "America/Denver";
vi.mock("@/lib/club-time/server", () => ({
  clubTimeZone: vi.fn(async () => CLUB_ZONE),
}));

import {
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  type ResolvedEventData,
} from "@/lib/calendar-service";

const WEEKLY_3: RecurrenceRule = {
  frequency: "WEEKLY",
  interval: 1,
  endMode: "count",
  count: 3,
};

function data(overrides: Partial<ResolvedEventData> = {}): ResolvedEventData {
  return {
    title: "Weekly standup",
    location: null,
    details: null,
    allDay: false,
    isMeeting: false,
    // Midday club time on Monday 3 Aug 2026, written as a real instant rather
    // than host-local components so the club calendar day is the same on every
    // machine that runs this.
    startsAt: new Date("2026-08-03T18:00:00.000Z"),
    endsAt: new Date("2026-08-03T19:00:00.000Z"),
    recurrence: null,
    ...overrides,
  };
}

/** Occurrences of a series, earliest first. */
function occurrencesOf(seriesId: string) {
  return [...h.events.values()]
    .filter((e) => e.seriesId === seriesId)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

beforeEach(() => h.reset());

/**
 * `updateCalendarEvent`'s `dateChanged` comparison is the third of this
 * subsystem's three zone-dependent questions (#2870), and the only one that
 * stayed in `calendar-service.ts` — it is inseparable from the entry point that
 * resolves the zone. A review lens measured that it had NO discriminating
 * coverage at all: replacing it with a host-local day key killed 0 of 124, and
 * so did pinning it to `false`. Only the `true` direction was caught, by one
 * test, and by accident.
 *
 * Both directions and the club-versus-host distinction are covered below. What a
 * wrong `false` costs, in the officer's words: they move a recurring event and
 * the occurrences do not move.
 */
describe("updateCalendarEvent — dateChanged is the CLUB's day, in both directions", () => {
  /*
    Two instants two hours apart that the CLUB and the HOST disagree about.
    Denver (this suite's persisted club zone, UTC-6 in August) rolls over at
    06:00Z, so 05:00Z is 3 August and 07:00Z is 4 August — a day change. Every
    host this repository runs on reads BOTH as the same day: 4 August in UTC, in
    Europe/London, in Pacific/Auckland and in Asia/Tokyo, and 3 August in
    Pacific/Pago_Pago. The host is pinned below anyway, so the disagreement is a
    fact of the fixture rather than a fact of the machine.
  */
  const BEFORE = requireInstant("2026-08-04T05:00:00.000Z");
  const AFTER = requireInstant("2026-08-04T07:00:00.000Z");
  const CLUB = requireClubTimeZone(CLUB_ZONE);
  /** A host that reads both instants as ONE day, so a host-local key sees no change. */
  const HOST_THAT_SEES_NO_CHANGE = "Pacific/Auckland";

  function clubDaysOf(seriesId: string): string[] {
    return occurrencesOf(seriesId).map((o) =>
      clubCalendarDateOf(o.startsAt, CLUB),
    );
  }

  it("regenerates when the CLUB's day changes even though the host's does not", async () => {
    const anchor = await createCalendarEvent(
      data({ startsAt: BEFORE, endsAt: null, recurrence: WEEKLY_3 }),
      "member-1",
    );
    const seriesId = h.events.get(anchor.id)!.seriesId!;
    const before = clubDaysOf(seriesId);
    const idsBefore = occurrencesOf(seriesId).map((o) => o.id);
    expect(before).toEqual(["2026-08-03", "2026-08-10", "2026-08-17"]);

    const result = await withTimeZoneAsync(HOST_THAT_SEES_NO_CHANGE, () => {
      // The premise, asserted inside the pin so it describes the run that
      // follows: the host really does read both instants as one day, so a
      // host-local `dateChanged` would answer "unchanged" and propagate.
      expect(BEFORE.getDate()).toBe(AFTER.getDate());
      expect(BEFORE.getMonth()).toBe(AFTER.getMonth());
      // …while the club reads them as two.
      expect(clubCalendarDateOf(BEFORE, CLUB)).not.toBe(
        clubCalendarDateOf(AFTER, CLUB),
      );
      return updateCalendarEvent(
        anchor.id,
        data({ startsAt: AFTER, endsAt: null, recurrence: WEEKLY_3 }),
        "series",
        "member-1",
      );
    });

    expect(result?.scope).toBe("series");
    /*
      A REGENERATE rebuilds the occurrence set from the new anchor, so every club
      day moves forward one. A propagate would have kept each occurrence's own
      day and pushed only the time-of-day onto it — which is what an officer
      moving a recurring event and finding the occurrences unmoved would be
      looking at.
    */
    expect(clubDaysOf(seriesId)).toEqual([
      "2026-08-04",
      "2026-08-11",
      "2026-08-18",
    ]);
    // A second, independent observable of the same decision: a regenerate
    // DELETES the non-detached rows and inserts fresh ones, so not one id
    // survives. Asserting both means neither can be weakened on its own.
    expect(occurrencesOf(seriesId).map((o) => o.id)).not.toEqual(idsBefore);
    for (const id of idsBefore) expect(h.events.has(id)).toBe(false);
  });

  it("does NOT regenerate a details-only edit: every occurrence row survives by id", async () => {
    const anchor = await createCalendarEvent(
      data({ startsAt: BEFORE, endsAt: null, recurrence: WEEKLY_3 }),
      "member-1",
    );
    const seriesId = h.events.get(anchor.id)!.seriesId!;
    const idsBefore = occurrencesOf(seriesId).map((o) => o.id);

    await updateCalendarEvent(
      anchor.id,
      data({
        startsAt: BEFORE,
        endsAt: null,
        recurrence: WEEKLY_3,
        title: "Renamed standup",
      }),
      "series",
      "member-1",
    );

    // Identity is the evidence: a regenerate DELETES the non-detached rows and
    // inserts fresh ones, so surviving ids prove the propagate path ran. The
    // titles alone would not — a regenerate carries the new title too.
    expect(occurrencesOf(seriesId).map((o) => o.id)).toEqual(idsBefore);
    expect(clubDaysOf(seriesId)).toEqual([
      "2026-08-03",
      "2026-08-10",
      "2026-08-17",
    ]);
    for (const occ of occurrencesOf(seriesId)) {
      expect(occ.title).toBe("Renamed standup");
    }
  });

  it("regenerates on a same-day time-of-day change only when the rule changed", async () => {
    // The pair above moves the club DAY. This one keeps it — 07:00Z and 08:00Z
    // are both 4 August in Denver — so the day comparison must answer
    // "unchanged" and the rows must survive, which is the same guard from the
    // other side and pins that `dateChanged` reads a DAY rather than an instant.
    const sameClubDayLater = requireInstant("2026-08-04T08:00:00.000Z");
    expect(clubCalendarDateOf(AFTER, CLUB)).toBe(
      clubCalendarDateOf(sameClubDayLater, CLUB),
    );
    const anchor = await createCalendarEvent(
      data({ startsAt: AFTER, endsAt: null, recurrence: WEEKLY_3 }),
      "member-1",
    );
    const seriesId = h.events.get(anchor.id)!.seriesId!;
    const idsBefore = occurrencesOf(seriesId).map((o) => o.id);

    await updateCalendarEvent(
      anchor.id,
      data({ startsAt: sameClubDayLater, endsAt: null, recurrence: WEEKLY_3 }),
      "series",
      "member-1",
    );
    expect(occurrencesOf(seriesId).map((o) => o.id)).toEqual(idsBefore);
  });
});

describe("updateCalendarEvent — single vs series, exception survival", () => {
  it("returns null for an unknown id", async () => {
    expect(
      await updateCalendarEvent("nope", data(), "single", "member-1"),
    ).toBeNull();
  });

  it("edits a standalone event in place", async () => {
    const created = await createCalendarEvent(data(), "member-1");
    const res = await updateCalendarEvent(
      created.id,
      data({ title: "Renamed" }),
      "single",
      "member-1",
    );
    expect(res?.scope).toBe("single");
    expect(h.events.get(created.id)?.title).toBe("Renamed");
  });

  it("HEADLINE: a single-occurrence edit becomes an exception the later series edit leaves untouched", async () => {
    // Build a 3-occurrence weekly series.
    const anchor = await createCalendarEvent(
      data({ recurrence: WEEKLY_3 }),
      "member-1",
    );
    const seriesId = h.events.get(anchor.id)!.seriesId!;
    const [occ1, occ2, occ3] = occurrencesOf(seriesId);
    expect([occ1, occ2, occ3].every(Boolean)).toBe(true);

    // 1) Edit ONLY the middle occurrence.
    const single = await updateCalendarEvent(
      occ2.id,
      data({ title: "Moved standup", recurrence: WEEKLY_3 }),
      "single",
      "member-1",
    );
    expect(single?.scope).toBe("single");
    const detached = h.events.get(occ2.id)!;
    expect(detached.title).toBe("Moved standup");
    expect(detached.detachedFromSeries).toBe(true);

    // 2) Edit the WHOLE series (same pattern → field propagation).
    const series = await updateCalendarEvent(
      anchor.id,
      data({ title: "Team sync", recurrence: WEEKLY_3 }),
      "series",
      "member-1",
    );
    expect(series?.scope).toBe("series");

    // The exception survives: the detached occurrence keeps its own title…
    expect(h.events.get(occ2.id)!.title).toBe("Moved standup");
    expect(h.events.get(occ2.id)!.detachedFromSeries).toBe(true);
    // …while every non-detached occurrence took the series-wide change.
    expect(h.events.get(occ1.id)!.title).toBe("Team sync");
    expect(h.events.get(occ3.id)!.title).toBe("Team sync");
  });

  it("regenerates the series when the pattern changes, preserving detached exceptions", async () => {
    const anchor = await createCalendarEvent(
      data({ recurrence: WEEKLY_3 }),
      "member-1",
    );
    const seriesId = h.events.get(anchor.id)!.seriesId!;
    const [, occ2] = occurrencesOf(seriesId);

    // Detach the middle occurrence first.
    await updateCalendarEvent(
      occ2.id,
      data({ title: "Detached", recurrence: WEEKLY_3 }),
      "single",
      "member-1",
    );

    // Change the recurrence COUNT (pattern change → regenerate).
    const newRule: RecurrenceRule = { ...WEEKLY_3, count: 2 };
    await updateCalendarEvent(
      anchor.id,
      data({ recurrence: newRule }),
      "series",
      "member-1",
    );

    const rows = [...h.events.values()].filter((e) => e.seriesId === seriesId);
    const detached = rows.filter((e) => e.detachedFromSeries);
    const regenerated = rows.filter((e) => !e.detachedFromSeries);
    // The detached exception is untouched; the non-detached set was rebuilt to
    // the new count.
    expect(detached).toHaveLength(1);
    expect(detached[0].title).toBe("Detached");
    expect(regenerated).toHaveLength(2);
  });

  // #2244: both writes below run AFTER the existence check, so a concurrent
  // admin can remove the row (or the whole series) in between. Prisma raises
  // P2025 there; the documented contract for "the thing you edited is gone" is
  // the route's 404, so the service must return null rather than let the error
  // escape as a 500.
  it("treats a concurrent delete during a single-occurrence edit (P2025) as already gone → null", async () => {
    const created = await createCalendarEvent(data(), "member-1");
    const calendarEvent = h.prisma.calendarEvent as {
      update: (args: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => Promise<unknown>;
    };
    const original = calendarEvent.update;
    // Delete the row the instant the update is issued, then run the real fake:
    // it raises P2025 exactly as Postgres/Prisma would.
    calendarEvent.update = async (args) => {
      h.events.delete(created.id);
      return original(args);
    };
    try {
      expect(
        await updateCalendarEvent(
          created.id,
          data({ title: "Renamed" }),
          "single",
          "member-1",
        ),
      ).toBeNull();
    } finally {
      calendarEvent.update = original;
    }
  });

  it("treats a concurrent whole-series delete during a pattern-change regenerate (P2025) as already gone → null", async () => {
    const anchor = await createCalendarEvent(
      data({ recurrence: WEEKLY_3 }),
      "member-1",
    );
    const seriesId = h.events.get(anchor.id)!.seriesId!;
    const calendarEventSeries = h.prisma.calendarEventSeries as {
      update: (args: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => Promise<unknown>;
    };
    const original = calendarEventSeries.update;
    calendarEventSeries.update = async (args) => {
      h.series.delete(seriesId);
      return original(args);
    };
    try {
      // A pattern change (count 3 → 2) takes the regenerate path.
      expect(
        await updateCalendarEvent(
          anchor.id,
          data({ recurrence: { ...WEEKLY_3, count: 2 } }),
          "series",
          "member-1",
        ),
      ).toBeNull();
    } finally {
      calendarEventSeries.update = original;
    }
  });

  it("still surfaces a non-P2025 failure from either update path", async () => {
    // The mapping is narrow: only "record not found" becomes a 404. A genuine
    // database failure must keep propagating, or a broken save reads as a
    // missing event.
    const created = await createCalendarEvent(data(), "member-1");
    const calendarEvent = h.prisma.calendarEvent as {
      update: (args: unknown) => Promise<unknown>;
    };
    const originalEventUpdate = calendarEvent.update;
    calendarEvent.update = async () => {
      throw Object.assign(new Error("connection lost"), { code: "P1001" });
    };
    try {
      await expect(
        updateCalendarEvent(created.id, data(), "single", "member-1"),
      ).rejects.toThrow("connection lost");
    } finally {
      calendarEvent.update = originalEventUpdate;
    }

    const anchor = await createCalendarEvent(
      data({ recurrence: WEEKLY_3 }),
      "member-1",
    );
    const calendarEventSeries = h.prisma.calendarEventSeries as {
      update: (args: unknown) => Promise<unknown>;
    };
    const originalSeriesUpdate = calendarEventSeries.update;
    calendarEventSeries.update = async () => {
      throw Object.assign(new Error("connection lost"), { code: "P1001" });
    };
    try {
      await expect(
        updateCalendarEvent(
          anchor.id,
          data({ recurrence: { ...WEEKLY_3, count: 2 } }),
          "series",
          "member-1",
        ),
      ).rejects.toThrow("connection lost");
    } finally {
      calendarEventSeries.update = originalSeriesUpdate;
    }
  });
});

describe("deleteCalendarEvent", () => {
  it("returns null for an unknown id", async () => {
    expect(await deleteCalendarEvent("nope", "single")).toBeNull();
  });

  it("deletes a whole series and its series row", async () => {
    const anchor = await createCalendarEvent(
      data({ recurrence: WEEKLY_3 }),
      "member-1",
    );
    const seriesId = h.events.get(anchor.id)!.seriesId!;

    const res = await deleteCalendarEvent(anchor.id, "series");
    expect(res?.scope).toBe("series");
    expect(res?.deletedCount).toBe(3);
    expect([...h.events.values()].some((e) => e.seriesId === seriesId)).toBe(false);
    expect(h.series.has(seriesId)).toBe(false);
  });

  it("deletes a single occurrence and tidies the emptied series row", async () => {
    // A 1-occurrence series so deleting the occurrence empties it.
    const single: RecurrenceRule = { ...WEEKLY_3, count: 1 };
    const anchor = await createCalendarEvent(
      data({ recurrence: single }),
      "member-1",
    );
    const seriesId = h.events.get(anchor.id)!.seriesId!;

    const res = await deleteCalendarEvent(anchor.id, "single");
    expect(res?.scope).toBe("single");
    expect(h.events.has(anchor.id)).toBe(false);
    // The now-empty series row is cleaned up.
    expect(h.series.has(seriesId)).toBe(false);
  });

  it("E3 keep: a whole-series delete orphans detached exceptions (seriesId → null) and they survive", async () => {
    const anchor = await createCalendarEvent(
      data({ recurrence: WEEKLY_3 }),
      "member-1",
    );
    const seriesId = h.events.get(anchor.id)!.seriesId!;
    const [, occ2] = occurrencesOf(seriesId);
    // Turn the middle occurrence into a detached exception.
    await updateCalendarEvent(
      occ2.id,
      data({ title: "Exception", recurrence: WEEKLY_3 }),
      "single",
      "member-1",
    );

    const res = await deleteCalendarEvent(anchor.id, "series", "keep");
    expect(res?.scope).toBe("series");
    // deletedCount counts only the non-detached occurrences (2 of 3).
    expect(res?.deletedCount).toBe(2);
    // The exception survives as a standalone event (series detached, row kept).
    const survivor = h.events.get(occ2.id);
    expect(survivor).toBeDefined();
    expect(survivor!.seriesId).toBeNull();
    expect(survivor!.title).toBe("Exception");
    // The non-detached occurrences and the series row are gone.
    expect(
      [...h.events.values()].filter((e) => e.seriesId === seriesId),
    ).toHaveLength(0);
    expect(h.series.has(seriesId)).toBe(false);
  });

  it("E3 delete: a whole-series delete with exceptions=delete removes detached exceptions too", async () => {
    const anchor = await createCalendarEvent(
      data({ recurrence: WEEKLY_3 }),
      "member-1",
    );
    const seriesId = h.events.get(anchor.id)!.seriesId!;
    const [, occ2] = occurrencesOf(seriesId);
    await updateCalendarEvent(
      occ2.id,
      data({ title: "Exception", recurrence: WEEKLY_3 }),
      "single",
      "member-1",
    );

    const res = await deleteCalendarEvent(anchor.id, "series", "delete");
    // All three occurrences (including the exception) are removed.
    expect(res?.deletedCount).toBe(3);
    expect(h.events.has(occ2.id)).toBe(false);
    expect(h.series.has(seriesId)).toBe(false);
  });

  it("treats a concurrent delete (P2025) as already gone → returns null", async () => {
    const created = await createCalendarEvent(data(), "member-1");
    // Simulate the row vanishing between the existence check and the delete.
    const calendarEvent = h.prisma.calendarEvent as {
      delete: (args: { where: { id: string } }) => Promise<unknown>;
    };
    const original = calendarEvent.delete;
    calendarEvent.delete = async () => {
      throw Object.assign(new Error("gone"), { code: "P2025" });
    };
    try {
      expect(await deleteCalendarEvent(created.id, "single")).toBeNull();
    } finally {
      calendarEvent.delete = original;
    }
  });
});

describe("createCalendarEvent — idempotency", () => {
  it("dedups on a repeated idempotencyKey: one event, the replay returns the first", async () => {
    const first = await createCalendarEvent(data(), "member-1", "key-1");
    const second = await createCalendarEvent(
      data({ title: "Second attempt" }),
      "member-1",
      "key-1",
    );
    // Same event returned; the replay did not create a second row or mutate the
    // first.
    expect(second.id).toBe(first.id);
    expect(second.title).toBe("Weekly standup");
    expect(
      [...h.events.values()].filter((e) => e.idempotencyKey === "key-1"),
    ).toHaveLength(1);
    expect(h.events.size).toBe(1);
  });

  it("different keys create distinct events", async () => {
    const a = await createCalendarEvent(data(), "member-1", "key-a");
    const b = await createCalendarEvent(data(), "member-1", "key-b");
    expect(a.id).not.toBe(b.id);
    expect(h.events.size).toBe(2);
  });
});

describe("regenerateSeries — E2 meeting-room preservation", () => {
  it("reuses the room slug for an unchanged date and mints a fresh one only for new dates", async () => {
    // A weekly meeting series (each occurrence has its own room).
    const anchor = await createCalendarEvent(
      data({ isMeeting: true, recurrence: WEEKLY_3 }),
      "member-1",
    );
    const seriesId = h.events.get(anchor.id)!.seriesId!;
    const before = occurrencesOf(seriesId);
    const roomByInstant = new Map(
      before.map((o) => [o.startsAt.getTime(), o.meetingRoom]),
    );
    expect(before.every((o) => o.meetingRoom)).toBe(true);

    // Extend the series (count 3 → 4): a pattern change → regenerate. The first
    // three instants are unchanged; a fourth date is added.
    await updateCalendarEvent(
      anchor.id,
      data({ isMeeting: true, recurrence: { ...WEEKLY_3, count: 4 } }),
      "series",
      "member-1",
    );

    const after = occurrencesOf(seriesId);
    expect(after).toHaveLength(4);
    for (const occ of after) {
      const priorRoom = roomByInstant.get(occ.startsAt.getTime());
      if (priorRoom) {
        // An instant that existed before keeps its original room (join link
        // preserved).
        expect(occ.meetingRoom).toBe(priorRoom);
      } else {
        // The genuinely-new date got a fresh room distinct from every prior one.
        expect(occ.meetingRoom).toBeTruthy();
        expect([...roomByInstant.values()]).not.toContain(occ.meetingRoom);
      }
    }
  });
});
