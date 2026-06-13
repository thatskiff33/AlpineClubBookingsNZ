import { BookingStatus } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockSendPreArrivalReminderEmail, mockLogger } = vi.hoisted(
  () => ({
    mockPrisma: {
      booking: {
        findMany: vi.fn(),
        updateMany: vi.fn(),
      },
    },
    mockSendPreArrivalReminderEmail: vi.fn(),
    mockLogger: {
      error: vi.fn(),
    },
  }),
);

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

vi.mock("@/lib/email", () => ({
  sendPreArrivalReminderEmail: mockSendPreArrivalReminderEmail,
}));

vi.mock("@/lib/logger", () => ({
  default: mockLogger,
}));

import { sendPreArrivalReminders } from "@/lib/cron-pre-arrival-reminders";

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    status: BookingStatus.PAID,
    checkIn: new Date("2026-06-13T00:00:00.000Z"),
    checkOut: new Date("2026-06-15T00:00:00.000Z"),
    expectedArrivalTime: "16:30",
    member: {
      email: "member@example.org",
      firstName: "Alice",
    },
    guests: [{ id: "guest-1" }, { id: "guest-2" }],
    ...overrides,
  };
}

describe("sendPreArrivalReminders", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:00:00.000Z"));
    vi.clearAllMocks();
    mockPrisma.booking.findMany.mockResolvedValue([]);
    mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
    mockSendPreArrivalReminderEmail.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("selects confirmed and paid bookings in the NZ date-only reminder window", async () => {
    const candidate = booking();
    mockPrisma.booking.findMany.mockResolvedValue([candidate]);

    const result = await sendPreArrivalReminders();

    const windowStart = new Date("2026-06-11T00:00:00.000Z");
    const windowEndExclusive = new Date("2026-06-15T00:00:00.000Z");
    expect(mockPrisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: { in: [BookingStatus.CONFIRMED, BookingStatus.PAID] },
          deletedAt: null,
          preArrivalReminderSentAt: null,
          checkIn: {
            gte: windowStart,
            lt: windowEndExclusive,
          },
        },
      }),
    );
    expect(mockPrisma.booking.updateMany).toHaveBeenCalledWith({
      where: {
        id: "booking-1",
        status: { in: [BookingStatus.CONFIRMED, BookingStatus.PAID] },
        deletedAt: null,
        preArrivalReminderSentAt: null,
        checkIn: {
          gte: windowStart,
          lt: windowEndExclusive,
        },
      },
      data: { preArrivalReminderSentAt: new Date("2026-06-10T12:00:00.000Z") },
    });
    expect(mockSendPreArrivalReminderEmail).toHaveBeenCalledWith({
      email: "member@example.org",
      firstName: "Alice",
      checkIn: candidate.checkIn,
      checkOut: candidate.checkOut,
      guestCount: 2,
      expectedArrivalTime: "16:30",
    });
    expect(result.sentBookingIds).toEqual(["booking-1"]);
    expect(result.windowStart).toBe("2026-06-11");
    expect(result.windowEndExclusive).toBe("2026-06-15");
  });

  it("does not send when another worker already claimed the booking", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([booking()]);
    mockPrisma.booking.updateMany.mockResolvedValue({ count: 0 });

    const result = await sendPreArrivalReminders();

    expect(mockSendPreArrivalReminderEmail).not.toHaveBeenCalled();
    expect(result.sentBookingIds).toEqual([]);
    expect(result.skippedBookingIds).toEqual(["booking-1"]);
  });

  it("does not claim or send when no bookings are inside the window", async () => {
    const result = await sendPreArrivalReminders();

    expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
    expect(mockSendPreArrivalReminderEmail).not.toHaveBeenCalled();
    expect(result.sentBookingIds).toEqual([]);
  });
});
