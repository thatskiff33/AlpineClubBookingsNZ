import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { getOccupiedBedsForNight, getOccupiedBedsForNights } from "@/lib/capacity";
import { formatDateOnly, parseDateOnly } from "@/lib/date-only";

const day = parseDateOnly;

/*
  The bookings term the Reports occupancy series reads (#4937). The expected
  counts are written out by hand, not derived from the single-night function,
  because both walk the same index; they are what the per-night loop at
  b17868649 produced, so a range read that drifts from it fails here.
*/
const BOOKINGS = [
  {
    checkIn: day("2026-08-01"),
    checkOut: day("2026-08-04"),
    guests: [
      // Contiguous: the three nights of the booking.
      { stayStart: day("2026-08-01"), stayEnd: day("2026-08-04"), nights: [] },
      // Sparse (#713/#2628): the explicit night set wins, so 2 Aug is a gap.
      {
        stayStart: day("2026-08-01"),
        stayEnd: day("2026-08-04"),
        nights: [{ stayDate: day("2026-08-01") }, { stayDate: day("2026-08-03") }],
      },
    ],
  },
  {
    // Back-to-back with the first: arrives the morning it departs.
    checkIn: day("2026-08-04"),
    checkOut: day("2026-08-06"),
    guests: [
      // No stay fields: falls back to the booking's own nights.
      { stayStart: null, stayEnd: null, nights: [] },
      { stayStart: day("2026-08-05"), stayEnd: day("2026-08-06"), nights: [] },
    ],
  },
  {
    // No stay window at all: never counted, whatever its guests say.
    checkIn: null,
    checkOut: day("2026-08-03"),
    guests: [{ stayStart: day("2026-08-02"), stayEnd: day("2026-08-03"), nights: [] }],
  },
];

const NIGHTS = [
  "2026-07-31",
  "2026-08-01",
  "2026-08-02",
  "2026-08-03",
  "2026-08-04",
  "2026-08-05",
  "2026-08-06",
].map(day);

describe("getOccupiedBedsForNights (#4937)", () => {
  it("counts the bookings term for each night, in the order given", () => {
    const counts = (nights: Date[]) =>
      getOccupiedBedsForNights(nights, BOOKINGS).map(({ night, occupiedBeds }) => [
        formatDateOnly(night),
        occupiedBeds,
      ]);
    const expected = [
      ["2026-07-31", 0],
      ["2026-08-01", 2],
      ["2026-08-02", 1],
      ["2026-08-03", 2],
      ["2026-08-04", 1],
      ["2026-08-05", 2],
      ["2026-08-06", 0],
    ];
    expect(counts(NIGHTS)).toEqual(expected);
    expect(counts([...NIGHTS].reverse())).toEqual([...expected].reverse());
  });

  it("keeps the single-night function's answer on every night", () => {
    expect(NIGHTS.map((night) => getOccupiedBedsForNight(night, BOOKINGS))).toEqual([
      0, 2, 1, 2, 1, 2, 0,
    ]);
  });

  it("returns no counts for no nights", () => {
    expect(getOccupiedBedsForNights([], BOOKINGS)).toEqual([]);
  });
});
