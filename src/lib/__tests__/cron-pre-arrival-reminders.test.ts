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
      bookingId: "booking-1",
      email: "member@example.org",
      firstName: "Alice",
      checkIn: candidate.checkIn,
      checkOut: candidate.checkOut,
      guestCount: 2,
      // #2350: nothing owed on this booking, so the note is not composed.
      outstandingAdditionalAmountCents: 0,
    });
    expect(result.sentBookingIds).toEqual(["booking-1"]);
    expect(result.windowStart).toBe("2026-06-11");
    expect(result.windowEndExclusive).toBe("2026-06-15");
  });

  // #2350: the pre-arrival note is the last message most members read before
  // they travel, so it says when a booking change left money uncollected.
  it("names an uncollected additional payment in the pre-arrival reminder", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking({
        payment: {
          additionalAmountCents: 21_000,
          additionalPaymentStatus: "PENDING",
        },
      }),
    ]);

    await sendPreArrivalReminders();

    expect(mockSendPreArrivalReminderEmail).toHaveBeenCalledWith(
      expect.objectContaining({ outstandingAdditionalAmountCents: 21_000 }),
    );
  });

  // FAILED rides along with PENDING everywhere the owed predicate is used.
  it("treats a failed additional payment as still owing", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking({
        payment: {
          additionalAmountCents: 4_500,
          additionalPaymentStatus: "FAILED",
        },
      }),
    ]);

    await sendPreArrivalReminders();

    expect(mockSendPreArrivalReminderEmail).toHaveBeenCalledWith(
      expect.objectContaining({ outstandingAdditionalAmountCents: 4_500 }),
    );
  });

  it("says nothing about an additional payment that was collected", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking({
        payment: {
          additionalAmountCents: 4_500,
          additionalPaymentStatus: "SUCCEEDED",
        },
      }),
    ]);

    await sendPreArrivalReminders();

    expect(mockSendPreArrivalReminderEmail).toHaveBeenCalledWith(
      expect.objectContaining({ outstandingAdditionalAmountCents: 0 }),
    );
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

// --- D-12 (#2307): the headcount in the email --------------------------------
//
// Owner decision D-12: an unconsented member guest is not operationally present.
// This email tells the booker how many guests are arriving, and there is no
// separate count query — `guests.length` is read straight off the include — so
// the include is where the exclusion has to land, and an inflated "Guests: 4" is
// the club stating something untrue in writing.
describe("sendPreArrivalReminders member-guest consent exclusion (D-12, #2307)", () => {
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

  it("asks the database for operationally present guests only", async () => {
    await sendPreArrivalReminders();

    // The include, not a post-filter: `guests.length` below has nothing to
    // filter with, so the predicate has to travel in the query.
    const args = mockPrisma.booking.findMany.mock.calls[0][0] as {
      include: { guests: { where?: { OR?: unknown } } };
    };
    // The explicit OR, never `{ not: "PENDING" }` — NULL is the dominant
    // consentStatus and `<> 'PENDING'` is UNKNOWN for NULL, which would drop
    // every ordinary guest out of every reminder ever sent.
    expect(args.include.guests.where?.OR).toEqual([
      { consentStatus: null },
      { consentStatus: "CONFIRMED" },
    ]);
  });

  it("counts the guests the query returned, so a pending guest never inflates it", async () => {
    // The query above excludes the pending row, so what reaches this code is a
    // two-guest booking whose third member guest is still awaiting consent.
    mockPrisma.booking.findMany.mockResolvedValue([
      booking({ guests: [{ id: "guest-1" }, { id: "guest-2" }] }),
    ]);

    await sendPreArrivalReminders();

    expect(mockSendPreArrivalReminderEmail).toHaveBeenCalledWith(
      expect.objectContaining({ guestCount: 2 }),
    );
  });
});
