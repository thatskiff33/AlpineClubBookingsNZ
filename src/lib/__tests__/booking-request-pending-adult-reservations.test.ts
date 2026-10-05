import { describe, expect, it, vi } from "vitest";
import { parseDateOnly } from "@/lib/date-only";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  buildLodgePendingAdultReservationCounter,
  buildPendingAdultReservationNightIndex,
  findPendingAdultReservationNights,
} from "@/lib/booking-request-pending-adult-reservations";

const LODGE = "lodge-a";

describe("pending school-adult capacity reservations", () => {
  it("sums capacity-only adult counts across requests by lodge night", () => {
    const nights = ["2026-07-01", "2026-07-02"].map(parseDateOnly);
    const index = buildPendingAdultReservationNightIndex(
      [
        { night: parseDateOnly("2026-07-01"), adultCount: 2 },
        { night: parseDateOnly("2026-07-01"), adultCount: 1 },
        { night: parseDateOnly("2026-07-02"), adultCount: 3 },
      ],
      nights,
    );
    expect(index.get("2026-07-01")).toBe(3);
    expect(index.get("2026-07-02")).toBe(3);
  });

  it("uses the exact lodge and half-open date window", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await findPendingAdultReservationNights({
      lodgeId: LODGE,
      from: parseDateOnly("2026-07-01"),
      toExclusive: parseDateOnly("2026-07-03"),
      db: { bookingRequestPendingAdultReservationNight: { findMany } } as never,
    });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        lodgeId: LODGE,
        night: {
          gte: parseDateOnly("2026-07-01"),
          lt: parseDateOnly("2026-07-03"),
        },
      },
      select: { night: true, adultCount: true },
    });
  });

  it("excludes the edited booking's own anonymous reservation", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await findPendingAdultReservationNights({
      lodgeId: LODGE,
      from: parseDateOnly("2026-07-01"),
      toExclusive: parseDateOnly("2026-07-02"),
      excludeBookingId: "edited-booking",
      db: { bookingRequestPendingAdultReservationNight: { findMany } } as never,
    });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ bookingId: { not: "edited-booking" } }),
    }));
  });

  it("returns zero for an old partial capacity test double", async () => {
    const counter = await buildLodgePendingAdultReservationCounter({
      lodgeId: LODGE,
      from: parseDateOnly("2026-07-01"),
      toExclusive: parseDateOnly("2026-07-02"),
      nights: [parseDateOnly("2026-07-01")],
      db: {} as never,
    });
    expect(counter(parseDateOnly("2026-07-01"))).toBe(0);
  });
});
