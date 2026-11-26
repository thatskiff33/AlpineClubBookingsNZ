import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/*
  #5398, #5433 PR 3: the one paid-confirmation render. `loadPaidConfirmationBooking`
  reads the booking as it stands; `sendPaidBookingConfirmation` describes a
  provisional non-member child, sends with the booking's worth and the owed
  notice's event key, states an upward change not yet collected (#2397, so a
  confirmation sent hours late after an edit stays true), and throws when the
  send does: its caller, the owed notice, decides what a failure means.

  The ordinary case is byte for byte what #5398's `sendPaidBookingConfirmedEmail`
  sent: the same arguments, and the event key added to the booking context.
*/

const h = vi.hoisted(() => ({
  findUnique: vi.fn(),
  send: vi.fn(),
  summary: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { booking: { findUnique: h.findUnique } },
}));
vi.mock("@/lib/email", () => ({ sendBookingConfirmedEmail: h.send }));
vi.mock("@/lib/booking-split-summary", () => ({
  getProvisionalNonMemberChildSummary: h.summary,
}));

import { savedCardChargeCents } from "@/lib/booking-payment-state";
import { loadPaidConfirmationBooking, sendPaidBookingConfirmation, type PaidConfirmationBooking } from "@/lib/paid-booking-confirmation-email";

const checkIn = new Date("2026-07-10T00:00:00.000Z");
const checkOut = new Date("2026-07-12T00:00:00.000Z");
const KEY = "booking-1:1782864000000";

function booking(overrides: Record<string, unknown> = {}): PaidConfirmationBooking {
  return {
    id: "booking-1",
    status: "PAID",
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
    payment: { changeFeeCents: 2_500, additionalAmountCents: 0, additionalPaymentStatus: null },
    ...overrides,
  } as unknown as PaidConfirmationBooking;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.send.mockResolvedValue({ status: "sent", emailLogId: `email:booking-confirmed:${KEY}`, messageId: null });
  h.summary.mockResolvedValue(null);
});

describe("loadPaidConfirmationBooking", () => {
  it("reads the booking with the owner, guests, promos, change fee and any uncollected change", async () => {
    h.findUnique.mockResolvedValue(booking());

    await expect(loadPaidConfirmationBooking("booking-1")).resolves.toMatchObject({ id: "booking-1" });

    expect(h.findUnique).toHaveBeenCalledWith({
      where: { id: "booking-1" },
      include: {
        member: true,
        organisation: { select: { name: true, email: true } },
        guests: true,
        promoRedemptions: { include: { promoCode: true } },
        payment: { select: { changeFeeCents: true, additionalAmountCents: true, additionalPaymentStatus: true } },
      },
    });
  });
});

describe("sendPaidBookingConfirmation", () => {
  it("sends with the booking's worth and the event key, the arguments #5398 sent otherwise", async () => {
    await sendPaidBookingConfirmation(booking(), CLUB_FORMAT_TEST, KEY);

    expect(h.summary).toHaveBeenCalledWith({ id: "booking-1", memberId: "member-1" });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith(
      { bookingId: "booking-1", recipientMemberId: "member-1", idempotencyKey: KEY },
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

  it("#4357 (INV-PAY-119): quotes the figure every saved-card door charges, so the confirm-pending job's confirmation is unchanged", async () => {
    const paid = booking();

    await sendPaidBookingConfirmation(paid, CLUB_FORMAT_TEST, KEY);

    expect(h.send.mock.calls[0]?.[6]).toBe(savedCardChargeCents(paid));
  });

  it("describes a provisional non-member child when the booking was split (#738)", async () => {
    const provisionalGuests = { guestCount: 1, amountCents: 4_000, holdUntil: checkIn };
    h.summary.mockResolvedValue(provisionalGuests);

    await sendPaidBookingConfirmation(booking(), CLUB_FORMAT_TEST, KEY);

    expect(h.send.mock.calls[0]?.[8]).toEqual({ lodgeId: "lodge-1", provisionalGuests });
  });

  it("states an upward change made since the payment and not yet collected as still owing (#2397)", async () => {
    const edited = booking({
      finalPriceCents: 14_000,
      payment: { changeFeeCents: 2_500, additionalAmountCents: 4_000, additionalPaymentStatus: "PENDING" },
    });

    await sendPaidBookingConfirmation(edited, CLUB_FORMAT_TEST, KEY);

    expect(h.send.mock.calls[0]?.[6]).toBe(16_500);
    expect(h.send.mock.calls[0]?.[8]).toEqual({ lodgeId: "lodge-1", outstandingBalance: { amountCents: 4_000, payableOnline: false } });
  });

  it("states nothing owing once that change is collected", async () => {
    const collected = booking({ payment: { changeFeeCents: 0, additionalAmountCents: 4_000, additionalPaymentStatus: "SUCCEEDED" } });

    await sendPaidBookingConfirmation(collected, CLUB_FORMAT_TEST, KEY);

    expect(h.send.mock.calls[0]?.[8]).toEqual({ lodgeId: "lodge-1" });
  });

  it("writes to an organisation owner's address with no member to name (#3369)", async () => {
    const school = booking({ memberId: null, member: null, organisation: { name: "Hill School", email: "office@school.test" } });

    await sendPaidBookingConfirmation(school, CLUB_FORMAT_TEST, KEY);

    expect(h.send.mock.calls[0]?.slice(0, 3)).toEqual([
      { bookingId: "booking-1", recipientMemberId: null, idempotencyKey: KEY },
      "office@school.test",
      "Hill School",
    ]);
  });

  it("throws when the send does", async () => {
    h.send.mockRejectedValue(new Error("mail down"));

    await expect(sendPaidBookingConfirmation(booking(), CLUB_FORMAT_TEST, KEY)).rejects.toThrow("mail down");
  });
});
