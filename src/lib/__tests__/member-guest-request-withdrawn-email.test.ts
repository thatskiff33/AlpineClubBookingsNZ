import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MG4 (#2309) — `member-guest-request-withdrawn`: the counterpart to
 * `member-guest-added`, and the sixth member-guest email.
 *
 * MG2 told a member they had a bed. Three things can take that back — a request
 * nobody had answered yet is withdrawn, a settled member guest is taken off, or
 * the booking-request pipeline swaps them out — and all three leave the member
 * holding an email that has stopped being true.
 *
 * This suite is the fifth sibling of the MG2 five, and it pins the same three
 * things each of those does: the template, the registry entry, and the sender's
 * envelope. It additionally pins the property MG4's own review found broken —
 * that the withdrawn-request case NAMES NOBODY.
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
  memberGuestRequestWithdrawnTemplate,
} from "@/lib/email-templates/member-guest";
import { composeMemberGuestWithdrawn } from "@/lib/member-guest-email-notes";
import { sendMemberGuestRequestWithdrawnEmail } from "@/lib/email/member-guest";

const TEMPLATE = "member-guest-request-withdrawn";
const SEND_PARAMS = {
  bookingId: "bkg_1",
  recipient: { kind: "member" as const, memberId: "member_removed" },
  email: "priya@example.nz",
  firstName: "Priya",
  bookerName: "Dave Ngata",
  context: "REQUEST_CANCELLED" as const,
  checkIn: parseDateOnly("2026-08-08"),
  checkOut: parseDateOnly("2026-08-10"),
  lodgeId: "lodge_1",
};

const MONEY_PATTERN = /[$€£]|\d+[.,]\d{2}/;

/** Only what the member can READ — the layout's inline CSS carries decimals. */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

function renderFor(context: Parameters<typeof composeMemberGuestWithdrawn>[0]["context"]) {
  const copy = composeMemberGuestWithdrawn({
    context,
    bookerName: "Dave Ngata",
    audience: { kind: "TARGET" },
  });
  return memberGuestRequestWithdrawnTemplate({
    firstName: "Priya",
    withdrawnHeading: copy.heading,
    withdrawnContextNote: copy.contextNote,
    lodgeName: "Silverpeak Lodge",
    checkIn: parseDateOnly("2026-08-08"),
    checkOut: parseDateOnly("2026-08-10"),
  });
}

describe("memberGuestRequestWithdrawnTemplate (#2309)", () => {
  const html = renderFor("REQUEST_CANCELLED");

  it("says which stay it was, and that the held bed is released", () => {
    expect(html).toContain("That request has been withdrawn");
    expect(html).toContain("Silverpeak Lodge");
    expect(html).toContain("8 Aug 2026");
    expect(html).toContain("10 Aug 2026");
    expect(html).toContain("has been released");
  });

  it("kills the earlier email's link before the member presses it", () => {
    // Mockup panel 8's third sentence, and the one doing real work in this
    // email: the member is holding an "Answer this request" button that now
    // leads nowhere, and being told beforehand is the difference between a
    // closed loop and an error page.
    expect(html).toContain("The link in the earlier email no longer works.");
    expect(html).toContain(
      "If plans change, you can be added to a booking again later.",
    );
  });

  it("carries the support address the editable default promises", () => {
    // The flat default ends "contact the club at {{SUPPORT_EMAIL}}". An HTML
    // twin that ended "contact the club." with no address would leave the two
    // renderings making different offers of help.
    expect(html).toContain("support@example.org");
    expect(html).toContain("mailto:support@example.org");
  });

  it("names NOBODY on a withdrawn request", () => {
    // The case is chosen from the guest ROW (its consent is still PENDING) by
    // the removal route and the batch modification alike, and neither consults
    // the actor — so the booker and a club officer both reach it. Naming the
    // booker was wrong about half the time, and where an officer had acted it
    // put a staff name in front of somebody who is not on the booking. Signed-
    // off mockup question 3 answers this "no name".
    expect(visibleText(html)).not.toContain("Dave Ngata");
  });

  it("keeps the possessive phrasing where it IS honest — a settled removal", () => {
    // The other half: a settled place really does exist on a named person's
    // booking, and the reader has already been told whose.
    expect(visibleText(renderFor("TAKEN_OFF"))).toContain("Dave Ngata");
  });

  it("names no stranger on the pipeline case either", () => {
    // A booking-request booking is owned by a non-login contact the reader has
    // never dealt with.
    expect(visibleText(renderFor("BOOKING_REQUEST_REPLACED"))).not.toContain(
      "Dave Ngata",
    );
  });

  it("offers no bearer/self-service action and no party listing", () => {
    // This built-in body has nothing for an ordinary removed reader to do. The
    // common mail core may append a canonical detail action only for a recipient
    // who independently retains bookings-view authority; it never adds a party
    // listing that would disclose who remains on the booking.
    expect(html).not.toContain("Answer this request");
    expect(html).not.toContain("#consent");
    expect(html).not.toContain("Everyone on this booking");
  });

  it("mentions no money", () => {
    expect(visibleText(html)).not.toMatch(MONEY_PATTERN);
  });

  it("says nothing about a booking being silenced", () => {
    expect(html.toLowerCase()).not.toContain("no emails");
  });

  it("escapes member-supplied names", () => {
    const escaped = memberGuestRequestWithdrawnTemplate({
      firstName: "Priya",
      withdrawnHeading: "That request has been withdrawn",
      withdrawnContextNote: '<script>alert("x")</script>',
      lodgeName: "Silverpeak Lodge",
      checkIn: parseDateOnly("2026-08-08"),
      checkOut: parseDateOnly("2026-08-10"),
    });

    expect(escaped).not.toContain('<script>alert("x")</script>');
    expect(escaped).toContain("&lt;script&gt;");
  });
});

