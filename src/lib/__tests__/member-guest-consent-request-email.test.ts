import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2307 (epic #2305, MG2) — `member-guest-consent-request`: the template, its
 * registry entry, and the sender wrapper.
 *
 * This is the one of the four that carries a deep link, so the subject-line
 * restriction on `consentUrl` is proved here at both layers: the save-time
 * validator an admin's override goes through, and the render-time neutraliser
 * that catches a row stored before that validation existed.
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
    // The sender resolves the booking's lodge identity for the lodge NAME the
    // copy states. Stubbed so these assertions do not depend on a database.
    loadEmailMessageSettingsForLodge: vi.fn(async () => settingsStub),
  };
});

import { getAppBaseUrl } from "@/lib/app-url";
import { parseDateOnly } from "@/lib/date-only";
import {
  getDefaultDeliveryMode,
  getEmailTemplateDefinition,
  getSensitiveEmailSubjectTokens,
  isAdminSystemTemplate,
} from "@/lib/email-message-registry";
import {
  neutraliseSensitiveSubjectContent,
  renderTemplateString,
  validateEmailTemplateContent,
} from "@/lib/email-message-renderer";
import {
  memberGuestConsentRequestTemplate,
} from "@/lib/email-templates/member-guest";
import { sendMemberGuestConsentRequestEmail } from "@/lib/email/member-guest";
import { buildMemberGuestPartyList } from "@/lib/member-guest-email-notes";

const TEMPLATE = "member-guest-consent-request";
// Derived from the app base URL because the template resolves the button href
// with `sameOrigin: true` — a consent link must never point off-site, and an
// off-origin one is deliberately replaced with the site's own base URL.
const CONSENT_URL = `${getAppBaseUrl()}/bookings/bkg_1#consent`;
const PARTY = [
  { firstName: "Dave", lastName: "Ngata" },
  { firstName: "Priya", lastName: "Kaur" },
];
const SEND_PARAMS = {
  bookingId: "bkg_1",
  recipient: { kind: "member" as const, memberId: "member_1" },
  email: "priya@example.nz",
  firstName: "Priya",
  bookerName: "Dave Ngata",
  audience: { kind: "TARGET" } as const,
  checkIn: parseDateOnly("2026-08-08"),
  checkOut: parseDateOnly("2026-08-10"),
  guestNights: [parseDateOnly("2026-08-08"), parseDateOnly("2026-08-09")],
  consentExpiresAt: parseDateOnly("2026-08-07"),
  consentUrl: CONSENT_URL,
  party: PARTY,
  lodgeId: "lodge_1",
};

const MONEY_PATTERN = /[$€£]|\d+[.,]\d{2}/;

/**
 * Only what the member can READ. The email layout's inline CSS is full of
 * decimal sizes ("line-height: 1.55"), so a money assertion over raw markup
 * would be asserting nothing about the copy.
 */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

