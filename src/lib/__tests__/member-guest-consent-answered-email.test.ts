import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2307 (epic #2305, MG2) — `member-guest-consent-answered`: the notice that
 * goes out when a DELEGATE answered on somebody else's behalf.
 *
 * WHY THIS EMAIL EXISTS. Owner decision D-10 lets an adult in the household
 * answer for a member who has no login of their own, and a decline releases that
 * member's bed and takes them off a booking somebody else put them on. Before
 * this, the only people who learnt of it were the booking's owner and the adult
 * who clicked: the member it was decided FOR heard nothing at all. The old
 * reasoning in the notifier — "a decline needs no notice: they just made the
 * decision themselves" — is true of a member answering for themselves and false
 * of a delegate.
 *
 * What this suite pins is the message itself: it names who answered and who they
 * answered for, it carries NO money and NO booking link (a household adult may
 * have nothing to do with this booking, and D-11 gives booking-page access to a
 * guest ROW rather than to a delegate), and each of the three answers reads
 * differently enough that swapping two of them fails.
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
  memberGuestConsentAnsweredTemplate,
} from "@/lib/email-templates/member-guest";
import { composeMemberGuestConsentAnswered } from "@/lib/member-guest-email-notes";
import { sendMemberGuestConsentAnsweredEmail } from "@/lib/email/member-guest";

const TEMPLATE = "member-guest-consent-answered";
const TARGET = { firstName: "Tama", lastName: "Reid" };
const STAY = {
  lodgeName: "Silverpeak Lodge",
  checkIn: parseDateOnly("2026-08-08"),
  checkOut: parseDateOnly("2026-08-10"),
};
const SEND_PARAMS = {
  bookingId: "bkg_1",
  recipient: { kind: "member" as const, memberId: "member_1" },
  email: "tama@example.nz",
  firstName: "Tama",
  target: TARGET,
  responderName: "Aroha Reid",
  answer: { kind: "DECLINED_REMOVED" } as const,
  checkIn: STAY.checkIn,
  checkOut: STAY.checkOut,
  lodgeId: "lodge_1",
};

const MONEY_PATTERN = /[$€£]|\d+[.,]\d{2}/;

/** Only what the reader can SEE — the layout's inline CSS carries decimals. */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

function copyFor(kind: "APPROVED" | "DECLINED_REMOVED" | "DECLINED_STILL_ON_BOOKING") {
  return composeMemberGuestConsentAnswered({
    target: TARGET,
    responderName: "Aroha Reid",
    ...STAY,
    answer: { kind },
  });
}

describe("composeMemberGuestConsentAnswered (#2307)", () => {
  // Pinned VERBATIM, all three. Copy asserted only by `toContain("Tama")` would
  // pass for every one of these sentences, which is exactly how a reader ends up
  // told that somebody accepted when they declined.
  it("says who answered, for whom, and that the member is now on the booking", () => {
    expect(copyFor("APPROVED")).toEqual({
      heading: "Aroha Reid answered for Tama Reid",
      sentence:
        "Aroha Reid said yes for Tama Reid, so Tama is now on the booking at Silverpeak Lodge, 8 Aug 2026 - 10 Aug 2026.",
      note: "If that is not what you expected, ask the person who made the booking, or the club, to change it.",
    });
  });

  it("says plainly when the member has been taken off", () => {
    expect(copyFor("DECLINED_REMOVED")).toEqual({
      heading: "Aroha Reid answered for Tama Reid",
      sentence:
        "Aroha Reid said no for Tama Reid, so Tama has been taken off the booking at Silverpeak Lodge, 8 Aug 2026 - 10 Aug 2026.",
      note: "If that is not what you expected, ask the person who made the booking to add Tama again.",
    });
  });

  it("does not pretend the member came off when the booking could not be changed", () => {
    // The honest version of the blocked case. Telling a household "Tama has been
    // taken off" when Tama is still holding a bed would be the same lie the
    // booking owner's outcome email used to tell.
    expect(copyFor("DECLINED_STILL_ON_BOOKING")).toEqual({
      heading: "Aroha Reid answered for Tama Reid",
      sentence:
        "Aroha Reid said no for Tama Reid on the booking at Silverpeak Lodge, 8 Aug 2026 - 10 Aug 2026, but the booking could not be changed automatically.",
      note: "Tama is still on that booking for now. The club has been told and will sort it out.",
    });
  });

  it("carries no money in any of the three answers", () => {
    // The money moved on the BOOKING OWNER's account and their own outcome email
    // reports it. A household adult reading this has no business being told what
    // somebody else's stay cost.
    for (const kind of ["APPROVED", "DECLINED_REMOVED", "DECLINED_STILL_ON_BOOKING"] as const) {
      const copy = copyFor(kind);
      expect(`${copy.heading} ${copy.sentence} ${copy.note}`).not.toMatch(MONEY_PATTERN);
    }
  });
});

