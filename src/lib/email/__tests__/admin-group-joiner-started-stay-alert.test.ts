import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #3672 (delta review D3): the mid-stay joiner alert links the organiser's
 * booking and each switched joiner's booking, the booking detail page whose
 * admin tools record a manual payment. The payments board it used to link
 * lists Payment rows, which a card-path joiner usually does not have yet.
 */

const h = vi.hoisted(() => ({
  sendToAdmins: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("../admin-alerts-shared", () => ({ sendToAdmins: h.sendToAdmins }));
vi.mock("@/lib/email-theme", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  renderEmailHtml: async (render: () => string) => render(),
}));
vi.mock("@/lib/email-templates-club-time", () => ({ emailCalendarDay: () => "30 June 2026" }));

import { sendAdminGroupJoinerStartedStayAlert } from "@/lib/email/admin-alerts-group-joiner-started-stay";
import { buildBookingDetailUrl } from "@/lib/booking-email-contract";

const RESULT = { deliveryAllowed: true, recipients: 1, sent: 1, queuedForRetry: 0, notDelivered: 0 };

beforeEach(() => {
  h.sendToAdmins.mockReset();
  h.sendToAdmins.mockResolvedValue(RESULT);
});

describe("sendAdminGroupJoinerStartedStayAlert (#3672)", () => {
  it("links the organiser's booking and each joiner's, and returns what sendToAdmins did", async () => {
    await expect(
      sendAdminGroupJoinerStartedStayAlert({
        organiserName: "Olive Organiser",
        organiserBookingId: "org-g1",
        checkIn: new Date("2026-06-30T00:00:00.000Z"),
        joiners: [
          { name: "Pat Past", bookingId: "past-1" },
          { name: "Tia Today", bookingId: "today-1" },
        ],
      })
    ).resolves.toBe(RESULT);

    const call = h.sendToAdmins.mock.calls[0][0];
    expect(call.templateName).toBe("admin-group-joiner-started-stay");
    expect(call.preferenceKey).toBe("adminPaymentFailure");
    expect(call.templateData).toEqual({
      organiserName: "Olive Organiser",
      bookingReference: expect.any(String),
      checkIn: "30 June 2026",
      joinerBookingLinks: `Pat Past: ${buildBookingDetailUrl("past-1")}\nTia Today: ${buildBookingDetailUrl("today-1")}`,
      organiserBookingUrl: buildBookingDetailUrl("org-g1"),
    });
    for (const id of ["org-g1", "past-1", "today-1"]) {
      expect(call.html).toContain(`href="${buildBookingDetailUrl(id)}"`);
    }
    expect(call.html).not.toContain("/admin/payments");
  });
});
