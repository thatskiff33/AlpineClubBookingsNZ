import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDateOnly } from "@/lib/date-only";

// The real capacity engine, with a mocked module client that carries the
// reservation delegate — this proves a HELD policy-exception reservation counts
// as occupancy in the canonical calculation (#2525), and that removing it frees
// the beds again (the mutation check).
const mocks = vi.hoisted(() => ({
  bookingFindMany: vi.fn(),
  hutLeaderFindMany: vi.fn(),
  reservationFindMany: vi.fn(),
  getLodgeCapacity: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findMany: mocks.bookingFindMany },
    hutLeaderAssignment: { findMany: mocks.hutLeaderFindMany },
    policyExceptionReservationNight: { findMany: mocks.reservationFindMany },
  },
}));

vi.mock("@/lib/lodge-capacity", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/lodge-capacity");
  return { ...actual, getLodgeCapacity: mocks.getLodgeCapacity };
});

import { checkCapacity, checkCapacityForGuestRanges } from "@/lib/capacity";

const LODGE = "lodge-a";
const CAPACITY = 10;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bookingFindMany.mockResolvedValue([]);
  mocks.hutLeaderFindMany.mockResolvedValue([]);
  mocks.reservationFindMany.mockResolvedValue([]);
  mocks.getLodgeCapacity.mockResolvedValue(CAPACITY);
});

function oneGuestRange() {
  return [
    {
      stayStart: parseDateOnly("2026-07-01"),
      stayEnd: parseDateOnly("2026-07-02"),
      nights: [{ stayDate: parseDateOnly("2026-07-01") }],
    },
  ];
}

describe("policy-exception reservations count as occupancy in capacity", () => {
  it("checkCapacityForGuestRanges subtracts a held reservation's beds", async () => {
    mocks.reservationFindMany.mockResolvedValue([
      { night: parseDateOnly("2026-07-01"), beds: 3 },
    ]);
    const result = await checkCapacityForGuestRanges(
      LODGE,
      parseDateOnly("2026-07-01"),
      parseDateOnly("2026-07-02"),
      oneGuestRange() as never,
    );
    // 10 capacity - 3 reserved - 1 proposed = 6.
    expect(result.nightDetails[0].occupiedBeds).toBe(4); // 3 reserved + 1 proposed
    expect(result.nightDetails[0].availableBeds).toBe(6);
    expect(result.available).toBe(true);
  });

  it("MUTATION: removing the reservation frees exactly those beds", async () => {
    // Same call, no reservation => 10 - 0 - 1 = 9 available (proves the 3-bed
    // delta above came from the reservation, not from anywhere else).
    const result = await checkCapacityForGuestRanges(
      LODGE,
      parseDateOnly("2026-07-01"),
      parseDateOnly("2026-07-02"),
      oneGuestRange() as never,
    );
    expect(result.nightDetails[0].availableBeds).toBe(9);
  });

  it("a reservation that fills the lodge forces a capacity refusal", async () => {
    mocks.reservationFindMany.mockResolvedValue([
      { night: parseDateOnly("2026-07-01"), beds: CAPACITY },
    ]);
    const result = await checkCapacityForGuestRanges(
      LODGE,
      parseDateOnly("2026-07-01"),
      parseDateOnly("2026-07-02"),
      oneGuestRange() as never,
    );
    expect(result.available).toBe(false);
    expect(result.minAvailable).toBeLessThan(0);
  });

  it("checkCapacity counts held reservations in occupiedBeds too", async () => {
    mocks.reservationFindMany.mockResolvedValue([
      { night: parseDateOnly("2026-07-01"), beds: 4 },
    ]);
    const result = await checkCapacity(
      LODGE,
      parseDateOnly("2026-07-01"),
      parseDateOnly("2026-07-02"),
      2,
    );
    // occupiedBeds = 4 reserved; availableBeds = 10 - 4 = 6; need 2 => available.
    expect(result.nightDetails[0].occupiedBeds).toBe(4);
    expect(result.nightDetails[0].availableBeds).toBe(6);
    expect(result.available).toBe(true);
  });
});
