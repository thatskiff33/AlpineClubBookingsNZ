import { describe, expect, it, vi } from "vitest";

// The writers import the app client; these tests hand every writer its own db.
vi.mock("@/lib/prisma", () => ({ prisma: {}, default: {} }));

import { approveBedAllocationsWithLocksHeld } from "@/lib/bed-allocation-approval";
import { deleteBedAllocationBedWithLocksHeld, updateBedAllocationBedWithLocksHeld } from "@/lib/bed-allocation-beds";
import {
  reconcileBedAllocationsForBookingWithGlobalLockHeld,
  reconcileBedAllocationsForBookingWithLodgeLockHeld,
  sweepFuturePartnerSharedAllocationsWithLocksHeld,
  sweepUnbackedFutureSharedDoublesWithLocksHeld,
} from "@/lib/bed-allocation-lifecycle";
import {
  deleteBedAllocationWithLocksHeld,
  manuallyAllocateBedForNightsWithLocksHeld,
  manuallyAllocateBedWithLocksHeld,
  moveBedAllocationsSameDateWithLocksHeld,
} from "@/lib/bed-allocation-manual-writes";
import { allocateBedNightWithLocksHeld } from "@/lib/bed-allocation-placement";
import { assignBedRangeWithLocksHeld } from "@/lib/bed-allocation-range-assign";
import { deleteBedAllocationRoomWithLocksHeld, updateBedAllocationRoomWithLocksHeld } from "@/lib/bed-allocation-rooms";
import { GlobalLockNotHeldError } from "@/lib/global-lock-held";
import { LodgeCapacityLockNotHeldError } from "@/lib/lodge-capacity-lock";

/*
 * Every caller-held-lock export refuses before it touches mutable state, and
 * checks the lodge its own rows belong to (#4929, INV-LOCK-003). The census
 * pins the shape of each entry check; this pins the key it is given.
 *
 * Each key lookup answers only for the id the writer was handed, so a lookup
 * keyed by the wrong id finds nothing, skips the check and is caught touching
 * the db. A caller-supplied DECOY lodge is held, so a check of the decoy rather
 * than the row's own lodge passes and is caught the same way.
 */
const DECOY = "lodge-decoy";
const TODAY = new Date("2026-07-01T00:00:00.000Z");

type Lookup = (args: { where?: Record<string, unknown> }) => unknown;

function fakeDb(options: { globalHeld: boolean; heldLodges: readonly string[]; lookups: Record<string, Lookup> }) {
  const touched: string[] = [];
  const lodgeProbes: string[] = [];
  const $queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes("pg_locks") && sql.includes("hashtextextended")) {
      lodgeProbes.push(String(values[0]));
      return [{ held: options.heldLodges.includes(String(values[0])) }];
    }
    if (sql.includes("pg_locks")) return [{ held: options.globalHeld }];
    touched.push(`$queryRaw ${sql}`);
    throw new Error("read past the lock checks");
  });
  const $executeRaw = vi.fn(async () => {
    touched.push("$executeRaw");
    throw new Error("wrote past the lock checks");
  });
  const db = new Proxy({} as Record<string, unknown>, {
    get(_target, model) {
      if (model === "$queryRaw") return $queryRaw;
      if (model === "$executeRaw") return $executeRaw;
      if (typeof model !== "string" || model === "then") return undefined;
      return new Proxy({} as Record<string, unknown>, {
        get(_inner, method) {
          const key = `${model}.${String(method)}`;
          return vi.fn(async (args: { where?: Record<string, unknown> }) => {
            const lookup = options.lookups[key];
            if (lookup) return lookup(args);
            touched.push(key);
            throw new Error(`${key} ran past the lock checks`);
          });
        },
      });
    },
  });
  return { db: db as never, touched, lodgeProbes };
}

/** A key lookup that answers only when handed `id`. */
const byId = (id: string, row: unknown): Lookup => (args) => (args.where?.id === id ? row : null);
const bedInLodge = (bedId: string, lodgeId: string) => ({ "lodgeBed.findUnique": byId(bedId, { room: { lodgeId } }) });
const roomInLodge = (roomId: string, lodgeId: string) => ({ "lodgeRoom.findUnique": byId(roomId, { lodgeId }) });
const allocationsIn = (...lodgeIds: string[]): Lookup => () => lodgeIds.map((lodgeId) => ({ room: { lodgeId } }));