describe("memberGuestConsentAnsweredTemplate (#2307)", () => {
  const copy = copyFor("DECLINED_REMOVED");
  const html = memberGuestConsentAnsweredTemplate({
    firstName: "Tama",
    answeredHeading: copy.heading,
    answeredSentence: copy.sentence,
    answeredNote: copy.note,
  });

  it("shows the composed heading, sentence and note", () => {
    expect(html).toContain("Aroha Reid answered for Tama Reid");
    expect(html).toContain("has been taken off the booking");
    expect(html).toContain("ask the person who made the booking to add Tama again");
  });

  it("offers no booking link", () => {
    // The recipient may be a household adult who is not on this booking at all,
    // so a "view this booking" button would either leak it or 403 in their face.
    expect(html).not.toContain("/bookings/");
    expect(html).not.toContain("View this booking");
  });

  it("mentions no money", () => {
    expect(visibleText(html)).not.toMatch(MONEY_PATTERN);
  });

  it("escapes member-supplied names", () => {
    const escaped = memberGuestConsentAnsweredTemplate({
      firstName: "Tama",
      answeredHeading: '<script>alert("x")</script>',
      answeredSentence: "s",
      answeredNote: "n",
    });
    expect(escaped).not.toContain('<script>alert("x")</script>');
    expect(escaped).toContain("&lt;script&gt;");
  });
});

describe("member-guest-consent-answered registry entry (#2307)", () => {
  const definition = getEmailTemplateDefinition(TEMPLATE);

  it("registers as a member-audience, delivery-locked template", () => {
    // Member audience is load-bearing, not cosmetic: it is what
    // `isBookingSuppressibleTemplate` keys on, so an admin-audience
    // classification would let a silenced booking mail out.
    if (!definition) throw new Error(`missing ${TEMPLATE}`);

    expect(definition.audience).toBe("member");
    expect(isAdminSystemTemplate(TEMPLATE)).toBe(false);
    expect(definition.deliveryEditable).toBe(false);
    expect(getDefaultDeliveryMode(TEMPLATE)).toBe("always");
  });

  it("refuses an override that drops what was said or by whom", () => {
    if (!definition) throw new Error(`missing ${TEMPLATE}`);

    expect(definition.requiredTokens).toEqual(
      expect.arrayContaining(["answeredHeading", "answeredSentence", "answeredNote"]),
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
    expect(definition.defaultSubject).not.toMatch(/[[\]]/);
    expect(definition.defaultBody).not.toMatch(/[[\]]/);
  });

  it("renders its default body from sample data with nothing left unresolved", () => {
    if (!definition) throw new Error(`missing ${TEMPLATE}`);

    const rendered = renderTemplateString(definition.defaultBody, definition.sampleData);
    expect(rendered).not.toMatch(/\{\{[^{}]+\}\}/);
    expect(rendered).not.toMatch(MONEY_PATTERN);
  });
});

describe("sendMemberGuestConsentAnsweredEmail (#2307)", () => {
  beforeEach(() => {
    sendEmailMock.mockReset();
    sendEmailMock.mockResolvedValue({
      status: "sent",
      emailLogId: "log_1",
      messageId: "msg_1",
    });
  });

  it("passes the booking id so the per-booking No-emails switch can withhold it", async () => {
    await sendMemberGuestConsentAnsweredEmail(SEND_PARAMS);

    const call = sendEmailMock.mock.calls[0][0];
    expect(call.bookingContext).toEqual({
      bookingId: "bkg_1",
      recipient: { kind: "member", memberId: "member_1" },
    });
    expect(call.templateName).toBe(TEMPLATE);
    expect(call.to).toBe("tama@example.nz");
    expect(call.lodgeId).toBe("lodge_1");
  });

  it("hands the flat body the same three blocks the HTML shows", async () => {
    await sendMemberGuestConsentAnsweredEmail(SEND_PARAMS);
    const call = sendEmailMock.mock.calls[0][0];

    expect(call.templateData).toMatchObject({
      firstName: "Tama",
      answeredHeading: "Aroha Reid answered for Tama Reid",
    });
    expect(call.html).toContain("Aroha Reid answered for Tama Reid");
  });

  it("returns the mailer's outcome instead of swallowing it", async () => {
    const outcome = { status: "sent", emailLogId: "log_1", messageId: "msg_1" };
    sendEmailMock.mockResolvedValue(outcome);
    await expect(sendMemberGuestConsentAnsweredEmail(SEND_PARAMS)).resolves.toBe(
      outcome,
    );
  });
});
