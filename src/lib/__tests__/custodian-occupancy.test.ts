import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDateOnly } from "@/lib/date-only";

/**
 * Custodian occupancy — the read-side module itself (#2286).
 *
 * These are the primitives every consumer shares: the night predicates, the
 * per-night count index, the planner rows, and the guard that refuses a
 * placement. Getting the INCLUSIVE endDate semantics wrong here would be wrong
 * everywhere at once, so they are pinned directly rather than only through the
 * engines.
 */

const mocks = vi.hoisted(() => ({
  hutLeaderAssignmentFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    hutLeaderAssignment: { findMany: mocks.hutLeaderAssignmentFindMany },
  },
}));

import {
  assertBedNightsFreeOfCustodianHold,
  buildCustodianNightIndex,
  custodianHeldBedNightKeys,
  custodianHeldNightsForBed,
  custodianOccupiedBedNightsForPlanner,
  CustodianHoldConflictError,
  findCustodianBedHolds,
  holdCoversNight,
  holdOverlapsRange,
  isCustodianHeldBedNight,
  isMinorAgeTier,
  type CustodianBedHold,
} from "@/lib/custodian-occupancy";

function hold(overrides: Partial<CustodianBedHold> = {}): CustodianBedHold {
  return {
    assignmentId: "assignment-1",
    memberId: "member-1",
    memberName: "Sam Ranger",
    memberIsMinor: false,
    lodgeId: "lodge-a",
    bedId: "bed-1",
    bedName: "A1",
    roomId: "room-1",
    roomName: "Kea",
    startDate: "2026-07-02",
    endDate: "2026-07-04",
    ...overrides,
  };
}

const nights = (...dates: string[]) => dates.map(parseDateOnly);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hutLeaderAssignmentFindMany.mockResolvedValue([]);
});

describe("night semantics", () => {
  it("covers the endDate night itself and nothing after it", () => {
    const h = hold({ startDate: "2026-07-02", endDate: "2026-07-04" });
    expect(holdCoversNight(h, "2026-07-01")).toBe(false);
    expect(holdCoversNight(h, "2026-07-02")).toBe(true);
    expect(holdCoversNight(h, "2026-07-04")).toBe(true);
    expect(holdCoversNight(h, "2026-07-05")).toBe(false);
  });

  it("overlaps a half-open [from, toExclusive) window on the inclusive endDate", () => {
    const h = hold({ startDate: "2026-07-02", endDate: "2026-07-04" });
    // Window ending exclusive-on-the-startDate does not overlap.
    expect(holdOverlapsRange(h, "2026-07-01", "2026-07-02")).toBe(false);
    // A window that is only the endDate night DOES overlap.
    expect(holdOverlapsRange(h, "2026-07-04", "2026-07-05")).toBe(true);
    // A window starting the day after does not.
    expect(holdOverlapsRange(h, "2026-07-05", "2026-07-06")).toBe(false);
  });
});

describe("buildCustodianNightIndex", () => {
  it("is a per-night COUNT, so two custodians on a handover night make two", () => {
    const index = buildCustodianNightIndex(
      [
        hold({ bedId: "bed-1", startDate: "2026-07-01", endDate: "2026-07-02" }),
        hold({ bedId: "bed-2", startDate: "2026-07-02", endDate: "2026-07-03" }),
      ],
      nights("2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"),
    );
    expect(index.get("2026-07-01")).toBe(1);
    expect(index.get("2026-07-02")).toBe(2);
    expect(index.get("2026-07-03")).toBe(1);
    expect(index.has("2026-07-04")).toBe(false);
  });

  it("returns an empty index for no holds, so consumers can short-circuit", () => {
    expect(buildCustodianNightIndex([], nights("2026-07-01")).size).toBe(0);
  });
});

