import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingStatus } from "@prisma/client";
import { parseDateOnly } from "@/lib/date-only";

const mocks = vi.hoisted(() => ({
  bookingFindMany: vi.fn(),
  clubModuleSettingsFindUnique: vi.fn(),
  lodgeBedCount: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findMany: mocks.bookingFindMany,
    },
    clubModuleSettings: {
      findUnique: mocks.clubModuleSettingsFindUnique,
    },
    lodgeBed: {
      count: mocks.lodgeBedCount,
    },
  },
}));

import {
  checkCapacity,
  checkCapacityForGuestRanges,
  getMonthAvailability,
} from "@/lib/capacity";
import {
  FALLBACK_LODGE_CAPACITY,
  getLodgeCapacityStatus,
} from "@/lib/lodge-capacity";

const TEST_LODGE_CAPACITY = FALLBACK_LODGE_CAPACITY;
const FEATURE_FLAGS_ON = {
  kiosk: false,
  chores: false,
  financeDashboard: false,
  waitlist: false,
  xeroIntegration: false,
  bedAllocation: true,
  internetBankingPayments: false,
};
const FEATURE_FLAGS_OFF = {
  ...FEATURE_FLAGS_ON,
  bedAllocation: false,
};

describe("capacity calendar availability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bookingFindMany.mockResolvedValue([]);
    mocks.clubModuleSettingsFindUnique.mockResolvedValue(null);
    mocks.lodgeBedCount.mockResolvedValue(0);
  });

  it("uses club config capacity when the bed allocation module is off", async () => {
    const status = await getLodgeCapacityStatus(
      {
        clubModuleSettings: {
          findUnique: mocks.clubModuleSettingsFindUnique,
        },
        lodgeBed: {
          count: mocks.lodgeBedCount,
        },
      } as never,
      FEATURE_FLAGS_OFF,
    );

    expect(status).toMatchObject({
      capacity: TEST_LODGE_CAPACITY,
      source: "club_config",
      bedAllocationEnabled: false,
      activeBedCount: 0,
    });
    expect(mocks.lodgeBedCount).not.toHaveBeenCalled();
  });

  it("uses active configured beds when the bed allocation module is on with beds", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: true });
    mocks.lodgeBedCount.mockResolvedValue(17);

    const status = await getLodgeCapacityStatus(
      {
        clubModuleSettings: {
          findUnique: mocks.clubModuleSettingsFindUnique,
        },
        lodgeBed: {
          count: mocks.lodgeBedCount,
        },
      } as never,
      FEATURE_FLAGS_ON,
    );

    expect(status).toMatchObject({
      capacity: 17,
      source: "configured_beds",
      bedAllocationEnabled: true,
      activeBedCount: 17,
    });
  });

  it("falls back to club config when the bed allocation module is on with zero active beds", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: true });
    mocks.lodgeBedCount.mockResolvedValue(0);

    const status = await getLodgeCapacityStatus(
      {
        clubModuleSettings: {
          findUnique: mocks.clubModuleSettingsFindUnique,
        },
        lodgeBed: {
          count: mocks.lodgeBedCount,
        },
      } as never,
      FEATURE_FLAGS_ON,
    );

    expect(status).toMatchObject({
      capacity: TEST_LODGE_CAPACITY,
      source: "club_config",
      bedAllocationEnabled: true,
      activeBedCount: 0,
    });
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
      TEST_LODGE_CAPACITY - 4
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
    expect(result.minAvailable).toBe(TEST_LODGE_CAPACITY - 4);
    expect(result.nightDetails.map((night) => night.availableBeds)).toEqual([
      TEST_LODGE_CAPACITY - 4,
      TEST_LODGE_CAPACITY - 4,
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
        guests: Array.from({ length: TEST_LODGE_CAPACITY - 1 }, (_, index) => ({
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
        guests: Array.from({ length: TEST_LODGE_CAPACITY - 1 }, (_, index) => ({
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
