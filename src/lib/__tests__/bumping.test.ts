import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Prisma
const mockFindMany = vi.fn();
const mockUpdate = vi.fn();
const mockFindUnique = vi.fn();
const mockTransaction = vi.fn();

vi.mock("../prisma", () => ({
  prisma: {
    booking: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
    },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

// Mock email
vi.mock("../email", () => ({
  sendBookingBumpedEmail: vi.fn(),
  sendBookingConfirmedEmail: vi.fn(),
  sendBookingPendingEmail: vi.fn(),
  sendAdminBookingBumpedAlert: vi.fn().mockResolvedValue(undefined),
}));

import {
  getOccupiedBedsPerNight,
  findBumpCandidates,
  wouldExceedCapacity,
  bumpPendingBookings,
  sendBumpedNotifications,
} from "../bumping";
import { FALLBACK_LODGE_CAPACITY as LODGE_CAPACITY } from "../lodge-capacity";
import { sendBookingBumpedEmail } from "../email";

// Helper mock for promoRedemption (returns null = no promo used)
const mockPromoRedemption = {
  findUnique: vi.fn().mockResolvedValue(null),
  delete: vi.fn().mockResolvedValue({}),
};
const mockPromoCode = {
  update: vi.fn().mockResolvedValue({}),
};

// Helper to create a fake booking with guests
function makeBooking(
  id: string,
  checkIn: string,
  checkOut: string,
  guestCount: number,
  status: string = "PENDING",
  createdAt: string = "2026-01-01T00:00:00Z"
) {
  return {
    id,
    checkIn: new Date(checkIn),
    checkOut: new Date(checkOut),
    status,
    createdAt: new Date(createdAt),
    memberId: `member_${id}`,
    member: {
      id: `member_${id}`,
      email: `${id}@example.com`,
      firstName: "Test",
      lastName: "User",
    },
    guests: Array.from({ length: guestCount }, (_, i) => ({
      id: `guest_${id}_${i}`,
      bookingId: id,
      firstName: `Guest${i}`,
      lastName: "Test",
      ageTier: "ADULT",
      isMember: false,
      priceCents: 5000,
    })),
  };
}

describe("Bumping Algorithm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("wouldExceedCapacity", () => {
    it("returns false when adding guests stays within capacity", () => {
      const occupied = new Map([["2026-07-10", LODGE_CAPACITY - 5]]);
      expect(wouldExceedCapacity(occupied, 5)).toBe(false);
    });

    it("returns false when exactly at capacity", () => {
      const occupied = new Map([["2026-07-10", LODGE_CAPACITY - 4]]);
      expect(wouldExceedCapacity(occupied, 4)).toBe(false);
    });

    it("returns true when adding guests exceeds capacity", () => {
      const occupied = new Map([["2026-07-10", LODGE_CAPACITY - 3]]);
      expect(wouldExceedCapacity(occupied, 4)).toBe(true);
    });

    it("checks all nights - returns true if any night exceeds", () => {
      const occupied = new Map([
        ["2026-07-10", LODGE_CAPACITY - 9],
        ["2026-07-11", LODGE_CAPACITY - 1],
        ["2026-07-12", LODGE_CAPACITY - 14],
      ]);
      expect(wouldExceedCapacity(occupied, 2)).toBe(true);
    });

    it("returns false when all nights have room", () => {
      const occupied = new Map([
        ["2026-07-10", LODGE_CAPACITY - 9],
        ["2026-07-11", LODGE_CAPACITY - 4],
        ["2026-07-12", LODGE_CAPACITY - 14],
      ]);
      expect(wouldExceedCapacity(occupied, 4)).toBe(false);
    });
  });

  describe("getOccupiedBedsPerNight", () => {
    it("counts guests from overlapping CONFIRMED and PENDING bookings", async () => {
      const bookings = [
        makeBooking("b1", "2026-07-10", "2026-07-12", 3, "CONFIRMED"),
        makeBooking("b2", "2026-07-11", "2026-07-13", 2, "PENDING"),
      ];

      const txMock = {
        booking: {
          findMany: vi.fn().mockResolvedValue(bookings),
        },
      };

      const result = await getOccupiedBedsPerNight(
        new Date("2026-07-10"),
        new Date("2026-07-13"),
        [],
        txMock as never
      );

      // July 10: only b1 (3 guests)
      expect(result.get("2026-07-10")).toBe(3);
      // July 11: b1 (3) + b2 (2) = 5
      expect(result.get("2026-07-11")).toBe(5);
      // July 12: only b2 (2 guests)
      expect(result.get("2026-07-12")).toBe(2);
    });

    it("excludes specified booking IDs", async () => {
      const txMock = {
        booking: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      };

      await getOccupiedBedsPerNight(
        new Date("2026-07-10"),
        new Date("2026-07-12"),
        ["excluded_id"],
        txMock as never
      );

      expect(txMock.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { notIn: ["excluded_id"] },
          }),
        })
      );
    });

    it("returns empty occupancy for date range with no bookings", async () => {
      const txMock = {
        booking: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      };

      const result = await getOccupiedBedsPerNight(
        new Date("2026-07-10"),
        new Date("2026-07-12"),
        [],
        txMock as never
      );

      expect(result.get("2026-07-10")).toBe(0);
      expect(result.get("2026-07-11")).toBe(0);
    });
  });

  describe("findBumpCandidates", () => {
    it("returns PENDING bookings sorted by createdAt DESC", async () => {
      const txMock = {
        booking: {
          findMany: vi.fn().mockResolvedValue([
            makeBooking("b2", "2026-07-10", "2026-07-12", 2, "PENDING", "2026-03-15"),
            makeBooking("b1", "2026-07-10", "2026-07-12", 3, "PENDING", "2026-03-10"),
          ]),
        },
      };

      const result = await findBumpCandidates(
        new Date("2026-07-10"),
        new Date("2026-07-12"),
        txMock as never
      );

      expect(txMock.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: "PENDING",
          }),
          orderBy: { createdAt: "desc" },
        })
      );
      expect(result).toHaveLength(2);
    });
  });

  describe("bumpPendingBookings", () => {
    it("returns no bumps when capacity is not exceeded", async () => {
      const txMock = {
        booking: {
          findMany: vi.fn().mockResolvedValue([]),
          update: vi.fn(),
        },
        promoRedemption: mockPromoRedemption,
        promoCode: mockPromoCode,
      };

      const result = await bumpPendingBookings(
        new Date("2026-07-10"),
        new Date("2026-07-12"),
        5,
        txMock as never
      );

      expect(result.bumpedBookingIds).toHaveLength(0);
      expect(result.capacityRestored).toBe(true);
    });

    it("does not bump for staggered proposed guests on nights they are not active", async () => {
      const fullFirstNight = makeBooking(
        "conf1", "2026-07-10", "2026-07-11", LODGE_CAPACITY, "CONFIRMED"
      );
      const oneBedLeftSecondNight = makeBooking(
        "conf2", "2026-07-11", "2026-07-12", LODGE_CAPACITY - 1, "CONFIRMED"
      );
      const txMock = {
        booking: {
          findMany: vi.fn().mockResolvedValue([
            fullFirstNight,
            oneBedLeftSecondNight,
          ]),
          update: vi.fn(),
        },
        promoRedemption: mockPromoRedemption,
        promoCode: mockPromoCode,
      };

      const result = await bumpPendingBookings(
        new Date("2026-07-10"),
        new Date("2026-07-12"),
        [
          {
            stayStart: new Date("2026-07-11"),
            stayEnd: new Date("2026-07-12"),
          },
        ],
        txMock as never
      );

      expect(result.bumpedBookingIds).toHaveLength(0);
      expect(result.capacityRestored).toBe(true);
      expect(txMock.booking.update).not.toHaveBeenCalled();
    });

    it("bumps most recent PENDING booking first when capacity exceeded", async () => {
      const existingConfirmed = makeBooking(
        "conf1", "2026-07-10", "2026-07-12", LODGE_CAPACITY - 4, "CONFIRMED"
      );
      const pendingOld = makeBooking(
        "pend1", "2026-07-10", "2026-07-12", 2, "PENDING", "2026-03-01"
      );

      // First call: getOccupiedBedsPerNight (all bookings)
      // Second call: findBumpCandidates (only PENDING)
      const findManyCallCount = { count: 0 };
      const txMock = {
        booking: {
          findMany: vi.fn().mockImplementation(() => {
            findManyCallCount.count++;
            if (findManyCallCount.count === 1) {
              // getOccupiedBedsPerNight - returns all overlapping
              return [existingConfirmed, pendingOld];
            }
            // findBumpCandidates - returns only PENDING
            return [pendingOld];
          }),
          update: vi.fn().mockResolvedValue({}),
        },
        promoRedemption: mockPromoRedemption,
        promoCode: mockPromoCode,
      };

      const result = await bumpPendingBookings(
        new Date("2026-07-10"),
        new Date("2026-07-12"),
        4,
        txMock as never
      );

      // 25 + 2 = 27 current. 27 + 4 = 31 > 29. Need to bump pendingOld (2 guests).
      // After bump: 25 + 4 = 29 <= 29. Capacity restored.
      expect(result.bumpedBookingIds).toContain("pend1");
      expect(result.capacityRestored).toBe(true);
      expect(txMock.booking.update).toHaveBeenCalledWith({
        where: { id: "pend1" },
        data: { status: "BUMPED" },
      });
    });

    it("bumps multiple bookings until capacity is restored", async () => {
      const existingConfirmed = makeBooking(
        "conf1", "2026-07-10", "2026-07-12", LODGE_CAPACITY - 5, "CONFIRMED"
      );
      const pendingNew = makeBooking(
        "pend2", "2026-07-10", "2026-07-12", 3, "PENDING", "2026-03-15"
      );
      const pendingOld = makeBooking(
        "pend1", "2026-07-10", "2026-07-12", 2, "PENDING", "2026-03-01"
      );

      const findManyCallCount = { count: 0 };
      const txMock = {
        booking: {
          findMany: vi.fn().mockImplementation(() => {
            findManyCallCount.count++;
            if (findManyCallCount.count === 1) {
              return [existingConfirmed, pendingNew, pendingOld];
            }
            // FIFO: most recent first
            return [pendingNew, pendingOld];
          }),
          update: vi.fn().mockResolvedValue({}),
        },
        promoRedemption: mockPromoRedemption,
        promoCode: mockPromoCode,
      };

      const result = await bumpPendingBookings(
        new Date("2026-07-10"),
        new Date("2026-07-12"),
        5,
        txMock as never
      );

      expect(result.bumpedBookingIds).toEqual(["pend2", "pend1"]);
      expect(result.capacityRestored).toBe(true);
    });

    it("stops bumping once capacity is restored", async () => {
      const existingConfirmed = makeBooking(
        "conf1", "2026-07-10", "2026-07-12", LODGE_CAPACITY - 5, "CONFIRMED"
      );
      const pendingNew = makeBooking(
        "pend2", "2026-07-10", "2026-07-12", 4, "PENDING", "2026-03-15"
      );
      const pendingOld = makeBooking(
        "pend1", "2026-07-10", "2026-07-12", 2, "PENDING", "2026-03-01"
      );

      const findManyCallCount = { count: 0 };
      const txMock = {
        booking: {
          findMany: vi.fn().mockImplementation(() => {
            findManyCallCount.count++;
            if (findManyCallCount.count === 1) {
              return [existingConfirmed, pendingNew, pendingOld];
            }
            return [pendingNew, pendingOld];
          }),
          update: vi.fn().mockResolvedValue({}),
        },
        promoRedemption: mockPromoRedemption,
        promoCode: mockPromoCode,
      };

      const result = await bumpPendingBookings(
        new Date("2026-07-10"),
        new Date("2026-07-12"),
        3,
        txMock as never
      );

      expect(result.bumpedBookingIds).toEqual(["pend2"]);
      expect(result.capacityRestored).toBe(true);
      // pend1 should NOT be bumped
      expect(txMock.booking.update).toHaveBeenCalledTimes(1);
    });

    it("returns capacityRestored=false when no PENDING bookings exist", async () => {
      const existingConfirmed = makeBooking(
        "conf1", "2026-07-10", "2026-07-12", LODGE_CAPACITY - 1, "CONFIRMED"
      );

      const findManyCallCount = { count: 0 };
      const txMock = {
        booking: {
          findMany: vi.fn().mockImplementation(() => {
            findManyCallCount.count++;
            if (findManyCallCount.count === 1) {
              return [existingConfirmed];
            }
            return []; // No PENDING bookings to bump
          }),
          update: vi.fn(),
        },
        promoRedemption: mockPromoRedemption,
        promoCode: mockPromoCode,
      };

      const result = await bumpPendingBookings(
        new Date("2026-07-10"),
        new Date("2026-07-12"),
        3,
        txMock as never
      );

      expect(result.bumpedBookingIds).toHaveLength(0);
      expect(result.capacityRestored).toBe(false);
    });

    it("returns capacityRestored=false when bumping all PENDING still not enough", async () => {
      const existingConfirmed = makeBooking(
        "conf1", "2026-07-10", "2026-07-12", LODGE_CAPACITY - 3, "CONFIRMED"
      );
      const pendingSmall = makeBooking(
        "pend1", "2026-07-10", "2026-07-12", 1, "PENDING", "2026-03-01"
      );

      const findManyCallCount = { count: 0 };
      const txMock = {
        booking: {
          findMany: vi.fn().mockImplementation(() => {
            findManyCallCount.count++;
            if (findManyCallCount.count === 1) {
              return [existingConfirmed, pendingSmall];
            }
            return [pendingSmall];
          }),
          update: vi.fn().mockResolvedValue({}),
        },
        promoRedemption: mockPromoRedemption,
        promoCode: mockPromoCode,
      };

      const result = await bumpPendingBookings(
        new Date("2026-07-10"),
        new Date("2026-07-12"),
        5,
        txMock as never
      );

      expect(result.bumpedBookingIds).toEqual(["pend1"]);
      expect(result.capacityRestored).toBe(false);
    });

    it("handles multi-night bookings where only some nights are tight", async () => {
      const confFull = makeBooking(
        "conf1", "2026-07-10", "2026-07-11", LODGE_CAPACITY - 7, "CONFIRMED"
      );
      const confPartial = makeBooking(
        "conf2", "2026-07-10", "2026-07-12", 5, "CONFIRMED"
      );
      const pendOverlap = makeBooking(
        "pend1", "2026-07-10", "2026-07-11", 3, "PENDING", "2026-03-01"
      );
      const findManyCallCount = { count: 0 };
      const txMock = {
        booking: {
          findMany: vi.fn().mockImplementation(() => {
            findManyCallCount.count++;
            if (findManyCallCount.count === 1) {
              return [confFull, confPartial, pendOverlap];
            }
            return [pendOverlap];
          }),
          update: vi.fn().mockResolvedValue({}),
        },
        promoRedemption: mockPromoRedemption,
        promoCode: mockPromoCode,
      };

      const result = await bumpPendingBookings(
        new Date("2026-07-10"),
        new Date("2026-07-12"),
        4,
        txMock as never
      );

      expect(result.capacityRestored).toBe(false);
    });
  });

  describe("sendBumpedNotifications", () => {
    it("sends emails for each bumped booking", async () => {
      const booking = makeBooking("b1", "2026-07-10", "2026-07-12", 2);
      mockFindUnique.mockResolvedValue(booking);

      await sendBumpedNotifications(["b1"]);

      expect(sendBookingBumpedEmail).toHaveBeenCalledWith(
        "b1@example.com",
        "Test",
        booking.checkIn,
        booking.checkOut,
        2
      );
    });

    it("continues sending even if one email fails", async () => {
      const booking1 = makeBooking("b1", "2026-07-10", "2026-07-12", 2);
      const booking2 = makeBooking("b2", "2026-07-13", "2026-07-15", 3);

      mockFindUnique
        .mockResolvedValueOnce(booking1)
        .mockResolvedValueOnce(booking2);

      vi.mocked(sendBookingBumpedEmail)
        .mockRejectedValueOnce(new Error("SMTP error"))
        .mockResolvedValueOnce(undefined);

      await sendBumpedNotifications(["b1", "b2"]);

      expect(sendBookingBumpedEmail).toHaveBeenCalledTimes(2);
    });

    it("skips bookings that are not found", async () => {
      mockFindUnique.mockResolvedValue(null);

      await sendBumpedNotifications(["nonexistent"]);

      expect(sendBookingBumpedEmail).not.toHaveBeenCalled();
    });
  });
});
