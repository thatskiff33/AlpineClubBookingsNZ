import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2260 — the member receipt for a manually recorded membership subscription
 * payment: the template, its registry entry, and the sender wrapper.
 */

const { sendEmailMock } = vi.hoisted(() => ({ sendEmailMock: vi.fn() }));
vi.mock("@/lib/email/core", () => ({ sendEmail: sendEmailMock }));

import {
  membershipPaymentRecordedTemplate,
} from "@/lib/email-templates/membership";
import {
  getDefaultDeliveryMode,
  getEmailTemplateDefinition,
  isAdminSystemTemplate,
} from "@/lib/email-message-registry";
import { validateEmailTemplateContent } from "@/lib/email-message-renderer";
import { sendMembershipPaymentRecordedEmail } from "@/lib/email/membership";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

// 8am on 2 July in NZ is still 1 July in UTC. Any date rendered through the
// NZ helpers reports 2 July; a bare toLocaleDateString on a UTC/other-zone
// machine would report 1 July (the #2256 class of bug).
const RECORDED_AT = new Date("2026-07-01T20:00:00Z");

describe("membershipPaymentRecordedTemplate (#2260)", () => {
  it("renders the season, the amount from integer cents and the NZ date recorded", () => {
    const html = membershipPaymentRecordedTemplate({
      firstName: "Ada",
      seasonYear: 2026,
      amountCents: 12345,
      recordedAt: RECORDED_AT,
    }, CLUB_FORMAT_TEST);

    expect(html).toContain("Membership Payment Recorded");
    expect(html).toContain("Ada");
    expect(html).toContain("2026");
    expect(html).toContain("$123.45");
    expect(html).toContain("2 Jul 2026");
    expect(html).not.toContain("1 Jul 2026");
  });

  it("omits the amount line entirely when no fee amount is recorded", () => {
    const html = membershipPaymentRecordedTemplate({
      firstName: "Ada",
      seasonYear: 2026,
      amountCents: null,
      recordedAt: RECORDED_AT,
    }, CLUB_FORMAT_TEST);

    // Never invent a figure for cash the app never saw — and never print
    // "$0.00" as if that were the amount paid.
    expect(html).not.toContain("Amount recorded");
    expect(html).not.toContain("$0.00");
    expect(html).toContain("2 Jul 2026");
  });

  it("promises nothing about invoices, payment links or Xero", () => {
    const html = membershipPaymentRecordedTemplate({
      firstName: "Ada",
      seasonYear: 2026,
      amountCents: 5000,
      recordedAt: RECORDED_AT,
    }, CLUB_FORMAT_TEST);

    expect(html.toLowerCase()).not.toContain("xero");
    expect(html.toLowerCase()).not.toContain("invoice");
    expect(html).not.toContain("/pay/");
  });

  it("escapes the member's name", () => {
    const html = membershipPaymentRecordedTemplate({
      firstName: '<script>alert("x")</script>',
      seasonYear: 2026,
      amountCents: null,
      recordedAt: RECORDED_AT,
    }, CLUB_FORMAT_TEST);

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("membership-payment-recorded registry entry (#2260)", () => {
  const definition = getEmailTemplateDefinition("membership-payment-recorded");

  it("registers as a member-facing, delivery-locked template", () => {
    if (!definition) throw new Error("missing membership-payment-recorded");

    expect(definition.audience).toBe("member");
    expect(isAdminSystemTemplate("membership-payment-recorded")).toBe(false);
    // Wording is editable; delivery is not admin-disable-able. Whether it sends
    // at all is the admin's per-action choice on the mark-paid dialog.
    expect(definition.deliveryEditable).toBe(false);
    expect(getDefaultDeliveryMode("membership-payment-recorded")).toBe("always");
  });

  it("requires the member and the season in any override, but never the amount", () => {
    if (!definition) throw new Error("missing membership-payment-recorded");

    expect(definition.requiredTokens).toEqual(
      expect.arrayContaining(["firstName", "seasonYear"]),
    );
    // The amount is omitted whenever the club has no recorded fee amount, so
    // requiring it would force an override to promise a figure the send cannot
    // always supply.
    expect(definition.requiredTokens).not.toContain("amount");
    for (const token of definition.requiredTokens) {
      expect(definition.defaultBody).toContain(`{{${token}}}`);
    }
    expect(definition.allowedTokens).toEqual(
      expect.arrayContaining(["amount", "date", "firstName", "seasonYear"]),
    );
    // No bearer token, so nothing here is subject-sensitive.
    expect(definition.requiredTokens).not.toContain("token");
  });

  it("has editor-safe defaults", () => {
    if (!definition) throw new Error("missing membership-payment-recorded");

    const validation = validateEmailTemplateContent({
      templateName: definition.key,
      subject: definition.defaultSubject,
      bodyText: definition.defaultBody,
    });

    expect(validation.issues).toEqual([]);
    expect(validation.valid).toBe(true);
  });
});

describe("sendMembershipPaymentRecordedEmail (#2260)", () => {
  beforeEach(() => {
    sendEmailMock.mockReset();
  });

  it("returns the send outcome instead of swallowing it", async () => {
    const outcome = {
      status: "skipped_placeholder_recipient",
      emailLogId: null,
      reason: "placeholder",
    };
    sendEmailMock.mockResolvedValue(outcome);

    // The caller has to be able to tell a dispatched receipt from one the
    // mailer never sent; a void return would leave it asserting delivery.
    await expect(
      sendMembershipPaymentRecordedEmail({
        email: "walkin@club.invalid",
        firstName: "Ada",
        seasonYear: 2026,
        amountCents: null,
        recordedAt: RECORDED_AT,
      }, CLUB_FORMAT_TEST),
    ).resolves.toBe(outcome);
  });

  it('sends with bookingContext "none" — a subscription is not a booking', async () => {
    sendEmailMock.mockResolvedValue({
      status: "sent",
      emailLogId: "log-1",
      messageId: "msg-1",
    });

    await sendMembershipPaymentRecordedEmail({
      email: "ada@example.org",
      firstName: "Ada",
      seasonYear: 2026,
      amountCents: 12345,
      recordedAt: RECORDED_AT,
    }, CLUB_FORMAT_TEST);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const call = sendEmailMock.mock.calls[0][0];
    // The per-booking "No emails" switch cannot apply to membership mail, so
    // the gate short-circuits on "none" (#2258).
    expect(call.bookingContext).toBe("none");
    expect(call.to).toBe("ada@example.org");
    expect(call.templateName).toBe("membership-payment-recorded");
    expect(call.subject).toContain("2026");
    expect(call.templateData).toMatchObject({
      firstName: "Ada",
      seasonYear: "2026",
      amount: "$123.45",
      date: "2 Jul 2026",
    });
  });

  it("passes an empty amount token when no fee amount is recorded", async () => {
    sendEmailMock.mockResolvedValue({ status: "sent", emailLogId: "log-1", messageId: "msg-1" });

    await sendMembershipPaymentRecordedEmail({
      email: "ada@example.org",
      firstName: "Ada",
      seasonYear: 2026,
      amountCents: null,
      recordedAt: RECORDED_AT,
    }, CLUB_FORMAT_TEST);

    expect(sendEmailMock.mock.calls[0][0].templateData.amount).toBe("");
  });
});
