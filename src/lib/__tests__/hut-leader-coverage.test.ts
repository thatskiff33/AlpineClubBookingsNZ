import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  coverageLodgeLabel,
  coverageNeedsLodgeContext,
  getHutLeaderDashboardCoverage,
  getUnassignedHutLeaderDates,
} from "@/lib/hut-leader-coverage";

function dateOnly(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

/** Lodge names, so a row's `lodgeName` and the name ordering can be asserted. */
const LODGE_NAMES: Record<string, string> = {
  "lodge-a": "Alpine Lodge",
  "lodge-b": "Basin Lodge",
  "lodge-z": "Zenith Lodge",
};

function buildDb(options: {
  hutLeaderLookaheadDays?: number;
  bookings?: Array<{
    lodgeId?: string | null;
    /** The booking's lodge `active` flag; defaults to an active lodge. */
    lodgeActive?: boolean;
    checkIn: Date;
    checkOut: Date;
    guests?: Array<{
      stayStart?: Date | null;
      stayEnd?: Date | null;
      nights?: Array<{ stayDate: Date }>;
    }>;
  }>;
  assignments?: Array<{
    lodgeId?: string | null;
    memberId?: string;
    startDate: Date;
    endDate: Date;
  }>;
  /**
   * The assigned leaders' own stays (#3818). Omitted, every leader is staying
   * every night their assignment claims, so the cases below keep testing what
   * they were written to test; pass an explicit list to test presence.
   */
  leaderStays?: Array<{
    memberId: string;
    lodgeId?: string;
    checkIn: Date;
    checkOut: Date;
  }>;
}) {
  const assignments = (options.assignments ?? []).map((assignment, index) => ({
    id: `assignment-${index}`,
    memberId: assignment.memberId ?? `leader-${index}`,
    source: "MANUAL" as const,
    bedId: null,
    ...assignment,
    lodgeId: assignment.lodgeId ?? "lodge-a",
  }));
  const leaderStays =
    options.leaderStays ??
    assignments.map((assignment) => ({
      memberId: assignment.memberId,
      lodgeId: assignment.lodgeId,
      checkIn: assignment.startDate,
      // The night of `endDate` is claimed, so the stay runs to the morning after.
      checkOut: new Date(assignment.endDate.getTime() + 86_400_000),
    }));
  return {
    lodgeSettings: {
      findUnique: vi.fn().mockResolvedValue({
        capacity: null,
        hutLeaderLookaheadDays: options.hutLeaderLookaheadDays,
      }),
    },
    booking: {
      findMany: vi.fn().mockResolvedValue(
        (options.bookings ?? []).map((booking) => {
          const lodgeId = booking.lodgeId ?? "lodge-a";
          return {
            lodge: {
              name: LODGE_NAMES[lodgeId] ?? lodgeId,
              active: booking.lodgeActive ?? true,
            },
            ...booking,
            lodgeId,
          };
        }),
      ),
    },
    hutLeaderAssignment: {
      findMany: vi.fn().mockResolvedValue(assignments),
    },
    bookingGuest: {
      findMany: vi.fn().mockResolvedValue(
        leaderStays.map((stay) => ({
          memberId: stay.memberId,
          stayStart: stay.checkIn,
          stayEnd: stay.checkOut,
          nights: [],
          booking: {
            lodgeId: stay.lodgeId ?? "lodge-a",
            checkIn: stay.checkIn,
            checkOut: stay.checkOut,
          },
        })),
      ),
    },
  };
}

/**
 * The expected shape of one uncovered lodge-night (#2917): the row names WHICH
 * lodge is uncovered, so a night can appear more than once.
 */
function uncovered(
  date: string,
  bookingCount: number,
  guestCount: number,
  lodgeId = "lodge-a",
  lodgeActive = true,
) {
  return {
    date,
    lodgeId,
    lodgeName: LODGE_NAMES[lodgeId],
    lodgeActive,
    bookingCount,
    guestCount,
  };
}

describe("getUnassignedHutLeaderDates", () => {
  it("uses the configured hut-leader lookahead when no override is supplied", async () => {
    const booking = {
      checkIn: dateOnly("2026-04-15"),
      checkOut: dateOnly("2026-04-16"),
      guests: [{}, {}],
    };
    const today = dateOnly("2026-04-10");

    await expect(
      getUnassignedHutLeaderDates({
        scope: { kind: "all" },
        db: buildDb({ hutLeaderLookaheadDays: 3, bookings: [booking] }),
        today,
      }),
    ).resolves.toEqual([]);

    await expect(
      getUnassignedHutLeaderDates({
        scope: { kind: "all" },
        db: buildDb({ hutLeaderLookaheadDays: 6, bookings: [booking] }),
        today,
      }),
    ).resolves.toEqual([uncovered("2026-04-15", 1, 2)]);
  });

  it("restricts to an explicit {from,to} window (may include past nights) and ignores the stored lookahead", async () => {
    const db = buildDb({
      hutLeaderLookaheadDays: 3,
      bookings: [
        // Occupies nights 03-05 and 03-06 (checkOut is exclusive).
        { checkIn: dateOnly("2026-03-05"), checkOut: dateOnly("2026-03-07"), guests: [{}, {}] },
        // Occupies night 03-20.
        { checkIn: dateOnly("2026-03-20"), checkOut: dateOnly("2026-03-21"), guests: [{}] },
        // Outside the window — must not appear even though the mock returns it.
        { checkIn: dateOnly("2026-04-15"), checkOut: dateOnly("2026-04-16"), guests: [{}] },
      ],
      // 03-06 already has a leader, so it is not "needs a leader".
      assignments: [{ startDate: dateOnly("2026-03-06"), endDate: dateOnly("2026-03-06") }],
    });

    const result = await getUnassignedHutLeaderDates({
      scope: { kind: "all" },
      db,
      from: dateOnly("2026-03-01"),
      to: dateOnly("2026-03-31"),
      // "today" is well after the window: a windowed call still reports history.
      today: dateOnly("2026-07-01"),
    });

    // A window skips the lookahead setting entirely.
    expect(db.lodgeSettings.findUnique).not.toHaveBeenCalled();
    expect(result).toEqual([
      uncovered("2026-03-05", 1, 2),
      uncovered("2026-03-20", 1, 1),
    ]);
  });

  it("ignores a partial window (only from, or only to) and falls back to the lookahead", async () => {
    const booking = {
      checkIn: dateOnly("2026-04-15"),
      checkOut: dateOnly("2026-04-16"),
      guests: [{}, {}],
    };

    await expect(
      getUnassignedHutLeaderDates({
        scope: { kind: "all" },
        db: buildDb({ hutLeaderLookaheadDays: 6, bookings: [booking] }),
        today: dateOnly("2026-04-10"),
        from: dateOnly("2026-03-01"),
      }),
    ).resolves.toEqual([uncovered("2026-04-15", 1, 2)]);
  });

  it("lets an explicit lookahead override the stored setting", async () => {
    const db = buildDb({
      hutLeaderLookaheadDays: 3,
      bookings: [
        {
          checkIn: dateOnly("2026-04-15"),
          checkOut: dateOnly("2026-04-16"),
          guests: [{}],
        },
      ],
    });

    const result = await getUnassignedHutLeaderDates({
      scope: { kind: "all" },
      db,
      today: dateOnly("2026-04-10"),
      lookAheadDays: 6,
    });

    expect(db.lodgeSettings.findUnique).not.toHaveBeenCalled();
    expect(result.map((item) => item.date)).toEqual(["2026-04-15"]);
  });

  it("binds both assignments and occupied bookings to the selected lodge", async () => {
    const db = buildDb({
      bookings: [
        {
          checkIn: dateOnly("2026-08-10"),
          checkOut: dateOnly("2026-08-11"),
          guests: [{}],
        },
      ],
    });

    await getUnassignedHutLeaderDates({
      scope: { kind: "lodge", lodgeId: "lodge-b" },
      db,
      from: dateOnly("2026-08-10"),
      to: dateOnly("2026-08-10"),
    });

    expect(db.hutLeaderAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ lodgeId: "lodge-b" }) }),
    );
    expect(db.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ lodgeId: "lodge-b" }) }),
    );
  });

  it("keeps lodge identity in all-lodges coverage for the same calendar night", async () => {
    const night = dateOnly("2026-08-10");
    const result = await getUnassignedHutLeaderDates({
      scope: { kind: "all" },
      db: buildDb({
        bookings: [
          { lodgeId: "lodge-a", checkIn: night, checkOut: dateOnly("2026-08-11"), guests: [{}] },
          { lodgeId: "lodge-b", checkIn: night, checkOut: dateOnly("2026-08-11"), guests: [{}, {}] },
        ],
        assignments: [
          { lodgeId: "lodge-a", startDate: night, endDate: night },
        ],
      }),
      from: night,
      to: night,
    });

    expect(result).toEqual([uncovered("2026-08-10", 1, 2, "lodge-b")]);
  });

  it("counts only explicit sparse guest nights and falls back only when none exist", async () => {
    const result = await getUnassignedHutLeaderDates({
      scope: { kind: "lodge", lodgeId: "lodge-a" },
      db: buildDb({
        bookings: [{
          lodgeId: "lodge-a",
          checkIn: dateOnly("2026-08-10"),
          checkOut: dateOnly("2026-08-13"),
          guests: [
            {
              stayStart: dateOnly("2026-08-10"),
              stayEnd: dateOnly("2026-08-13"),
              nights: [
                { stayDate: dateOnly("2026-08-10") },
                { stayDate: dateOnly("2026-08-12") },
              ],
            },
            {},
          ],
        }],
      }),
      from: dateOnly("2026-08-10"),
      to: dateOnly("2026-08-12"),
    });

    expect(result).toEqual([
      uncovered("2026-08-10", 1, 2),
      uncovered("2026-08-11", 1, 1),
      uncovered("2026-08-12", 1, 2),
    ]);
  });

  /**
   * Per-lodge coverage semantics (#2917), the read side of the per-lodge
   * auto-assign cron shipped by #2915/PR #2916.
   */
  describe("one row per uncovered lodge-night", () => {
    it("reports the SAME night twice when two lodges are both uncovered, with each lodge's own counts", async () => {
      const night = dateOnly("2026-08-10");
      const result = await getUnassignedHutLeaderDates({
        scope: { kind: "all" },
        db: buildDb({
          bookings: [
            {
              lodgeId: "lodge-a",
              checkIn: night,
              checkOut: dateOnly("2026-08-11"),
              guests: [{}],
            },
            {
              lodgeId: "lodge-b",
              checkIn: night,
              checkOut: dateOnly("2026-08-11"),
              guests: [{}, {}, {}],
            },
          ],
        }),
        from: night,
        to: night,
      });

      // Before #2917 this was ONE row reading {bookingCount: 2, guestCount: 4} —
      // a number an officer could not act on, because it never said where.
      expect(result).toEqual([
        uncovered("2026-08-10", 1, 1, "lodge-a"),
        uncovered("2026-08-10", 1, 3, "lodge-b"),
      ]);
    });

    it("orders deterministically by date, then by lodge name", async () => {
      const night = dateOnly("2026-08-10");
      const laterNight = dateOnly("2026-08-11");
      const result = await getUnassignedHutLeaderDates({
        scope: { kind: "all" },
        db: buildDb({
          // Deliberately returned in reverse-name order: the sort, not the
          // query, is what makes the response stable.
          bookings: [
            {
              lodgeId: "lodge-z",
              checkIn: night,
              checkOut: dateOnly("2026-08-12"),
              guests: [{}],
            },
            {
              lodgeId: "lodge-b",
              checkIn: night,
              checkOut: dateOnly("2026-08-12"),
              guests: [{}],
            },
            {
              lodgeId: "lodge-a",
              checkIn: night,
              checkOut: dateOnly("2026-08-12"),
              guests: [{}],
            },
          ],
        }),
        from: night,
        to: laterNight,
      });

      expect(result.map((row) => [row.date, row.lodgeName])).toEqual([
        ["2026-08-10", "Alpine Lodge"],
        ["2026-08-10", "Basin Lodge"],
        ["2026-08-10", "Zenith Lodge"],
        ["2026-08-11", "Alpine Lodge"],
        ["2026-08-11", "Basin Lodge"],
        ["2026-08-11", "Zenith Lodge"],
      ]);
    });

    it("groups every uncovered booking at one lodge into that lodge's single row", async () => {
      const night = dateOnly("2026-08-10");
      const result = await getUnassignedHutLeaderDates({
        scope: { kind: "all" },
        db: buildDb({
          bookings: [
            {
              lodgeId: "lodge-a",
              checkIn: night,
              checkOut: dateOnly("2026-08-11"),
              guests: [{}, {}],
            },
            {
              lodgeId: "lodge-a",
              checkIn: night,
              checkOut: dateOnly("2026-08-11"),
              guests: [{}],
            },
          ],
        }),
        from: night,
        to: night,
      });

      expect(result).toEqual([uncovered("2026-08-10", 2, 3)]);
    });

    it("A SINGLE-LODGE CLUB IS UNCHANGED: same nights, same counts as before #2917", async () => {
      // The pre-#2917 expectation, copied verbatim from the club-wide result
      // this function used to return for exactly this fixture. Only the two
      // lodge fields are new; every date and count is identical, and the row
      // count is identical, so no single-lodge club's badge, tile or officer
      // card can move.
      const legacyRows = [
        { date: "2026-08-10", bookingCount: 2, guestCount: 3 },
        { date: "2026-08-11", bookingCount: 1, guestCount: 1 },
        // 08-12 has a leader; 08-13 has a booking with no guests.
      ];

      const result = await getUnassignedHutLeaderDates({
        scope: { kind: "all" },
        db: buildDb({
          bookings: [
            {
              checkIn: dateOnly("2026-08-10"),
              checkOut: dateOnly("2026-08-11"),
              guests: [{}, {}],
            },
            {
              checkIn: dateOnly("2026-08-10"),
              checkOut: dateOnly("2026-08-13"),
              guests: [{}],
            },
            {
              checkIn: dateOnly("2026-08-13"),
              checkOut: dateOnly("2026-08-14"),
              guests: [],
            },
          ],
          assignments: [
            { startDate: dateOnly("2026-08-12"), endDate: dateOnly("2026-08-12") },
          ],
        }),
        from: dateOnly("2026-08-10"),
        to: dateOnly("2026-08-13"),
      });

      expect(
        result.map(({ date, bookingCount, guestCount }) => ({
          date,
          bookingCount,
          guestCount,
        })),
      ).toEqual(legacyRows);
      // …and every row names the club's only lodge, so a caller never has to
      // guess which lodge a bare date meant.
      expect(result.every((row) => row.lodgeId === "lodge-a")).toBe(true);
    });

    it("STILL REPORTS an archived lodge that kept its future bookings, and never filters a club-wide read by lodge", async () => {
      // Deactivating a lodge with future bookings is permitted with `force` and
      // does not cancel them (src/lib/lodge-deactivation-guard.ts), so real
      // guests arrive at an archived lodge with no leader. Filtering the club-wide
      // read to active lodges removed that night from the dashboard card, the
      // sidebar badge and the stuck-state tile at once, and no other page can
      // show it — an invisible uncovered night, which is strictly worse than one
      // that takes an extra step to clear (#2917 review).
      const night = dateOnly("2026-08-10");
      const clubWide = buildDb({
        bookings: [
          {
            lodgeId: "lodge-b",
            lodgeActive: false,
            checkIn: night,
            checkOut: dateOnly("2026-08-11"),
            guests: [{}, {}],
          },
        ],
      });
      const result = await getUnassignedHutLeaderDates({
        scope: { kind: "all" },
        db: clubWide,
        from: night,
        to: night,
      });

      expect(result).toEqual([
        uncovered("2026-08-10", 1, 2, "lodge-b", false),
      ]);
      // No lodge predicate at all on a club-wide read: the row is reported and
      // labelled, not excluded by the query.
      const [[clubWideArgs]] = clubWide.booking.findMany.mock.calls as [
        [{ where: Record<string, unknown> }],
      ];
      expect(clubWideArgs.where.lodge).toBeUndefined();
      expect(clubWideArgs.where.lodgeId).toBeUndefined();

      const oneLodge = buildDb({});
      await getUnassignedHutLeaderDates({
        scope: { kind: "lodge", lodgeId: "lodge-b" },
        db: oneLodge,
        from: dateOnly("2026-08-10"),
        to: dateOnly("2026-08-10"),
      });
      const [[lodgeScopedArgs]] = oneLodge.booking.findMany.mock.calls as [
        [{ where: Record<string, unknown> }],
      ];
      expect(lodgeScopedArgs.where.lodgeId).toBe("lodge-b");
      expect(lodgeScopedArgs.where.lodge).toBeUndefined();
    });
  });
});