describe("member-guest-request-withdrawn registry entry (#2309)", () => {
  const definition = getEmailTemplateDefinition(TEMPLATE);

  it("registers as a member-audience, delivery-locked template", () => {
    // Member audience is what makes it suppressible by the per-booking
    // No-emails switch; an admin-audience consent email would bypass it.
    if (!definition) throw new Error(`missing ${TEMPLATE}`);

    expect(definition.audience).toBe("member");
    expect(isAdminSystemTemplate(TEMPLATE)).toBe(false);
    expect(definition.deliveryEditable).toBe(false);
    expect(getDefaultDeliveryMode(TEMPLATE)).toBe("always");
  });

  it("refuses an override that drops what happened or why", () => {
    // Between them the two tokens ARE the message: an override keeping only the
    // stay dates would leave a member holding a stay with no statement that
    // they are no longer on it.
    if (!definition) throw new Error(`missing ${TEMPLATE}`);

    expect(definition.requiredTokens).toEqual(
      expect.arrayContaining(["withdrawnHeading", "withdrawnContextNote"]),
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

  it("keeps the flat default and the HTML making the same two promises", () => {
    // The anti-drift rule, checked on the two sentences MG4's review found
    // diverging: the dead-link paragraph was missing from both renderings, and
    // the support address was in one of them only.
    if (!definition) throw new Error(`missing ${TEMPLATE}`);

    expect(definition.defaultBody).toContain(
      "The link in the earlier email no longer works.",
    );
    expect(definition.defaultBody).toContain("{{SUPPORT_EMAIL}}");
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

describe("sendMemberGuestRequestWithdrawnEmail (#2309)", () => {
  beforeEach(() => {
    sendEmailMock.mockReset();
    sendEmailMock.mockResolvedValue({
      status: "sent",
      emailLogId: "log_1",
      messageId: "msg_1",
    });
  });

  it("passes the booking id so the per-booking No-emails switch can withhold it", async () => {
    await sendMemberGuestRequestWithdrawnEmail(SEND_PARAMS);

    const call = sendEmailMock.mock.calls[0][0];
    expect(call.bookingContext).toEqual({
      bookingId: "bkg_1",
      recipient: { kind: "member", memberId: "member_removed" },
    });
    expect(call.templateName).toBe(TEMPLATE);
    expect(call.to).toBe("priya@example.nz");
    expect(call.lodgeId).toBe("lodge_1");
  });

  it("returns the mailer's outcome instead of swallowing it", async () => {
    const outcome = { status: "sent", emailLogId: "log_1", messageId: "msg_1" };
    sendEmailMock.mockResolvedValue(outcome);
    await expect(
      sendMemberGuestRequestWithdrawnEmail(SEND_PARAMS),
    ).resolves.toBe(outcome);
  });

  it("hands the flat body the same facts the HTML shows", async () => {
    await sendMemberGuestRequestWithdrawnEmail(SEND_PARAMS);
    const call = sendEmailMock.mock.calls[0][0];

    expect(call.templateData).toMatchObject({
      firstName: "Priya",
      checkIn: "8 Aug 2026",
      checkOut: "10 Aug 2026",
    });
    expect(call.html).toContain(call.templateData.withdrawnHeading);
    expect(call.html).toContain("8 Aug 2026");
  });

  it("addresses a DELEGATE about the guest, never about themselves", async () => {
    // Owner decision D-9 makes a target with no login of their own the NORMAL
    // case, so this lands in a family adult's inbox routinely. "You are no
    // longer on that booking" would be addressed to somebody who never was.
    await sendMemberGuestRequestWithdrawnEmail({
      ...SEND_PARAMS,
      context: "TAKEN_OFF",
      firstName: "Pat",
      audience: {
        kind: "DELEGATE",
        guest: { firstName: "Tama", lastName: "Kaur" },
      },
    });

    const call = sendEmailMock.mock.calls[0][0];
    expect(call.templateData.withdrawnHeading).toContain("Tama Kaur");
    expect(call.templateData.withdrawnHeading).not.toMatch(/^You /);
    expect(call.templateData.withdrawnContextNote).toContain(
      "does not have a login of their own",
    );
  });
});
