import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  eachDateOnlyInRange,
  formatDateOnly,
  parseDateOnly,
} from "@/lib/date-only";

/**
 * Exclusive whole-lodge holds as PLANNER occupancy (#2317, owner decision
 * option (a), 1 Aug 2026).
 *
 * A held group implicitly occupies every bed of its lodge for its nights
 * (ADR-001) but owns no `BedAllocation` row anywhere (#2285), so until this
 * change both bed-allocation planners saw a held lodge as a lodge full of free
 * beds. These tests pin the four properties the decision asks for, on BOTH
 * planners:
 *
 *   1. a held night reads as fully occupied,
 *   2. the occupancy is UNATTRIBUTED — no booking id, no guest id, no name,
 *   3. no planner action can displace it, and
 *   4. what the planners treat as held is exactly what the CAPACITY ENGINE
 *      treats as held — same predicate, no parallel list to drift.
 *
 * The db doubles here interpret the Prisma `where` they are given (see
 * `matchesWhere`) instead of answering every query with the same rows. That
 * matters for (4): `getLodgeHeldNights` filters in SQL and trusts the result,
 * so a double that ignored the filter would let the capacity engine and the
 * planners "agree" on data neither would really see.
 */

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  executeRaw: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    $executeRaw: mocks.executeRaw,
  },
}));

vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacity: vi.fn(),
  getLodgeCapacityStatus: vi.fn(),
  getLodgePartnerSharedCapacityStatus: vi.fn(),
}));

import {
  getBedAllocationDashboard,
  parseBedAllocationDateRange,
} from "@/lib/admin-bed-allocation";
import { buildFirstFitBedAllocationPlan } from "@/lib/bed-allocation";
import { BED_ALLOCATION_PRIORITY_VOCABULARY } from "@/lib/bed-allocation-settings";
import { reconcileBedAllocationsForBookingWithLodgeLockHeld as reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { getLodgeHeldNights } from "@/lib/capacity";
import {
  buildWholeLodgeHeldNightPredicate,
  findBlockingWholeLodgeHolds,
  isBlockingWholeLodgeHold,
  toWholeLodgeHoldSpans,
  wholeLodgeHoldOccupiedBedNightsForPlanner,
} from "@/lib/exclusive-hold-occupancy";

const LODGE = "lodge-1";

// ---------------------------------------------------------------------------
// A small, GENERIC Prisma `where` interpreter.
//
// Generic on purpose: it understands the operator shapes (`in`, `not`, `isNot`,
// `lt`, `gt`, `some`, `OR`, `AND`, `NOT`) but knows nothing about which
// statuses hold capacity. The rule under test is whatever
// `capacityHoldingBookingFilter()` puts in the query at runtime, so these tests
// cannot quietly re-implement — and then agree with — a stale copy of it.
// ---------------------------------------------------------------------------
type AnyRow = Record<string, any>;

function matchesCondition(value: unknown, condition: any): boolean {
  if (condition === null) return value === null || value === undefined;
  if (condition instanceof Date) {
    return value instanceof Date && value.getTime() === condition.getTime();
  }
  if (typeof condition !== "object") return value === condition;

  if ("in" in condition) return (condition.in as unknown[]).includes(value);
  if ("notIn" in condition) return !(condition.notIn as unknown[]).includes(value);
  if ("not" in condition) return !matchesCondition(value, condition.not);
  // Relation filters: `{ isNot: null }` means "the relation is present".
  if ("isNot" in condition) return !matchesCondition(value, condition.isNot);
  if ("is" in condition) return matchesCondition(value, condition.is);
  if ("some" in condition) return Array.isArray(value) && value.length > 0;
  if ("lt" in condition) return (value as Date) < condition.lt;
  if ("lte" in condition) return (value as Date) <= condition.lte;
  if ("gt" in condition) return (value as Date) > condition.gt;
  if ("gte" in condition) return (value as Date) >= condition.gte;
  return true;
}

function matchesWhere(row: AnyRow, where: AnyRow | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") {
      return (condition as AnyRow[]).some((clause) => matchesWhere(row, clause));
    }
    if (key === "AND") {
      return (condition as AnyRow[]).every((clause) => matchesWhere(row, clause));
    }
    if (key === "NOT") return !matchesWhere(row, condition as AnyRow);
    return matchesCondition(row[key], condition);
  });
}

// ---------------------------------------------------------------------------
// Fixtures. One room, two active beds. Three board nights: 07-01, 07-02, 07-03.
// ---------------------------------------------------------------------------
const ROOM = {
  id: "room-a",
  name: "Kea",
  sortOrder: 1,
  active: true,
  notes: null,
  lodgeId: LODGE,
  beds: [1, 2].map((n) => ({
    id: `bed-a${n}`,
    roomId: "room-a",
    name: `A${n}`,
    sortOrder: n,
    active: true,
    bedType: "SINGLE",
    bunkGroup: null,
  })),
};

const RANGE = parseBedAllocationDateRange({ from: "2026-07-01", to: "2026-07-04" });

function guest(overrides: AnyRow = {}) {
  const stayStart = overrides.stayStart ?? parseDateOnly("2026-07-01");
  const stayEnd = overrides.stayEnd ?? parseDateOnly("2026-07-04");
  return {
    id: "guest-ord",
    bookingId: "booking-ord",
    firstName: "Ada",
    lastName: "Ordinary",
    ageTier: "ADULT",
    stayStart,
    stayEnd,
    nights: eachDateOnlyInRange(stayStart, stayEnd).map((stayDate) => ({
      stayDate,
    })),
    ...overrides,
  };
}

