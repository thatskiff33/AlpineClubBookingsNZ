import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4911 (`INV-PAY-151`): the alert for a cardholder's dispute of a Stripe
 * payment, pinned at the real sender - its unmuteable path, its subject per
 * stage, its template name, its tokens and its Finance-editor audience.
 * Routing it through the muteable `sendToAdmins` fails here.
 */
const mocks = vi.hoisted(() => ({
  sendToAdmins: vi.fn(),
  sendUnmuteableAdminAlert: vi.fn(),
}));

vi.mock("@/lib/email/admin-alerts-shared", () => ({
  sendToAdmins: mocks.sendToAdmins,
  sendUnmuteableAdminAlert: mocks.sendUnmuteableAdminAlert,
}));

import { sendAdminStripeDisputeAlert } from "@/lib/email/admin-alerts-stripe-dispute";
import type { StripeDisputeAlertFields } from "@/lib/email-templates/admin-stripe-dispute";
import { STRIPE_DISPUTE_HOLD_NOTE, STRIPE_DISPUTE_NEXT_STEP } from "@/lib/stripe-dispute-note";

type CapturedAlert = {
  subject: string;
  html: string;
  templateName: string;
  templateData: Record<string, unknown>;
  requirement: { area: string; level: string };
};

const OPENED: StripeDisputeAlertFields = {
  stage: "opened",
  outcome: "open",
  amount: "$120.00",
  reason: "product not received",
  openedAt: "1 Jul 2026, 9:00 am",
  bookingId: "booking_<1>",
  bookingOwner: "Sam <Member>",
  disputeId: "dp_1",
  paymentIntentId: "pi_disputed_1",
  chargeId: "ch_disputed_1",
  disputeNextStep: STRIPE_DISPUTE_NEXT_STEP.OPEN,
  stripeDashboardUrl: "https://dashboard.stripe.com/payments/pi_disputed_1",
};

function captured(): CapturedAlert {
  expect(mocks.sendToAdmins).not.toHaveBeenCalled();
  expect(mocks.sendUnmuteableAdminAlert).toHaveBeenCalledTimes(1);
  return (mocks.sendUnmuteableAdminAlert.mock.calls[0] as [CapturedAlert])[0];
}

describe("sendAdminStripeDisputeAlert (#4911)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends the opened alert through its own template, unmuteable, to Finance editors, with every token its body needs", async () => {
    await sendAdminStripeDisputeAlert(OPENED);

    const alert = captured();
    expect(alert.subject).toBe("Card payment disputed by the cardholder - respond in Stripe: $120.00");
    expect(alert.templateName).toBe("admin-stripe-dispute");
    expect(alert.requirement).toEqual({ area: "finance", level: "edit" });
    expect(alert.templateData).toEqual({
      ...OPENED,
      disputeHoldNote: STRIPE_DISPUTE_HOLD_NOTE,
      disputeSubjectLabel: "Card payment disputed by the cardholder - respond in Stripe",
    });
    expect(alert.html).toContain("Card Payment Disputed by the Cardholder");
    expect(alert.html).toContain("Respond in Stripe with evidence");
    expect(alert.html).toContain("the app issues no card refund and no account credit for this payment");
    expect(alert.html).toContain("dp_1");
    expect(alert.html).toContain("pi_disputed_1");
    expect(alert.html).toContain("ch_disputed_1");
    expect(alert.html).toContain("https://dashboard.stripe.com/payments/pi_disputed_1");
  });

  it.each([
    { outcome: "won", status: "WON" as const, subject: "Card payment dispute closed (won): $120.00" },
    { outcome: "lost", status: "LOST" as const, subject: "Card payment dispute closed (lost): $120.00" },
    {
      outcome: "closed with no funds taken",
      status: "CLOSED_OTHER" as const,
      subject: "Card payment dispute closed (closed with no funds taken): $120.00",
    },
  ])("titles the closed alert by its outcome ($outcome)", async ({ outcome, status, subject }) => {
    await sendAdminStripeDisputeAlert({ ...OPENED, stage: "closed", outcome, disputeNextStep: STRIPE_DISPUTE_NEXT_STEP[status] });

    const alert = captured();
    expect(alert.subject).toBe(subject);
    expect(alert.templateName).toBe("admin-stripe-dispute");
    expect(alert.requirement).toEqual({ area: "finance", level: "edit" });
    expect(alert.templateData.disputeSubjectLabel).toBe(subject.replace(/: \$120\.00$/, ""));
    expect(alert.html).toContain("Card Payment Dispute Closed");
    expect(alert.html).not.toContain("Card Payment Disputed by the Cardholder");
    expect(alert.html).toContain(STRIPE_DISPUTE_NEXT_STEP[status].split(".")[0]);
  });

  it("escapes every value it did not write itself", async () => {
    await sendAdminStripeDisputeAlert({ ...OPENED, stage: "closed", outcome: "lost <b>", reason: "fraudulent <i>" });

    const { html } = captured();
    expect(html).toContain("booking_&lt;1&gt;");
    expect(html).not.toContain("booking_<1>");
    expect(html).toContain("Sam &lt;Member&gt;");
    expect(html).not.toContain("Sam <Member>");
    expect(html).toContain("lost &lt;b&gt;");
    expect(html).not.toContain("lost <b>");
    expect(html).toContain("fraudulent &lt;i&gt;");
    expect(html).not.toContain("fraudulent <i>");
  });
});
