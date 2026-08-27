import { beforeEach, describe, expect, it, vi } from "vitest";

// Fork issue #35, review finding F1 — the {{ical}} block and the HTML
// calendar line embed the booking id in a sessionless bearer URL, and the
// outbound HTML sanitiser (`removeBookingButtons`) only recognises /bookings
// paths, so it can never strip them. The guard is therefore at COMPOSITION:
// the sender builds calendar material only when `resolveBookingEmailLink` —
// "the privacy gate that decides whether the booking id may be placed in
// outbound mail" — returns a link authority for this exact recipient. This
// suite pins that gate in both directions, plus the fail-closed error path.

const {
  sendEmailMock,
  loadLodgeSettingsMock,
  loadAppliedCreditMock,
  resolveBookingEmailLinkMock,
  errorMock,
} = vi.hoisted(() => ({
  sendEmailMock: vi.fn().mockResolvedValue({ status: "sent" }),
  loadLodgeSettingsMock: vi.fn(),
  loadAppliedCreditMock: vi.fn(),
  resolveBookingEmailLinkMock: vi.fn(),
  errorMock: vi.fn(),
}));

vi.mock("@/lib/email/core", () => ({
  sendEmail: sendEmailMock,
}));

vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), error: errorMock, info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/booking-confirmation-credit", () => ({
  loadBookingAppliedCredit: loadAppliedCreditMock,
}));

vi.mock("@/lib/booking-email-authority", () => ({
  resolveBookingEmailLink: resolveBookingEmailLinkMock,
}));

vi.mock("@/lib/email-message-settings", () => ({
  EMAIL_DEFAULT_LODGE_NAME: "Example Club Lodge",
  EMAIL_DEFAULT_FROM_NAME: "Example Club - Online Booking System",
  loadEmailMessageSettingsForLodge: loadLodgeSettingsMock,
  loadEmailMessageSettings: vi.fn(),
  applyEmailMessageSettingsToHtml: vi.fn((html: string) => html),
  applyEmailMessageSettingsToSubject: vi.fn((subject: string) => subject),
  buildEmailTemplateGlobalData: vi.fn(() => ({})),
}));

const BOOKING_ID = "bk_cal_authority";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AUTH_SECRET", "calendar-authority-test-secret");
  vi.stubEnv("NEXTAUTH_URL", "https://bookings.example.org");
  loadLodgeSettingsMock.mockResolvedValue({
    lodgeName: "Example Club Lodge",
    lodgeTravelNote: "Take the Bruce Road.",
    doorCode: null,
  });
  loadAppliedCreditMock.mockResolvedValue({
    amountCents: 0,
    settlementMethod: "card",
  });
});

async function send(): Promise<{
  templateData: Record<string, unknown>;
  html: string;
}> {
  const { sendBookingConfirmedEmail } = await import("@/lib/email/booking");
  await sendBookingConfirmedEmail(
    { bookingId: BOOKING_ID, recipientMemberId: "member_cal" },
    "member@example.org",
    "Sam",
    new Date("2026-08-15"),
    new Date("2026-08-17"),
    2,
    30000,
    {},
  );
  expect(sendEmailMock).toHaveBeenCalledTimes(1);
  const call = sendEmailMock.mock.calls[0][0];
  return { templateData: call.templateData, html: call.html };
}

describe("booking-confirmed calendar links follow the booking-link authority", () => {
  it("an authorized recipient gets the {{ical}} block and the HTML calendar line, id-bearing URL included", async () => {
    resolveBookingEmailLinkMock.mockResolvedValue({
      authority: "authorized",
      bookingUrl: `https://bookings.example.org/bookings/${BOOKING_ID}`,
    });
    const { templateData, html } = await send();
    expect(resolveBookingEmailLinkMock).toHaveBeenCalledWith({
      bookingId: BOOKING_ID,
      templateName: "booking-confirmed",
      recipient: { kind: "member", memberId: "member_cal" },
      deliveryAddress: "member@example.org",
    });
    expect(String(templateData.ical)).toContain(
      `/api/booking-calendar/${BOOKING_ID}?token=`,
    );
    expect(html).toContain("Add this stay to your calendar");
    expect(html).toContain(`/api/booking-calendar/${BOOKING_ID}`);
    // Fork #41: the three links render as self-hosted icons whose alt text
    // keeps them readable when a mail client blocks remote images.
    expect(html).toContain('/branding/calendar/ics.png');
    expect(html).toContain('alt="Google Calendar"');
    expect(html).toContain('alt="Outlook.com"');
  });

  it("an unauthorized recipient gets NO calendar material anywhere — the sanitiser cannot strip these, so composition must not add them", async () => {
    resolveBookingEmailLinkMock.mockResolvedValue({
      authority: "unauthorized",
      bookingUrl: null,
    });
    const { templateData, html } = await send();
    expect(templateData.ical).toBe("");
    expect(html).not.toContain("Add this stay to your calendar");
    expect(html).not.toContain("/api/booking-calendar/");
    expect(html).not.toContain("calendar.google.com");
    expect(html).not.toContain("outlook.live.com");
  });

  it("fails CLOSED when the authority read errors: the send still goes out, without calendar links", async () => {
    resolveBookingEmailLinkMock.mockRejectedValue(new Error("db down"));
    const { templateData, html } = await send();
    expect(templateData.ical).toBe("");
    expect(html).not.toContain("/api/booking-calendar/");
    expect(errorMock).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: BOOKING_ID }),
      expect.stringContaining("booking-link authority"),
    );
  });

  it("fails OPEN when link building itself throws (no auth secret): the send still goes out, without calendar links", async () => {
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("NEXTAUTH_SECRET", "");
    resolveBookingEmailLinkMock.mockResolvedValue({
      authority: "authorized",
      bookingUrl: `https://bookings.example.org/bookings/${BOOKING_ID}`,
    });
    const { templateData, html } = await send();
    expect(templateData.ical).toBe("");
    expect(html).not.toContain("/api/booking-calendar/");
    expect(errorMock).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: BOOKING_ID }),
      expect.stringContaining("add-to-calendar links"),
    );
  });
});
