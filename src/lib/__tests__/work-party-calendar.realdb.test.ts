/**
 * Real-PostgreSQL proof for #5148: a work party's Events
 * Calendar entries, written by the REAL writer against a real database. The
 * unit suites (`work-party-calendar.test.ts`, `work-party-calendar-service.test.ts`)
 * prove the calls with recording fakes; these claims need PostgreSQL itself:
 *
 *  1. "Add to calendar" writes one all-day entry per night, as one daily
 *     series, each linked to the work party.
 *  2. An edit (`updateWorkPartyWithCalendar`, one transaction) moves the
 *     entries: the old rows AND their emptied series go (the
 *     `events: { none: {} }` clean-up), and the new rows match the saved dates.
 *     An edit of a work party with no entries adds none.
 *  3. The calendar's visibility rule (`whereVisibleCalendarEvent`) as a real
 *     relation filter: an inactive work party's entries are hidden and come
 *     back on reactivation; every work party's entries are hidden while the
 *     Work parties module is off, and from every viewer who is not a member;
 *     an ordinary event always shows. The dashboard's Events card shows a
 *     multi-night work party as one line, on its first night.
 *  4. Deleting the work party removes its entries and their series inside the
 *     delete's transaction, and the foreign key's ON DELETE CASCADE removes the
 *     entries even on a path that forgot to (the series is then left empty,
 *     which is why the writer clears it itself).
 *  5. The calendar's own edit and delete refuse a linked entry.
 *  6. The lock (`lockWorkPartyCalendar`), with the interleaving FORCED rather
 *     than hoped for: the first writer is held just after taking the lock
 *     (inside its resolver, or between the delete's steps), the second is
 *     seen WAITING on that advisory lock in `pg_locks`, and only then is the
 *     first released. Edit against Add, edit against delete, and Add against
 *     Add (a double click) each end with one set of entries matching the work
 *     party as it ended up, no orphaned series, and no deadlock. Two edits
 *     racing are also covered, but they prove the outcome only: the
 *     WorkPartyEvent row lock alone would serialise them.
 *  7. A failure after the work party's update rolls the whole edit back: the
 *     row, its promo and its entries are as they were.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL the race harness provisions (#1881), and the
 * `realdb-all` job finds it by its name. It owns and cleans its `race-5148-`
 * fixtures.
 */
import type { PrismaClient } from "@prisma/client";
import type { CalendarViewer } from "@/lib/calendar-events";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

vi.mock("server-only", () => ({}));

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const ACTOR_ID = "race-5148-officer";
const LODGE_ID = "race-5148-lodge";
const LODGE_NAME = "Race 5148 Lodge";
const ORDINARY_EVENT_ID = "race-5148-ordinary";
const TITLE_PREFIX = "Work party: Race 5148";

// FUTURE against the frozen suite clock (1 July 2026). Date-only columns hold
// the first and the LAST night, both inclusive.
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const JULY = { startDate: day("2026-07-10"), endDate: day("2026-07-12") }; // 3 nights
const AUGUST = { startDate: day("2026-08-01"), endDate: day("2026-08-02") }; // 2 nights
const SEPTEMBER = { startDate: day("2026-09-05"), endDate: day("2026-09-08") }; // 4 nights

let prisma: PrismaClient;
let workParty: typeof import("@/lib/work-party");
let workPartyCalendar: typeof import("@/lib/work-party-calendar");
let entries: typeof import("@/lib/calendar-work-party-entries");
let calendarEvents: typeof import("@/lib/calendar-events");
let calendarService: typeof import("@/lib/calendar-service");
let dashboardEvents: typeof import("@/lib/dashboard-calendar-events");
const createdWorkParties: { id: string; promoCodeId: string }[] = [];

function input(
  name: string,
  window: { startDate: Date; endDate: Date },
  active = true,
) {
  return {
    name,
    description: "Bring gloves",
    startDate: window.startDate,
    endDate: window.endDate,
    discountPercent: 50,
    active,
    lodgeId: LODGE_ID,
  };
}

