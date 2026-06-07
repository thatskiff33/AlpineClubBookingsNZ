import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingStatus } from "@prisma/client";
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

import {
  checkCapacity,
  checkCapacityForGuestRanges,
  getMonthAvailability,
  LODGE_CAPACITY,
} from "@/lib/capacity";

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

  it("queries completed bookings as capacity-holding bookings", async () => {
    await getMonthAvailability(2026, 3);

    const call = mocks.bookingFindMany.mock.calls[0][0];
    expect(call.where.status.in).toEqual(
      expect.arrayContaining([BookingStatus.COMPLETED])
    );
  });

  it("counts completed bookings in monthly occupied beds", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      {
        status: BookingStatus.COMPLETED,
        checkIn: parseDateOnly("2026-04-10"),
        checkOut: parseDateOnly("2026-04-12"),
        guests: [{ id: "g1" }, { id: "g2" }, { id: "g3" }, { id: "g4" }],
      },
    ]);

    const availability = await getMonthAvailability(2026, 3);

    expect(availability.get("2026-04-09")).toBe(0);
    expect(availability.get("2026-04-10")).toBe(4);
    expect(availability.get("2026-04-11")).toBe(4);
    expect(availability.get("2026-04-12")).toBe(0);
  });

  it("counts completed bookings when checking capacity", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      {
        status: BookingStatus.COMPLETED,
        checkIn: parseDateOnly("2026-04-10"),
        checkOut: parseDateOnly("2026-04-12"),
        guests: [{ id: "g1" }, { id: "g2" }, { id: "g3" }, { id: "g4" }],
      },
    ]);

    const result = await checkCapacity(
      parseDateOnly("2026-04-10"),
      parseDateOnly("2026-04-12"),
      LODGE_CAPACITY - 4
    );

    expect(mocks.bookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            in: expect.arrayContaining([BookingStatus.COMPLETED]),
          },
        }),
      })
    );
    expect(result.available).toBe(true);
    expect(result.minAvailable).toBe(LODGE_CAPACITY - 4);
    expect(result.nightDetails.map((night) => night.availableBeds)).toEqual([
      LODGE_CAPACITY - 4,
      LODGE_CAPACITY - 4,
    ]);
  });

  it("counts guests only on nights inside their individual stay ranges", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      {
        status: BookingStatus.PAID,
        checkIn: parseDateOnly("2026-04-10"),
        checkOut: parseDateOnly("2026-04-15"),
        guests: [
          {
            id: "full-stay",
            stayStart: parseDateOnly("2026-04-10"),
            stayEnd: parseDateOnly("2026-04-15"),
          },
          {
            id: "cut-short",
            stayStart: parseDateOnly("2026-04-10"),
            stayEnd: parseDateOnly("2026-04-13"),
          },
        ],
      },
    ]);

    const availability = await getMonthAvailability(2026, 3);

    expect(availability.get("2026-04-09")).toBe(0);
    expect(availability.get("2026-04-10")).toBe(2);
    expect(availability.get("2026-04-11")).toBe(2);
    expect(availability.get("2026-04-12")).toBe(2);
    expect(availability.get("2026-04-13")).toBe(1);
    expect(availability.get("2026-04-14")).toBe(1);
    expect(availability.get("2026-04-15")).toBe(0);
  });

  it("allows proposed staggered guests when only one bed is available per night", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      {
        status: BookingStatus.PAID,
        checkIn: parseDateOnly("2026-04-10"),
        checkOut: parseDateOnly("2026-04-12"),
        guests: Array.from({ length: LODGE_CAPACITY - 1 }, (_, index) => ({
          id: `existing-${index}`,
          stayStart: parseDateOnly("2026-04-10"),
          stayEnd: parseDateOnly("2026-04-12"),
        })),
      },
    ]);

    const result = await checkCapacityForGuestRanges(
      parseDateOnly("2026-04-10"),
      parseDateOnly("2026-04-12"),
      [
        {
          stayStart: parseDateOnly("2026-04-10"),
          stayEnd: parseDateOnly("2026-04-11"),
        },
        {
          stayStart: parseDateOnly("2026-04-11"),
          stayEnd: parseDateOnly("2026-04-12"),
        },
      ]
    );

    expect(result.available).toBe(true);
    expect(result.nightDetails.map((night) => night.availableBeds)).toEqual([0, 0]);
  });

  it("still rejects full-span proposed guests when only one bed is available per night", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      {
        status: BookingStatus.PAID,
        checkIn: parseDateOnly("2026-04-10"),
        checkOut: parseDateOnly("2026-04-12"),
        guests: Array.from({ length: LODGE_CAPACITY - 1 }, (_, index) => ({
          id: `existing-${index}`,
          stayStart: parseDateOnly("2026-04-10"),
          stayEnd: parseDateOnly("2026-04-12"),
        })),
      },
    ]);

    const result = await checkCapacityForGuestRanges(
      parseDateOnly("2026-04-10"),
      parseDateOnly("2026-04-12"),
      [{}, {}]
    );

    expect(result.available).toBe(false);
    expect(result.nightDetails.map((night) => night.availableBeds)).toEqual([-1, -1]);
  });
});
