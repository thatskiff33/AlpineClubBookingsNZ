import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #1967/#1994: the split-guest settlement admin alert must keep the #1422-style
// preference gating (routed to the shared `adminPaymentFailure` category so a
// rare event needs no new NotificationPreference column) and carry the
// registered `admin-split-settlement-unpaid` template name so `sendToAdmins`
// resolves its delivery-mode policy from the registry.
const h = vi.hoisted(() => ({
  sendToAdmins: vi.fn(),
  shouldSendDirectAdminSystemEmail: vi.fn().mockResolvedValue(true),
  unpaidTemplate: vi.fn(() => "<html>split settlement unpaid</html>"),
  cancelledTemplate: vi.fn(
    (..._args: unknown[]) => "<html>split settlement cancelled</html>",
  ),
}));

vi.mock("../admin-alerts-shared", () => ({
  sendToAdmins: h.sendToAdmins,
  shouldSendDirectAdminSystemEmail: h.shouldSendDirectAdminSystemEmail,
}));
// Derived from the module's own exports (#2689 review): this factory used to
// name 14 of the 16 templates by hand, so a new one silently arrived as
// `undefined`. Spreading the real module means only the two this suite
// asserts on are stubbed, and a new template needs no edit here.
vi.mock("@/lib/email-templates/admin-booking", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  adminSplitSettlementUnpaidTemplate: h.unpaidTemplate,
  adminSplitSettlementCancelledTemplate: h.cancelledTemplate,
}));

import {
  sendAdminSplitSettlementUnpaidAlert,
  sendAdminSplitSettlementCancelledAlert,
} from "@/lib/email/admin-alerts-booking";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

const ORIGINAL_URL = process.env.NEXTAUTH_URL;

const baseData = {
  memberName: "Alex Member",
  checkIn: new Date("2026-08-10T00:00:00.000Z"),
  checkOut: new Date("2026-08-12T00:00:00.000Z"),
  guestCount: 2,
  totalCents: 12300,
  holdUntil: new Date("2026-08-13T00:00:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXTAUTH_URL = "https://club.example.test";
});
afterEach(() => {
  process.env.NEXTAUTH_URL = ORIGINAL_URL;
});

describe("sendAdminSplitSettlementUnpaidAlert (#1967/#1994)", () => {
  it.each([false, true])(
    "routes the alert through the adminPaymentFailure preference for parentUnpaid=%s",
    async (parentUnpaid) => {
      await sendAdminSplitSettlementUnpaidAlert({ ...baseData, parentUnpaid }, CLUB_FORMAT_TEST);

      // #1422 precedent: gated by the existing payment-failure notification
      // category, not a bespoke new preference column.
      expect(h.sendToAdmins).toHaveBeenCalledWith(
        expect.objectContaining({
          templateName: "admin-split-settlement-unpaid",
          preferenceKey: "adminPaymentFailure",
        }),
      );
    },
  );

  it("selects the wording variant from parentUnpaid without changing the audit template name", async () => {
    await sendAdminSplitSettlementUnpaidAlert({ ...baseData, parentUnpaid: false }, CLUB_FORMAT_TEST);
    await sendAdminSplitSettlementUnpaidAlert({ ...baseData, parentUnpaid: true }, CLUB_FORMAT_TEST);

    // A single registry entry backs both wording variants: the boolean only
    // switches the rendered paragraph, so both sends share one templateName.
    expect(h.unpaidTemplate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ parentUnpaid: false }),
      CLUB_FORMAT_TEST,
    );
    expect(h.unpaidTemplate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ parentUnpaid: true }),
      CLUB_FORMAT_TEST,
    );
    for (const call of h.sendToAdmins.mock.calls) {
      expect(call[0].templateName).toBe("admin-split-settlement-unpaid");
      expect(call[0].preferenceKey).toBe("adminPaymentFailure");
    }
  });
});

describe("sendAdminSplitSettlementCancelledAlert (#1993 Part A, C1)", () => {
  it.each([false, true])(
    "sends the DEDICATED cancelled template through adminPaymentFailure for parentUnpaid=%s",
    async (parentUnpaid) => {
      await sendAdminSplitSettlementCancelledAlert({ ...baseData, parentUnpaid }, CLUB_FORMAT_TEST);

      // A distinct registered template (not the recurring alert's name), so an
      // admin override of the noisy recurring alert cannot rewrite the terminal
      // notice; still gated by the shared adminPaymentFailure preference.
      expect(h.sendToAdmins).toHaveBeenCalledWith(
        expect.objectContaining({
          templateName: "admin-split-settlement-cancelled",
          preferenceKey: "adminPaymentFailure",
        }),
      );
      // Renders the cancelled template, never the recurring unpaid one.
      expect(h.cancelledTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ parentUnpaid }),
        CLUB_FORMAT_TEST,
      );
      expect(h.unpaidTemplate).not.toHaveBeenCalled();
    },
  );

  it("carries no holdUntil (terminal notice has no hold to extend)", async () => {
    await sendAdminSplitSettlementCancelledAlert({
      ...baseData,
      parentUnpaid: false,
    }, CLUB_FORMAT_TEST);

    expect(h.cancelledTemplate.mock.calls[0][0]).not.toHaveProperty("holdUntil");
  });
});
