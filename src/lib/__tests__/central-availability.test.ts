import { beforeEach, describe, expect, it, vi } from "vitest";

// Free beds for a stay (#62, decision D2): the member calendar's number, night
// by night, the smallest of them, never below 0. The calendar function is the
// source, so it is mocked here and its own tests cover the occupancy terms.

const mocks = vi.hoisted(() => ({
  getLodgeCapacity: vi.fn(),
  getMonthAvailability: vi.fn(),
}));
vi.mock("@/lib/capacity", () => ({
  getLodgeCapacity: mocks.getLodgeCapacity,
  getMonthAvailability: mocks.getMonthAvailability,
}));

import { freeBedsForStay } from "@/lib/central-availability";
import { parseDateOnly } from "@/lib/date-only";

/** Occupied beds by night, served per (year, month) the way the calendar does. */
function occupancy(byNight: Record<string, number>) {
  mocks.getMonthAvailability.mockImplementation(async (_lodge: string, year: number, month: number) => {
    const prefix = `${year}-${String(month + 1).padStart(2, "0")}-`;
    return new Map(Object.entries(byNight).filter(([night]) => night.startsWith(prefix)));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getLodgeCapacity.mockResolvedValue(20);
});

const answer = (from: string, to: string) => freeBedsForStay("lodge_1", parseDateOnly(from), parseDateOnly(to));
const stay = async (from: string, to: string) => (await answer(from, to)).freeBeds;

describe("freeBedsForStay", () => {
  it("is the fewest free beds on any night of the stay, check-out night excluded", async () => {
    occupancy({ "2026-07-10": 5, "2026-07-11": 12, "2026-07-12": 3, "2026-07-13": 20 });
    expect(await stay("2026-07-10", "2026-07-13")).toBe(8);
  });

  it("counts a night with no occupancy as the whole capacity", async () => {
    occupancy({});
    expect(await stay("2026-07-10", "2026-07-12")).toBe(20);
  });

  it("reads every month the stay touches, once each", async () => {
    occupancy({ "2026-07-31": 4, "2026-08-01": 15 });
    expect(await stay("2026-07-30", "2026-08-02")).toBe(5);
    expect(mocks.getMonthAvailability.mock.calls.map(([, y, m]) => `${y}-${m}`)).toEqual(["2026-6", "2026-7"]);
  });

  // A whole-lodge-held night arrives from the calendar ALREADY pinned to full
  // (getMonthAvailability's own tests cover that pin); this pins only that a
  // full night gives 0 here.
  it("is 0 on a night the calendar reports as full, as it does a whole-lodge-held one", async () => {
    occupancy({ "2026-07-10": 2, "2026-07-11": 20 });
    expect(await stay("2026-07-10", "2026-07-12")).toBe(0);
  });

  it("is never negative when a night is over-allocated", async () => {
    occupancy({ "2026-07-10": 23 });
    expect(await stay("2026-07-10", "2026-07-11")).toBe(0);
  });
});

describe("freeBedsForStay night by night (#79)", () => {
  it("lists every night of the stay in order, check-out night excluded, each the calendar's own number", async () => {
    occupancy({ "2026-07-31": 4, "2026-08-01": 15, "2026-08-02": 1 });
    expect((await answer("2026-07-30", "2026-08-02")).nights).toEqual([
      { date: "2026-07-30", freeBeds: 20 },
      { date: "2026-07-31", freeBeds: 16 },
      { date: "2026-08-01", freeBeds: 5 },
    ]);
  });

  it("never lists a night below 0, and the stay's number is the fewest of the nights", async () => {
    occupancy({ "2026-07-10": 23, "2026-07-11": 2 });
    const { freeBeds, nights } = await answer("2026-07-10", "2026-07-12");
    expect(nights).toEqual([
      { date: "2026-07-10", freeBeds: 0 },
      { date: "2026-07-11", freeBeds: 18 },
    ]);
    expect(freeBeds).toBe(Math.min(...nights.map((n) => n.freeBeds)));
  });

  it("reads 0 for every night, and 0 for the stay, at a lodge with no capacity", async () => {
    mocks.getLodgeCapacity.mockResolvedValue(-1);
    occupancy({});
    const { freeBeds, nights } = await answer("2026-07-10", "2026-07-12");
    expect(nights.map((n) => n.freeBeds)).toEqual([0, 0]);
    expect(freeBeds).toBe(0);
  });

  it("covers the longest stay, 30 nights across three months, reading each month once", async () => {
    occupancy({ "2027-02-14": 6 });
    const { nights } = await answer("2027-01-31", "2027-03-02");
    expect(nights).toHaveLength(30);
    expect(nights[0]?.date).toBe("2027-01-31");
    expect(nights[29]?.date).toBe("2027-03-01");
    expect(nights.find((n) => n.date === "2027-02-14")?.freeBeds).toBe(14);
    expect(mocks.getMonthAvailability.mock.calls.map(([, y, m]) => `${y}-${m}`)).toEqual(["2027-0", "2027-1", "2027-2"]);
  });
});