interface Writer {
  name: string;
  run: (db: never) => Promise<unknown>;
  lookups: Record<string, Lookup>;
  /** Lodges that hold the writer's rows; the unheld one must be refused. Empty: global tier only. */
  lodges: readonly string[];
  global?: boolean;
}

const WRITERS: Writer[] = [
  {
    name: "reconcileBedAllocationsForBookingWithLodgeLockHeld",
    run: (db) => reconcileBedAllocationsForBookingWithLodgeLockHeld({ db, bookingId: "booking-1" }),
    lookups: { "booking.findUnique": byId("booking-1", { lodgeId: "lodge-booking" }) },
    lodges: ["lodge-booking"],
  },
  {
    name: "sweepFuturePartnerSharedAllocationsWithLocksHeld",
    run: (db) => sweepFuturePartnerSharedAllocationsWithLocksHeld({ db, memberId: "m-1", partnerMemberId: "m-2", reason: "partner_link_dissolved", today: TODAY }),
    lookups: { "bedAllocation.findMany": allocationsIn("lodge-a", "lodge-b", "lodge-a") },
    lodges: ["lodge-a", "lodge-b"],
  },
  {
    name: "sweepUnbackedFutureSharedDoublesWithLocksHeld",
    run: (db) => sweepUnbackedFutureSharedDoublesWithLocksHeld({ db, memberIds: ["m-1"], lockedLodgeIds: ["lodge-a", "lodge-b"], reason: "members_merged", today: TODAY }),
    lookups: {},
    lodges: ["lodge-a", "lodge-b"],
    global: false,
  },
  {
    name: "manuallyAllocateBedWithLocksHeld",
    run: (db) => manuallyAllocateBedWithLocksHeld({ db, bookingGuestId: "guest-1", bedId: "bed-1", stayDate: "2026-07-02" }),
    lookups: bedInLodge("bed-1", "lodge-bed"),
    lodges: ["lodge-bed"],
  },
  {
    name: "moveBedAllocationsSameDateWithLocksHeld",
    run: (db) => moveBedAllocationsSameDateWithLocksHeld({ db, allocationIds: ["alloc-1"], bedId: "bed-1", actorMemberId: "officer-1" }),
    lookups: bedInLodge("bed-1", "lodge-bed"),
    lodges: ["lodge-bed"],
  },
  {
    name: "manuallyAllocateBedForNightsWithLocksHeld",
    run: (db) => manuallyAllocateBedForNightsWithLocksHeld({ db, bookingGuestId: "guest-1", bedId: "bed-1", stayDates: ["2026-07-02"] }),
    lookups: bedInLodge("bed-1", "lodge-bed"),
    lodges: ["lodge-bed"],
  },
  {
    name: "deleteBedAllocationWithLocksHeld",
    run: (db) => deleteBedAllocationWithLocksHeld({ db, id: "alloc-1" }),
    lookups: { "bedAllocation.findUnique": byId("alloc-1", { room: { lodgeId: "lodge-allocation" } }) },
    lodges: ["lodge-allocation"],
  },
  {
    name: "assignBedRangeWithLocksHeld",
    run: (db) => assignBedRangeWithLocksHeld({ db, bookingGuestId: "guest-1", bedId: "bed-1", from: "2026-07-02", to: "2026-07-04", approvedByMemberId: "officer-1" }),
    lookups: bedInLodge("bed-1", "lodge-bed"),
    lodges: ["lodge-bed"],
  },
  {
    name: "allocateBedNightWithLocksHeld",
    run: (db) => allocateBedNightWithLocksHeld({ db, guest: { id: "guest-1" } as never, bed: { id: "bed-1", roomId: "room-1" } as never, stayDate: new Date("2026-07-02T00:00:00.000Z") }),
    lookups: roomInLodge("room-1", "lodge-room"),
    lodges: ["lodge-room"],
  },
  {
    name: "updateBedAllocationBedWithLocksHeld",
    run: (db) => updateBedAllocationBedWithLocksHeld({ db, id: "bed-1", label: "Top", today: TODAY } as never),
    lookups: bedInLodge("bed-1", "lodge-bed"),
    lodges: ["lodge-bed"],
  },
  {
    name: "deleteBedAllocationBedWithLocksHeld",
    run: (db) => deleteBedAllocationBedWithLocksHeld({ db, id: "bed-1" }),
    lookups: bedInLodge("bed-1", "lodge-bed"),
    lodges: ["lodge-bed"],
  },
  {
    name: "updateBedAllocationRoomWithLocksHeld",
    run: (db) => updateBedAllocationRoomWithLocksHeld({ db, id: "room-1", lodgeId: DECOY, name: "Bunkroom", today: TODAY } as never),
    lookups: roomInLodge("room-1", "lodge-room"),
    lodges: ["lodge-room"],
  },
  {
    name: "deleteBedAllocationRoomWithLocksHeld",
    run: (db) => deleteBedAllocationRoomWithLocksHeld({ db, id: "room-1", lodgeId: DECOY }),
    lookups: roomInLodge("room-1", "lodge-room"),
    lodges: ["lodge-room"],
  },
  {
    name: "approveBedAllocationsWithLocksHeld (club-wide)",
    run: (db) => approveBedAllocationsWithLocksHeld({ db, approvedByMemberId: "officer-1", allocationIds: ["alloc-1", "alloc-2", "alloc-3"] }),
    lookups: { "bedAllocation.findMany": allocationsIn("lodge-a", "lodge-b", "lodge-a") },
    lodges: ["lodge-a", "lodge-b"],
  },
  {
    name: "approveBedAllocationsWithLocksHeld (one lodge)",
    run: (db) => approveBedAllocationsWithLocksHeld({ db, approvedByMemberId: "officer-1", allocationIds: ["alloc-1"], lodgeId: "lodge-scoped" } as never),
    lookups: {},
    lodges: ["lodge-scoped"],
  },
  {
    // Global only: it takes the lodge key itself, after this check.
    name: "reconcileBedAllocationsForBookingWithGlobalLockHeld",
    run: (db) => reconcileBedAllocationsForBookingWithGlobalLockHeld({ db, bookingId: "booking-1" } as never),
    lookups: { "booking.findUnique": byId("booking-1", { lodgeId: "lodge-booking" }) },
    lodges: [],
  },
];