describe("planner rows", () => {
  it("emits #1768 unknown-occupant rows — null booking AND null guest, never evictable", () => {
    const rows = custodianOccupiedBedNightsForPlanner(
      [hold({ startDate: "2026-07-02", endDate: "2026-07-03" })],
      nights("2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"),
    );
    expect(rows).toEqual([
      {
        bedId: "bed-1",
        roomId: "room-1",
        stayDate: "2026-07-02",
        bookingId: null,
        bookingGuestId: null,
      },
      {
        bedId: "bed-1",
        roomId: "room-1",
        stayDate: "2026-07-03",
        bookingId: null,
        bookingGuestId: null,
      },
    ]);
    // No ageTier: the planner reads a tierless unknown occupant as an adult
    // (conservative for room mix) without the custodian's real tier leaking in.
    for (const row of rows) {
      expect(row).not.toHaveProperty("ageTier");
    }
  });

  it("keys every held bed-night for the pre-write re-filter", () => {
    const keys = custodianHeldBedNightKeys(
      [hold({ bedId: "bed-9", startDate: "2026-07-02", endDate: "2026-07-02" })],
      nights("2026-07-01", "2026-07-02"),
    );
    expect([...keys]).toEqual(["bed-9:2026-07-02"]);
  });
});

describe("findCustodianBedHolds", () => {
  it("drops a row whose bed relation is missing rather than asserting it away", async () => {
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([
      {
        id: "a1",
        memberId: "m1",
        lodgeId: "lodge-a",
        bedId: null,
        startDate: parseDateOnly("2026-07-02"),
        endDate: parseDateOnly("2026-07-03"),
        member: { firstName: "A", lastName: "B", ageTier: "ADULT" },
        bed: null,
      },
    ]);
    const holds = await findCustodianBedHolds({
      from: parseDateOnly("2026-07-01"),
      toExclusive: parseDateOnly("2026-07-10"),
    });
    expect(holds).toEqual([]);
  });

  it("marks a minor-age custodian, so the display contract can refuse to name them", async () => {
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([
      {
        id: "a1",
        memberId: "m1",
        lodgeId: "lodge-a",
        bedId: "bed-1",
        startDate: parseDateOnly("2026-07-02"),
        endDate: parseDateOnly("2026-07-03"),
        member: { firstName: "Kid", lastName: "Ranger", ageTier: "YOUTH" },
        bed: {
          id: "bed-1",
          name: "A1",
          roomId: "room-1",
          room: { id: "room-1", name: "Kea" },
        },
      },
    ]);
    const [found] = await findCustodianBedHolds({
      from: parseDateOnly("2026-07-01"),
      toExclusive: parseDateOnly("2026-07-10"),
    });
    expect(found.memberIsMinor).toBe(true);
  });

  it("treats INFANT, CHILD and YOUTH as minors and ADULT as not", () => {
    expect(isMinorAgeTier("INFANT")).toBe(true);
    expect(isMinorAgeTier("CHILD")).toBe(true);
    expect(isMinorAgeTier("YOUTH")).toBe(true);
    expect(isMinorAgeTier("ADULT")).toBe(false);
    expect(isMinorAgeTier(null)).toBe(false);
  });
});

