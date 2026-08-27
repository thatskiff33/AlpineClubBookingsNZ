/**
 * #2628 — a sparse stay can reach "complete".
 *
 * The admin bookings list derives a per-booking `bedState` by diffing the
 * guest-nights it EXPECTS against the `BedAllocation` rows that exist. It used
 * to build the expected set by expanding `stayStart`/`stayEnd`, so a guest
 * booked on nights {1, 3} was also expected on the 2nd. Nothing allocates a bed
 * for the 2nd — the allocator places `BookingGuestNight` rows — so the booking
 * was permanently "partial" and sat in the operational queue for good.
 *
 * Frozen clock discipline: fixtures sit at July 2026, near-future of the frozen
 * 2026-07-01 instant, permanently.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findMany: vi.fn(), count: vi.fn() },
    xeroSyncOperation: { findMany: vi.fn() },
    xeroObjectLink: { findMany: vi.fn() },
  },
}));

import {
  adminBookingsQuerySchema,
  listAdminBookings,
  type AdminBookingsClubDay,
} from "@/lib/admin-bookings-service";
import {
  dateOnlyInstantOf,
  requireCalendarDate,
  requireClubTimeZone,
} from "@/lib/club-time";

/**
 * The club's day and zone these cases mean, stated rather than read (#3123).
 * `listAdminBookings` and its `where` builders take them as data instead of
 * projecting through `APP_TIME_ZONE`; that the value comes from the PERSISTED
 * club timezone is pinned in `admin-bookings-club-time-authority.test.ts`.
 */
const TEST_CLUB_DAY: AdminBookingsClubDay = {
  zone: requireClubTimeZone("Pacific/Auckland"),
  today: dateOnlyInstantOf(requireCalendarDate("2026-07-01")),
};
import { prisma } from "@/lib/prisma";
import { installAdminBookingsDbMock } from "./admin-bookings-db-mock";

function night(day: string) {
  return new Date(`2026-07-${day}T00:00:00.000Z`);
}

function allocation(stayDate: Date) {
  return {
    id: `alloc-${stayDate.toISOString()}`,
    bookingId: "booking-1",
    bookingGuestId: "guest-1",
    roomId: "room-a",
    bedId: "bed-a1",
    stayDate,
    approvedAt: new Date("2026-06-20T00:00:00.000Z"),
    bookingGuest: { ageTier: "ADULT" },
  };
}

/**
 * One PAID booking whose single guest has an envelope of 1st..4th (three
 * nights) but only the night rows `nights` says.
 */
function bookingWith(
  nights: Date[],
  allocations: Date[],
): Record<string, unknown> {
  return {
    id: "booking-1",
    status: "PAID",
    checkIn: night("01"),
    checkOut: night("04"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    finalPriceCents: 10_000,
    requiresAdminReview: false,
    adminReviewStatus: null,
    adminReviewReason: null,
    deletedAt: null,
    wholeLodgeHold: false,
    member: {
      id: "member-1",
      firstName: "Aroha",
      lastName: "Ngata",
      email: "aroha@example.test",
    },
    guests: [
      {
        id: "guest-1",
        firstName: "Aroha",
        lastName: "Ngata",
        ageTier: "ADULT",
        isMember: true,
        stayStart: night("01"),
        stayEnd: night("04"),
        nights: nights.map((stayDate) => ({ stayDate })),
      },
    ],
    _count: { guests: 1 },
    payment: null,
    bedAllocations: allocations.map(allocation),
    modifications: [],
    changeRequests: [],
    creditsFromCancellation: [],
    refundRequests: [],
  };
}

async function bedStateFor(booking: Record<string, unknown>) {
  installAdminBookingsDbMock([booking]);
  const result = await listAdminBookings(adminBookingsQuerySchema.parse({}), {}, TEST_CLUB_DAY);
  return result.bookings[0].operational;
}

describe("admin bookings bed state on a sparse stay (#2628)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.xeroSyncOperation.findMany).mockResolvedValue([]);
    vi.mocked(prisma.xeroObjectLink.findMany).mockResolvedValue([]);
  });

  it("reaches complete when every night in the SET has a bed", async () => {
    // Nights {1, 3}; the gap night 2 is an absence, not an unallocated night.
    const row = await bedStateFor(
      bookingWith([night("01"), night("03")], [night("01"), night("03")]),
    );

    expect(row.expectedGuestNights).toBe(2);
    expect(row.allocatedGuestNights).toBe(2);
    expect(row.bedState).toBe("complete");
  });

  it("still reports partial when a real night of a sparse stay has no bed", async () => {
    // The positive control: the fix makes the state accurate, not permissive.
    const row = await bedStateFor(
      bookingWith([night("01"), night("03")], [night("01")]),
    );

    expect(row.expectedGuestNights).toBe(2);
    expect(row.allocatedGuestNights).toBe(1);
    expect(row.bedState).toBe("partial");
  });

  it("does not count the gap night even when something allocated a bed on it", async () => {
    // A stale row on the gap night is not evidence the guest is there. The
    // expected set is the night set, so the gap allocation matches nothing.
    const row = await bedStateFor(
      bookingWith([night("01"), night("03")], [night("01"), night("02"), night("03")]),
    );

    expect(row.expectedGuestNights).toBe(2);
    expect(row.allocatedGuestNights).toBe(2);
    expect(row.bedState).toBe("complete");
  });

  it("is unchanged for a contiguous stay", async () => {
    const row = await bedStateFor(
      bookingWith(
        [night("01"), night("02"), night("03")],
        [night("01"), night("02")],
      ),
    );

    expect(row.expectedGuestNights).toBe(3);
    expect(row.allocatedGuestNights).toBe(2);
    expect(row.bedState).toBe("partial");
  });

  it("is unchanged for a legacy guest carrying no night rows", async () => {
    // Pre-#713 rows have only the envelope, so `getGuestBedNightKeys` falls back
    // to it and this booking behaves exactly as it did before #2628.
    const booking = bookingWith([], [night("01"), night("02"), night("03")]);
    (booking.guests as Array<Record<string, unknown>>)[0].nights = [];

    const row = await bedStateFor(booking);

    expect(row.expectedGuestNights).toBe(3);
    expect(row.allocatedGuestNights).toBe(3);
    expect(row.bedState).toBe("complete");
  });
});
