import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDateOnly } from "@/lib/date-only";

const mocks = vi.hoisted(() => ({
  bookingFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findMany: mocks.bookingFindMany,
    },
  },
}));

import { getMonthAvailability } from "@/lib/capacity";

describe("capacity calendar availability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bookingFindMany.mockResolvedValue([]);
  });

  it("emits one key for each date-only day in the requested month", async () => {
    const availability = await getMonthAvailability(2026, 3);
    const keys = [...availability.keys()];

    expect(keys).toHaveLength(30);
    expect(keys[0]).toBe("2026-04-01");
    expect(keys.at(-1)).toBe("2026-04-30");
    expect(availability.get("2026-04-30")).toBe(0);
    expect(availability.has("2026-03-31")).toBe(false);
  });

  it("queries the full month using date-only exclusive end boundaries", async () => {
    await getMonthAvailability(2026, 3);

    const call = mocks.bookingFindMany.mock.calls[0][0];
    expect(call.where.checkIn.lt).toEqual(parseDateOnly("2026-05-01"));
    expect(call.where.checkOut.gt).toEqual(parseDateOnly("2026-04-01"));
  });

  it("counts bookings that start on the final day of the month", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      {
        checkIn: parseDateOnly("2026-04-30"),
        checkOut: parseDateOnly("2026-05-02"),
        guests: [{ id: "g1" }, { id: "g2" }],
      },
    ]);

    const availability = await getMonthAvailability(2026, 3);

    expect(availability.get("2026-04-29")).toBe(0);
    expect(availability.get("2026-04-30")).toBe(2);
  });
});
