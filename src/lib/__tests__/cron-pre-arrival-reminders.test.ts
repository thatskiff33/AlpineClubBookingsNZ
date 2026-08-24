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
    // Every level the cron actually calls. It used to hold `error` alone, and
    // that was not merely incomplete: `logger.warn` was then `undefined`, so a
    // withhold threw a TypeError inside the loop and every assertion about the
    // withhold path measured the CATCH branch instead (#3035).
    mockLogger: {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
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

import {
  EMAIL_SENT,
  emailWithheldForBooking,
  emailWithheldForEnvironment,
} from "@/lib/__tests__/helpers/email-outcomes";
import { sendPreArrivalReminders } from "@/lib/cron-pre-arrival-reminders";

/*
  The mailer's outcome shapes come from a shared helper (#3035). The stub used to
  be `undefined`, which was harmless while this cron ignored the outcome and is
  not any more: the claim it writes BEFORE the send is the only thing that ever
  selects a booking for this reminder, so it has to tell a send from a withhold.
*/

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
    mockSendPreArrivalReminderEmail.mockResolvedValue(EMAIL_SENT);
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
      expectedArrivalTime: "16:30",
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
    mockSendPreArrivalReminderEmail.mockResolvedValue(EMAIL_SENT);
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

// --- #3035 (ENV-SAFETY 2): a withheld reminder must not consume its claim ----
//
// THE SHAPE OF THE DEFECT. This cron stamps `preArrivalReminderSentAt` in a
// guarded claim BEFORE it sends, and the selecting query filters on
// `preArrivalReminderSentAt: null`. So a stamp written for a message that never
// went out is consumed permanently — and this is the message that carries the
// door code and the arrival instructions, so the member arrives at a locked
// lodge and nothing anywhere says why.
//
// `sendEmail` RETURNS rather than throws when it withholds, so the cron's
// `catch` never saw any of it: the outcome has to be inspected.
describe("sendPreArrivalReminders environment-safety withholds (#3035)", () => {
  const CLAIMED_AT = new Date("2026-06-10T12:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(CLAIMED_AT);
    vi.clearAllMocks();
    mockPrisma.booking.findMany.mockResolvedValue([booking()]);
    mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
    mockSendPreArrivalReminderEmail.mockResolvedValue(EMAIL_SENT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** The claim-restoring update, if the cron made one. */
  function restoreCall() {
    return mockPrisma.booking.updateMany.mock.calls.find(
      (call) =>
        (call[0] as { data?: { preArrivalReminderSentAt?: unknown } }).data
          ?.preArrivalReminderSentAt === null,
    );
  }

  it("hands the claim back when the installation's role is unknown", async () => {
    mockSendPreArrivalReminderEmail.mockResolvedValue(
      emailWithheldForEnvironment("environment_unknown"),
    );

    const result = await sendPreArrivalReminders();

    expect(restoreCall()?.[0]).toEqual({
      // Guarded on the instant this pass stamped, so a concurrent run's claim is
      // never cleared.
      where: { id: "booking-1", preArrivalReminderSentAt: CLAIMED_AT },
      data: { preArrivalReminderSentAt: null },
    });
    expect(result.sentBookingIds).toEqual([]);
    expect(result.skippedBookingIds).toEqual(["booking-1"]);
  });

  it("hands the claim back when the live site declares a capture mailbox", async () => {
    mockSendPreArrivalReminderEmail.mockResolvedValue(
      emailWithheldForEnvironment("capture_transport_in_production"),
    );

    await sendPreArrivalReminders();

    expect(restoreCall()).toBeDefined();
  });

  it("KEEPS the claim on a confirmed copy, so an idle copy writes no new row each run", async () => {
    /*
      The one outcome that is terminal rather than a fault. A copy is a copy until
      somebody re-declares it, so there is nothing to retry — and re-claiming and
      re-suppressing the same booking every run would write a new counted
      SKIPPED_NON_PRODUCTION row per pass. That count is what tells a live club
      wrongly declared a copy from an idle staging one (owner decision 1,
      23 Aug 2026), so an idle copy must not manufacture it.
    */
    mockSendPreArrivalReminderEmail.mockResolvedValue(
      emailWithheldForEnvironment("environment_non_production"),
    );

    const result = await sendPreArrivalReminders();

    expect(restoreCall()).toBeUndefined();
    expect(result.sentBookingIds).toEqual([]);
    expect(result.skippedBookingIds).toEqual(["booking-1"]);
  });

  it("hands the claim back for a booking whose 'No emails' switch could not be read", async () => {
    /*
      Not an environment case, but the same claim and — here — the same answer.
      The additional-payment reminder KEEPS its stamp for this reason, because the
      fail-closed booking withhold leaves a replayable FAILED EmailLog row. This
      template cannot: `pre-arrival-reminder` carries the door code, so it is in
      SENSITIVE_EMAIL_LOG_TEMPLATES, its body is never persisted, and the retry
      cron only selects rows that still hold one. Nothing will replay it, so the
      stamp comes back.
    */
    mockSendPreArrivalReminderEmail.mockResolvedValue(
      emailWithheldForBooking("booking_flag_unreadable"),
    );

    await sendPreArrivalReminders();

    expect(restoreCall()).toBeDefined();
  });

  it("hands the claim back when the send throws", async () => {
    /*
      A throw burns the same claim, and this template's body is deliberately not
      retained (it carries a door code) so the email retry cron can never replay
      the FAILED row. Before #3035 the stamp stayed and the reminder was gone.
    */
    mockSendPreArrivalReminderEmail.mockRejectedValue(new Error("smtp down"));

    const result = await sendPreArrivalReminders();

    expect(restoreCall()).toBeDefined();
    expect(result.failedBookingIds).toEqual(["booking-1"]);
  });

  it("keeps the claim when the message really went out", async () => {
    const result = await sendPreArrivalReminders();

    expect(restoreCall()).toBeUndefined();
    expect(result.sentBookingIds).toEqual(["booking-1"]);
  });
});
