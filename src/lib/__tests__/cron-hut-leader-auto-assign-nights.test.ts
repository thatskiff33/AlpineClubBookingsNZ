import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The auto-assign cron writes the NIGHTS a leader stays (#3817): from the first
 * to the last night of the run of consecutive nights containing the date it is
 * deciding, so the row ends on `checkOut - 1`, never on the check-out day, and a
 * split stay gets one row per run.
 *
 * The booking double applies the job's envelope filter (`stayStart <= day <
 * stayEnd`) per day, so a split stay's gap night reaches the job exactly the way
 * the database would hand it over — and the job must refuse it on the night
 * model. Today is frozen at 2026-07-01 (`vitest.clock-setup.ts`).
 */

const { mockPrisma, mockFlags, mockLookahead } = vi.hoisted(() => ({
  mockPrisma: {
    lodge: { findMany: vi.fn() },
    booking: { findMany: vi.fn() },
    hutLeaderAssignment: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    bookingGuest: { findMany: vi.fn() },
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(),
  },
  mockFlags: vi.fn(),
  mockLookahead: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("./prisma", () => ({ prisma: mockPrisma }));
// Partial: `admin-modules` (reached through the capacity counter since the
// #3817 one-space rule) reads `normalizeClubModuleSettings` at import time.
vi.mock("@/lib/module-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/module-settings")),
  loadEffectiveModuleFlags: mockFlags,
}));
vi.mock("./module-settings", () => ({ loadEffectiveModuleFlags: mockFlags }));
vi.mock("@/lib/lodge-settings", () => ({ loadHutLeaderLookaheadDays: mockLookahead }));
vi.mock("./lodge-settings", () => ({ loadHutLeaderLookaheadDays: mockLookahead }));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("./logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { autoAssignHutLeaders } from "@/lib/cron-hut-leader-auto-assign";
import { hutLeaderStayBookingWhere } from "@/lib/hut-leader-stayed-nights";

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const iso = (value: Date) => value.toISOString().slice(0, 10);

type Guest = {
  memberId: string;
  stayStart: Date;
  stayEnd: Date;
  nights: Array<{ stayDate: Date }>;
  member: { id: string; active: true };
};

/** One adult member guest, optionally with an explicit (split) night set. */
function guest(memberId: string, checkIn: string, checkOut: string, nights: string[] = []): Guest {
  return {
    memberId,
    stayStart: day(checkIn),
    stayEnd: day(checkOut),
    nights: nights.map((n) => ({ stayDate: day(n) })),
    member: { id: memberId, active: true },
  };
}

/** Serve bookings the way the job's per-day envelope query would. */
function withGuests(guests: Guest[]) {
  // The presence-aware cover (#3818) reads the leaders' stays: every guest
  // here is at lodge-a, so it sees the same stays the job does.
  mockPrisma.bookingGuest.findMany.mockResolvedValue(
    guests.map((g) => ({
      memberId: g.memberId,
      stayStart: g.stayStart,
      stayEnd: g.stayEnd,
      nights: g.nights,
      booking: { lodgeId: "lodge-a", checkIn: g.stayStart, checkOut: g.stayEnd },
    })),
  );
  mockPrisma.booking.findMany.mockImplementation(
    async ({ where }: { where: { checkIn: { lte: Date } } }) => {
      const asked = where.checkIn.lte;
      const present = guests.filter((g) => g.stayStart <= asked && asked < g.stayEnd);
      return present.map((g) => ({ checkIn: g.stayStart, checkOut: g.stayEnd, guests: [g] }));
    },
  );
}

/** Rows the job wrote, as `[memberId, startDate, endDate]`. */
function written() {
  return mockPrisma.hutLeaderAssignment.create.mock.calls.map(([call]) => {
    const data = (call as { data: { memberId: string; startDate: Date; endDate: Date } }).data;
    return [data.memberId, iso(data.startDate), iso(data.endDate)];
  });
}

describe("autoAssignHutLeaders writes stayed nights (#3817)", () => {
  /** Assignments written so far, so the job's own coverage probe sees them. */
  let rows: Array<{ memberId: string; startDate: Date; endDate: Date }> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    rows = [];
    mockFlags.mockResolvedValue({ hutLeaders: true });
    mockLookahead.mockResolvedValue(14);
    mockPrisma.lodge.findMany.mockResolvedValue([{ id: "lodge-a" }]);
    mockPrisma.bookingGuest.findMany.mockResolvedValue([]);
    // The coverage cover's read (it selects `source`) sees the rows written so
    // far; the overlap guard's read refuses nothing, as before.
    mockPrisma.hutLeaderAssignment.findMany.mockImplementation(
      async (args: { select?: { source?: true }; where: { startDate: { lte: Date }; endDate: { gte: Date } } }) =>
        args.select?.source
          ? rows
              .filter((r) => r.startDate <= args.where.startDate.lte && r.endDate >= args.where.endDate.gte)
              .map((r, index) => ({
                id: `row-${index + 1}`,
                memberId: r.memberId,
                lodgeId: "lodge-a",
                startDate: r.startDate,
                endDate: r.endDate,
                source: "CRON",
                bedId: null,
                isCustodian: false,
              }))
          : [],
    );
    mockPrisma.hutLeaderAssignment.create.mockImplementation(
      async ({ data }: { data: { memberId: string; startDate: Date; endDate: Date } }) => {
        rows.push({ memberId: data.memberId, startDate: data.startDate, endDate: data.endDate });
        return { id: `row-${rows.length}` };
      },
    );
    mockPrisma.$transaction.mockImplementation(async (arg: unknown) =>
      typeof arg === "function" ? (arg as (tx: typeof mockPrisma) => unknown)(mockPrisma) : arg,
    );
  });

  it("ends the row on the last night stayed, checkOut - 1", async () => {
    withGuests([guest("m-1", "2026-07-03", "2026-07-06")]);

    await autoAssignHutLeaders();

    expect(written()).toEqual([["m-1", "2026-07-03", "2026-07-05"]]);
  });

  it("writes one row per run of a split stay, and never the gap night", async () => {
    // Nights 3, 4 and 7, 8: the envelope 3-9 fills the 5th and 6th.
    withGuests([
      guest("m-1", "2026-07-03", "2026-07-09", [
        "2026-07-03",
        "2026-07-04",
        "2026-07-07",
        "2026-07-08",
      ]),
    ]);

    await autoAssignHutLeaders();

    expect(written()).toEqual([
      ["m-1", "2026-07-03", "2026-07-04"],
      ["m-1", "2026-07-07", "2026-07-08"],
    ]);
  });

  it("does not count a guest on their gap night towards 'exactly one adult'", async () => {
    // m-gap is away on the 5th (nights 3 and 6 only); m-solo is the only adult
    // actually there that night, so the 5th gets m-solo.
    withGuests([
      guest("m-gap", "2026-07-05", "2026-07-07", ["2026-07-06"]),
      guest("m-solo", "2026-07-05", "2026-07-06"),
    ]);

    await autoAssignHutLeaders();

    expect(written()).toContainEqual(["m-solo", "2026-07-05", "2026-07-05"]);
  });

  it("Wednesday-leave / Thursday-arrive leaves Wednesday night unassigned", async () => {
    // A: Mon 6 - Wed 8 Jul (nights Mon, Tue). B: Thu 9 - Sat 11 (nights Thu, Fri).
    withGuests([
      guest("m-a", "2026-07-06", "2026-07-08"),
      guest("m-b", "2026-07-09", "2026-07-11"),
    ]);

    await autoAssignHutLeaders();

    expect(written()).toEqual([
      ["m-a", "2026-07-06", "2026-07-07"],
      ["m-b", "2026-07-09", "2026-07-10"],
    ]);
    const wednesday = day("2026-07-08");
    expect(rows.some((r) => r.startDate <= wednesday && r.endDate >= wednesday)).toBe(false);
  });

  it("reads bookings through THE hut-leader stay definition: no soft-deleted booking (#3817)", async () => {
    withGuests([guest("m-1", "2026-07-01", "2026-07-03")]);
    mockLookahead.mockResolvedValue(0);
    await autoAssignHutLeaders();
    const [{ where }] = mockPrisma.booking.findMany.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    expect(where).toMatchObject(
      hutLeaderStayBookingWhere({
        lodgeId: "lodge-a",
        rangeStart: day("2026-07-01"),
        rangeEnd: day("2026-07-01"),
      }) as Record<string, unknown>,
    );
    expect(where).toMatchObject({ deletedAt: null });
  });

  it("starts at the club's today, not the day before (date-only days)", async () => {
    // The defect this pins (date-fns `eachDayOfInterval` returning LOCAL
    // midnights) shows only when the process zone is ahead of UTC, and CI runs
    // in UTC, so the zone is pinned here or the test cannot fail (#3817
    // review). Node re-reads `process.env.TZ` on assignment; restored after.
    const previousTz = process.env.TZ;
    process.env.TZ = "Pacific/Auckland";
    try {
      // A stay whose only night is yesterday must not be assigned.
      withGuests([guest("m-past", "2026-06-30", "2026-07-01")]);
      mockLookahead.mockResolvedValue(0);

      await autoAssignHutLeaders();

      expect(written()).toEqual([]);
      // The nights the job asked bookings for (one per uncovered night).
      const asked = mockPrisma.booking.findMany.mock.calls.map(
        ([args]) => (args as { where: { checkIn: { lte: Date } } }).where.checkIn.lte,
      );
      expect(asked.map(iso)).toEqual(["2026-07-01"]);
      // Every asked day is a stored calendar day: a UTC-midnight instant.
      for (const instant of asked) expect(instant.getTime() % 86_400_000).toBe(0);
    } finally {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    }
  });
});
