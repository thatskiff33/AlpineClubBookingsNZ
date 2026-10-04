import { describe, expect, it, vi } from "vitest";
import { BookingStatus } from "@prisma/client";

import { capacityHoldingBookingFilter } from "@/lib/booking-status";
import { SCHOOL_GROUP_BOOKING_WHERE } from "@/lib/school-group-booking";

import {
  buildHutLeaderNightCover,
  isHutLeaderNightCovered,
  listHutLeaderHandovers,
  listHutLeaderNightLeaders,
  loadHutLeaderNightCover,
  type HutLeaderSchoolBooking,
  type HutLeaderShift,
  type HutLeaderStay,
} from "@/lib/hut-leader-night-cover";
import {
  DEFAULT_SCHOOL_HUT_LEADER_KINDS,
  SCHOOL_HUT_LEADER_KINDS,
  type SchoolHutLeaderKind,
  type SchoolHutLeaderKinds,
} from "@/lib/school-hut-leader-kinds";

/**
 * The one presence-aware coverage definition (#3818, `INV-DATE-031`): a night
 * is covered when an assignment claims it AND its leader is in the lodge.
 */

function d(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function shift(overrides: Partial<HutLeaderShift> & { startDate: Date; endDate: Date }): HutLeaderShift {
  return {
    id: "shift-1",
    memberId: "leader",
    lodgeId: "lodge-a",
    source: "MANUAL",
    bedId: null,
    isCustodian: false,
    member: { firstName: "Ann", lastName: "Smith" },
    lodge: { name: "Alpine Lodge", active: true },
    ...overrides,
  };
}

function stay(
  memberId: string,
  checkIn: string,
  checkOut: string,
  options: { lodgeId?: string; nights?: string[]; bookingId?: string } = {},
): HutLeaderStay {
  return {
    memberId,
    stayStart: d(checkIn),
    stayEnd: d(checkOut),
    nights: (options.nights ?? []).map((night) => ({ stayDate: d(night) })),
    booking: {
      id: options.bookingId ?? `booking-${memberId}`,
      lodgeId: options.lodgeId ?? "lodge-a",
      checkIn: d(checkIn),
      checkOut: d(checkOut),
    },
  };
}

/** A school group's booking at lodge-a, 10 Aug to the morning of the 13th. */
const SCHOOL: HutLeaderSchoolBooking = {
  id: "school-booking",
  lodgeId: "lodge-a",
  checkIn: d("2026-08-10"),
  checkOut: d("2026-08-13"),
};

function onlyKinds(...ticked: SchoolHutLeaderKind[]): SchoolHutLeaderKinds {
  return Object.fromEntries(
    SCHOOL_HUT_LEADER_KINDS.map((kind) => [kind, ticked.includes(kind)]),
  ) as SchoolHutLeaderKinds;
}

function schoolNights(kinds: SchoolHutLeaderKinds = DEFAULT_SCHOOL_HUT_LEADER_KINDS) {
  return { bookings: [SCHOOL], kindsByLodge: new Map([["lodge-a", kinds]]) };
}

describe("buildHutLeaderNightCover", () => {
  it("covers a night only when the row claims it AND the leader is staying", () => {
    // Row stamped through the checkout day (the old cron shape): stays 3–4 Aug,
    // leaves the morning of the 5th.
    const cover = buildHutLeaderNightCover(
      [shift({ startDate: d("2026-08-03"), endDate: d("2026-08-05") })],
      [stay("leader", "2026-08-03", "2026-08-05")],
    );

    expect(cover.isCovered("lodge-a", d("2026-08-03"))).toBe(true);
    expect(cover.isCovered("lodge-a", d("2026-08-04"))).toBe(true);
    // The checkout night: claimed by the row, but nobody is staying.
    expect(cover.isCovered("lodge-a", d("2026-08-05"))).toBe(false);
    // Outside the row: staying is not enough without an assignment.
    expect(cover.isCovered("lodge-a", d("2026-08-02"))).toBe(false);
  });

  it("does not count a stay at a different lodge", () => {
    const cover = buildHutLeaderNightCover(
      [shift({ startDate: d("2026-08-03"), endDate: d("2026-08-04") })],
      [stay("leader", "2026-08-03", "2026-08-05", { lodgeId: "lodge-b" })],
    );
    expect(cover.isCovered("lodge-a", d("2026-08-03"))).toBe(false);
  });

  it("reads explicit sparse nights through the shared night predicate", () => {
    const cover = buildHutLeaderNightCover(
      [shift({ startDate: d("2026-08-03"), endDate: d("2026-08-06") })],
      [stay("leader", "2026-08-03", "2026-08-07", { nights: ["2026-08-03", "2026-08-05"] })],
    );
    expect(cover.isCovered("lodge-a", d("2026-08-03"))).toBe(true);
    expect(cover.isCovered("lodge-a", d("2026-08-04"))).toBe(false);
    expect(cover.isCovered("lodge-a", d("2026-08-05"))).toBe(true);
    expect(cover.isCovered("lodge-a", d("2026-08-06"))).toBe(false);
  });

  it("a teacher row covers only while a school booking stays at its lodge (#3819)", () => {
    // Stamped the pre-#3819 way, through the checkout day: the school's stay,
    // not the row, ends the cover. Teachers ticked at this lodge.
    const teacher = shift({ source: "SCHOOL_BOOKING", startDate: d("2026-08-10"), endDate: d("2026-08-13") });
    const cover = buildHutLeaderNightCover([teacher], [], schoolNights(onlyKinds("teacherOnBooking")));
    expect(cover.isCovered("lodge-a", d("2026-08-10"))).toBe(true);
    expect(cover.isCovered("lodge-a", d("2026-08-12"))).toBe(true);
    expect(cover.isCovered("lodge-a", d("2026-08-13"))).toBe(false);
    // No school booking staying (cancelled, moved, or never loaded): no cover.
    expect(buildHutLeaderNightCover([teacher], []).isCovered("lodge-a", d("2026-08-11"))).toBe(false);
  });

  it("a custodian's bed hold is presence on every night it covers, inclusive (INV-LIFE-062)", () => {
    const cover = buildHutLeaderNightCover(
      [shift({ bedId: "bed-1", startDate: d("2026-08-10"), endDate: d("2026-08-12") })],
      [],
    );
    expect(cover.isCovered("lodge-a", d("2026-08-12"))).toBe(true);
    expect(cover.isCovered("lodge-a", d("2026-08-13"))).toBe(false);
  });

  it("a ticked custodian with no bed and no stay is present on every night it covers (#3817 tick)", () => {
    const cover = buildHutLeaderNightCover(
      [shift({ isCustodian: true, startDate: d("2026-08-10"), endDate: d("2026-08-12") })],
      [],
    );
    expect(cover.isCovered("lodge-a", d("2026-08-10"))).toBe(true);
    expect(cover.isCovered("lodge-a", d("2026-08-12"))).toBe(true);
    expect(cover.isCovered("lodge-a", d("2026-08-13"))).toBe(false);
  });

  it("a role-only row that is not ticked, with no bed and no stay, never covers", () => {
    const cover = buildHutLeaderNightCover(
      [shift({ startDate: d("2026-08-10"), endDate: d("2026-08-12") })],
      [],
    );
    expect(cover.isCovered("lodge-a", d("2026-08-10"))).toBe(false);
    expect(cover.isCovered("lodge-a", d("2026-08-11"))).toBe(false);
  });
});

describe("loadHutLeaderNightCover", () => {
  function buildDb(
    shifts: HutLeaderShift[],
    stays: HutLeaderStay[],
    school: { bookings?: HutLeaderSchoolBooking[]; settingsRow?: Record<string, unknown> | null } = {},
  ) {
    return {
      hutLeaderAssignment: { findMany: vi.fn().mockResolvedValue(shifts) },
      bookingGuest: { findMany: vi.fn().mockResolvedValue(stays) },
      booking: { findMany: vi.fn().mockResolvedValue(school.bookings ?? []) },
      lodgeSettings: { findUnique: vi.fn().mockResolvedValue(school.settingsRow ?? null) },
    };
  }

  it("loads only operational, undeleted, consented stays at the leaders' lodges", async () => {
    const db = buildDb(
      [shift({ startDate: d("2026-08-03"), endDate: d("2026-08-05") })],
      [stay("leader", "2026-08-03", "2026-08-05")],
    );

    await loadHutLeaderNightCover(db, {
      scope: { kind: "lodge", lodgeId: "lodge-a" },
      from: d("2026-08-01"),
      to: d("2026-08-31"),
    });

    expect(db.hutLeaderAssignment.findMany).toHaveBeenCalledTimes(1);
    expect(db.hutLeaderAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          lodgeId: "lodge-a",
          startDate: { lte: d("2026-08-31") },
          endDate: { gte: d("2026-08-01") },
        }),
      }),
    );
    expect(db.bookingGuest.findMany).toHaveBeenCalledTimes(1);
    const [[args]] = db.bookingGuest.findMany.mock.calls as [[{ where: Record<string, unknown> }]];
    expect(args.where).toMatchObject({
      memberId: { in: ["leader"] },
      booking: {
        lodgeId: { in: ["lodge-a"] },
        // A cancelled, bumped or pending stay is never loaded, so never covers.
        status: { in: ["PAID", "COMPLETED"] },
        deletedAt: null,
        // Any stay overlapping the window: in by `to`, out after `from`.
        checkIn: { lte: d("2026-08-31") },
        checkOut: { gt: d("2026-08-01") },
      },
      OR: [{ consentStatus: null }, { consentStatus: "CONFIRMED" }],
    });
  });

  it("selects scalar columns only by default, and names only when asked", async () => {
    const db = buildDb([], []);
    const input = { scope: { kind: "all" } as const, from: d("2026-08-01"), to: d("2026-08-31") };

    await loadHutLeaderNightCover(db, input);
    const [[lean]] = db.hutLeaderAssignment.findMany.mock.calls as [[{ select: Record<string, unknown> }]];
    expect(lean.select).not.toHaveProperty("member");
    expect(lean.select).not.toHaveProperty("lodge");

    await loadHutLeaderNightCover(db, { ...input, withNames: true });
    const named = db.hutLeaderAssignment.findMany.mock.calls[1]?.[0] as { select: Record<string, unknown> };
    expect(named.select).toMatchObject({
      member: { select: { firstName: true, lastName: true } },
      lodge: { select: { name: true, active: true } },
    });
  });

  it("skips the stay read when every row is a teacher's", async () => {
    const db = buildDb(
      [shift({ source: "SCHOOL_BOOKING", startDate: d("2026-08-03"), endDate: d("2026-08-05") })],
      [],
    );
    await loadHutLeaderNightCover(db, {
      scope: { kind: "all" },
      from: d("2026-08-01"),
      to: d("2026-08-31"),
    });
    expect(db.bookingGuest.findMany).not.toHaveBeenCalled();
  });

  it("a ticked custodian with no bed covers without a stay", async () => {
    const db = buildDb(
      [shift({ isCustodian: true, startDate: d("2026-08-03"), endDate: d("2026-08-05") })],
      [],
    );
    const cover = await loadHutLeaderNightCover(db, {
      scope: { kind: "lodge", lodgeId: "lodge-a" },
      from: d("2026-08-01"),
      to: d("2026-08-31"),
    });
    expect(cover.isCovered("lodge-a", d("2026-08-04"))).toBe(true);
  });

  it("reads the school bookings at the leaders' lodges, and each school lodge's kinds on the same client (#3819)", async () => {
    const db = buildDb(
      [shift({ isCustodian: true, startDate: d("2026-08-10"), endDate: d("2026-08-12") })],
      [],
      // An own settings row that leaves the custodian unticked.
      { bookings: [SCHOOL], settingsRow: { capacity: null, schoolHutLeaderCustodian: false } },
    );
    const cover = await loadHutLeaderNightCover(db, {
      scope: { kind: "lodge", lodgeId: "lodge-a" },
      from: d("2026-08-01"),
      to: d("2026-08-31"),
    });

    const [[args]] = db.booking.findMany.mock.calls as [[{ where: Record<string, unknown> }]];
    expect(args.where).toEqual({
      lodgeId: { in: ["lodge-a"] },
      deletedAt: null,
      checkIn: { lte: d("2026-08-31") },
      checkOut: { gt: d("2026-08-01") },
      // The capacity engine's population, not the paid-only stay list: an
      // approved school booking is CONFIRMED until its invoice is paid.
      AND: [capacityHoldingBookingFilter(), SCHOOL_GROUP_BOOKING_WHERE],
    });
    expect(db.lodgeSettings.findUnique).toHaveBeenCalledWith({ where: { id: "lodge-a" } });
    // The custodian is present, but this lodge does not accept a custodian
    // for a school night; the night after the school leaves is an ordinary one.
    expect(cover.isCovered("lodge-a", d("2026-08-11"))).toBe(false);
    expect(cover.isCovered("lodge-a", d("2026-08-13"))).toBe(false);
    expect(cover.isCovered("lodge-a", d("2026-08-09"))).toBe(false);
  });

  it("counts a CONFIRMED, not-yet-paid school booking as staying (its teachers cover)", async () => {
    // What the population admits: an approved school booking awaiting its
    // invoice is CONFIRMED, which holds capacity.
    const filter = capacityHoldingBookingFilter() as { OR: Array<{ status?: { in?: string[] } }> };
    expect(filter.OR[0]?.status?.in).toContain(BookingStatus.CONFIRMED);

    // And when the read returns that booking, the lodge's ticked teacher covers.
    const db = buildDb(
      [shift({ source: "SCHOOL_BOOKING", startDate: d("2026-08-10"), endDate: d("2026-08-12") })],
      [],
      { bookings: [SCHOOL], settingsRow: { capacity: null, schoolHutLeaderTeacherOnBooking: true } },
    );
    const cover = await loadHutLeaderNightCover(db, {
      scope: { kind: "lodge", lodgeId: "lodge-a" },
      from: d("2026-08-01"),
      to: d("2026-08-31"),
    });
    expect(cover.isCovered("lodge-a", d("2026-08-11"))).toBe(true);
  });

  it("reads no lodge settings when no school booking is in the window", async () => {
    const db = buildDb(
      [shift({ isCustodian: true, startDate: d("2026-08-10"), endDate: d("2026-08-12") })],
      [],
    );
    const cover = await loadHutLeaderNightCover(db, {
      scope: { kind: "lodge", lodgeId: "lodge-a" },
      from: d("2026-08-01"),
      to: d("2026-08-31"),
    });
    expect(db.lodgeSettings.findUnique).not.toHaveBeenCalled();
    expect(cover.isCovered("lodge-a", d("2026-08-11"))).toBe(true);
  });

  it("isHutLeaderNightCovered answers one lodge night", async () => {
    const db = buildDb(
      [shift({ startDate: d("2026-08-03"), endDate: d("2026-08-05") })],
      [stay("leader", "2026-08-03", "2026-08-05")],
    );
    await expect(
      isHutLeaderNightCovered(db, { lodgeId: "lodge-a", night: d("2026-08-05") }),
    ).resolves.toBe(false);
    await expect(
      isHutLeaderNightCovered(db, { lodgeId: "lodge-a", night: d("2026-08-04") }),
    ).resolves.toBe(true);
  });
});