/** The ordinary booking the officer kept over the hold (ADR-001 decision 1). */
function ordinaryBooking(overrides: AnyRow = {}) {
  return {
    id: "booking-ord",
    status: "PAID",
    deletedAt: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    checkIn: parseDateOnly("2026-07-01"),
    checkOut: parseDateOnly("2026-07-04"),
    lodgeId: LODGE,
    requestedRoomId: null,
    parentBookingId: null,
    originBookingRequest: null,
    heldForBookingRequest: null,
    requestedRoom: null,
    adminCapacityHoldAt: null,
    wholeLodgeHold: false,
    member: { firstName: "Ada", lastName: "Ordinary", email: "a@x.nz" },
    guests: [guest()],
    ...overrides,
  };
}

/**
 * The school group holding the whole lodge for the nights of 07-01 and 07-02
 * (checkOut 07-03 is a departure morning — the half-open envelope).
 */
function holdBooking(overrides: AnyRow = {}) {
  return {
    id: "booking-hold",
    status: "PAID",
    deletedAt: null,
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    checkIn: parseDateOnly("2026-07-01"),
    checkOut: parseDateOnly("2026-07-03"),
    lodgeId: LODGE,
    requestedRoomId: null,
    parentBookingId: null,
    originBookingRequest: null,
    heldForBookingRequest: null,
    requestedRoom: null,
    adminCapacityHoldAt: null,
    wholeLodgeHold: true,
    member: { firstName: "Sam", lastName: "Teacher", email: "s@school.nz" },
    guests: [
      guest({
        id: "guest-hold",
        bookingId: "booking-hold",
        firstName: "Pat",
        lastName: "Student",
        stayStart: parseDateOnly("2026-07-01"),
        stayEnd: parseDateOnly("2026-07-03"),
      }),
    ],
    ...overrides,
  };
}

/**
 * A db double for the BOARD planner. `booking.findMany` answers from one shared
 * fixture set, filtered by the caller's own `where` — so the board's
 * bed-allocatable load and the #2317 blocking-hold load each see exactly what
 * their query asks for.
 */