describe("coverageNeedsLodgeContext", () => {
  const oneLodgeRows = [
    uncovered("2026-08-10", 1, 1),
    uncovered("2026-08-11", 1, 1),
  ];

  it("NAMES THE LODGE FOR A MULTI-LODGE CLUB EVEN WHEN EVERY UNCOVERED NIGHT IS AT ONE LODGE", () => {
    // The whole point of #2917. Three active lodges, two of them covered for the
    // entire lookahead, so the rows span a single lodge — the common multi-lodge
    // case. Keying on the rows would show bare dates here (rejected Option B),
    // and would flip the wording back and forth as the other lodges gained and
    // lost cover between page loads.
    expect(
      coverageNeedsLodgeContext({ activeLodgeCount: 3, rows: oneLodgeRows }),
    ).toBe(true);
    // Same club, nothing uncovered at all: still multi-lodge, so a surface that
    // renders a noun renders the lodge-night one.
    expect(coverageNeedsLodgeContext({ activeLodgeCount: 3, rows: [] })).toBe(
      true,
    );
  });

  it("shows a single-lodge club no lodge context (ADR-002 Presentation Rule)", () => {
    expect(
      coverageNeedsLodgeContext({ activeLodgeCount: 1, rows: oneLodgeRows }),
    ).toBe(false);
    expect(coverageNeedsLodgeContext({ activeLodgeCount: 1, rows: [] })).toBe(
      false,
    );
  });

  it("names the lodge on a one-lodge club when a row belongs to an ARCHIVED lodge", () => {
    // One active lodge, but an archived lodge that kept its bookings is also
    // reported: a bare date would point the officer at the wrong lodge.
    expect(
      coverageNeedsLodgeContext({
        activeLodgeCount: 1,
        rows: [uncovered("2026-08-10", 1, 1, "lodge-b", false)],
      }),
    ).toBe(true);
  });
});

