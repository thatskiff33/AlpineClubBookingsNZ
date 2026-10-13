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

const stay = (from: string, to: string) => freeBedsForStay("lodge_1", parseDateOnly(from), parseDateOnly(to));

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

  it("is 0 on a whole-lodge-held night, which the calendar reports as full", async () => {
    occupancy({ "2026-07-10": 2, "2026-07-11": 20 });
    expect(await stay("2026-07-10", "2026-07-12")).toBe(0);
  });

  it("is never negative when a night is over-allocated", async () => {
    occupancy({ "2026-07-10": 23 });
    expect(await stay("2026-07-10", "2026-07-11")).toBe(0);
  });
});
