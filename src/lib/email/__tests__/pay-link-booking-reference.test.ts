import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #5407: the two pay-link emails take the booking id and show its short
 * reference, as every other member email does, so no caller can put the raw
 * id in front of a member (or into a club's own wording that uses
 * `{{bookingReference}}`). The pay link itself is built from the token.
 */

const h = vi.hoisted(() => ({
  sendEmail: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("../core", () => ({ sendEmail: h.sendEmail }));
vi.mock("@/lib/email-theme", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  renderEmailHtml: async (render: () => string) => render(),
}));
vi.mock("@/lib/email-templates-club-time", () => ({
  emailCalendarDay: () => "30 June 2026",
  emailClubDateTime: () => "29 June 2026, 8:00 pm",
}));

import {
  sendBookingRequestApprovedEmail,
  sendSplitGuestPaymentLinkEmail,
} from "@/lib/email/booking-requests";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

const PARAMS = {
  bookingContext: "none" as const,
  email: "tara@example.test",
  firstName: "Tara",
  token: "pay-token",
  checkIn: new Date("2026-07-10T00:00:00.000Z"),
  checkOut: new Date("2026-07-12T00:00:00.000Z"),
  guestCount: 2,
  priceCents: 12_000,
  amountDueCents: 12_000,
  bookingId: "ckbooking1234567890",
  expiresAt: new Date("2026-07-03T00:00:00.000Z"),
};

beforeEach(() => {
  h.sendEmail.mockReset();
  h.sendEmail.mockResolvedValue({ status: "sent" });
});

describe.each([
  ["booking-request-approved", sendBookingRequestApprovedEmail],
  ["split-guest-payment-link", sendSplitGuestPaymentLinkEmail],
] as const)("%s (#5407)", (templateName, send) => {
  it("gives the short booking reference, never the raw id, and keeps the pay link on the token", async () => {
    await send(PARAMS, CLUB_FORMAT_TEST);

    const call = h.sendEmail.mock.calls[0][0];
    expect(call.templateName).toBe(templateName);
    expect(call.templateData.bookingReference).toBe("CKBOOKIN");
    expect(JSON.stringify(call.templateData)).not.toContain(PARAMS.bookingId);
    expect(call.templateData.payUrl).toMatch(/\/pay\/pay-token$/);
  });
});
