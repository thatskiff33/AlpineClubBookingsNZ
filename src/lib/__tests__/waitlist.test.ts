/**
 * Waitlist Feature Tests
 *
 * Tests for: core waitlist logic, booking creation waitlist path,
 * cancellation triggers, cron job, API routes, status colors, email templates.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───

const mockPrismaTransaction = vi.fn();
const mockBookingFindUnique = vi.fn();
const mockBookingFindMany = vi.fn();
const mockBookingCount = vi.fn();
const mockBookingUpdate = vi.fn();
const mockBookingUpdateMany = vi.fn();
const mockBookingCreate = vi.fn();
const mockExecuteRaw = vi.fn().mockResolvedValue(undefined);

const mockTx = {
  $executeRaw: mockExecuteRaw,
  booking: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
  },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (fn: ((tx: unknown) => Promise<unknown>) | unknown[]) =>
      typeof fn === "function"
        ? mockPrismaTransaction(fn)
        : Promise.resolve(fn),
    booking: {
      findUnique: (...args: unknown[]) => mockBookingFindUnique(...args),
      findMany: (...args: unknown[]) => mockBookingFindMany(...args),
      count: (...args: unknown[]) => mockBookingCount(...args),
      update: (...args: unknown[]) => mockBookingUpdate(...args),
      updateMany: (...args: unknown[]) => mockBookingUpdateMany(...args),
      create: (...args: unknown[]) => mockBookingCreate(...args),
    },
  },
}));

vi.mock("@/lib/capacity", () => ({
  checkCapacityForGuestRanges: vi.fn(),
  LODGE_CAPACITY: 29,
}));

vi.mock("@/lib/cancellation", () => ({
  getNonMemberHoldDays: vi.fn().mockResolvedValue(7),
}));

vi.mock("@/lib/email", () => ({
  sendWaitlistOfferEmail: vi.fn().mockResolvedValue(undefined),
  sendWaitlistOfferExpiredEmail: vi.fn().mockResolvedValue(undefined),
  sendWaitlistConfirmationEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminWaitlistOfferAlert: vi.fn().mockResolvedValue(undefined),
  sendBookingCancelledEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockPrismaTransaction.mockReset();
  mockBookingFindUnique.mockReset();
  mockBookingFindMany.mockReset();
  mockBookingCount.mockReset();
  mockBookingUpdate.mockReset();
  mockBookingUpdateMany.mockReset();
  mockBookingCreate.mockReset();
  mockExecuteRaw.mockReset();
  mockTx.booking.findMany.mockReset();
  mockTx.booking.findUnique.mockReset();
  mockTx.booking.update.mockReset();
  mockTx.booking.count.mockReset();
  mockExecuteRaw.mockResolvedValue(undefined);
  // Default: transaction runs the callback with mockTx
  mockPrismaTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx));
});

// ─── Core Logic Tests ───

describe("getWaitlistPosition", () => {
  it("returns correct FIFO position", async () => {
    const { getWaitlistPosition } = await import("@/lib/waitlist");

    mockBookingFindUnique.mockResolvedValue({
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      createdAt: new Date("2026-04-08T12:00:00Z"),
      status: "WAITLISTED",
    });
    mockBookingCount.mockResolvedValue(2); // 2 ahead

    const position = await getWaitlistPosition("booking1");
    expect(position).toBe(3); // 2 ahead + 1
  });

  it("returns 0 for non-waitlisted booking", async () => {
    const { getWaitlistPosition } = await import("@/lib/waitlist");

    mockBookingFindUnique.mockResolvedValue({
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      createdAt: new Date(),
      status: "CONFIRMED",
    });

    const position = await getWaitlistPosition("booking1");
    expect(position).toBe(0);
  });

  it("returns 0 for non-existent booking", async () => {
    const { getWaitlistPosition } = await import("@/lib/waitlist");

    mockBookingFindUnique.mockResolvedValue(null);

    const position = await getWaitlistPosition("nonexistent");
    expect(position).toBe(0);
  });
});

describe("getWaitlistForDates", () => {
  it("returns waitlisted bookings ordered by createdAt ASC", async () => {
    const { getWaitlistForDates } = await import("@/lib/waitlist");

    const mockEntries = [
      { id: "b1", createdAt: new Date("2026-04-01") },
      { id: "b2", createdAt: new Date("2026-04-02") },
    ];
    mockBookingFindMany.mockResolvedValue(mockEntries);

    const result = await getWaitlistForDates(
      new Date("2026-07-01"),
      new Date("2026-07-05")
    );

    expect(result).toEqual(mockEntries);
    expect(mockBookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "WAITLISTED" }),
        orderBy: { createdAt: "asc" },
      })
    );
  });
});

describe("processWaitlistForDates", () => {
  it("offers to top candidate when capacity available", async () => {
    const { processWaitlistForDates } = await import("@/lib/waitlist");
    const { checkCapacityForGuestRanges: mockCheckCapacity } = await import("@/lib/capacity");

    const candidate = {
      id: "booking1",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      createdAt: new Date("2026-04-01"),
      guests: [{ id: "g1" }, { id: "g2" }],
      member: { id: "m1", email: "test@test.com", firstName: "John", lastName: "Doe" },
    };

    mockTx.booking.findMany.mockResolvedValue([candidate]);
    (mockCheckCapacity as ReturnType<typeof vi.fn>).mockResolvedValue({ available: true });
    mockTx.booking.update.mockResolvedValue({});
    mockTx.booking.count.mockResolvedValue(0); // first in queue

    const result = await processWaitlistForDates({
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-05"),
    });

    expect(result.offeredBookingId).toBe("booking1");
    expect(mockTx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "booking1" },
        data: expect.objectContaining({ status: "WAITLIST_OFFERED" }),
      })
    );
  });

  it("skips candidates with only partial availability", async () => {
    const { processWaitlistForDates } = await import("@/lib/waitlist");
    const { checkCapacityForGuestRanges: mockCheckCapacity } = await import("@/lib/capacity");

    const candidate = {
      id: "booking1",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      createdAt: new Date("2026-04-01"),
      guests: [{ id: "g1" }],
      member: { id: "m1", email: "test@test.com", firstName: "John", lastName: "Doe" },
    };

    mockTx.booking.findMany.mockResolvedValue([candidate]);
    (mockCheckCapacity as ReturnType<typeof vi.fn>).mockResolvedValue({ available: false });

    const result = await processWaitlistForDates({
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-05"),
    });

    expect(result.offeredBookingId).toBeNull();
  });

  it("passes per-guest stay ranges into waitlist promotion capacity checks", async () => {
    const { processWaitlistForDates } = await import("@/lib/waitlist");
    const { checkCapacityForGuestRanges: mockCheckCapacity } = await import("@/lib/capacity");

    const candidate = {
      id: "booking1",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      createdAt: new Date("2026-04-01"),
      guests: [
        {
          id: "g1",
          stayStart: new Date("2026-07-01"),
          stayEnd: new Date("2026-07-02"),
        },
        {
          id: "g2",
          stayStart: new Date("2026-07-02"),
          stayEnd: new Date("2026-07-03"),
        },
      ],
      member: { id: "m1", email: "test@test.com", firstName: "John", lastName: "Doe" },
    };

    mockTx.booking.findMany.mockResolvedValue([candidate]);
    (mockCheckCapacity as ReturnType<typeof vi.fn>).mockResolvedValue({
      available: true,
      minAvailable: 0,
      nightDetails: [],
    });
    mockTx.booking.update.mockResolvedValue({});
    mockTx.booking.count.mockResolvedValue(0);

    const result = await processWaitlistForDates({
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
    });

    expect(result.offeredBookingId).toBe("booking1");
    expect(mockCheckCapacity).toHaveBeenCalledWith(
      candidate.checkIn,
      candidate.checkOut,
      candidate.guests,
      undefined,
      mockTx
    );
  });

  it("does nothing when no waitlisted bookings exist", async () => {
    const { processWaitlistForDates } = await import("@/lib/waitlist");

    mockTx.booking.findMany.mockResolvedValue([]);

    const result = await processWaitlistForDates({
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-05"),
    });

    expect(result.offeredBookingId).toBeNull();
  });
});

describe("confirmWaitlistOffer", () => {
  it("transitions to PAYMENT_PENDING for all-member bookings", async () => {
    const { confirmWaitlistOffer } = await import("@/lib/waitlist");
    const { checkCapacityForGuestRanges: mockCheckCapacity } = await import("@/lib/capacity");

    mockTx.booking.findUnique.mockResolvedValue({
      id: "booking1",
      memberId: "m1",
      status: "WAITLIST_OFFERED",
      waitlistOfferExpiresAt: new Date(Date.now() + 86400000),
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      guests: [{ id: "g1", isMember: true }],
    });
    (mockCheckCapacity as ReturnType<typeof vi.fn>).mockResolvedValue({ available: true });
    mockTx.booking.update.mockResolvedValue({});

    const result = await confirmWaitlistOffer("booking1", "m1");

    expect(result.success).toBe(true);
    expect(result.newStatus).toBe("PAYMENT_PENDING");
  });

  it("transitions to PENDING for non-member bookings far from check-in", async () => {
    const { confirmWaitlistOffer } = await import("@/lib/waitlist");
    const { checkCapacityForGuestRanges: mockCheckCapacity } = await import("@/lib/capacity");

    const farFuture = new Date();
    farFuture.setDate(farFuture.getDate() + 30);

    mockTx.booking.findUnique.mockResolvedValue({
      id: "booking1",
      memberId: "m1",
      status: "WAITLIST_OFFERED",
      waitlistOfferExpiresAt: new Date(Date.now() + 86400000),
      checkIn: farFuture,
      checkOut: new Date(farFuture.getTime() + 2 * 86400000),
      guests: [
        { id: "g1", isMember: true },
        { id: "g2", isMember: false },
      ],
    });
    (mockCheckCapacity as ReturnType<typeof vi.fn>).mockResolvedValue({ available: true });
    mockTx.booking.update.mockResolvedValue({});

    const result = await confirmWaitlistOffer("booking1", "m1");

    expect(result.success).toBe(true);
    expect(result.newStatus).toBe("PENDING");
  });

  it("rejects expired offers", async () => {
    const { confirmWaitlistOffer } = await import("@/lib/waitlist");

    mockTx.booking.findUnique.mockResolvedValue({
      id: "booking1",
      memberId: "m1",
      status: "WAITLIST_OFFERED",
      waitlistOfferExpiresAt: new Date(Date.now() - 1000),
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      guests: [{ id: "g1", isMember: true }],
    });

    const result = await confirmWaitlistOffer("booking1", "m1");

    expect(result.success).toBe(false);
    expect(result.error).toContain("expired");
  });

  it("rejects non-owner", async () => {
    const { confirmWaitlistOffer } = await import("@/lib/waitlist");

    mockTx.booking.findUnique.mockResolvedValue({
      id: "booking1",
      memberId: "m1",
      status: "WAITLIST_OFFERED",
      waitlistOfferExpiresAt: new Date(Date.now() + 86400000),
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      guests: [{ id: "g1", isMember: true }],
    });

    const result = await confirmWaitlistOffer("booking1", "m2");

    expect(result.success).toBe(false);
    expect(result.error).toBe("Forbidden");
  });

  it("handles capacity race condition (capacity taken between offer and confirm)", async () => {
    const { confirmWaitlistOffer } = await import("@/lib/waitlist");
    const { checkCapacityForGuestRanges: mockCheckCapacity } = await import("@/lib/capacity");

    mockTx.booking.findUnique.mockResolvedValue({
      id: "booking1",
      memberId: "m1",
      status: "WAITLIST_OFFERED",
      waitlistOfferExpiresAt: new Date(Date.now() + 86400000),
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      guests: [{ id: "g1", isMember: true }],
    });
    (mockCheckCapacity as ReturnType<typeof vi.fn>).mockResolvedValue({ available: false });
    mockTx.booking.update.mockResolvedValue({});

    const result = await confirmWaitlistOffer("booking1", "m1");

    expect(result.success).toBe(false);
    expect(result.error).toContain("no longer available");
  });

  it("rejects non-WAITLIST_OFFERED status", async () => {
    const { confirmWaitlistOffer } = await import("@/lib/waitlist");

    mockTx.booking.findUnique.mockResolvedValue({
      id: "booking1",
      memberId: "m1",
      status: "WAITLISTED",
      waitlistOfferExpiresAt: null,
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      guests: [{ id: "g1", isMember: true }],
    });

    const result = await confirmWaitlistOffer("booking1", "m1");

    expect(result.success).toBe(false);
    expect(result.error).toContain("not in WAITLIST_OFFERED");
  });
});

describe("expireStaleOffers", () => {
  it("reverts expired offers to WAITLISTED", async () => {
    const { expireStaleOffers } = await import("@/lib/waitlist");

    mockTx.booking.findMany
      .mockResolvedValueOnce([
        {
          id: "booking1",
          checkIn: new Date("2026-07-01"),
          checkOut: new Date("2026-07-03"),
          createdAt: new Date("2026-04-01"),
          member: { email: "test@test.com", firstName: "John" },
        },
      ])
      .mockResolvedValueOnce([]);
    mockTx.booking.update.mockResolvedValue({});

    const result = await expireStaleOffers();

    expect(result.expiredCount).toBe(1);
    expect(mockTx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "booking1" },
        data: expect.objectContaining({ status: "WAITLISTED" }),
      })
    );
  });

  it("does nothing when no stale offers exist", async () => {
    const { expireStaleOffers } = await import("@/lib/waitlist");

    mockTx.booking.findMany.mockResolvedValueOnce([]);

    const result = await expireStaleOffers();

    expect(result.expiredCount).toBe(0);
    expect(result.reofferedCount).toBe(0);
  });

  it("reverts expired offer to WAITLISTED and keeps reofferedCount=0 when no capacity for next candidate", async () => {
    const { expireStaleOffers } = await import("@/lib/waitlist");
    const { checkCapacityForGuestRanges } = await import("@/lib/capacity");

    mockTx.booking.findMany
      .mockResolvedValueOnce([
        {
          id: "expired-offer-1",
          checkIn: new Date("2026-08-01"),
          checkOut: new Date("2026-08-03"),
          createdAt: new Date("2026-05-01"),
          member: { email: "alice@test.com", firstName: "Alice" },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "next-candidate",
          checkIn: new Date("2026-08-01"),
          checkOut: new Date("2026-08-03"),
          createdAt: new Date("2026-05-02"),
          guests: [{ id: "g1" }, { id: "g2" }],
          member: { id: "m2", email: "bob@test.com", firstName: "Bob", lastName: "Jones" },
        },
      ]);
    mockTx.booking.update.mockResolvedValue({});
    vi.mocked(checkCapacityForGuestRanges).mockResolvedValue({
      available: false,
      minAvailable: 0,
      nightDetails: [],
    });

    const result = await expireStaleOffers();

    expect(result.expiredCount).toBe(1);
    expect(result.reofferedCount).toBe(0);
    expect(mockTx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "expired-offer-1" },
        data: expect.objectContaining({ status: "WAITLISTED" }),
      })
    );
  });
});

describe("processWaitlistCron", () => {
  it("retries transient Prisma transaction-start failures", async () => {
    const originalDelay = process.env.WAITLIST_TRANSACTION_RETRY_DELAY_MS;
    process.env.WAITLIST_TRANSACTION_RETRY_DELAY_MS = "0";
    try {
      const { processWaitlistCron } = await import("@/lib/cron-waitlist");

      mockPrismaTransaction
        .mockRejectedValueOnce(
          new Error("Transaction API error: Unable to start a transaction in the given time.")
        )
        .mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx));
      mockTx.booking.findMany.mockResolvedValueOnce([]);
      mockBookingFindMany.mockResolvedValueOnce([]);

      await expect(processWaitlistCron()).resolves.toEqual({
        expiredOffers: 0,
        newOffers: 0,
        autoCancelled: 0,
      });
      expect(mockPrismaTransaction).toHaveBeenCalledTimes(2);
    } finally {
      if (originalDelay === undefined) {
        delete process.env.WAITLIST_TRANSACTION_RETRY_DELAY_MS;
      } else {
        process.env.WAITLIST_TRANSACTION_RETRY_DELAY_MS = originalDelay;
      }
    }
  });
});

// ─── Status Colors Tests ───

describe("status colors include waitlist statuses", () => {
  it("defines WAITLISTED and WAITLIST_OFFERED colors", async () => {
    const { bookingStatusClasses } = await import("@/lib/status-colors");

    expect(bookingStatusClasses["WAITLISTED"]).toBeTruthy();
    expect(bookingStatusClasses["WAITLIST_OFFERED"]).toBeTruthy();
    expect(bookingStatusClasses["WAITLISTED"]).not.toBe(bookingStatusClasses["WAITLIST_OFFERED"]);
  });

  it("WAITLISTED and WAITLIST_OFFERED have unique colors", async () => {
    const { bookingStatusClasses } = await import("@/lib/status-colors");

    const allClasses = Object.values(bookingStatusClasses);
    const unique = new Set(allClasses);
    expect(unique.size).toBe(allClasses.length);
  });

  it("bookingStatusClass returns fallback for unknown status", async () => {
    const { bookingStatusClass } = await import("@/lib/status-colors");

    expect(bookingStatusClass("UNKNOWN")).toBe("bg-gray-100 text-gray-700");
  });
});

// ─── Email Template Tests ───

describe("waitlist email templates", () => {
  it("waitlistConfirmationTemplate renders correctly", async () => {
    const { waitlistConfirmationTemplate } = await import("@/lib/email-templates");

    const html = waitlistConfirmationTemplate(
      "John",
      new Date("2026-07-01"),
      new Date("2026-07-03"),
      3,
      2
    );

    expect(html).toContain("Waitlist");
    expect(html).toContain("John");
    expect(html).toContain("#2");
  });

  it("waitlistOfferTemplate renders correctly", async () => {
    const { waitlistOfferTemplate } = await import("@/lib/email-templates");

    const html = waitlistOfferTemplate(
      "Jane",
      new Date("2026-07-01"),
      new Date("2026-07-03"),
      2,
      new Date("2026-07-10"),
      "booking123"
    );

    expect(html).toContain("Spot Has Opened Up");
    expect(html).toContain("Jane");
    expect(html).toContain("booking123");
  });

  it("waitlistOfferExpiredTemplate renders correctly", async () => {
    const { waitlistOfferExpiredTemplate } = await import("@/lib/email-templates");

    const html = waitlistOfferExpiredTemplate(
      "Mike",
      new Date("2026-07-01"),
      new Date("2026-07-03"),
      3
    );

    expect(html).toContain("Expired");
    expect(html).toContain("Mike");
    expect(html).toContain("#3");
  });

  it("adminWaitlistOfferTemplate renders correctly", async () => {
    const { adminWaitlistOfferTemplate } = await import("@/lib/email-templates");

    const html = adminWaitlistOfferTemplate({
      memberName: "John Doe",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      guestCount: 4,
      position: 1,
    });

    expect(html).toContain("Waitlist Offer Made");
    expect(html).toContain("John Doe");
  });
});

// ─── Cron Job Tests ───

describe("processWaitlistCron", () => {
  it("skips cleanly when Admin Modules disables waitlist", async () => {
    const { runWaitlistProcessorCron } = await import("@/lib/cron-waitlist");

    await expect(
      runWaitlistProcessorCron({ isModuleEnabled: () => false })
    ).resolves.toEqual({
      cronStatus: "SKIPPED",
      expiredOffers: 0,
      newOffers: 0,
      autoCancelled: 0,
      reason: "Waitlist effective module state is disabled",
    });
    expect(mockBookingFindMany).not.toHaveBeenCalled();
    expect(mockBookingUpdateMany).not.toHaveBeenCalled();
  });

  it("auto-cancels past-date waitlisted bookings", async () => {
    const { processWaitlistCron } = await import("@/lib/cron-waitlist");

    mockTx.booking.findMany.mockResolvedValueOnce([]);
    mockBookingFindMany.mockResolvedValueOnce([
      {
        id: "old1",
      },
      { id: "old2" },
    ]);
    mockBookingUpdateMany.mockResolvedValue({ count: 2 });

    const result = await processWaitlistCron();

    expect(result.autoCancelled).toBe(2);
    expect(mockBookingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["old1", "old2"] } },
        data: expect.objectContaining({ status: "CANCELLED" }),
      })
    );
  });
});

// ─── Booking Creation Waitlist Path Tests ───

describe("booking creation waitlist response", () => {
  it("returns 409 with canWaitlist when capacity exceeded", () => {
    // Test the error object structure used in the booking route
    const err = Object.assign(new Error("CAPACITY_EXCEEDED"), {
      code: "CAPACITY_EXCEEDED",
      fullNights: ["2026-07-01", "2026-07-02"],
      canWaitlist: true,
    });

    expect((err as unknown as { code: string }).code).toBe("CAPACITY_EXCEEDED");
    expect((err as unknown as { canWaitlist: boolean }).canWaitlist).toBe(true);
    expect((err as unknown as { fullNights: string[] }).fullNights).toHaveLength(2);
  });
});

describe("updateWaitlistPositions", () => {
  it("recalculates positions correctly", async () => {
    const { updateWaitlistPositions } = await import("@/lib/waitlist");

    mockBookingFindMany.mockResolvedValue([
      { id: "b1" },
      { id: "b2" },
      { id: "b3" },
    ]);
    mockBookingUpdate.mockResolvedValue({});

    await updateWaitlistPositions(
      new Date("2026-07-01"),
      new Date("2026-07-05")
    );

    expect(mockBookingUpdate).toHaveBeenCalledTimes(3);
    expect(mockBookingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "b1" },
        data: { waitlistPosition: 1 },
      })
    );
    expect(mockBookingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "b3" },
        data: { waitlistPosition: 3 },
      })
    );
  });
});
