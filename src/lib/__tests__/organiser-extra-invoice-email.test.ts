import { beforeEach, describe, expect, it, vi } from "vitest";

const sendEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email/core", () => ({ sendEmail }));

import { sendOrganiserExtraInvoiceEmail } from "@/lib/organiser-extra-invoice-email";
import { getEmailTemplateDefinition } from "@/lib/email-message-registry";
import { ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES } from "@/lib/booking-email-suppression";
import { BOOKING_URL_TEMPLATE_NAMES } from "@/lib/booking-email-template-contract";
import { renderTemplateString } from "@/lib/email-message-renderer";
import { CLUB_FORMAT_TEST, CLUB_FORMAT_TEST_OTHER } from "./support/club-format-fixture";

const params = {
  billing: {
    organiserMemberId: "organiser-member",
    organiserBookingId: "organiser-booking",
    organiser: { id: "organiser-member", firstName: "Alex", lastName: "Organiser", email: "alex@example.org" },
    combinedInvoiceId: "combined-invoice",
    placeBookingId: "private-joiner-booking",
  },
  bookingModificationId: "change-1",
  invoiceId: "invoice-id",
  invoiceNumber: "INV-0042",
  amountCents: 6500,
  format: CLUB_FORMAT_TEST,
  placeName: "Sam Joiner",
  changeDescription: "Added one night, including the late-change fee",
};

beforeEach(() => {
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ status: "sent", emailLogId: "log-1", messageId: null });
});

describe("organiser extra-invoice notice (#4299)", () => {
  it("names the place, change, full extra and invoice, and bills the organiser", async () => {
    await sendOrganiserExtraInvoiceEmail(params);
    const call = sendEmail.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      to: "alex@example.org",
      templateName: "group-organiser-extra-invoice",
      idempotencyKey: "change-1",
      deferDelivery: true,
      templateData: {
        firstName: "Alex", joinerName: "Sam Joiner",
        changeSummary: params.changeDescription,
        additionalAmount: "$65.00", xeroInvoiceNumber: "INV-0042",
      },
      bookingContext: {
        bookingId: "organiser-booking",
        recipient: { kind: "member", memberId: "organiser-member" },
      },
    });
    for (const value of [params.placeName, params.changeDescription, "$65.00", "INV-0042", "you are responsible for this extra payment"]) {
      expect(call.html).toContain(value);
    }
    expect(call.html).not.toContain("private-joiner-booking");
    expect(JSON.stringify(call)).not.toContain("/bookings/private-joiner-booking");
  });

  it("registers the money facts as required, with organiser-scoped suppression and retry authority", () => {
    const definition = getEmailTemplateDefinition("group-organiser-extra-invoice");
    expect(definition?.audience).toBe("member");
    expect(definition?.requiredTokens).toEqual(["joinerName", "changeSummary", "additionalAmount", "xeroInvoiceNumber"]);
    expect(ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES.has("group-organiser-extra-invoice")).toBe(true);
    expect(BOOKING_URL_TEMPLATE_NAMES.has("group-organiser-extra-invoice")).toBe(true);
    expect(definition?.defaultBody).toContain("{{bookingUrl}}");
  });

  it("keeps HTML and editable wording aligned and escapes the supplied place and change", async () => {
    await sendOrganiserExtraInvoiceEmail({ ...params, placeName: "Sam <Joiner>", changeDescription: "Added <script>alert(1)</script>" });
    const call = sendEmail.mock.calls[0]?.[0];
    const definition = getEmailTemplateDefinition("group-organiser-extra-invoice");
    if (!definition) throw new Error("missing organiser invoice template");
    const flat = renderTemplateString(definition.defaultBody, call.templateData);
    expect(flat).toContain("Sam <Joiner>");
    expect(flat).toContain("Added <script>alert(1)</script>");
    expect(call.html).toContain("Sam &lt;Joiner&gt;");
    expect(call.html).toContain("Added &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(call.html).not.toContain("<script>");
  });

  it("uses the club format, and retains an invoice reference when Xero returns no number", async () => {
    await sendOrganiserExtraInvoiceEmail({ ...params, format: CLUB_FORMAT_TEST_OTHER, invoiceNumber: null });
    const call = sendEmail.mock.calls[0]?.[0];
    expect(call.templateData.additionalAmount).toContain("CHF");
    expect(call.templateData.additionalAmount).not.toContain("$");
    expect(call.templateData.xeroInvoiceNumber).toBe("invoice-id");
    expect(call.html).toContain("invoice-id");
  });

  it("propagates a missing durable notice so invoice recovery retries it", async () => {
    sendEmail.mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(sendOrganiserExtraInvoiceEmail(params)).rejects.toThrow("queue unavailable");
    await sendOrganiserExtraInvoiceEmail(params);
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(sendEmail.mock.calls[0]?.[0].idempotencyKey).toBe(sendEmail.mock.calls[1]?.[0].idempotencyKey);
  });
});
