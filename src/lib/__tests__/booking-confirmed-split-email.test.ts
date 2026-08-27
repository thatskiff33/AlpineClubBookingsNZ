import { describe, it, expect, vi, beforeEach } from "vitest";

// #1942 — the split-booking parent's confirmation email must explain the
// provisional non-member portion. These tests pin the wiring from
// sendBookingConfirmedEmail into both the rendered HTML and the
// operator-overridable {{provisionalGuestsNote}} token.

const { sendEmailMock } = vi.hoisted(() => ({
  sendEmailMock: vi.fn().mockResolvedValue({ status: "sent" }),
}));

vi.mock("@/lib/email/core", () => ({
  sendEmail: sendEmailMock,
}));

// #2328: the confirmation now reads its own applied account credit before
// composing. These cases are about the split-parent section, so the loader is
// stubbed to "no credit was used" — the shape #2328 leaves byte-for-byte
// unchanged. Its own behaviour is covered in booking-confirmed-credit-email.
vi.mock("@/lib/booking-confirmation-credit", () => ({
  loadBookingAppliedCredit: vi
    .fn()
    .mockResolvedValue({ amountCents: 0, settlementMethod: "card" }),
}));

// Fork #35: authority stubbed to "unauthorized" so no calendar material
// enters these renders; the calendar path has its own dedicated suite
// (booking-confirmed-calendar-authority.test.ts).
vi.mock("@/lib/booking-email-authority", () => ({
  resolveBookingEmailLink: vi
    .fn()
    .mockResolvedValue({ authority: "unauthorized", bookingUrl: null }),
}));

vi.mock("@/lib/email-message-settings", () => ({
  EMAIL_DEFAULT_LODGE_NAME: "Example Club Lodge",
  // Search key the email `<title>` bakes (C6 #1985); required alongside
  // EMAIL_DEFAULT_LODGE_NAME whenever this module is mocked and a template renders.
  EMAIL_DEFAULT_FROM_NAME: "Example Club - Online Booking System",
  loadEmailMessageSettingsForLodge: vi.fn().mockResolvedValue({
    lodgeTravelNote: "Take the Bruce Road.",
    doorCode: null,
  }),
}));

describe("sendBookingConfirmedEmail split provisional section (#1942)", () => {
  const checkIn = new Date("2026-07-15");
  const checkOut = new Date("2026-07-18");
  const holdUntil = new Date("2026-07-08T00:30:00Z");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the provisional section and sets the note token for a split parent", async () => {
    const { sendBookingConfirmedEmail } = await import("../email/booking");

    await sendBookingConfirmedEmail(
      { bookingId: "bk_test", recipientMemberId: "member_1" },
      "member@example.org",
      "Sam",
      checkIn,
      checkOut,
      1,
      12000,
      { provisionalGuests: { guestCount: 2, holdUntil } },
    );

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const call = sendEmailMock.mock.calls[0][0];
    expect(call.templateName).toBe("booking-confirmed");
    expect(call.html).toContain("held provisionally");
    expect(call.html).toContain("2 non-member guests");
    expect(call.html).toContain("covers only your member places");
    // The operator-overridable token carries the same story.
    expect(call.templateData.provisionalGuestsNote).toContain(
      "held provisionally",
    );
    expect(call.templateData.provisionalGuestsNote).toContain(
      "2 non-member guests",
    );
  });

  it("emits no provisional section or note for an ordinary confirmation", async () => {
    const { sendBookingConfirmedEmail } = await import("../email/booking");

    await sendBookingConfirmedEmail(
      { bookingId: "bk_test", recipientMemberId: "member_1" },
      "member@example.org",
      "Sam",
      checkIn,
      checkOut,
      2,
      12000,
    );

    const call = sendEmailMock.mock.calls[0][0];
    expect(call.html).not.toContain("held provisionally");
    expect(call.templateData.provisionalGuestsNote).toBe("");
  });
});
