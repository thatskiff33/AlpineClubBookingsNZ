import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4532 (`INV-INT-032`): the alert for a Stripe payment the app did not create,
 * pinned at the real sender - its unmuteable path, its subject, its template
 * name, its tokens and its Finance-editor audience. Routing it through the
 * muteable `sendToAdmins` fails here.
 */
const mocks = vi.hoisted(() => ({
  sendToAdmins: vi.fn(),
  sendUnmuteableAdminAlert: vi.fn(),
}));

vi.mock("@/lib/email/admin-alerts-shared", () => ({
  sendToAdmins: mocks.sendToAdmins,
  sendUnmuteableAdminAlert: mocks.sendUnmuteableAdminAlert,
}));

import {
  sendAdminUnrecognisedStripePaymentAlert,
  sendAdminUnrecognisedStripePaymentsPausedAlert,
} from "@/lib/email/admin-alerts-unrecognised-stripe-payment";
import {
  UNRECOGNISED_STRIPE_PAYMENT_NOTE,
  UNRECOGNISED_STRIPE_PAYMENTS_PAUSED_NOTE,
} from "@/lib/unrecognised-stripe-payment-note";

type CapturedAlert = {
  subject: string;
  html: string;
  templateName: string;
  templateData: Record<string, unknown>;
  requirement: { area: string; level: string };
};

const FIELDS = {
  amount: "$50.00",
  paidAt: "1 Jul 2026, 9:00 am",
  description: "Donation <b>",
  paymentIntentId: "pi_foreign_1",
  chargeId: "ch_foreign_1",
  checkoutSessionId: "cs_foreign_1",
  paymentLinkId: "plink_foreign_1",
  applicationNote: "",
  stripeDashboardUrl: "https://dashboard.stripe.com/payments/pi_foreign_1",
};

describe("sendAdminUnrecognisedStripePaymentAlert (#4532)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends its own template, unmuteable, to Finance editors, with every token its body needs", async () => {
    await sendAdminUnrecognisedStripePaymentAlert(FIELDS);

    expect(mocks.sendToAdmins).not.toHaveBeenCalled();
    expect(mocks.sendUnmuteableAdminAlert).toHaveBeenCalledTimes(1);
    const [alert] = mocks.sendUnmuteableAdminAlert.mock.calls[0] as [CapturedAlert];
    expect(alert.subject).toBe("Stripe payment the app did not create - code it in Xero: $50.00");
    expect(alert.templateName).toBe("admin-unrecognised-stripe-payment");
    expect(alert.requirement).toEqual({ area: "finance", level: "edit" });
    expect(alert.templateData).toEqual({ ...FIELDS, unrecognisedPaymentNote: UNRECOGNISED_STRIPE_PAYMENT_NOTE });
    expect(alert.html).toContain("Stripe Payment the App Did Not Create");
    expect(alert.html).toContain("pi_foreign_1");
    expect(alert.html).toContain("plink_foreign_1");
    expect(alert.html).toContain("https://dashboard.stripe.com/payments/pi_foreign_1");
    // A payer-typed description is escaped, never markup.
    expect(alert.html).toContain("Donation &lt;b&gt;");
    expect(alert.html).not.toContain("Donation <b>");
  });

  it("sends the hourly \"more payments\" alert through the same unmuteable path, to the same audience", async () => {
    await sendAdminUnrecognisedStripePaymentsPausedAlert({
      paymentCount: "12",
      pausedUntil: "1 Jul 2026, 10:00 am",
      stripeDashboardUrl: "https://dashboard.stripe.com/payments",
    });

    expect(mocks.sendToAdmins).not.toHaveBeenCalled();
    const [alert] = mocks.sendUnmuteableAdminAlert.mock.calls[0] as [CapturedAlert];
    expect(alert.subject).toBe("More Stripe payments the app did not create - check Stripe");
    expect(alert.templateName).toBe("admin-unrecognised-stripe-payments-paused");
    expect(alert.requirement).toEqual({ area: "finance", level: "edit" });
    expect(alert.templateData).toEqual({
      paymentCount: "12",
      pausedUntil: "1 Jul 2026, 10:00 am",
      stripeDashboardUrl: "https://dashboard.stripe.com/payments",
      unrecognisedPaymentsPausedNote: UNRECOGNISED_STRIPE_PAYMENTS_PAUSED_NOTE,
    });
    expect(alert.html).toContain("card testing");
  });

  it("names another platform only when one created the payment", async () => {
    await sendAdminUnrecognisedStripePaymentAlert({ ...FIELDS, applicationNote: "Another platform created this payment." });

    const [alert] = mocks.sendUnmuteableAdminAlert.mock.calls[0] as [CapturedAlert];
    expect(alert.html).toContain("Another platform created this payment.");
  });
});