describe("memberGuestConsentRequestTemplate (#2307)", () => {
  const html = memberGuestConsentRequestTemplate({
    firstName: "Priya",
    bookerName: "Dave Ngata",
    askHeading: "Can Dave Ngata add you to this booking?",
    askContextNote: "Dave Ngata has put you down as a guest on a lodge booking.",
    lodgeName: "Silverpeak Lodge",
    checkIn: parseDateOnly("2026-08-08"),
    checkOut: parseDateOnly("2026-08-10"),
    guestNightsLabel: "8 Aug 2026, 9 Aug 2026 (2 nights)",
    consentExpiresAt: parseDateOnly("2026-08-07"),
    consentUrl: CONSENT_URL,
    partyList: buildMemberGuestPartyList(PARTY),
  });

  it("states the ask, the stay, the answer-by date and the link to answer on", () => {
    expect(html).toContain("Can Dave Ngata add you to this booking?");
    expect(html).toContain("Silverpeak Lodge");
    expect(html).toContain("8 Aug 2026");
    expect(html).toContain("10 Aug 2026");
    expect(html).toContain("8 Aug 2026, 9 Aug 2026 (2 nights)");
    expect(html).toContain("7 Aug 2026");
    expect(html).toContain(CONSENT_URL);
    expect(html).toContain("Answer this request");
  });

  it("carries the full party listing with first AND last names (MG2-D-a)", () => {
    expect(html).toContain("Everyone on this booking");
    expect(html).toContain("<li>Dave Ngata</li>");
    expect(html).toContain("<li>Priya Kaur</li>");
  });

  it("mentions no money at all", () => {
    // Owner decision MG2-D-a: names, not prices. Nothing in this email tells the
    // member what anyone is paying.
    expect(visibleText(html)).not.toMatch(MONEY_PATTERN);
  });

  it("says nothing about a booking being silenced", () => {
    // #2258/#2259: a member must never learn the per-booking "No emails" switch
    // exists, and this email goes to a member who is not the booking's owner.
    expect(html.toLowerCase()).not.toContain("no emails");
  });

  it("escapes member-supplied names", () => {
    const escaped = memberGuestConsentRequestTemplate({
      firstName: "Priya",
      bookerName: '<script>alert("x")</script>',
      askHeading: "Can somebody add you to this booking?",
      askContextNote: "Somebody has put you down as a guest.",
      lodgeName: "Silverpeak Lodge",
      checkIn: parseDateOnly("2026-08-08"),
      checkOut: parseDateOnly("2026-08-10"),
      guestNightsLabel: "8 Aug 2026 (1 night)",
      consentExpiresAt: parseDateOnly("2026-08-07"),
      consentUrl: CONSENT_URL,
      partyList: buildMemberGuestPartyList(PARTY),
    });

    expect(escaped).not.toContain('<script>alert("x")</script>');
    expect(escaped).toContain("&lt;script&gt;");
  });

  it("omits the nights row rather than printing an empty label", () => {
    const noNights = memberGuestConsentRequestTemplate({
      firstName: "Priya",
      bookerName: "Dave Ngata",
      askHeading: "Can Dave Ngata add you to this booking?",
      askContextNote: "Dave Ngata has put you down as a guest.",
      lodgeName: "Silverpeak Lodge",
      checkIn: parseDateOnly("2026-08-08"),
      checkOut: parseDateOnly("2026-08-10"),
      guestNightsLabel: "",
      consentExpiresAt: parseDateOnly("2026-08-07"),
      consentUrl: CONSENT_URL,
      partyList: buildMemberGuestPartyList([]),
    });

    expect(noNights).not.toContain("Nights");
    // An empty party list produces nothing at all, not a bare heading.
    expect(noNights).not.toContain("Everyone on this booking");
  });
});

describe("member-guest-consent-request registry entry (#2307)", () => {
  const definition = getEmailTemplateDefinition(TEMPLATE);

  it("registers as a member-audience, delivery-locked template", () => {
    if (!definition) throw new Error(`missing ${TEMPLATE}`);

    // audience "member" is LOAD-BEARING: isBookingSuppressibleTemplate only ever
    // withholds member-audience mail, so an admin classification would let a
    // silenced booking mail out (#2258).
    expect(definition.audience).toBe("member");
    expect(isAdminSystemTemplate(TEMPLATE)).toBe(false);
    expect(definition.deliveryEditable).toBe(false);
    expect(getDefaultDeliveryMode(TEMPLATE)).toBe("always");
  });

  it("refuses an override that drops the ask, the deadline or the link", () => {
    if (!definition) throw new Error(`missing ${TEMPLATE}`);

    expect(definition.requiredTokens).toEqual(
      expect.arrayContaining([
        "askHeading",
        "askContextNote",
        "consentExpiresAt",
        "consentUrl",
      ]),
    );
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

    // The admin editor pre-fills from defaultBody and stores it verbatim, so an
    // "[only when ...]" note prints into a member's inbox forever. Several older
    // defaults still carry that bug; none of the member-guest ones may.
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
    // The party listing arrives as one block, heading included, because the
    // template language cannot render a list.
    expect(rendered).toContain("Everyone on this booking:");
    expect(rendered).toContain("- Priya Kaur");
    // And still no money, through the override path as well as the HTML one.
    expect(rendered).not.toMatch(MONEY_PATTERN);
  });

  it("keeps the consent link out of subject lines, at both layers", () => {
    // Layer 1 — save time: an admin cannot store a subject that references it.
    expect(getSensitiveEmailSubjectTokens(TEMPLATE).has("consentUrl")).toBe(true);
    const validation = validateEmailTemplateContent({
      templateName: TEMPLATE,
      subject: "Answer here {{consentUrl}}",
      bodyText: definition?.defaultBody ?? "",
    });
    expect(validation.valid).toBe(false);
    expect(validation.sensitiveSubjectTokens).toEqual(["consentUrl"]);
    expect(validation.issues.map((issue) => issue.code)).toContain(
      "sensitive_subject_token",
    );

    // Layer 2 — render time: a row stored before that validation existed still
    // never puts the live link in a header EmailLog persists in the clear.
    expect(
      neutraliseSensitiveSubjectContent(
        `Answer here {{consentUrl}} ${CONSENT_URL}`,
        { consentUrl: CONSENT_URL },
        TEMPLATE,
      ),
    ).toBe("Answer here");
  });
});