describe("caller-held lock writers refuse an unlocked caller (#4929)", () => {
  it.each(WRITERS.filter((writer) => writer.global !== false))("$name refuses without the global key before any read", async (writer) => {
    const fake = fakeDb({ globalHeld: false, heldLodges: [DECOY, ...writer.lodges], lookups: writer.lookups });
    await expect(writer.run(fake.db)).rejects.toBeInstanceOf(GlobalLockNotHeldError);
    expect(fake.lodgeProbes).toEqual([]);
    expect(fake.touched).toEqual([]);
  });

  it.each(WRITERS.filter((writer) => writer.lodges.length > 0))("$name checks every lodge its rows sit in and refuses the unheld one", async (writer) => {
    // Hold every lodge but the last, so a writer that skips one walks on.
    const unheld = writer.lodges.at(-1)!;
    const held = [DECOY, ...writer.lodges.slice(0, -1)];
    // The merge sweep runs with global NOT held, proving it needs only its lodge keys (#2595).
    const fake = fakeDb({ globalHeld: writer.global !== false, heldLodges: held, lookups: writer.lookups });
    const refused = await writer.run(fake.db).then(() => undefined, (error: unknown) => error);
    expect(refused).toBeInstanceOf(LodgeCapacityLockNotHeldError);
    expect((refused as LodgeCapacityLockNotHeldError).lodgeId).toBe(unheld);
    expect([...new Set(fake.lodgeProbes)]).toEqual(writer.lodges);
    expect(fake.touched).toEqual([]);
  });
});
