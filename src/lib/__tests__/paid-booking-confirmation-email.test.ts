import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/*
  #5398: `sendPaidBookingConfirmedEmail` is the one paid-confirmation send both
  racing payment paths call (#772). It loads the booking, describes a
  provisional non-member child, sends with the booking's worth, and never
  throws: the payment has already settled when it runs.
*/

const h = vi.hoisted(() => ({
  findUnique: vi.fn(),
  send: vi.fn(),
  summary: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { booking: { findUnique: h.findUnique } },
}));
vi.mock("@/lib/email", () => ({ sendBookingConfirmedEmail: h.send }));
vi.mock("@/lib/booking-split-summary", () => ({
  getProvisionalNonMemberChildSummary: h.summary,
}));
vi.mock("@/lib/logger", () => ({ default: { error: h.logError } }));

import { sendPaidBookingConfirmedEmail } from "@/lib/paid-booking-confirmation-email";

const checkIn = new Date("2026-07-10T00:00:00.000Z");
const checkOut = new Date("2026-07-12T00:00:00.000Z");

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    memberId: "member-1",
    lodgeId: "lodge-1",
    checkIn,
    checkOut,
    finalPriceCents: 10_000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    member: { id: "member-1", firstName: "Alice", lastName: "Example", email: "alice@example.com" },
    organisation: null,
    guests: [{ id: "g1" }, { id: "g2" }],
    promoRedemptions: [],
    payment: { changeFeeCents: 2_500 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.send.mockResolvedValue(undefined);
  h.summary.mockResolvedValue(null);
});

describe("sendPaidBookingConfirmedEmail (#5398)", () => {
  it("loads the booking with the owner, guests, promos and change fee, and sends with its worth", async () => {
    h.findUnique.mockResolvedValue(booking());

    await sendPaidBookingConfirmedEmail("booking-1", CLUB_FORMAT_TEST);

    expect(h.findUnique).toHaveBeenCalledWith({
      where: { id: "booking-1" },
      include: {
        member: true,
        organisation: { select: { name: true, email: true } },
        guests: true,
        promoRedemptions: { include: { promoCode: true } },
        payment: { select: { changeFeeCents: true } },
      },
    });
    expect(h.summary).toHaveBeenCalledWith({ id: "booking-1", memberId: "member-1" });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith(
      { bookingId: "booking-1", recipientMemberId: "member-1" },
      "alice@example.com",
      "Alice",
      checkIn,
      checkOut,
      2,
      // The worth: the price plus the recorded change fee (#3955 F8).
      12_500,
      CLUB_FORMAT_TEST,
      { lodgeId: "lodge-1" },
    );
  });

  it("describes a provisional non-member child when the booking was split (#738)", async () => {
    h.findUnique.mockResolvedValue(booking());
    const provisionalGuests = { guestCount: 1, amountCents: 4_000, holdUntil: checkIn };
    h.summary.mockResolvedValue(provisionalGuests);

    await sendPaidBookingConfirmedEmail("booking-1", CLUB_FORMAT_TEST);

    expect(h.send.mock.calls[0]?.[8]).toEqual({ lodgeId: "lodge-1", provisionalGuests });
  });

  it("sends nothing when the booking is gone", async () => {
    h.findUnique.mockResolvedValue(null);

    await sendPaidBookingConfirmedEmail("booking-1", CLUB_FORMAT_TEST);

    expect(h.send).not.toHaveBeenCalled();
    expect(h.logError).not.toHaveBeenCalled();
  });

  it("logs and swallows a send failure", async () => {
    h.findUnique.mockResolvedValue(booking());
    const failure = new Error("mail down");
    h.send.mockRejectedValue(failure);

    await expect(sendPaidBookingConfirmedEmail("booking-1", CLUB_FORMAT_TEST)).resolves.toBeUndefined();

    expect(h.logError).toHaveBeenCalledWith(
      { err: failure, bookingId: "booking-1" },
      "Failed to send confirmation email",
    );
  });
});
