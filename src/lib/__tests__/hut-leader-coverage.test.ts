import { describe, expect, it, vi } from "vitest";
import { getUnassignedHutLeaderDates } from "@/lib/hut-leader-coverage";

function dateOnly(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function buildDb(options: {
  hutLeaderLookaheadDays?: number;
  bookings?: Array<{
    checkIn: Date;
    checkOut: Date;
    guests?: Array<{ stayStart?: Date | null; stayEnd?: Date | null }>;
  }>;
  assignments?: Array<{ startDate: Date; endDate: Date }>;
}) {
  return {
    lodgeSettings: {
      findUnique: vi.fn().mockResolvedValue({
        capacity: null,
        hutLeaderLookaheadDays: options.hutLeaderLookaheadDays,
      }),
    },
    booking: {
      findMany: vi.fn().mockResolvedValue(options.bookings ?? []),
    },
    hutLeaderAssignment: {
      findMany: vi.fn().mockResolvedValue(options.assignments ?? []),
    },
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
        db: buildDb({ hutLeaderLookaheadDays: 3, bookings: [booking] }),
        today,
      }),
    ).resolves.toEqual([]);

    await expect(
      getUnassignedHutLeaderDates({
        db: buildDb({ hutLeaderLookaheadDays: 6, bookings: [booking] }),
        today,
      }),
    ).resolves.toEqual([
      {
        date: "2026-04-15",
        bookingCount: 1,
        guestCount: 2,
      },
    ]);
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
      db,
      today: dateOnly("2026-04-10"),
      lookAheadDays: 6,
    });

    expect(db.lodgeSettings.findUnique).not.toHaveBeenCalled();
    expect(result.map((item) => item.date)).toEqual(["2026-04-15"]);
  });
});
