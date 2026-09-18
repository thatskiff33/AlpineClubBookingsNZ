import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2307 (epic #2305, MG2) — `member-guest-consent-expired`: the notice back to
 * the member who WAS ASKED, when their request lapsed.
 *
 * Sent only where a request email actually went out, so nobody is ever told a
 * request lapsed that they never received. That is the caller's rule; what this
 * suite pins is that the message itself asks for nothing, offers no action link,
 * and mentions no money — the bed is already released and there is nothing left
 * for the member to do.
 */

const { sendEmailMock, settingsStub } = vi.hoisted(() => ({
  sendEmailMock: vi.fn(),
  settingsStub: {
    clubName: "Alpine Sports Club",
    bookingsName: "Alpine Sports Club - Bookings",
    lodgeName: "Silverpeak Lodge",
    emailFromName: "Alpine Sports Club - Online Booking System",
    supportEmail: "support@example.org",
    contactEmail: "support@example.org",
    publicUrl: "https://bookings.example.org",
    lodgeTravelNote: "Please allow adequate travel time.",
    doorCode: null as string | null,
  },
}));
vi.mock("@/lib/email/core", () => ({ sendEmail: sendEmailMock }));
vi.mock("@/lib/email-message-settings", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/email-message-settings");
  return {
    ...actual,
    loadEmailMessageSettingsForLodge: vi.fn(async () => settingsStub),
  };
});

import { parseDateOnly } from "@/lib/date-only";
import {
  getDefaultDeliveryMode,
  getEmailTemplateDefinition,
  isAdminSystemTemplate,
} from "@/lib/email-message-registry";
import {
  renderTemplateString,
  validateEmailTemplateContent,
} from "@/lib/email-message-renderer";
import {
  memberGuestConsentExpiredTemplate,
} from "@/lib/email-templates/member-guest";
import { sendMemberGuestConsentExpiredEmail } from "@/lib/email/member-guest";

const TEMPLATE = "member-guest-consent-expired";
const SEND_PARAMS = {
  bookingId: "bkg_1",
  recipient: { kind: "member" as const, memberId: "member_1" },
  email: "priya@example.nz",
  firstName: "Priya",
  bookerName: "Dave Ngata",
  checkIn: parseDateOnly("2026-08-08"),
  checkOut: parseDateOnly("2026-08-10"),
  lodgeId: "lodge_1",
};

const MONEY_PATTERN = /[$€£]|\d+[.,]\d{2}/;

/** Only what the member can READ — the layout's inline CSS carries decimals. */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

describe("memberGuestConsentExpiredTemplate (#2307)", () => {
  const html = memberGuestConsentExpiredTemplate({
    firstName: "Priya",
    bookerName: "Dave Ngata",
    lodgeName: "Silverpeak Lodge",
    checkIn: parseDateOnly("2026-08-08"),
    checkOut: parseDateOnly("2026-08-10"),
  });

  it("names who asked, where, when, and that the bed is released", () => {
    expect(html).toContain("That request has lapsed");
    expect(html).toContain("Dave Ngata");
    expect(html).toContain("Silverpeak Lodge");
    expect(html).toContain("8 Aug 2026");
    expect(html).toContain("10 Aug 2026");
    expect(html).toContain("the bed that was held for you has been released");
  });

  it("asks for nothing and offers no action link", () => {
    expect(html).toContain("You do not need to do anything");
    // No button: there is no action, and a link to a dead consent surface would
    // invite the member to try one.
    expect(html).not.toContain("Answer this request");
    expect(html).not.toContain("#consent");
  });

  it("mentions no money", () => {
    expect(visibleText(html)).not.toMatch(MONEY_PATTERN);
  });

  it("says nothing about a booking being silenced", () => {
    expect(html.toLowerCase()).not.toContain("no emails");
  });

  it("escapes member-supplied names", () => {
    const escaped = memberGuestConsentExpiredTemplate({
      firstName: "Priya",
      bookerName: '<script>alert("x")</script>',
      lodgeName: "Silverpeak Lodge",
      checkIn: parseDateOnly("2026-08-08"),
      checkOut: parseDateOnly("2026-08-10"),
    });

    expect(escaped).not.toContain('<script>alert("x")</script>');
    expect(escaped).toContain("&lt;script&gt;");
  });
});

