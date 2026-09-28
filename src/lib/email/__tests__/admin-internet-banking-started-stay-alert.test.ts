import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #3663 / #3672: the started-stay hold alert hands back what `sendToAdmins`
 * did, so the caller's once-per-payment claim is kept, held a day or given
 * back by the same rule as the mid-stay group alert (`sendAdminAlertOnceEver`).
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
vi.mock("@/lib/email-templates-club-time", () => ({
  emailCalendarDay: () => "30 June 2026",
  emailClubDateTime: () => "29 June 2026, 8:00 pm",
}));

import { sendAdminInternetBankingHoldStartedStayAlert } from "@/lib/email/admin-alerts-internet-banking-started-stay";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

const RESULT = { deliveryAllowed: true, recipients: 1, sent: 0, queuedForRetry: 1, notDelivered: 0 };

beforeEach(() => {
  h.sendToAdmins.mockReset();
  h.sendToAdmins.mockResolvedValue(RESULT);
});

describe("sendAdminInternetBankingHoldStartedStayAlert (#3663)", () => {
  it("sends on the payment-failure preference and returns what sendToAdmins did", async () => {
    await expect(
      sendAdminInternetBankingHoldStartedStayAlert(
        {
          memberName: "Alice Member",
          bookingId: "booking_ib_1",
          checkIn: new Date("2026-06-30T00:00:00.000Z"),
          holdUntil: new Date("2026-06-29T08:00:00.000Z"),
          amountOwingCents: 12345,
        },
        CLUB_FORMAT_TEST,
      ),
    ).resolves.toBe(RESULT);

    const call = h.sendToAdmins.mock.calls[0][0];
    expect(call.templateName).toBe("admin-internet-banking-hold-started-stay");
    expect(call.preferenceKey).toBe("adminPaymentFailure");
    expect(call.templateData).toMatchObject({
      memberName: "Alice Member",
      bookingId: "booking_ib_1",
      checkIn: "30 June 2026",
      holdUntil: "29 June 2026, 8:00 pm",
    });
  });
});
