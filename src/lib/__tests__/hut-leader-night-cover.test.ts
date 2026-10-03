import { describe, expect, it, vi } from "vitest";

import {
  buildHutLeaderNightCover,
  isHutLeaderNightCovered,
  listHutLeaderHandovers,
  listHutLeaderNightLeaders,
  loadHutLeaderNightCover,
  type HutLeaderShift,
  type HutLeaderStay,
} from "@/lib/hut-leader-night-cover";

/**
 * The one presence-aware coverage definition (#3818, `INV-DATE-030`): a night
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
    member: { firstName: "Ann", lastName: "Smith" },
    lodge: { name: "Alpine Lodge", active: true },
    ...overrides,
  };
}

function stay(
  memberId: string,
  checkIn: string,
  checkOut: string,
  options: { lodgeId?: string; nights?: string[] } = {},
): HutLeaderStay {
  return {
    memberId,
    stayStart: d(checkIn),
    stayEnd: d(checkOut),
    nights: (options.nights ?? []).map((night) => ({ stayDate: d(night) })),
    booking: { lodgeId: options.lodgeId ?? "lodge-a", checkIn: d(checkIn), checkOut: d(checkOut) },
  };
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

  it("a school-booking teacher row covers its booking's nights, arrival to checkout − 1", () => {
    // The school writer stamps request.checkIn .. request.checkOut; teachers are
    // not booking guests, so no stay is loaded for them.
    const cover = buildHutLeaderNightCover(
      [shift({ source: "SCHOOL_BOOKING", startDate: d("2026-08-10"), endDate: d("2026-08-13") })],
      [],
    );
    expect(cover.isCovered("lodge-a", d("2026-08-10"))).toBe(true);
    expect(cover.isCovered("lodge-a", d("2026-08-12"))).toBe(true);
    expect(cover.isCovered("lodge-a", d("2026-08-13"))).toBe(false);
  });

  it("a custodian's bed hold is presence on every night it covers, inclusive (INV-LIFE-062)", () => {
    const cover = buildHutLeaderNightCover(
      [shift({ bedId: "bed-1", startDate: d("2026-08-10"), endDate: d("2026-08-12") })],
      [],
    );
    expect(cover.isCovered("lodge-a", d("2026-08-12"))).toBe(true);
    expect(cover.isCovered("lodge-a", d("2026-08-13"))).toBe(false);
  });
});

describe("loadHutLeaderNightCover", () => {
  function buildDb(shifts: HutLeaderShift[], stays: HutLeaderStay[]) {
    return {
      hutLeaderAssignment: { findMany: vi.fn().mockResolvedValue(shifts) },
      bookingGuest: { findMany: vi.fn().mockResolvedValue(stays) },
    };
  }

  it("reads in two queries and loads only operational, undeleted, consented stays at the leaders' lodges", async () => {
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

  it("skips the stay read when no row needs a member stay", async () => {
    const db = buildDb(
      [shift({ bedId: "bed-1", startDate: d("2026-08-03"), endDate: d("2026-08-05") })],
      [],
    );
    await loadHutLeaderNightCover(db, {
      scope: { kind: "all" },
      from: d("2026-08-01"),
      to: d("2026-08-31"),
    });
    expect(db.bookingGuest.findMany).not.toHaveBeenCalled();
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