describe("the placement guard", () => {
  function seedHold(startDate: string, endDate: string, assignmentId = "a1") {
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([
      {
        id: assignmentId,
        memberId: "m1",
        lodgeId: "lodge-a",
        bedId: "bed-1",
        startDate: parseDateOnly(startDate),
        endDate: parseDateOnly(endDate),
        member: { firstName: "Sam", lastName: "Ranger", ageTier: "ADULT" },
        bed: {
          id: "bed-1",
          name: "A1",
          roomId: "room-1",
          room: { id: "room-1", name: "Kea" },
        },
      },
    ]);
  }

  it("refuses a held night and names the dates in the message", async () => {
    seedHold("2026-07-02", "2026-07-03");
    await expect(
      assertBedNightsFreeOfCustodianHold({
        bedId: "bed-1",
        stayDates: nights("2026-07-02", "2026-07-03"),
      }),
    ).rejects.toThrow(CustodianHoldConflictError);

    await expect(
      assertBedNightsFreeOfCustodianHold({
        bedId: "bed-1",
        stayDates: nights("2026-07-03"),
      }),
    ).rejects.toThrow(/2026-07-03/);
  });

  it("allows a night outside the hold", async () => {
    seedHold("2026-07-02", "2026-07-03");
    await expect(
      assertBedNightsFreeOfCustodianHold({
        bedId: "bed-1",
        stayDates: nights("2026-07-04"),
      }),
    ).resolves.toBeUndefined();
  });

  it("ignores an assignment's OWN hold when it is being edited", async () => {
    seedHold("2026-07-02", "2026-07-03", "being-edited");
    await expect(
      custodianHeldNightsForBed({
        bedId: "bed-1",
        stayDates: nights("2026-07-02"),
        excludeAssignmentId: "being-edited",
      }),
    ).resolves.toEqual([]);
  });

  it("uses the MIN of an UNSORTED night list as the window's lower bound", async () => {
    // #2286 review L2. The bulk and range paths legitimately pass a
    // non-contiguous (#713) and not-necessarily-sorted night set. Taking
    // `stayDates[0]` as the lower bound meant a window that started AFTER some
    // of the nights being asked about, so a hold covering the earlier ones read
    // as absent — and the placement guard let the write through.
    seedHold("2026-07-02", "2026-07-02");

    await expect(
      custodianHeldNightsForBed({
        bedId: "bed-1",
        // Deliberately out of order: the latest night first.
        stayDates: [
          parseDateOnly("2026-07-09"),
          parseDateOnly("2026-07-02"),
        ],
      }),
    ).resolves.toEqual(["2026-07-02"]);

    const where = mocks.hutLeaderAssignmentFindMany.mock.calls[0][0].where;
    // The query window starts at the EARLIEST night, not the first one listed.
    expect(where.endDate.gte).toEqual(parseDateOnly("2026-07-02"));
    expect(where.startDate.lt).toEqual(parseDateOnly("2026-07-10"));
  });

  it("keys nights on the UTC date-only grid, not the club time zone", async () => {
    // #2286 review L3: ONE convention. A caller that hands over a Date carrying
    // a time component (or a local-midnight Date on a non-UTC host) must be
    // truncated the same way the rest of the capacity domain truncates, so the
    // keys compared on both sides of the guard come from the same grid.
    seedHold("2026-07-02", "2026-07-02");

    await expect(
      custodianHeldNightsForBed({
        bedId: "bed-1",
        stayDates: [new Date("2026-07-02T13:45:00.000Z")],
      }),
    ).resolves.toEqual(["2026-07-02"]);

    const where = mocks.hutLeaderAssignmentFindMany.mock.calls[0][0].where;
    expect(where.endDate.gte).toEqual(parseDateOnly("2026-07-02"));
  });
});

/**
 * THE whole-lodge-hold exclusion predicate (#2698, INV-CAP-035). The planner
 * expansion and the custodian write path's ordering check both subtract
 * through this one function, so its boundaries are the rule's boundaries.
 */
describe("isCustodianHeldBedNight", () => {
  const holds = [hold()];

  it("covers the endDate night itself — the range is inclusive-inclusive", () => {
    expect(isCustodianHeldBedNight(holds, "bed-1", "2026-07-04")).toBe(true);
    expect(isCustodianHeldBedNight(holds, "bed-1", "2026-07-05")).toBe(false);
  });

  it("covers the startDate night and nothing before it", () => {
    expect(isCustodianHeldBedNight(holds, "bed-1", "2026-07-02")).toBe(true);
    expect(isCustodianHeldBedNight(holds, "bed-1", "2026-07-01")).toBe(false);
  });

  it("is per BED, so another bed's hold excludes nothing", () => {
    expect(isCustodianHeldBedNight(holds, "bed-2", "2026-07-03")).toBe(false);
  });

  it("answers false for an empty hold set", () => {
    expect(isCustodianHeldBedNight([], "bed-1", "2026-07-03")).toBe(false);
  });

  it("takes the union of several holds on one bed", () => {
    const handover = [
      hold({ startDate: "2026-07-02", endDate: "2026-07-02" }),
      hold({
        assignmentId: "assignment-2",
        startDate: "2026-07-06",
        endDate: "2026-07-07",
      }),
    ];
    expect(isCustodianHeldBedNight(handover, "bed-1", "2026-07-02")).toBe(true);
    expect(isCustodianHeldBedNight(handover, "bed-1", "2026-07-04")).toBe(false);
    expect(isCustodianHeldBedNight(handover, "bed-1", "2026-07-07")).toBe(true);
  });
});