describe("coverageLodgeLabel", () => {
  it("marks an archived lodge, because the hut-leaders selector cannot offer one", () => {
    expect(coverageLodgeLabel(uncovered("2026-08-10", 1, 1))).toBe(
      "Alpine Lodge",
    );
    expect(
      coverageLodgeLabel(uncovered("2026-08-10", 1, 1, "lodge-b", false)),
    ).toBe("Basin Lodge, archived");
  });

  it("is null for a legacy row with no lodge, so a caller falls back to the bare date", () => {
    expect(
      coverageLodgeLabel({
        date: "2026-08-10",
        lodgeId: null,
        lodgeName: null,
        lodgeActive: null,
        bookingCount: 1,
        guestCount: 1,
      }),
    ).toBeNull();
  });
});

describe("getUnassignedHutLeaderDates — a leader must be staying (#3818)", () => {
  it("an existing row ending on checkout day no longer covers the checkout night, with no backfill", async () => {
    // The leader stays Mon 3 Aug and Tue 4 Aug, leaving Wed 5 Aug morning; the
    // old cron stamped the row through the checkout day. Other guests stay on
    // Wednesday night, so it needs a leader the row's dates still "claim".
    const db = buildDb({
      bookings: [
        { checkIn: dateOnly("2026-08-03"), checkOut: dateOnly("2026-08-07"), guests: [{}, {}] },
      ],
      assignments: [
        { memberId: "leader", startDate: dateOnly("2026-08-03"), endDate: dateOnly("2026-08-05") },
      ],
      leaderStays: [
        { memberId: "leader", checkIn: dateOnly("2026-08-03"), checkOut: dateOnly("2026-08-05") },
      ],
    });

    const result = await getUnassignedHutLeaderDates({
      scope: { kind: "lodge", lodgeId: "lodge-a" },
      db,
      from: dateOnly("2026-08-03"),
      to: dateOnly("2026-08-06"),
    });

    // Healed by the reader alone: this PR ships no migration or backfill.
    expect(result.map((row) => row.date)).toEqual(["2026-08-05", "2026-08-06"]);
  });

  it("a leader whose stay is not loaded (cancelled, bumped or archived) covers nothing", async () => {
    const result = await getUnassignedHutLeaderDates({
      scope: { kind: "lodge", lodgeId: "lodge-a" },
      db: buildDb({
        bookings: [
          { checkIn: dateOnly("2026-08-03"), checkOut: dateOnly("2026-08-04"), guests: [{}] },
        ],
        assignments: [{ startDate: dateOnly("2026-08-03"), endDate: dateOnly("2026-08-03") }],
        leaderStays: [],
      }),
      from: dateOnly("2026-08-03"),
      to: dateOnly("2026-08-03"),
    });

    expect(result.map((row) => row.date)).toEqual(["2026-08-03"]);
  });
});

