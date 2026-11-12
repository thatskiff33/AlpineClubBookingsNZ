import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #4960 follow-up: the "Quote accepted, ready for approval" alert linked
 * `?tab=public&filter=ACCEPTED`, but the public-requests panel reads its
 * opening filter from `status`, so officers landed on the default queue.
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

import { sendAdminBookingRequestQuoteAcceptedEmail } from "@/lib/email/admin-alerts-booking";
import { readPublicBookingRequestFilter } from "@/lib/admin-booking-requests-path";

beforeEach(() => {
  h.sendToAdmins.mockReset();
  h.sendToAdmins.mockResolvedValue(undefined);
});

describe("sendAdminBookingRequestQuoteAcceptedEmail", () => {
  it("links the public-requests tab opened on the ACCEPTED filter", async () => {
    await sendAdminBookingRequestQuoteAcceptedEmail({
      requesterName: "Rita Requester",
      checkIn: new Date("2026-07-10T00:00:00.000Z"),
      checkOut: new Date("2026-07-12T00:00:00.000Z"),
      guestCount: 4,
    });

    const call = h.sendToAdmins.mock.calls[0][0];
    const reviewUrl = new URL(call.templateData.reviewUrl);
    expect(reviewUrl.pathname).toBe("/admin/booking-requests");
    expect(reviewUrl.searchParams.get("tab")).toBe("public");
    // The panel's own reader decides the opening filter.
    expect(readPublicBookingRequestFilter(reviewUrl.searchParams)).toBe("ACCEPTED");
    // The HTML button carries the same link, not a second copy of it.
    expect(call.html).toContain(`href="${reviewUrl.href.replaceAll("&", "&amp;")}"`);
  });
});