describe("handovers and covered-night listings", () => {
  // Ann's last night is Wednesday 5 Aug (she leaves Thursday morning); Ben
  // arrives Thursday 6 Aug. Both rows are the old shape, stamped through the
  // checkout day, so Thursday is claimed by both — presence decides.
  const cover = buildHutLeaderNightCover(
    [
      shift({ id: "ann", memberId: "ann", startDate: d("2026-08-03"), endDate: d("2026-08-06") }),
      shift({
        id: "ben",
        memberId: "ben",
        member: { firstName: "Ben", lastName: "Jones" },
        startDate: d("2026-08-06"),
        endDate: d("2026-08-09"),
      }),
    ],
    [stay("ann", "2026-08-03", "2026-08-06"), stay("ben", "2026-08-06", "2026-08-09")],
  );

  it("lists who validly covers each night", () => {
    const rows = listHutLeaderNightLeaders(cover, { from: d("2026-08-05"), to: d("2026-08-06") });
    expect(rows).toEqual([
      { date: "2026-08-05", lodgeId: "lodge-a", leaders: [{ memberId: "ann", name: "Ann Smith" }] },
      { date: "2026-08-06", lodgeId: "lodge-a", leaders: [{ memberId: "ben", name: "Ben Jones" }] },
    ]);
  });

  it("finds Thursday's midday handover and nothing else that week", () => {
    expect(listHutLeaderHandovers(cover, { from: d("2026-08-03"), to: d("2026-08-09") })).toEqual([
      expect.objectContaining({
        date: "2026-08-06",
        lodgeId: "lodge-a",
        lodgeName: "Alpine Lodge",
        from: [{ memberId: "ann", name: "Ann Smith" }],
        to: [{ memberId: "ben", name: "Ben Jones" }],
      }),
    ]);
  });
});