describe("sendMemberGuestConsentRequestEmail (#2307)", () => {
  beforeEach(() => {
    sendEmailMock.mockReset();
    sendEmailMock.mockResolvedValue({
      status: "sent",
      emailLogId: "log_1",
      messageId: "msg_1",
    });
  });

  it("passes the booking id so the per-booking No-emails switch can withhold it", async () => {
    await sendMemberGuestConsentRequestEmail(SEND_PARAMS);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const call = sendEmailMock.mock.calls[0][0];
    // A required discriminated union: `"none"` here would silently escape the
    // switch, and this email is always about one specific booking.
    expect(call.bookingContext).toEqual({
      bookingId: "bkg_1",
      recipient: { kind: "member", memberId: "member_1" },
    });
    expect(call.templateName).toBe(TEMPLATE);
    expect(call.to).toBe("priya@example.nz");
    expect(call.lodgeId).toBe("lodge_1");
  });

  it("returns the mailer's outcome instead of swallowing it", async () => {
    const outcome = {
      status: "withheld_for_booking",
      emailLogId: "log_1",
      bookingId: "bkg_1",
      reason: "booking_no_emails",
    };
    sendEmailMock.mockResolvedValue(outcome);

    await expect(sendMemberGuestConsentRequestEmail(SEND_PARAMS)).resolves.toBe(
      outcome,
    );
  });

  it("hands the flat body exactly the composed values the HTML shows", async () => {
    await sendMemberGuestConsentRequestEmail(SEND_PARAMS);
    const call = sendEmailMock.mock.calls[0][0];

    expect(call.templateData).toMatchObject({
      firstName: "Priya",
      bookerName: "Dave Ngata",
      askHeading: "Can Dave Ngata add you to this booking?",
      checkIn: "8 Aug 2026",
      checkOut: "10 Aug 2026",
      guestNightsLabel: "8 Aug 2026, 9 Aug 2026 (2 nights)",
      consentExpiresAt: "7 Aug 2026",
      consentUrl: CONSENT_URL,
      partyListNote: buildMemberGuestPartyList(PARTY).text,
    });
    // The same names, in the same order, in the HTML the member actually gets.
    for (const name of buildMemberGuestPartyList(PARTY).names) {
      expect(call.html).toContain(`<li>${name}</li>`);
    }
  });

  it("uses the composed heading as the subject, so the two cannot disagree", async () => {
    await sendMemberGuestConsentRequestEmail(SEND_PARAMS);
    expect(sendEmailMock.mock.calls[0][0].subject).toBe(
      "Can Dave Ngata add you to this booking?",
    );
  });

  it("addresses a family delegate about the guest, not about themselves (D-9)", async () => {
    await sendMemberGuestConsentRequestEmail({
      ...SEND_PARAMS,
      email: "parent@example.nz",
      firstName: "Aroha",
      audience: {
        kind: "DELEGATE",
        guest: { firstName: "Tama", lastName: "Kaur" },
      },
    });

    const call = sendEmailMock.mock.calls[0][0];
    expect(call.subject).toBe("Can Dave Ngata add Tama Kaur to this booking?");
    expect(call.templateData.askContextNote).toContain(
      "has put Tama Kaur down as a guest",
    );
    expect(call.templateData.askContextNote).not.toContain("put you down");
    expect(call.html).toContain("Tama Kaur");
  });

  it("never puts the consent link in the subject it passes", async () => {
    await sendMemberGuestConsentRequestEmail(SEND_PARAMS);
    expect(sendEmailMock.mock.calls[0][0].subject).not.toContain(CONSENT_URL);
    expect(sendEmailMock.mock.calls[0][0].subject).not.toContain("http");
  });
});
