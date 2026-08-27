import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3123 — the LOCK-BOUND half: eight sites that ask "what day is it at the
 * club" from inside a transaction that already holds locks.
 *
 * ## Why these could not be fixed the way the other 44 were
 *
 * `INV-LOCK-004` names this exact case: *"Two more cannot take one — the
 * subscription-lockout mode and the club timezone — and are resolved before the
 * transaction opens and passed in as a value instead."* Resolving the club's
 * persisted zone is a `clubTimeSettings.findUnique`; taken inside these
 * transactions it would hold a second pooled connection under
 * `pg_advisory_xact_lock(1)` and the per-lodge capacity key, which is the
 * pool-starvation shape `docs/CONCURRENCY_AND_LOCKING.md` -> "Which client
 * reads the club's timezone" forbids. So every site here took a REQUIRED
 * `today` parameter and every caller resolves it before opening its
 * transaction. No defaults were added: a default is what produced this whole
 * class (`getTodayDateOnly(timeZone = APP_TIME_ZONE)`), and a required
 * parameter is what makes the compiler enumerate the callers.
 *
 * ## DISCRIMINATION
 *
 * `APP_TIME_ZONE` — the container's zone, and the only thing the replaced
 * helper ever read — is pinned to `Pacific/Auckland`. That is both the answer
 * the old code gave AND this codebase's own documented fallback, so it is the
 * one value a wrong fix (a lost read, a hard-coded default, a fail-soft
 * degradation) could still pass under. The persisted club zone is
 * `America/Denver`, behind Greenwich, which is the side these defects show on.
 * Under the frozen clock (`2026-07-01T00:00:00.000Z`) that is 1 July against
 * 30 June, so no assertion here can pass by coincidence — which is precisely
 * what #3123's execution contract asks for.
 *
 * Bounds are asserted at the exact millisecond, not as a calendar day.
 * `HutLeaderAssignment.endDate` and `Booking.checkOut` are `@db.Date`, so a
 * club-LOCAL midnight bound would be `2026-06-30T06:00:00Z`, which the Prisma
 * adapter narrows to 29 June (`INV-DATE-026`). Only "the club's day, encoded at
 * UTC midnight" gives `2026-06-30T00:00:00.000Z`.
 *
 * ## The other half of this file is the LOCK assertion
 *
 * Getting the zone right and reading it in the wrong place are different
 * defects, and only one of them shows up in a date. `resolves the club's zone
 * BEFORE the transaction opens, never inside it` records an ordered timeline of
 * settings reads, transaction openings and lock acquisitions, and requires
 * every zone read to precede every transaction. A source-level companion that
 * covers all thirteen caller files at once — including the ones no runtime test
 * here reaches — is `lock-bound-club-zone-outside-transaction.test.ts`.
 */

// Inlined literals: `vi.mock` factories hoist above every const in this file.
vi.mock("server-only", () => ({}));
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "Pacific/Auckland",
  APP_LOCALE: "en-NZ",
}));

const mocks = vi.hoisted(() => ({
  /** Ordered record of "who ran when", for the lock-ordering assertions. */
  timeline: [] as string[],
  clubTimeSettingsFindUnique: vi.fn(),
  hutLeaderAssignmentFindMany: vi.fn(),
  bedAllocationFindMany: vi.fn(),
  lodgeBedFindMany: vi.fn(),
  lodgeBedUpdate: vi.fn(),
  lodgeRoomUpdate: vi.fn(),
  lodgeBedFindUnique: vi.fn(),
  lodgeRoomFindUnique: vi.fn(),
  executeRaw: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
}));

/*
  THE `clubTimeSettings` DELEGATE IS NOT OPTIONAL ON THIS MOCK. `getClubTimeZone`
  is fail-soft in three places — a missing delegate, a throwing query and an
  absent row — and every one of them degrades silently to the environment. A
  prisma mock without it therefore passes for exactly the reason this file
  exists to rule out.
*/
vi.mock("@/lib/prisma", () => {
  const delegates = {
    clubTimeSettings: { findUnique: mocks.clubTimeSettingsFindUnique },
    hutLeaderAssignment: { findMany: mocks.hutLeaderAssignmentFindMany },
    bedAllocation: { findMany: mocks.bedAllocationFindMany },
    lodgeBed: {
      findMany: mocks.lodgeBedFindMany,
      findUnique: mocks.lodgeBedFindUnique,
      update: mocks.lodgeBedUpdate,
    },
    lodgeRoom: {
      findUnique: mocks.lodgeRoomFindUnique,
      update: mocks.lodgeRoomUpdate,
    },
    $executeRaw: mocks.executeRaw,
  };
  return {
    prisma: {
      ...delegates,
      $transaction: async (run: (tx: unknown) => unknown) => {
        mocks.timeline.push("transaction-open");
        const result = await run(delegates);
        mocks.timeline.push("transaction-close");
        return result;
      },
    },
  };
});

vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: mocks.acquireLodgeCapacityLock,
}));
vi.mock("@/lib/lodge-capacity", () => ({
  getLodgePartnerSharedCapacityStatus: vi.fn(),
}));

import { APP_TIME_ZONE } from "@/config/operational";
import { clubToday, requireClubTimeZone } from "@/lib/club-time";
import { updateBedAllocationBed } from "@/lib/bed-allocation-beds";
import { updateBedAllocationRoom } from "@/lib/bed-allocation-rooms";

const ENVIRONMENT_ZONE = "Pacific/Auckland";
const PERSISTED_ZONE = "America/Denver";
/** The club's day at the frozen instant, as Prisma's `@db.Date` encoding. */
const CLUB_DAY = "2026-06-30T00:00:00.000Z";
/** What the container's zone would have said. Every assertion must reject it. */
const ENVIRONMENT_DAY = "2026-07-01T00:00:00.000Z";

function persistClubZone(timeZone: string) {
  mocks.clubTimeSettingsFindUnique.mockImplementation(async () => {
    mocks.timeline.push("club-zone-read");
    return {
      timeZone,
      updatedByMemberId: null,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
  });
}

/** The `endDate: { gte: … }` bound the custodian-hold refusal queried on. */
function custodianHoldBound(): string {
  const call = mocks.hutLeaderAssignmentFindMany.mock.calls[0]?.[0] as {
    where: { endDate: { gte: Date } };
  };
  return call.where.endDate.gte.toISOString();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.timeline.length = 0;
  persistClubZone(PERSISTED_ZONE);
  mocks.hutLeaderAssignmentFindMany.mockResolvedValue([]);
  mocks.bedAllocationFindMany.mockResolvedValue([]);
  mocks.lodgeBedFindMany.mockResolvedValue([{ id: "bed-1" }]);
  mocks.lodgeBedFindUnique.mockResolvedValue({
    room: { lodgeId: "lodge-a" },
    roomId: "room-1",
    bedType: "SINGLE",
    bunkGroup: null,
  });
  mocks.lodgeRoomFindUnique.mockResolvedValue({ lodgeId: "lodge-a" });
  mocks.lodgeBedUpdate.mockResolvedValue({ id: "bed-1" });
  mocks.lodgeRoomUpdate.mockResolvedValue({ id: "room-1" });
  mocks.acquireLodgeCapacityLock.mockImplementation(async () => {
    mocks.timeline.push("lodge-capacity-lock");
  });
  mocks.executeRaw.mockImplementation(async () => {
    mocks.timeline.push("global-cohort-lock");
    return 1;
  });
});