describe("handovers across a one-night overlap", () => {
  // Ann's nights are 3–5 Aug, Ben's 5–8 Aug: both are on duty on night 5 (the
  // one-day overlap the overlap guard allows).
  const cover = buildHutLeaderNightCover(
    [
      shift({ id: "ann", memberId: "ann", startDate: d("2026-08-03"), endDate: d("2026-08-05") }),
      shift({
        id: "ben",
        memberId: "ben",
        member: { firstName: "Ben", lastName: "Jones" },
        startDate: d("2026-08-05"),
        endDate: d("2026-08-08"),
      }),
    ],
    [stay("ann", "2026-08-03", "2026-08-06"), stay("ben", "2026-08-05", "2026-08-09")],
  );

  it("is ONE handover, on the day Ann finishes, with Ann on one side only", () => {
    expect(listHutLeaderHandovers(cover, { from: d("2026-08-03"), to: d("2026-08-09") })).toEqual([
      expect.objectContaining({
        date: "2026-08-06",
        from: [{ memberId: "ann", name: "Ann Smith" }],
        to: [{ memberId: "ben", name: "Ben Jones" }],
      }),
    ]);
  });
});

describe("a school booking's nights obey the lodge's ticked kinds (#3819)", () => {
  // One leader of each kind, each present on night 11 Aug at lodge-a.
  const LEADERS: Record<SchoolHutLeaderKind, { shifts: HutLeaderShift[]; stays: HutLeaderStay[] }> = {
    teacherOnBooking: {
      shifts: [shift({ source: "SCHOOL_BOOKING", startDate: d("2026-08-10"), endDate: d("2026-08-12") })],
      stays: [],
    },
    custodian: {
      shifts: [shift({ isCustodian: true, startDate: d("2026-08-10"), endDate: d("2026-08-12") })],
      stays: [],
    },
    memberOnBooking: {
      shifts: [shift({ startDate: d("2026-08-10"), endDate: d("2026-08-12") })],
      stays: [stay("leader", "2026-08-10", "2026-08-13", { bookingId: SCHOOL.id })],
    },
    memberStayingSeparately: {
      shifts: [shift({ startDate: d("2026-08-10"), endDate: d("2026-08-12") })],
      stays: [stay("leader", "2026-08-10", "2026-08-13", { bookingId: "own-booking" })],
    },
  };

  it.each(SCHOOL_HUT_LEADER_KINDS)("%s covers a school night when ticked, and not when it is the only kind unticked", (kind) => {
    const { shifts, stays } = LEADERS[kind];
    const ticked = buildHutLeaderNightCover(shifts, stays, schoolNights(onlyKinds(kind)));
    expect(ticked.isCovered("lodge-a", d("2026-08-11"))).toBe(true);

    const othersOnly = SCHOOL_HUT_LEADER_KINDS.filter((other) => other !== kind);
    const unticked = buildHutLeaderNightCover(shifts, stays, schoolNights(onlyKinds(...othersOnly)));
    expect(unticked.isCovered("lodge-a", d("2026-08-11"))).toBe(false);
  });

  it("leaves a night with no school booking to the ordinary rule", () => {
    const cover = buildHutLeaderNightCover(
      [shift({ startDate: d("2026-08-08"), endDate: d("2026-08-12") })],
      [stay("leader", "2026-08-08", "2026-08-13", { bookingId: "own-booking" })],
      schoolNights(onlyKinds()),
    );
    // 8-9 Aug: no school there, so nothing is unticked.
    expect(cover.isCovered("lodge-a", d("2026-08-09"))).toBe(true);
    // 10 Aug: the school has arrived and this lodge ticks nothing.
    expect(cover.isCovered("lodge-a", d("2026-08-10"))).toBe(false);
  });

  it("counts a leader of two kinds when either is ticked", () => {
    // A ticked custodian who is also a guest on a booking of their own.
    const cover = buildHutLeaderNightCover(
      LEADERS.custodian.shifts,
      [stay("leader", "2026-08-10", "2026-08-13", { bookingId: "own-booking" })],
      schoolNights(onlyKinds("memberStayingSeparately")),
    );
    expect(cover.isCovered("lodge-a", d("2026-08-11"))).toBe(true);
  });

  it("a lodge with no settings read keeps the defaults: everyone but teachers", () => {
    const teacher = buildHutLeaderNightCover(
      LEADERS.teacherOnBooking.shifts,
      [],
      { bookings: [SCHOOL], kindsByLodge: new Map() },
    );
    expect(teacher.isCovered("lodge-a", d("2026-08-11"))).toBe(false);
    const custodian = buildHutLeaderNightCover(
      LEADERS.custodian.shifts,
      [],
      { bookings: [SCHOOL], kindsByLodge: new Map() },
    );
    expect(custodian.isCovered("lodge-a", d("2026-08-11"))).toBe(true);
  });
});