async function createWorkParty(name: string, window = JULY) {
  const event = await workParty.createWorkPartyEventWithPromo(input(name, window));
  createdWorkParties.push({ id: event.id, promoCodeId: event.promoCodeId });
  return event;
}

async function linkedEntries(workPartyEventId: string) {
  return prisma.calendarEvent.findMany({
    where: { workPartyEventId },
    orderBy: { startsAt: "asc" },
    select: {
      id: true,
      title: true,
      location: true,
      details: true,
      allDay: true,
      seriesId: true,
      startsAt: true,
    },
  });
}

const MEMBER = { accessRoles: ["USER"], role: "USER", canLogin: true };

async function visibleIds(
  modules: { workParties: boolean },
  viewer: CalendarViewer = MEMBER,
) {
  const rows = await prisma.calendarEvent.findMany({
    where: calendarEvents.whereVisibleCalendarEvent(
      { OR: [{ id: ORDINARY_EVENT_ID }, { title: { startsWith: TITLE_PREFIX } }] },
      { modules, viewer },
    ),
    select: { id: true, workPartyEventId: true },
  });
  return rows;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * Wait until `count` sessions in THIS database are queued on an advisory lock
 * (the race files take turns on the one race database, so nothing else is).
 * Measured with `realElapsedMs`: `Date` is frozen in tests.
 */
async function waitForPendingAdvisoryLocks(count: number): Promise<void> {
  const startedAt = process.hrtime.bigint();
  while (realElapsedMs(startedAt) < 5_000) {
    const rows = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS "count"
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND granted = false
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
    `;
    if ((rows[0]?.count ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for ${count} session(s) to queue on the work-party calendar lock`,
  );
}

/**
 * "Add to calendar" exactly as `addWorkPartyToCalendar` runs it, but held just
 * after the lock (its resolver runs after the lock and the linked read) until
 * `gate` opens. `entered` fires once it holds the lock.
 */
function heldAdd(workPartyEventId: string, entered: () => void, gate: Promise<void>) {
  return entries.replaceWorkPartyCalendarEvents(
    workPartyEventId,
    async (tx) => {
      entered();
      await gate;
      const row = await tx.workPartyEvent.findUnique({
        where: { id: workPartyEventId },
        select: {
          name: true,
          description: true,
          startDate: true,
          endDate: true,
          lodge: { select: { name: true } },
        },
      });
      return row ? workPartyCalendar.workPartyCalendarEntry(row) : null;
    },
    ACTOR_ID,
  );
}

async function orphanedSeriesCount() {
  return prisma.calendarEventSeries.count({
    where: { createdById: ACTOR_ID, events: { none: {} } },
  });
}

async function clean(): Promise<void> {
  const workParties = await prisma.workPartyEvent.findMany({
    where: { name: { startsWith: "Race 5148" } },
    select: { id: true, promoCodeId: true },
  });
  const ids = workParties.map((row) => row.id);
  const seriesIds = (
    await prisma.calendarEvent.findMany({
      where: { OR: [{ workPartyEventId: { in: ids } }, { createdById: ACTOR_ID }] },
      select: { seriesId: true },
    })
  )
    .map((row) => row.seriesId)
    .filter((id): id is string => id !== null);
  await prisma.calendarEvent.deleteMany({
    where: { OR: [{ workPartyEventId: { in: ids } }, { createdById: ACTOR_ID }] },
  });
  await prisma.calendarEventSeries.deleteMany({
    where: { OR: [{ id: { in: seriesIds } }, { createdById: ACTOR_ID }] },
  });
  await prisma.workPartyEvent.deleteMany({ where: { id: { in: ids } } });
  await prisma.promoCode.deleteMany({
    where: {
      id: {
        in: [
          ...workParties.map((row) => row.promoCodeId),
          ...createdWorkParties.map((row) => row.promoCodeId),
        ],
      },
    },
  });
  await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
  createdWorkParties.length = 0;
}

(RUN ? describe : describe.skip)(
  "work party calendar entries on PostgreSQL (#5148)",
  { timeout: 60_000 },
  () => {
    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Work party calendar");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = (await import("@/lib/prisma")) as unknown as {
        prisma: PrismaClient;
      });
      workParty = await import("@/lib/work-party");
      workPartyCalendar = await import("@/lib/work-party-calendar");
      entries = await import("@/lib/calendar-work-party-entries");
      calendarEvents = await import("@/lib/calendar-events");
      calendarService = await import("@/lib/calendar-service");
      dashboardEvents = await import("@/lib/dashboard-calendar-events");
      await clean();
    });

    beforeEach(async () => {
      await clean();
      await prisma.lodge.create({
        data: { id: LODGE_ID, name: LODGE_NAME, slug: "race-5148" },
      });
      await prisma.calendarEvent.create({
        data: {
          id: ORDINARY_EVENT_ID,
          title: "Race 5148 committee meeting",
          allDay: true,
          startsAt: day("2026-07-11"),
          createdById: ACTOR_ID,
        },
      });
    });

    afterAll(async () => {
      if (prisma) await clean();
    });

    it("1. Add to calendar writes one all-day entry per night, as one daily series", async () => {
      const event = await createWorkParty("Race 5148 add");
      await expect(
        workPartyCalendar.addWorkPartyToCalendar(event.id, ACTOR_ID),
      ).resolves.toBe(3);
      const rows = await linkedEntries(event.id);
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((row) => row.seriesId)).size).toBe(1);
      expect(rows[0]!.seriesId).not.toBeNull();
      for (const row of rows) {
        expect(row).toMatchObject({
          title: "Work party: Race 5148 add",
          location: LODGE_NAME,
          details: "Bring gloves",
          allDay: true,
        });
      }
      const series = await prisma.calendarEventSeries.findUnique({
        where: { id: rows[0]!.seriesId! },
      });
      expect(series).toMatchObject({ frequency: "DAILY", interval: 1, count: 3 });
    });

    it("2. an edit moves the entries in its own transaction and clears the emptied series", async () => {
      const event = await createWorkParty("Race 5148 edit");
      await workPartyCalendar.addWorkPartyToCalendar(event.id, ACTOR_ID);
      const [oldFirst] = await linkedEntries(event.id);

      await workPartyCalendar.updateWorkPartyWithCalendar(
        event.id,
        input("Race 5148 edit moved", AUGUST),
        ACTOR_ID,
      );

      const rows = await linkedEntries(event.id);
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.title === "Work party: Race 5148 edit moved")).toBe(true);
      expect(
        await prisma.calendarEventSeries.findUnique({ where: { id: oldFirst!.seriesId! } }),
      ).toBeNull();
      expect(await prisma.calendarEvent.findUnique({ where: { id: oldFirst!.id } })).toBeNull();
      const saved = await prisma.workPartyEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(saved.name).toBe("Race 5148 edit moved");
    });

    it("2b. an edit of a work party with no entries adds none", async () => {
      const event = await createWorkParty("Race 5148 unlinked");
      await workPartyCalendar.updateWorkPartyWithCalendar(
        event.id,
        input("Race 5148 unlinked", AUGUST),
        ACTOR_ID,
      );
      expect(await linkedEntries(event.id)).toHaveLength(0);
    });

    it("3. the visibility rule hides an inactive work party's entries, and all of them while the module is off", async () => {
      const event = await createWorkParty("Race 5148 visible");
      await workPartyCalendar.addWorkPartyToCalendar(event.id, ACTOR_ID);

      const on = await visibleIds({ workParties: true });
      expect(on.filter((row) => row.workPartyEventId === event.id)).toHaveLength(3);
      expect(on.some((row) => row.id === ORDINARY_EVENT_ID)).toBe(true);

      const off = await visibleIds({ workParties: false });
      expect(off.filter((row) => row.workPartyEventId !== null)).toEqual([]);
      expect(off.some((row) => row.id === ORDINARY_EVENT_ID)).toBe(true);

      await workPartyCalendar.updateWorkPartyWithCalendar(
        event.id,
        input("Race 5148 visible", JULY, false),
        ACTOR_ID,
      );
      // Deactivating keeps the entries (rewritten from the saved row) but hides them.
      expect(await linkedEntries(event.id)).toHaveLength(3);
      const inactive = await visibleIds({ workParties: true });
      expect(inactive.filter((row) => row.workPartyEventId !== null)).toEqual([]);
      expect(inactive.some((row) => row.id === ORDINARY_EVENT_ID)).toBe(true);

      await workPartyCalendar.updateWorkPartyWithCalendar(
        event.id,
        input("Race 5148 visible", JULY, true),
        ACTOR_ID,
      );
      const back = await visibleIds({ workParties: true });
      expect(back.filter((row) => row.workPartyEventId === event.id)).toHaveLength(3);
    });

    it("3b. a non-member, a kiosk, an admin-only and an organisation account see no work party entry (owner decision, 20 Nov 2026)", async () => {
      const event = await createWorkParty("Race 5148 members only");
      await workPartyCalendar.addWorkPartyToCalendar(event.id, ACTOR_ID);

      expect(
        (await visibleIds({ workParties: true })).filter(
          (row) => row.workPartyEventId === event.id,
        ),
      ).toHaveLength(3);
      for (const viewer of [
        { accessRoles: [], role: "NON_MEMBER", canLogin: true },
        { accessRoles: ["LODGE"], role: "LODGE", canLogin: true },
        { accessRoles: ["ADMIN"], role: "ADMIN", canLogin: true },
        { accessRoles: ["ORG"], role: "USER", canLogin: true },
      ]) {
        const rows = await visibleIds({ workParties: true }, viewer);
        expect(rows.filter((row) => row.workPartyEventId !== null)).toEqual([]);
        expect(rows.some((row) => row.id === ORDINARY_EVENT_ID)).toBe(true);
      }
    });

    it("3c. the dashboard Events card shows a multi-night work party once, on its first night, beside an ordinary event", async () => {
      const event = await createWorkParty("Race 5148 dashboard");
      await workPartyCalendar.addWorkPartyToCalendar(event.id, ACTOR_ID);
      const read = (viewer: CalendarViewer) =>
        dashboardEvents.listDashboardCalendarEvents({
          from: day("2026-07-01"),
          to: day("2026-07-15"),
          modules: { workParties: true },
          viewer,
          limit: 50,
        });

      const lines = (await read(MEMBER)).filter(
        (line) => line.id === ORDINARY_EVENT_ID || line.workPartyEventId === event.id,
      );
      // Work party nights 10-12 July (three rows), the ordinary event on 11 July.
      const nights = await linkedEntries(event.id);
      expect(nights).toHaveLength(3);
      expect(lines.map((line) => [line.workPartyEventId, line.startsAt.toISOString()])).toEqual([
        [event.id, nights[0].startsAt.toISOString()],
        [null, day("2026-07-11").toISOString()],
      ]);

      const nonMember = await read({ accessRoles: [], role: "NON_MEMBER", canLogin: true });
      expect(nonMember.some((line) => line.workPartyEventId !== null)).toBe(false);
      expect(nonMember.some((line) => line.id === ORDINARY_EVENT_ID)).toBe(true);
    });

    it("4. the delete removes the entries and their series; the foreign key cascades the entries regardless", async () => {
      const event = await createWorkParty("Race 5148 delete");
      await workPartyCalendar.addWorkPartyToCalendar(event.id, ACTOR_ID);
      const [first] = await linkedEntries(event.id);

      await prisma.$transaction(async (tx) => {
        await entries.removeWorkPartyCalendarEventsInTransaction(tx, event.id);
        await tx.workPartyEvent.delete({ where: { id: event.id } });
        await tx.promoCode.delete({ where: { id: event.promoCodeId } });
      });
      expect(await prisma.calendarEvent.count({ where: { workPartyEventId: event.id } })).toBe(0);
      expect(
        await prisma.calendarEventSeries.findUnique({ where: { id: first!.seriesId! } }),
      ).toBeNull();

      const cascaded = await createWorkParty("Race 5148 cascade");
      await workPartyCalendar.addWorkPartyToCalendar(cascaded.id, ACTOR_ID);
      const ids = (await linkedEntries(cascaded.id)).map((row) => row.id);
      await prisma.workPartyEvent.delete({ where: { id: cascaded.id } });
      expect(await prisma.calendarEvent.count({ where: { id: { in: ids } } })).toBe(0);
    });

    it("5. the calendar's own edit and delete refuse a linked entry", async () => {
      const event = await createWorkParty("Race 5148 managed");
      await workPartyCalendar.addWorkPartyToCalendar(event.id, ACTOR_ID);
      const [first] = await linkedEntries(event.id);
      await expect(
        calendarService.deleteCalendarEvent(first!.id, "series"),
      ).rejects.toBeInstanceOf(calendarService.WorkPartyManagedCalendarEventError);
      await expect(
        calendarService.updateCalendarEvent(
          first!.id,
          {
            title: "hijacked",
            location: null,
            details: null,
            allDay: true,
            isMeeting: false,
            startsAt: first!.startsAt,
            endsAt: null,
            recurrence: null,
          },
          "single",
          ACTOR_ID,
        ),
      ).rejects.toBeInstanceOf(calendarService.WorkPartyManagedCalendarEventError);
      expect(await linkedEntries(event.id)).toHaveLength(3);
    });

    it("6a. two edits racing end matching the saved work party (outcome only: the row lock alone serialises them)", async () => {
      const event = await createWorkParty("Race 5148 race");
      await workPartyCalendar.addWorkPartyToCalendar(event.id, ACTOR_ID);

      await Promise.all([
        workPartyCalendar.updateWorkPartyWithCalendar(
          event.id,
          input("Race 5148 race", AUGUST),
          ACTOR_ID,
        ),
        workPartyCalendar.updateWorkPartyWithCalendar(
          event.id,
          input("Race 5148 race", SEPTEMBER),
          ACTOR_ID,
        ),
      ]);

      const saved = await prisma.workPartyEvent.findUniqueOrThrow({ where: { id: event.id } });
      const expectedNights = saved.startDate.getTime() === AUGUST.startDate.getTime() ? 2 : 4;
      const rows = await linkedEntries(event.id);
      expect(rows).toHaveLength(expectedNights);
      expect(new Set(rows.map((row) => row.seriesId)).size).toBe(1);
      expect(await orphanedSeriesCount()).toBe(0);
    });

    it("6b. an edit queued behind a held Add to calendar ends with the edit's entries, once", async () => {
      const event = await createWorkParty("Race 5148 add race");
      // Already on the calendar, so the edit has entries to rewrite.
      await workPartyCalendar.addWorkPartyToCalendar(event.id, ACTOR_ID);
      const held = deferred();
      const gate = deferred();
      const add = heldAdd(event.id, held.resolve, gate.promise);
      await held.promise;

      const edit = workPartyCalendar.updateWorkPartyWithCalendar(
        event.id,
        input("Race 5148 add race", SEPTEMBER),
        ACTOR_ID,
      );
      await waitForPendingAdvisoryLocks(1);
      gate.resolve();
      await Promise.all([add, edit]);

      const rows = await linkedEntries(event.id);
      expect(rows).toHaveLength(4);
      expect(new Set(rows.map((row) => row.seriesId)).size).toBe(1);
      expect(await orphanedSeriesCount()).toBe(0);
    });

    it("6c. an edit queued behind a held delete waits, finds no row to update, and no entry survives", async () => {
      const event = await createWorkParty("Race 5148 delete race");
      await workPartyCalendar.addWorkPartyToCalendar(event.id, ACTOR_ID);
      const held = deferred();
      const gate = deferred();
      const remove = prisma.$transaction(async (tx) => {
        await entries.removeWorkPartyCalendarEventsInTransaction(tx, event.id);
        held.resolve();
        await gate.promise;
        await tx.workPartyEvent.delete({ where: { id: event.id } });
        await tx.promoCode.delete({ where: { id: event.promoCodeId } });
      });
      await held.promise;

      const edit = workPartyCalendar
        .updateWorkPartyWithCalendar(event.id, input("Race 5148 delete race", SEPTEMBER), ACTOR_ID)
        .then(
          () => null,
          (error: unknown) => error,
        );
      await waitForPendingAdvisoryLocks(1);
      gate.resolve();
      await remove;
      const editError = await edit;

      // The edit waited on the lock before touching the row the delete needed,
      // so there is no deadlock; its update then finds no row (P2025).
      expect(editError).toMatchObject({ code: "P2025" });
      expect(String(editError)).not.toMatch(/deadlock/i);
      expect(await prisma.workPartyEvent.findUnique({ where: { id: event.id } })).toBeNull();
      expect(await prisma.calendarEvent.count({ where: { workPartyEventId: event.id } })).toBe(0);
      expect(await orphanedSeriesCount()).toBe(0);
    });

    it("6d. Add to calendar clicked twice writes one set of entries and no orphaned series", async () => {
      const event = await createWorkParty("Race 5148 double add");
      const held = deferred();
      const gate = deferred();
      const first = heldAdd(event.id, held.resolve, gate.promise);
      await held.promise;

      const second = workPartyCalendar.addWorkPartyToCalendar(event.id, ACTOR_ID);
      await waitForPendingAdvisoryLocks(1);
      gate.resolve();
      await Promise.all([first, second]);

      const rows = await linkedEntries(event.id);
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((row) => row.seriesId)).size).toBe(1);
      expect(await orphanedSeriesCount()).toBe(0);
    });

    it("7. a failure after the update rolls the whole edit back", async () => {
      const event = await createWorkParty("Race 5148 rollback");
      await workPartyCalendar.addWorkPartyToCalendar(event.id, ACTOR_ID);
      const before = await linkedEntries(event.id);
      // A real database failure inside the rewrite, after the work party's
      // update has run: inserting the moved entries raises.
      await prisma.$executeRawUnsafe(
        "CREATE OR REPLACE FUNCTION race_5148_refuse_insert() RETURNS trigger AS " +
          "'BEGIN RAISE EXCEPTION ''race 5148 injected failure''; END;' LANGUAGE plpgsql",
      );
      await prisma.$executeRawUnsafe(
        'CREATE TRIGGER race_5148_refuse_insert BEFORE INSERT ON "CalendarEvent" ' +
          "FOR EACH ROW WHEN (NEW.title = 'Work party: Race 5148 rollback moved') " +
          "EXECUTE FUNCTION race_5148_refuse_insert()",
      );
      try {
        await expect(
          workPartyCalendar.updateWorkPartyWithCalendar(
            event.id,
            input("Race 5148 rollback moved", AUGUST),
            ACTOR_ID,
          ),
        ).rejects.toThrow();
      } finally {
        await prisma.$executeRawUnsafe(
          'DROP TRIGGER IF EXISTS race_5148_refuse_insert ON "CalendarEvent"',
        );
        await prisma.$executeRawUnsafe("DROP FUNCTION IF EXISTS race_5148_refuse_insert()");
      }

      const saved = await prisma.workPartyEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(saved.name).toBe("Race 5148 rollback");
      expect(saved.startDate.getTime()).toBe(JULY.startDate.getTime());
      const promo = await prisma.promoCode.findUniqueOrThrow({ where: { id: event.promoCodeId } });
      expect(promo.description).toBe("Working bee: Race 5148 rollback");
      expect(await linkedEntries(event.id)).toEqual(before);
    });
  },
);