function buildBoardDb(bookings: AnyRow[], rooms: AnyRow[] = [ROOM]) {
  return {
    $executeRaw: mocks.executeRaw,
    bedAllocationSettings: {
      findUnique: vi.fn().mockResolvedValue({
        autoAllocationEnabled: true,
        allocationPriorityOrder: [...BED_ALLOCATION_PRIORITY_VOCABULARY],
        updatedByMemberId: null,
        updatedAt: parseDateOnly("2026-06-30"),
      }),
    },
    lodgeRoom: { findMany: vi.fn().mockResolvedValue(rooms) },
    booking: {
      findMany: vi.fn(async ({ where }: AnyRow) =>
        bookings.filter((row) => matchesWhere(row, where)),
      ),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    bedAllocation: {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    hutLeaderAssignment: { findMany: vi.fn().mockResolvedValue([]) },
  } as never;
}

/** The same room stock, at a second lodge. */
const ROOM_LODGE_2 = {
  ...ROOM,
  id: "room-b",
  name: "Kaka",
  lodgeId: "lodge-2",
  beds: [1, 2].map((n) => ({
    ...ROOM.beds[n - 1],
    id: `bed-b${n}`,
    roomId: "room-b",
  })),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.executeRaw.mockResolvedValue(1);
});

// ---------------------------------------------------------------------------
describe("the blocking predicate is the capacity engine's, not a parallel list", () => {
  it("blocks only when the hold flag AND the capacity-holding rule both say so", () => {
    // Naturally capacity-holding statuses.
    for (const status of ["PAID", "CONFIRMED", "COMPLETED", "AWAITING_REVIEW"]) {
      expect(
        isBlockingWholeLodgeHold({ ...holdBooking(), status }),
      ).toBe(true);
    }
    // PENDING holds ONLY as a converted request (#1254); PAYMENT_PENDING ONLY
    // with an admin capacity hold (#1764) — both come straight from
    // bookingHoldsCapacity().
    expect(
      isBlockingWholeLodgeHold({ ...holdBooking(), status: "PENDING" }),
    ).toBe(false);
    expect(
      isBlockingWholeLodgeHold({
        ...holdBooking(),
        status: "PENDING",
        originBookingRequest: { id: "req-1" },
      }),
    ).toBe(true);
    expect(
      isBlockingWholeLodgeHold({ ...holdBooking(), status: "PAYMENT_PENDING" }),
    ).toBe(false);
    expect(
      isBlockingWholeLodgeHold({
        ...holdBooking(),
        status: "PAYMENT_PENDING",
        adminCapacityHoldAt: new Date("2026-06-02T00:00:00.000Z"),
      }),
    ).toBe(true);
  });

  it("never blocks without the hold flag, however the booking is paid for", () => {
    expect(
      isBlockingWholeLodgeHold({ ...holdBooking(), wholeLodgeHold: false }),
    ).toBe(false);
  });

  it("spans no nights for a hold with no stay window (capacity.ts's own guard)", () => {
    expect(
      toWholeLodgeHoldSpans([{ ...holdBooking(), checkIn: null, checkOut: null }]),
    ).toEqual([]);
  });

  it("covers checkIn..checkOut EXCLUSIVE, so a back-to-back arrival is free", () => {
    const [span] = toWholeLodgeHoldSpans([holdBooking()]);
    const isHeld = buildWholeLodgeHeldNightPredicate([span]);
    expect(isHeld(LODGE, "2026-06-30")).toBe(false);
    expect(isHeld(LODGE, "2026-07-01")).toBe(true);
    expect(isHeld(LODGE, "2026-07-02")).toBe(true);
    // checkOut is a departure MORNING, not a held night.
    expect(isHeld(LODGE, "2026-07-03")).toBe(false);
  });

  it("does not reach across lodges, and a lodge-less hold blocks conservatively", () => {
    const [span] = toWholeLodgeHoldSpans([holdBooking()]);
    const isHeld = buildWholeLodgeHeldNightPredicate([span]);
    expect(isHeld("lodge-2", "2026-07-01")).toBe(false);

    const [lodgeless] = toWholeLodgeHoldSpans([holdBooking({ lodgeId: null })]);
    const blocksAnywhere = buildWholeLodgeHeldNightPredicate([lodgeless]);
    expect(blocksAnywhere("lodge-2", "2026-07-01")).toBe(true);
  });

  it("re-applies the predicate over what the query returned", async () => {
    // A double that answers the query without honouring its filter must not be
    // able to fabricate a hold: findBlockingWholeLodgeHolds runs the in-memory
    // predicate over the rows it gets back.
    const db = {
      booking: {
        findMany: vi
          .fn()
          .mockResolvedValue([holdBooking({ status: "PAYMENT_PENDING" })]),
      },
    } as never;
    await expect(
      findBlockingWholeLodgeHolds({
        lodgeId: LODGE,
        from: RANGE.from,
        toExclusive: RANGE.to,
        db,
      }),
    ).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("the synthesised rows are unattributed and non-displaceable", () => {
  const nights = ["2026-07-01", "2026-07-02", "2026-07-03"].map(parseDateOnly);

  it("emits every active bed of the held lodge on every held night, with NO booking or guest id", () => {
    const rows = wholeLodgeHoldOccupiedBedNightsForPlanner(
      toWholeLodgeHoldSpans([holdBooking()]),
      [ROOM],
      nights,
    );

    expect(rows).toEqual([
      { bedId: "bed-a1", roomId: "room-a", stayDate: "2026-07-01", bookingId: null, bookingGuestId: null },
      { bedId: "bed-a2", roomId: "room-a", stayDate: "2026-07-01", bookingId: null, bookingGuestId: null },
      { bedId: "bed-a1", roomId: "room-a", stayDate: "2026-07-02", bookingId: null, bookingGuestId: null },
      { bedId: "bed-a2", roomId: "room-a", stayDate: "2026-07-02", bookingId: null, bookingGuestId: null },
    ]);
    // Nothing that could name the held group — this is the privacy property: a
    // hold can start life as a PUBLIC school request.
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain("Sam");
    expect(serialised).not.toContain("Pat");
    expect(serialised).not.toContain("booking-hold");
    // And no ageTier, so the planner reads the occupant as an adult (the
    // conservative #1768 room-mix reading) without learning anything.
    expect(rows.every((row) => !("ageTier" in row))).toBe(true);
  });

  it("skips inactive rooms and inactive beds — they are not in the bed stock", () => {
    const rows = wholeLodgeHoldOccupiedBedNightsForPlanner(
      toWholeLodgeHoldSpans([holdBooking()]),
      [
        { ...ROOM, beds: [{ ...ROOM.beds[0], active: false }, ROOM.beds[1]] },
        { ...ROOM, id: "room-b", active: false },
      ],
      nights,
    );
    expect(rows.map((row) => row.bedId)).toEqual(["bed-a2", "bed-a2"]);
  });

  it("de-duplicates overlapping holds down to one row per bed-night", () => {
    const rows = wholeLodgeHoldOccupiedBedNightsForPlanner(
      toWholeLodgeHoldSpans([holdBooking(), holdBooking({ id: "booking-hold-2" })]),
      [ROOM],
      nights,
    );
    expect(rows).toHaveLength(4);
  });

  it("emits nothing at all when no hold blocks", () => {
    expect(
      wholeLodgeHoldOccupiedBedNightsForPlanner(
        toWholeLodgeHoldSpans([holdBooking({ status: "PAYMENT_PENDING" })]),
        [ROOM],
        nights,
      ),
    ).toEqual([]);
  });

  /**
   * The sharp edge under "non-displaceable" (#2317 review, HIGH).
   *
   * "There is no row for the planner to move" protects the hold ROW. It does
   * NOT protect the hold's BED-NIGHT, because a real `BedAllocation` row can
   * legitimately sit on the same bed on the same night: ADR-001 decision 1
   * never refuses an overlapping booking, setting a hold prunes only the HELD
   * booking's own rows, and manual placement is deliberately left open. The
   * planner keys occupancy as `bedId:stayDate`, so the synthesised row and the
   * real row are ONE entry — and #1677 whole-booking displacement deletes that
   * entry when it evicts the real row.
   *
   * These tests run the LIFECYCLE planner shape (`prioritizeCapacityHolding`,
   * the only planner that displaces) over exactly that world.
   */
  describe("a co-located provisional row cannot be evicted into the hold's bed", () => {
    const HELD_NIGHT = "2026-07-01";
    const PLANNER_ROOM = {
      id: "room-a",
      name: "Kea",
      sortOrder: 1,
      active: true,
      lodgeId: LODGE,
      beds: [1, 2].map((n) => ({
        id: `bed-a${n}`,
        roomId: "room-a",
        name: `A${n}`,
        sortOrder: n,
        active: true,
      })),
    };

    /** The hold's synthesised occupancy: both beds, the one held night. */
    const heldBedNights = wholeLodgeHoldOccupiedBedNightsForPlanner(
      toWholeLodgeHoldSpans([
        holdBooking({ checkOut: parseDateOnly("2026-07-02") }),
      ]),
      [PLANNER_ROOM],
      [parseDateOnly(HELD_NIGHT)],
    );

    /**
     * A provisional booking's REAL row on one of the held beds — the officer
     * kept it (decision 1) or placed it by hand, and the hold prune never
     * touched it because it belongs to a different booking.
     */
    const provisionalRow = {
      bedId: "bed-a1",
      roomId: "room-a",
      stayDate: HELD_NIGHT,
      bookingId: "booking-prov",
      bookingGuestId: "guest-prov",
      ageTier: "ADULT" as const,
      approvedAt: null,
      bookingCreatedAt: new Date("2026-06-20T00:00:00.000Z"),
      holdsCapacity: false,
      stayExtendsBeyondWindow: false,
    };

    /** The capacity-holding booking with an unplaced adult on the held night. */
    const incoming = {
      id: "booking-ord",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      requestedRoomId: null,
      lodgeId: LODGE,
      holdsCapacity: true,
      guests: [
        {
          id: "guest-ord",
          bookingId: "booking-ord",
          ageTier: "ADULT" as const,
          stayStart: parseDateOnly(HELD_NIGHT),
          stayEnd: parseDateOnly("2026-07-02"),
        },
      ],
    };

    it("leaves the guest unallocated instead of displacing into a held bed", () => {
      const plan = buildFirstFitBedAllocationPlan({
        enabled: true,
        prioritizeCapacityHolding: true,
        rooms: [PLANNER_ROOM],
        bookings: [incoming],
        occupiedBedNights: [...heldBedNights, provisionalRow],
      });

      // Nothing placed: every bed of the lodge is the held group's that night.
      expect(plan.allocations).toEqual([]);
      // And in particular NOT on the bed the provisional booking shares with
      // the hold — the mutation this test exists for.
      expect(plan.allocations).not.toContainEqual(
        expect.objectContaining({ bedId: "bed-a1", stayDate: HELD_NIGHT }),
      );
      // No eviction: the provisional booking keeps its bed, and no
      // `provisional_displaced` audit will be written for a claim that never
      // happened.
      expect(plan.displacements).toBeUndefined();
      expect(plan.unallocatedGuestNights).toEqual([
        {
          bookingId: "booking-ord",
          bookingGuestId: "guest-ord",
          stayDate: HELD_NIGHT,
          reason: "NO_BED_AVAILABLE",
        },
      ]);
    });

    it("still displaces that same provisional row when the hold is NOT there", () => {
      // The control: without the synthesised occupancy the #1677 displacement
      // is exactly what should happen, so the test above is pinning the hold
      // and not merely a planner that never displaces.
      const plan = buildFirstFitBedAllocationPlan({
        enabled: true,
        prioritizeCapacityHolding: true,
        rooms: [PLANNER_ROOM],
        bookings: [incoming],
        occupiedBedNights: [
          provisionalRow,
          // Fill the other bed with a non-displaceable occupant so the only
          // way in is through the provisional row.
          { ...provisionalRow, bedId: "bed-a2", bookingId: null, bookingGuestId: null },
        ],
      });

      expect(plan.allocations).toEqual([
        expect.objectContaining({ bedId: "bed-a1", stayDate: HELD_NIGHT }),
      ]);
      expect(plan.displacements).toEqual([
        expect.objectContaining({
          type: "UNALLOCATE",
          bookingId: "booking-prov",
          stayDate: HELD_NIGHT,
        }),
      ]);
    });

    it("never sizes a whole-stay eviction off rows that share a held bed-night", () => {
      // Phase 2 arithmetic in its own right. Every bed of the room is the
      // hold's, and the provisional booking has a real row on BOTH of them.
      // Counting those rows as beds an eviction would free makes the room look
      // feasible; the party is then "placed" into beds that are still occupied,
      // so nothing is written, nothing is recorded as unallocated, and the
      // provisional booking is displaced for a placement that never happened.
      const plan = buildFirstFitBedAllocationPlan({
        enabled: true,
        prioritizeCapacityHolding: true,
        rooms: [PLANNER_ROOM],
        bookings: [
          {
            ...incoming,
            guests: [1, 2].map((n) => ({
              id: `guest-ord-${n}`,
              bookingId: "booking-ord",
              ageTier: "ADULT" as const,
              stayStart: parseDateOnly(HELD_NIGHT),
              stayEnd: parseDateOnly("2026-07-02"),
            })),
          },
        ],
        occupiedBedNights: [
          ...heldBedNights,
          provisionalRow,
          {
            ...provisionalRow,
            bedId: "bed-a2",
            bookingGuestId: "guest-prov-2",
          },
        ],
      });

      expect(plan.allocations).toEqual([]);
      expect(plan.displacements).toBeUndefined();
      // Both guest-nights are reported, not silently swallowed.
      expect(
        plan.unallocatedGuestNights.map((row) => row.bookingGuestId).sort(),
      ).toEqual(["guest-ord-1", "guest-ord-2"]);
    });

    it("does not count a co-located row as freeable when sizing a whole-stay eviction", () => {
      // The Phase-2 path (`planEvictionsForRoom`) reaches the same conclusion
      // by different arithmetic: crediting the provisional row against the
      // night's shortfall would make the room look feasible and place the
      // party into beds that are not free.
      const plan = buildFirstFitBedAllocationPlan({
        enabled: true,
        prioritizeCapacityHolding: true,
        rooms: [PLANNER_ROOM],
        bookings: [
          {
            ...incoming,
            guests: [
              incoming.guests[0],
              {
                id: "guest-ord-2",
                bookingId: "booking-ord",
                ageTier: "ADULT" as const,
                stayStart: parseDateOnly(HELD_NIGHT),
                stayEnd: parseDateOnly("2026-07-02"),
              },
            ],
          },
        ],
        occupiedBedNights: [...heldBedNights, provisionalRow],
      });

      expect(plan.allocations).toEqual([]);
      expect(plan.displacements).toBeUndefined();
    });

    it("keeps the held bed-night occupied when the co-located booking is evicted for a DIFFERENT night", () => {
      // The eviction here is entirely legitimate — it is driven by the free
      // night, where the provisional booking really is in the way. What must
      // not follow is that freeing that booking's rows also releases its
      // bed-night on the HELD night, which it shares with the hold. #1677
      // evicts a provisional stay whole, so this is the ordinary shape, not an
      // exotic one.
      const freeNight = "2026-07-02";
      const plan = buildFirstFitBedAllocationPlan({
        enabled: true,
        prioritizeCapacityHolding: true,
        rooms: [PLANNER_ROOM],
        bookings: [
          // Planned first: two adults on the free night, which the provisional
          // booking's row on bed-a1 blocks.
          {
            ...incoming,
            id: "booking-free-night",
            guests: [1, 2].map((n) => ({
              id: `guest-free-${n}`,
              bookingId: "booking-free-night",
              ageTier: "ADULT" as const,
              stayStart: parseDateOnly(freeNight),
              stayEnd: parseDateOnly("2026-07-03"),
            })),
          },
          // Planned second: one adult on the HELD night. The only bed that
          // could possibly be offered to them is the one the eviction above
          // touched.
          { ...incoming, createdAt: new Date("2026-06-02T00:00:00.000Z") },
        ],
        occupiedBedNights: [
          ...heldBedNights,
          provisionalRow,
          { ...provisionalRow, stayDate: freeNight },
        ],
      });

      // The free night is allocated (both beds) and the provisional booking is
      // displaced for it...
      expect(
        plan.allocations
          .filter((row) => row.stayDate === freeNight)
          .map((row) => row.bedId)
          .sort(),
      ).toEqual(["bed-a1", "bed-a2"]);
      expect(plan.displacements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ bookingId: "booking-prov" }),
        ]),
      );
      // ...but the held night gained nothing from it.
      expect(
        plan.allocations.filter((row) => row.stayDate === HELD_NIGHT),
      ).toEqual([]);
      expect(
        plan.unallocatedGuestNights.map((row) => ({
          stayDate: row.stayDate,
          reason: row.reason,
        })),
      ).toEqual([{ stayDate: HELD_NIGHT, reason: "NO_BED_AVAILABLE" }]);
    });
  });
});

// ---------------------------------------------------------------------------
describe("planner 1 — the admin board (getBedAllocationDashboard)", () => {
  it("without a hold, places the kept booking on every night", async () => {
    const dashboard = await getBedAllocationDashboard({
      range: RANGE,
      lodgeId: LODGE,
      db: buildBoardDb([ordinaryBooking()]),
    });

    expect(
      dashboard.suggestedAllocations.map((row) => row.stayDate).sort(),
    ).toEqual(["2026-07-01", "2026-07-02", "2026-07-03"]);
    expect(dashboard.suggestedUnallocatedGuestNights).toEqual([]);
  });

  it("with a hold, refuses the held nights as NO_BED_AVAILABLE and keeps the free night", async () => {
    const dashboard = await getBedAllocationDashboard({
      range: RANGE,
      lodgeId: LODGE,
      db: buildBoardDb([ordinaryBooking(), holdBooking()]),
    });

    // Only the night AFTER the hold ends is still placeable.
    expect(dashboard.suggestedAllocations.map((row) => row.stayDate)).toEqual([
      "2026-07-03",
    ]);
    expect(
      dashboard.suggestedUnallocatedGuestNights.map((row) => ({
        stayDate: row.stayDate,
        reason: row.reason,
      })),
    ).toEqual([
      { stayDate: "2026-07-01", reason: "NO_BED_AVAILABLE" },
      { stayDate: "2026-07-02", reason: "NO_BED_AVAILABLE" },
    ]);
    // The board preview never displaces anything, and there is nothing here it
    // COULD displace: the hold owns no row for the planner to move.
    expect(dashboard.suggestedAllocations).not.toContainEqual(
      expect.objectContaining({ bookingId: "booking-hold" }),
    );
  });

  it("does not block for a hold flag on a booking that stopped holding capacity", async () => {
    // The stale-flag case: the capacity engine would admit a new booking on
    // these nights, so the planner must place on them too. This is the
    // direction that keeps planner and engine in step.
    const dashboard = await getBedAllocationDashboard({
      range: RANGE,
      lodgeId: LODGE,
      db: buildBoardDb([
        ordinaryBooking(),
        holdBooking({ status: "PAYMENT_PENDING" }),
      ]),
    });

    expect(
      dashboard.suggestedAllocations.map((row) => row.stayDate).sort(),
    ).toEqual(["2026-07-01", "2026-07-02", "2026-07-03"]);
  });

  it("does not block another lodge's board", async () => {
    const dashboard = await getBedAllocationDashboard({
      range: RANGE,
      lodgeId: "lodge-2",
      db: buildBoardDb(
        [
          ordinaryBooking({ lodgeId: "lodge-2" }),
          // Scoped OUT by the query's lodge filter, exactly as the capacity
          // engine's own hold query would scope it out.
          holdBooking(),
        ],
        [ROOM_LODGE_2],
      ),
    });

    expect(dashboard.suggestedAllocations).toHaveLength(3);
  });

  it("on a CLUB-WIDE board, a hold takes its own lodge's beds and only those", async () => {
    const dashboard = await getBedAllocationDashboard({
      range: RANGE,
      db: buildBoardDb(
        [
          ordinaryBooking({ id: "booking-l1" }),
          ordinaryBooking({
            id: "booking-l2",
            lodgeId: "lodge-2",
            guests: [guest({ id: "guest-l2", bookingId: "booking-l2" })],
          }),
          holdBooking(),
        ],
        [ROOM, ROOM_LODGE_2],
      ),
    });

    const byBooking = new Map<string, string[]>();
    for (const row of dashboard.suggestedAllocations) {
      byBooking.set(row.bookingId, [
        ...(byBooking.get(row.bookingId) ?? []),
        row.stayDate,
      ]);
    }
    // Lodge 1 is held on two of the three nights; lodge 2 is untouched.
    expect(byBooking.get("booking-l1")).toEqual(["2026-07-03"]);
    expect(byBooking.get("booking-l2")).toHaveLength(3);
    expect(
      dashboard.suggestedUnallocatedGuestNights.map((row) => row.bookingId),
    ).toEqual(["booking-l1", "booking-l1"]);
  });

  it("frees the beds again the moment the hold is cleared (hold -> ordinary confirmed booking)", async () => {
    // The conversion the officer actually performs: clear the hold, the group
    // becomes an ordinary confirmed booking and is planned onto beds like
    // anyone else, and its nights stop blocking the booking beside it.
    const converted = holdBooking({ wholeLodgeHold: false, status: "CONFIRMED" });
    const dashboard = await getBedAllocationDashboard({
      range: RANGE,
      lodgeId: LODGE,
      db: buildBoardDb([ordinaryBooking(), converted]),
    });

    expect(dashboard.exclusiveHolds).toEqual([]);
    expect(dashboard.suggestedUnallocatedGuestNights).toEqual([]);
    // Both parties are now placed by name, on the two beds.
    const byBooking = new Map<string, string[]>();
    for (const row of dashboard.suggestedAllocations) {
      byBooking.set(row.bookingId, [
        ...(byBooking.get(row.bookingId) ?? []),
        row.stayDate,
      ]);
    }
    expect(byBooking.get("booking-ord")).toHaveLength(3);
    expect(byBooking.get("booking-hold")).toHaveLength(2);
  });

  it("still reports the hold as an exclusive-hold banner, not as a placement", async () => {
    const dashboard = await getBedAllocationDashboard({
      range: RANGE,
      lodgeId: LODGE,
      db: buildBoardDb([ordinaryBooking(), holdBooking()]),
    });

    expect(dashboard.exclusiveHolds).toEqual([
      expect.objectContaining({
        bookingId: "booking-hold",
        nights: ["2026-07-01", "2026-07-02"],
      }),
    ]);
  });
});

// ---------------------------------------------------------------------------
describe("planner 2 — the lifecycle auto-allocator", () => {
  function buildLifecycleDb(bookings: AnyRow[], overrides: AnyRow = {}) {
    const reconciled = bookings.find((row) => row.id === "booking-ord");
    const db: AnyRow = {
      clubModuleSettings: {
        findUnique: vi.fn().mockResolvedValue({ bedAllocation: true }),
      },
      booking: {
        findUnique: vi.fn().mockResolvedValue(reconciled),
        findMany: vi.fn(async ({ where, select }: AnyRow) => {
          const matched = bookings.filter((row) => matchesWhere(row, where));
          // The unallocatable write-time re-check asks for a narrow scalar
          // projection; give it exactly that shape.
          if (!select?.guests && !select?.checkIn) {
            return matched.map((row) => ({
              id: row.id,
              status: row.status,
              deletedAt: row.deletedAt ?? null,
              wholeLodgeHold: row.wholeLodgeHold,
            }));
          }
          return matched;
        }),
      },
      bedAllocation: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(null),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn(async ({ data }: AnyRow) => ({ count: data.length })),
      },
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({
          autoAllocationEnabled: true,
          allocationPriorityOrder: [...BED_ALLOCATION_PRIORITY_VOCABULARY],
        }),
      },
      lodgeRoom: { findMany: vi.fn().mockResolvedValue([ROOM]) },
      hutLeaderAssignment: { findMany: vi.fn().mockResolvedValue([]) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      $executeRaw: mocks.executeRaw,
      ...overrides,
    };
    db.$transaction = vi.fn((cb: (client: unknown) => unknown) => cb(db));
    return db;
  }

  function writtenNights(db: AnyRow): string[] {
    return db.bedAllocation.createMany.mock.calls
      .flatMap((call: AnyRow[]) => (call[0] as AnyRow).data as AnyRow[])
      .map((row: AnyRow) => formatDateOnly(row.stayDate))
      .sort();
  }

  it("without a hold, writes a bed for every night of the reconciled booking", async () => {
    const db = buildLifecycleDb([ordinaryBooking()]);
    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-ord",
      db: db as never,
    });

    expect(result.createdCount).toBe(3);
    expect(writtenNights(db)).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
    ]);
  });

  it("with a hold, writes only the night the hold does not take", async () => {
    const db = buildLifecycleDb([ordinaryBooking(), holdBooking()]);
    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-ord",
      db: db as never,
    });

    expect(writtenNights(db)).toEqual(["2026-07-03"]);
    expect(result.createdCount).toBe(1);
  });

  it("never writes a row FOR the held booking, and never displaces the hold", async () => {
    const db = buildLifecycleDb([ordinaryBooking(), holdBooking()]);
    await reconcileBedAllocationsForBooking({
      bookingId: "booking-ord",
      db: db as never,
    });

    const written = db.bedAllocation.createMany.mock.calls.flatMap(
      (call: AnyRow[]) => (call[0] as AnyRow).data as AnyRow[],
    );
    expect(written.every((row: AnyRow) => row.bookingId === "booking-ord")).toBe(
      true,
    );
    // Displacement is how the planner takes a bed off somebody else (#1387).
    // A hold has no row to take, so nothing is moved and nothing is deleted:
    // the occupancy is non-displaceable by construction.
    expect(db.bedAllocation.updateMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("takes no notice of a hold flag on a booking that stopped holding capacity", async () => {
    const db = buildLifecycleDb([
      ordinaryBooking(),
      holdBooking({ status: "PAYMENT_PENDING" }),
    ]);
    await reconcileBedAllocationsForBooking({
      bookingId: "booking-ord",
      db: db as never,
    });

    expect(writtenNights(db)).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
    ]);
  });

  it("the PLAN itself avoids held nights, not merely the write", async () => {
    // The inverse race, and the test that pins the planner feed on its own: the
    // hold is live when the plan is built and gone by the time the write
    // re-checks. Only the synthesised occupancy can keep the guest off those
    // beds here — the write-time re-filter finds nothing to drop.
    let planned = false;
    const db = buildLifecycleDb([ordinaryBooking()]);
    const withHold = [ordinaryBooking(), holdBooking()];
    db.booking.findMany = vi.fn(async ({ where, select }: AnyRow) => {
      if (select?.checkIn && !select?.guests) {
        const rows = planned ? [ordinaryBooking()] : withHold;
        planned = true;
        return rows.filter((row) => matchesWhere(row, where));
      }
      const matched = [ordinaryBooking()].filter((row) =>
        matchesWhere(row, where),
      );
      if (!select?.guests) {
        return matched.map((row) => ({
          id: row.id,
          status: row.status,
          deletedAt: row.deletedAt ?? null,
          wholeLodgeHold: row.wholeLodgeHold,
        }));
      }
      return matched;
    });

    await reconcileBedAllocationsForBooking({
      bookingId: "booking-ord",
      db: db as never,
    });

    expect(writtenNights(db)).toEqual(["2026-07-03"]);
  });

  // -------------------------------------------------------------------------
  // A provisional booking with a REAL row on a bed the hold also claims. This
  // is not an edge case: ADR-001 decision 1 never refuses the overlapping
  // booking, setting a hold prunes only the HELD booking's own rows, and manual
  // placement is deliberately left open.
  // -------------------------------------------------------------------------
  /** An existing `BedAllocation` row for a displaceable provisional booking. */
  function provisionalAllocation(overrides: AnyRow = {}) {
    return {
      bedId: "bed-a1",
      roomId: "room-a",
      bookingId: "booking-prov",
      bookingGuestId: "guest-prov",
      stayDate: parseDateOnly("2026-07-01"),
      approvedAt: null,
      bookingGuest: { ageTier: "ADULT" },
      booking: {
        status: "PENDING",
        createdAt: new Date("2026-06-20T00:00:00.000Z"),
        checkIn: parseDateOnly("2026-07-01"),
        checkOut: parseDateOnly("2026-07-02"),
        originBookingRequest: null,
        adminCapacityHoldAt: null,
      },
      ...overrides,
    };
  }

  /** The same booking as the planner's `bookings` load sees it. */
  function provisionalBooking(overrides: AnyRow = {}) {
    return ordinaryBooking({
      id: "booking-prov",
      status: "PENDING",
      createdAt: new Date("2026-06-20T00:00:00.000Z"),
      checkIn: parseDateOnly("2026-07-01"),
      checkOut: parseDateOnly("2026-07-02"),
      member: { firstName: "Kit", lastName: "Provisional", email: "k@x.nz" },
      guests: [
        guest({
          id: "guest-prov",
          bookingId: "booking-prov",
          stayStart: parseDateOnly("2026-07-01"),
          stayEnd: parseDateOnly("2026-07-02"),
        }),
      ],
      ...overrides,
    });
  }

  it("does not displace a provisional row off a held bed to place a capacity-holding adult", async () => {
    // The hold takes both beds on 07-01 and 07-02; the provisional booking sits
    // on one of them. Displacing it would free NOTHING — the hold still has the
    // bed — so the guest must stay unallocated, the provisional booking must
    // keep its row, and no `provisional_displaced` audit may be written for a
    // claim that never happened.
    const db = buildLifecycleDb([
      ordinaryBooking(),
      holdBooking(),
      provisionalBooking(),
    ]);
    db.bedAllocation.findMany = vi.fn().mockResolvedValue([
      provisionalAllocation(),
    ]);

    await reconcileBedAllocationsForBooking({
      bookingId: "booking-ord",
      db: db as never,
    });

    expect(writtenNights(db)).toEqual(["2026-07-03"]);
    expect(db.bedAllocation.updateMany).not.toHaveBeenCalled();
    expect(db.bedAllocation.deleteMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ bookingGuestId: "guest-prov" }),
      }),
    );
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("does not apply a displacement whose freed bed-night the re-checked payload no longer claims", async () => {
    // A hold that commits between the plan and the write, covering only PART of
    // the reconciled stay — the normal shape, since a hold and a stay rarely
    // line up. The planner displaced a provisional booking to take 07-02; the
    // re-filter then drops that very row. Applying the displacement anyway
    // would delete the provisional booking's bed for an allocation that is
    // never written, and audit it as though a capacity-holding booking had
    // claimed the bed.
    const stay = {
      checkIn: parseDateOnly("2026-07-01"),
      checkOut: parseDateOnly("2026-07-03"),
    };
    const twoAdults = ordinaryBooking({
      ...stay,
      guests: [1, 2].map((n) =>
        guest({
          id: `guest-ord-${n}`,
          stayStart: stay.checkIn,
          stayEnd: stay.checkOut,
        }),
      ),
    });
    // Blocks the second night only, on one of the two beds.
    const blocker = provisionalBooking({
      checkIn: parseDateOnly("2026-07-02"),
      checkOut: parseDateOnly("2026-07-03"),
      guests: [
        guest({
          id: "guest-prov",
          bookingId: "booking-prov",
          stayStart: parseDateOnly("2026-07-02"),
          stayEnd: parseDateOnly("2026-07-03"),
        }),
      ],
    });
    // The hold arrives late and covers 07-02 alone.
    const lateHold = holdBooking({
      checkIn: parseDateOnly("2026-07-02"),
      checkOut: parseDateOnly("2026-07-03"),
    });

    const db = buildLifecycleDb([twoAdults, blocker]);
    db.bedAllocation.findMany = vi.fn().mockResolvedValue([
      provisionalAllocation({
        stayDate: parseDateOnly("2026-07-02"),
        booking: {
          ...provisionalAllocation().booking,
          checkIn: parseDateOnly("2026-07-02"),
          checkOut: parseDateOnly("2026-07-03"),
        },
      }),
    ]);
    let holdVisible = false;
    db.booking.findMany = vi.fn(async ({ where, select }: AnyRow) => {
      if (select?.checkIn && !select?.guests) {
        // Invisible while planning, live by the time the write re-checks.
        const rows = holdVisible ? [lateHold] : [];
        holdVisible = true;
        return rows.filter((row) => matchesWhere(row, where));
      }
      const matched = [twoAdults, blocker].filter((row) =>
        matchesWhere(row, where),
      );
      if (!select?.guests) {
        return matched.map((row) => ({
          id: row.id,
          status: row.status,
          deletedAt: row.deletedAt ?? null,
          wholeLodgeHold: row.wholeLodgeHold,
        }));
      }
      return matched;
    });

    await reconcileBedAllocationsForBooking({
      bookingId: "booking-ord",
      db: db as never,
    });

    // The free night is still written for both guests...
    expect(writtenNights(db)).toEqual(["2026-07-01", "2026-07-01"]);
    // ...and the provisional booking keeps the bed it was going to lose.
    expect(db.bedAllocation.deleteMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ bookingGuestId: "guest-prov" }),
      }),
    );
    expect(db.bedAllocation.updateMany).not.toHaveBeenCalled();
    // No audit entry claiming a displacement that never happened.
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("still applies a displacement whose freed bed-night the payload DOES claim", async () => {
    // The control for the filter above: with no late hold, the same plan
    // displaces the provisional booking and audits it, exactly as #1387 says.
    const stay = {
      checkIn: parseDateOnly("2026-07-01"),
      checkOut: parseDateOnly("2026-07-03"),
    };
    const twoAdults = ordinaryBooking({
      ...stay,
      guests: [1, 2].map((n) =>
        guest({
          id: `guest-ord-${n}`,
          stayStart: stay.checkIn,
          stayEnd: stay.checkOut,
        }),
      ),
    });
    const blocker = provisionalBooking({
      checkIn: parseDateOnly("2026-07-02"),
      checkOut: parseDateOnly("2026-07-03"),
      guests: [
        guest({
          id: "guest-prov",
          bookingId: "booking-prov",
          stayStart: parseDateOnly("2026-07-02"),
          stayEnd: parseDateOnly("2026-07-03"),
        }),
      ],
    });
    const db = buildLifecycleDb([twoAdults, blocker]);
    db.bedAllocation.findMany = vi.fn().mockResolvedValue([
      provisionalAllocation({
        stayDate: parseDateOnly("2026-07-02"),
        booking: {
          ...provisionalAllocation().booking,
          checkIn: parseDateOnly("2026-07-02"),
          checkOut: parseDateOnly("2026-07-03"),
        },
      }),
    ]);

    await reconcileBedAllocationsForBooking({
      bookingId: "booking-ord",
      db: db as never,
    });

    expect(writtenNights(db)).toEqual([
      "2026-07-01",
      "2026-07-01",
      "2026-07-02",
      "2026-07-02",
    ]);
    expect(db.bedAllocation.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ bookingGuestId: "guest-prov" }),
      }),
    );
    expect(db.auditLog.create).toHaveBeenCalled();
  });

  it("write-time re-check: a hold committing after the plan is built writes nothing on its nights", async () => {
    // The plan is built against a lodge with no hold; the hold commits before
    // the createMany. `dropAllocationRowsForUnallocatableBookings` cannot see
    // this — the booking being placed is still perfectly allocatable — so the
    // #2317 re-filter is the only thing standing between the suggestion and a
    // guest in a school group's bed.
    let holdVisible = false;
    const db = buildLifecycleDb([ordinaryBooking()]);
    const bookings = [ordinaryBooking(), holdBooking()];
    db.booking.findMany = vi.fn(async ({ where, select }: AnyRow) => {
      if (select?.checkIn && !select?.guests) {
        // The blocking-hold query: invisible on the planner's read, live by
        // the time the write re-checks.
        const rows = holdVisible ? bookings : [ordinaryBooking()];
        holdVisible = true;
        return rows.filter((row) => matchesWhere(row, where));
      }
      const matched = [ordinaryBooking()].filter((row) =>
        matchesWhere(row, where),
      );
      if (!select?.guests) {
        return matched.map((row) => ({
          id: row.id,
          status: row.status,
          deletedAt: row.deletedAt ?? null,
          wholeLodgeHold: row.wholeLodgeHold,
        }));
      }
      return matched;
    });

    await reconcileBedAllocationsForBooking({
      bookingId: "booking-ord",
      db: db as never,
    });

    expect(writtenNights(db)).toEqual(["2026-07-03"]);
  });
});