describe("getHutLeaderDashboardCoverage (#3818)", () => {
  // Today 1 Aug, a three-night lookahead (1..4 Aug), the week 1..7 Aug.
  const today = dateOnly("2026-08-01");
  const week = { from: today, to: dateOnly("2026-08-07") };

  it("reads ONE cover reaching from the night before the week to whichever window ends later, with names", async () => {
    const db = buildDb({
      hutLeaderLookaheadDays: 3,
      bookings: [
        { checkIn: dateOnly("2026-08-02"), checkOut: dateOnly("2026-08-03"), guests: [{}] },
      ],
      assignments: [
        { memberId: "ann", startDate: dateOnly("2026-07-31"), endDate: dateOnly("2026-08-02") },
        { memberId: "ben", startDate: dateOnly("2026-08-03"), endDate: dateOnly("2026-08-06") },
      ],
    });

    const result = await getHutLeaderDashboardCoverage({
      db,
      scope: { kind: "all" },
      today,
      handovers: week,
    });

    expect(db.hutLeaderAssignment.findMany).toHaveBeenCalledTimes(1);
    expect(db.hutLeaderAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { startDate: { lte: week.to }, endDate: { gte: dateOnly("2026-07-31") } },
        select: expect.objectContaining({ member: expect.anything() }),
      }),
    );
    // The uncovered nights still answer over the lookahead window alone.
    expect(db.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          checkIn: { lte: dateOnly("2026-08-04") },
          checkOut: { gt: today },
        }),
      }),
    );
    expect(result.unassignedDates).toEqual([]);
    expect(result.handovers.map((handover) => handover.date)).toEqual(["2026-08-03"]);
  });

  it("reads neither names nor handovers when the viewer cannot see the card", async () => {
    const db = buildDb({ hutLeaderLookaheadDays: 3 });

    const result = await getHutLeaderDashboardCoverage({
      db,
      scope: { kind: "all" },
      today,
      handovers: null,
    });

    const [[args]] = db.hutLeaderAssignment.findMany.mock.calls as [
      [{ where: unknown; select: Record<string, unknown> }],
    ];
    expect(args.where).toEqual({
      startDate: { lte: dateOnly("2026-08-04") },
      endDate: { gte: today },
    });
    expect(args.select).not.toHaveProperty("member");
    expect(result.handovers).toEqual([]);
  });
});