describe("member-guest-consent-expired registry entry (#2307)", () => {
  const definition = getEmailTemplateDefinition(TEMPLATE);

  it("registers as a member-audience, delivery-locked template", () => {
    if (!definition) throw new Error(`missing ${TEMPLATE}`);

    expect(definition.audience).toBe("member");
    expect(isAdminSystemTemplate(TEMPLATE)).toBe(false);
    expect(definition.deliveryEditable).toBe(false);
    expect(getDefaultDeliveryMode(TEMPLATE)).toBe("always");
  });

  it("refuses an override that drops who asked or which stay it was", () => {
    if (!definition) throw new Error(`missing ${TEMPLATE}`);

    expect(definition.requiredTokens).toEqual(
      expect.arrayContaining(["bookerName", "checkIn", "checkOut"]),
    );
    expect(definition.requiredTokens).not.toContain("token");
    for (const token of definition.requiredTokens) {
      expect(definition.defaultBody).toContain(`{{${token}}}`);
    }
  });

  it("has editor-safe defaults with no square-bracket authoring notes", () => {
    if (!definition) throw new Error(`missing ${TEMPLATE}`);

    const validation = validateEmailTemplateContent({
      templateName: TEMPLATE,
      subject: definition.defaultSubject,
      bodyText: definition.defaultBody,
    });
    expect(validation.issues).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(definition.defaultSubject).not.toMatch(/[[\]]/);
    expect(definition.defaultBody).not.toMatch(/[[\]]/);
  });

  it("renders its default body from sample data with nothing left unresolved", () => {
    if (!definition) throw new Error(`missing ${TEMPLATE}`);

    const rendered = renderTemplateString(
      definition.defaultBody,
      definition.sampleData,
    );
    expect(rendered).not.toMatch(/\{\{[^{}]+\}\}/);
    expect(rendered).not.toMatch(MONEY_PATTERN);
  });
});

describe("sendMemberGuestConsentExpiredEmail (#2307)", () => {
  beforeEach(() => {
    sendEmailMock.mockReset();
    sendEmailMock.mockResolvedValue({
      status: "sent",
      emailLogId: "log_1",
      messageId: "msg_1",
    });
  });

  it("passes the booking id so the per-booking No-emails switch can withhold it", async () => {
    await sendMemberGuestConsentExpiredEmail(SEND_PARAMS);

    const call = sendEmailMock.mock.calls[0][0];
    expect(call.bookingContext).toEqual({
      bookingId: "bkg_1",
      recipient: { kind: "member", memberId: "member_1" },
    });
    expect(call.templateName).toBe(TEMPLATE);
    expect(call.to).toBe("priya@example.nz");
    expect(call.lodgeId).toBe("lodge_1");
    expect(call.subject).toBe(
      "The request to add you to a lodge booking has lapsed",
    );
  });

  it("returns the mailer's outcome instead of swallowing it", async () => {
    const outcome = { status: "sent", emailLogId: "log_1", messageId: "msg_1" };
    sendEmailMock.mockResolvedValue(outcome);
    await expect(sendMemberGuestConsentExpiredEmail(SEND_PARAMS)).resolves.toBe(
      outcome,
    );
  });

  it("hands the flat body the same facts the HTML shows", async () => {
    await sendMemberGuestConsentExpiredEmail(SEND_PARAMS);
    const call = sendEmailMock.mock.calls[0][0];

    expect(call.templateData).toMatchObject({
      firstName: "Priya",
      bookerName: "Dave Ngata",
      checkIn: "8 Aug 2026",
      checkOut: "10 Aug 2026",
    });
    expect(call.html).toContain("Dave Ngata");
    expect(call.html).toContain("8 Aug 2026");
  });
});
