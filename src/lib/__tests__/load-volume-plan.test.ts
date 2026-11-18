import { describe, expect, it } from "vitest";
import {
  eachCalendarDate,
  requireCalendarDate,
  type CalendarDate,
} from "@/lib/club-time";
import {
  LOAD_VOLUME_DEFAULTS,
  pastSeasonWindows,
  planLoadVolume,
  type LoadVolumeLodge,
  type LoadVolumeOptions,
} from "../../../prisma/load-volume-plan";

/**
 * #4940: the volume seeder's plan. A load run reads this history through the
 * real admin and member read paths, so it must look like a club's: never more
 * guests on a night than the lodge holds, never one member in two beds, and
 * nothing on or after today.
 */
const day = requireCalendarDate;
const TODAY = day("2026-07-01");

const lodge = (
  id: string,
  capacity: number,
  occupied: Array<[string, number]> = [],
): LoadVolumeLodge => ({
  id,
  capacity,
  seasons: [
    { start: day("2026-04-02"), endExclusive: day("2027-02-25") },
  ],
  occupied: new Map(occupied.map(([night, count]) => [day(night), count])),
});

const options = (over: Partial<LoadVolumeOptions> = {}): LoadVolumeOptions => ({
  ...LOAD_VOLUME_DEFAULTS,
  memberCount: 300,
  today: TODAY,
  lodges: [lodge("lodge-a", 20), lodge("lodge-b", 12)],
  ...over,
});

function occupancyByLodgeNight(plan: ReturnType<typeof planLoadVolume>) {
  const held = new Map<string, number>();
  for (const booking of plan.bookings) {
    for (const night of eachCalendarDate(booking.checkIn, booking.checkOut)) {
      const key = `${booking.lodgeId}|${night}`;
      held.set(key, (held.get(key) ?? 0) + booking.guests.length);
    }
  }
  return held;
}

describe("planLoadVolume", () => {
  it("is deterministic for a seed and differs for another", () => {
    expect(planLoadVolume(options())).toEqual(planLoadVolume(options()));
    expect(planLoadVolume(options({ seed: 1 })).bookings).not.toEqual(
      planLoadVolume(options()).bookings,
    );
  });

  it("builds several seasons of history with guests, cancellations and both payment sources", () => {
    const plan = planLoadVolume(options());
    expect(plan.members).toHaveLength(300);
    expect(plan.members[0]?.local).toBe("load-00001");
    expect(plan.bookings.length).toBeGreaterThan(1000);
    const years = new Set(plan.bookings.map((booking) => booking.checkIn.slice(0, 4)));
    expect(years.size).toBeGreaterThanOrEqual(5);
    expect(plan.bookings.some((b) => b.outcome === "CANCELLED")).toBe(true);
    expect(plan.bookings.some((b) => b.paymentSource === "INTERNET_BANKING")).toBe(true);
    expect(plan.bookings.some((b) => b.cancellationSettlement === "STRIPE_REFUND")).toBe(true);
    expect(plan.bookings.some((b) => b.guests.some((g) => g.kind === "guest"))).toBe(true);
    expect(plan.bookings.some((b) => b.guests.filter((g) => g.kind === "member").length > 1)).toBe(true);
  });

  it("never puts more guests on a night than the lodge holds, counting existing occupancy", () => {
    const plan = planLoadVolume(
      options({
        targetOccupancy: 1,
        lodges: [lodge("lodge-a", 20, [["2025-07-10", 18]]), lodge("lodge-b", 12)],
      }),
    );
    const held = occupancyByLodgeNight(plan);
    for (const [key, count] of held) {
      const capacity = key.startsWith("lodge-a") ? 20 : 12;
      const existing = key === "lodge-a|2025-07-10" ? 18 : 0;
      expect(count + existing, key).toBeLessThanOrEqual(capacity);
    }
    expect(Math.max(...held.values())).toBeGreaterThanOrEqual(10);
  });

  it("never books one member onto two bookings for the same night, across lodges", () => {
    const plan = planLoadVolume(options({ memberCount: 40, targetOccupancy: 1 }));
    const seen = new Set<string>();
    for (const booking of plan.bookings) {
      for (const guest of booking.guests) {
        if (guest.kind !== "member") continue;
        for (const night of eachCalendarDate(booking.checkIn, booking.checkOut)) {
          const key = `${guest.memberIndex}|${night}`;
          expect(seen.has(key), key).toBe(false);
          seen.add(key);
        }
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it("keeps every night strictly before today", () => {
    const plan = planLoadVolume(options());
    for (const booking of plan.bookings) {
      expect(booking.checkOut <= TODAY, booking.checkOut).toBe(true);
    }
  });

  it("refuses nonsense shares and counts", () => {
    expect(() => planLoadVolume(options({ cancelRate: 1.5 }))).toThrow(/cancelRate/);
    expect(() => planLoadVolume(options({ memberCount: 0 }))).toThrow(/memberCount/);
  });
});

describe("pastSeasonWindows", () => {
  it("shifts each season back whole years and clips at today", () => {
    const windows = pastSeasonWindows(
      [{ start: day("2026-06-01"), endExclusive: day("2027-08-01") as CalendarDate }],
      2,
      TODAY,
    );
    expect(windows).toEqual([
      { start: day("2024-06-01"), endExclusive: day("2025-08-01") },
      { start: day("2025-06-01"), endExclusive: TODAY },
    ]);
  });
});