describe("the lock-bound bed-inventory writers take today from the club (#3123)", () => {
  it("PREMISE: the persisted zone and the container's give different days", () => {
    // Without this leg the suite passes just as well when the two agree, which
    // is the false green #3123's execution contract names by hand.
    expect(APP_TIME_ZONE).toBe(ENVIRONMENT_ZONE);
    expect(clubToday(requireClubTimeZone(ENVIRONMENT_ZONE))).toBe("2026-07-01");
    expect(clubToday(requireClubTimeZone(PERSISTED_ZONE))).toBe("2026-06-30");
  });

  describe("bed-allocation-beds.ts — refusing to retire a bed a custodian holds", () => {
    it("judges 'future hold' against the club's day, not the container's", async () => {
      // A day out here retires a bed somebody is booked to sleep in, or refuses
      // a retirement over a hold that has already ended (#2286).
      await updateBedAllocationBed({ id: "bed-1", active: false });

      expect(custodianHoldBound()).toBe(CLUB_DAY);
      expect(custodianHoldBound()).not.toBe(ENVIRONMENT_DAY);
    });

    it("moves with the persisted zone — kills a hard-coded Pacific/Auckland", async () => {
      // The leg that a literal club zone cannot pass. Kiritimati is UTC+14 and
      // Pago Pago UTC-11, so they straddle the frozen instant's date boundary.
      persistClubZone("Pacific/Kiritimati");
      await updateBedAllocationBed({ id: "bed-1", active: false });
      expect(custodianHoldBound()).toBe("2026-07-01T00:00:00.000Z");

      vi.clearAllMocks();
      mocks.hutLeaderAssignmentFindMany.mockResolvedValue([]);
      mocks.bedAllocationFindMany.mockResolvedValue([]);
      mocks.lodgeBedFindUnique.mockResolvedValue({
        room: { lodgeId: "lodge-a" },
        roomId: "room-1",
        bedType: "SINGLE",
        bunkGroup: null,
      });
      mocks.lodgeBedUpdate.mockResolvedValue({ id: "bed-1" });
      persistClubZone("Pacific/Pago_Pago");
      await updateBedAllocationBed({ id: "bed-1", active: false });
      expect(custodianHoldBound()).toBe("2026-06-30T00:00:00.000Z");
    });
  });

  describe("bed-allocation-rooms.ts — refusing to retire a room whose bed is held", () => {
    it("judges 'future hold' against the club's day, not the container's", async () => {
      await updateBedAllocationRoom({ id: "room-1", active: false });

      expect(custodianHoldBound()).toBe(CLUB_DAY);
      expect(custodianHoldBound()).not.toBe(ENVIRONMENT_DAY);
    });

    it("moves with the persisted zone — kills a hard-coded Pacific/Auckland", async () => {
      // BOTH zones, not one. Kiritimati alone agrees with the container's
      // Auckland at this instant, so a Kiritimati-only leg passes on the
      // pre-migration source too — measured. Pago Pago is what discriminates.
      persistClubZone("Pacific/Kiritimati");
      await updateBedAllocationRoom({ id: "room-1", active: false });
      expect(custodianHoldBound()).toBe("2026-07-01T00:00:00.000Z");

      vi.clearAllMocks();
      mocks.hutLeaderAssignmentFindMany.mockResolvedValue([]);
      mocks.lodgeBedFindMany.mockResolvedValue([{ id: "bed-1" }]);
      mocks.lodgeRoomFindUnique.mockResolvedValue({ lodgeId: "lodge-a" });
      mocks.lodgeRoomUpdate.mockResolvedValue({ id: "room-1" });
      persistClubZone("Pacific/Pago_Pago");
      await updateBedAllocationRoom({ id: "room-1", active: false });
      expect(custodianHoldBound()).toBe("2026-06-30T00:00:00.000Z");
    });
  });

  describe("INV-LOCK-004 — where the zone is read, not just which zone it is", () => {
    /*
      This is the regression the lane most needs to prevent, and it is invisible
      to every date assertion above: an `await clubTodayDateOnlyInstant()` that
      drifts back inside the transaction still produces the RIGHT day. What it
      also produces is a `clubTimeSettings.findUnique` on a second pooled
      connection, held for the length of the settings query behind
      `pg_advisory_xact_lock(1)` and the lodge capacity key.
    */
    it("resolves the club's zone BEFORE the transaction opens, never inside it", async () => {
      await updateBedAllocationBed({ id: "bed-1", active: false });

      const opened = mocks.timeline.indexOf("transaction-open");
      const closed = mocks.timeline.indexOf("transaction-close");
      expect(opened, "the writer never opened a transaction").toBeGreaterThan(-1);
      expect(mocks.timeline.slice(0, opened)).toContain("club-zone-read");
      expect(
        mocks.timeline.slice(opened, closed),
        "a club-zone read ran while the transaction was open, holding a " +
          "settings query under `pg_advisory_xact_lock(1)` and the per-lodge " +
          "capacity key. Resolve it before `prisma.$transaction` and thread " +
          "the value in — `INV-LOCK-004`, and `docs/CONCURRENCY_AND_LOCKING.md` " +
          '-> "Which client reads the club\'s timezone".',
      ).not.toContain("club-zone-read");
    });

    it("does the same for the room writer", async () => {
      await updateBedAllocationRoom({ id: "room-1", active: false });

      const opened = mocks.timeline.indexOf("transaction-open");
      const closed = mocks.timeline.indexOf("transaction-close");
      expect(opened).toBeGreaterThan(-1);
      expect(mocks.timeline.slice(0, opened)).toContain("club-zone-read");
      expect(mocks.timeline.slice(opened, closed)).not.toContain(
        "club-zone-read",
      );
    });

    it("NOT VACUOUS: the timeline really observes the locks it claims to", async () => {
      // Without this, a mock that stopped recording — or a writer that stopped
      // locking — would leave both assertions above passing over an empty
      // slice. The order asserted here is `INV-LOCK-002`'s: global, then lodge.
      await updateBedAllocationBed({ id: "bed-1", active: false });

      expect(mocks.timeline).toContain("global-cohort-lock");
      expect(mocks.timeline).toContain("lodge-capacity-lock");
      expect(mocks.timeline.indexOf("global-cohort-lock")).toBeLessThan(
        mocks.timeline.indexOf("lodge-capacity-lock"),
      );
      expect(mocks.timeline.indexOf("club-zone-read")).toBeLessThan(
        mocks.timeline.indexOf("global-cohort-lock"),
      );
    });
  });
});