// ---------------------------------------------------------------------------
describe("the planners and the capacity engine agree about which nights are held", () => {
  /**
   * THE invariant. Both sides are given the same fixture through the same
   * filter-honouring double; `getLodgeHeldNights` is the capacity engine's own
   * held-night report, and the board's refused nights are what an officer sees.
   * They must name the same nights — the planner may never under-report a night
   * the engine considers taken.
   */
  async function heldNightsPerEngine(bookings: AnyRow[]): Promise<string[]> {
    return getLodgeHeldNights(
      LODGE,
      RANGE.from,
      RANGE.to,
      buildBoardDb(bookings) as never,
    );
  }

  async function refusedNightsPerBoard(bookings: AnyRow[]): Promise<string[]> {
    const dashboard = await getBedAllocationDashboard({
      range: RANGE,
      lodgeId: LODGE,
      db: buildBoardDb(bookings),
    });
    return dashboard.suggestedUnallocatedGuestNights
      .map((row) => row.stayDate)
      .sort();
  }

  it("agrees when a hold blocks", async () => {
    const bookings = [ordinaryBooking(), holdBooking()];
    expect(await heldNightsPerEngine(bookings)).toEqual([
      "2026-07-01",
      "2026-07-02",
    ]);
    expect(await refusedNightsPerBoard(bookings)).toEqual([
      "2026-07-01",
      "2026-07-02",
    ]);
  });

  it("agrees when the hold flag is stale — neither side treats the nights as taken", async () => {
    const bookings = [
      ordinaryBooking(),
      holdBooking({ status: "PAYMENT_PENDING" }),
    ];
    expect(await heldNightsPerEngine(bookings)).toEqual([]);
    expect(await refusedNightsPerBoard(bookings)).toEqual([]);
  });

  it("agrees on the departure morning — held nights stop at checkOut on both sides", async () => {
    const bookings = [
      ordinaryBooking(),
      holdBooking({ checkOut: parseDateOnly("2026-07-02") }),
    ];
    expect(await heldNightsPerEngine(bookings)).toEqual(["2026-07-01"]);
    expect(await refusedNightsPerBoard(bookings)).toEqual(["2026-07-01"]);
  });
});
