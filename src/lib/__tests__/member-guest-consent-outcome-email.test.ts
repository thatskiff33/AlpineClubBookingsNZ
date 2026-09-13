import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2307 (epic #2305, MG2) — `member-guest-consent-outcome`: the one template that
 * tells the person who MADE the booking what happened, across all four outcomes
 * (approved, declined, lapsed-and-removed, lapsed-but-still-on-the-booking).
 *
 * This is the only one of the four member-guest emails that mentions money, and
 * it has to: owner decision D-15 settles an expired or declined place as account
 * credit to this recipient. The fourth outcome is the one this suite guards
 * hardest — the owner must never be left believing a guest came off their
 * booking when the sweep could not take them off.
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
  memberGuestConsentOutcomeTemplate,
} from "@/lib/email-templates/member-guest";
import { sendMemberGuestConsentOutcomeEmail } from "@/lib/email/member-guest";
import { composeMemberGuestConsentOutcome } from "@/lib/member-guest-email-notes";

const TEMPLATE = "member-guest-consent-outcome";
const SEND_PARAMS = {
  bookingId: "bkg_1",
  recipient: { kind: "member" as const, memberId: "member_1" },
  email: "dave@example.nz",
  firstName: "Dave",
  guest: { firstName: "Priya", lastName: "Kaur" },
  checkIn: parseDateOnly("2026-08-08"),
  checkOut: parseDateOnly("2026-08-10"),
  outcome: { kind: "APPROVED" } as const,
  lodgeId: "lodge_1",
};

describe("memberGuestConsentOutcomeTemplate (#2307)", () => {
  const copy = composeMemberGuestConsentOutcome({
    guest: { firstName: "Priya", lastName: "Kaur" },
    lodgeName: "Silverpeak Lodge",
    checkIn: parseDateOnly("2026-08-08"),
    checkOut: parseDateOnly("2026-08-10"),
    outcome: { kind: "DECLINED", creditCents: 4800 },
  });
  const html = memberGuestConsentOutcomeTemplate({
    firstName: "Dave",
    outcomeHeading: copy.heading,
    outcomeSentence: copy.sentence,
    consequenceNote: copy.consequenceNote,
    bookingId: "bkg_1",
  });

  it("renders the composed heading, sentence, consequence and booking link", () => {
    expect(html).toContain("Priya Kaur has declined");
    expect(html).toContain("has been taken off your booking");
    expect(html).toContain("$48.00 has been added to your account credit");
    expect(html).toContain("/bookings/bkg_1");
    expect(html).toContain("View this booking");
  });

  it("escapes member-supplied names inside the composed copy", () => {
    const escaped = memberGuestConsentOutcomeTemplate({
      firstName: "Dave",
      outcomeHeading: '<script>alert("x")</script> has declined',
      outcomeSentence: "somebody has declined.",
      consequenceNote: "Your booking has been repriced.",
      bookingId: "bkg_1",
    });

    expect(escaped).not.toContain('<script>alert("x")</script>');
    expect(escaped).toContain("&lt;script&gt;");
  });
});

describe("member-guest-consent-outcome registry entry (#2307)", () => {
  const definition = getEmailTemplateDefinition(TEMPLATE);

  it("registers as a member-audience, delivery-locked template", () => {
    if (!definition) throw new Error(`missing ${TEMPLATE}`);

    // It goes to the booking's OWNER, who is a member — and audience "member" is
    // what lets the per-booking "No emails" switch withhold it (#2258).
    expect(definition.audience).toBe("member");
    expect(isAdminSystemTemplate(TEMPLATE)).toBe(false);
    expect(definition.deliveryEditable).toBe(false);
    expect(getDefaultDeliveryMode(TEMPLATE)).toBe("always");
  });

  it("requires the outcome and consequence while keeping the authorized link optional", () => {
    if (!definition) throw new Error(`missing ${TEMPLATE}`);

    expect(definition.requiredTokens).toEqual(
      expect.arrayContaining([
        "outcomeHeading",
        "outcomeSentence",
        "consequenceNote",
      ]),
    );
    expect(definition.requiredTokens).not.toContain("bookingUrl");
    expect(definition.allowedTokens).toContain("bookingUrl");
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

  it("never prefixes a currency sign to a token that carries its own", () => {
    if (!definition) throw new Error(`missing ${TEMPLATE}`);
    // {{consequenceNote}} arrives with the amount already formatted by
    // formatCents, so a "$" in front of it in the body would print "$$48.00".
    expect(definition.defaultBody).not.toMatch(/\$\s*\{\{/);
    expect(definition.defaultBody).not.toMatch(/-\s*\{\{consequenceNote\}\}/);
  });

  it("renders its default body from sample data with nothing left unresolved", () => {
    if (!definition) throw new Error(`missing ${TEMPLATE}`);

    const rendered = renderTemplateString(
      definition.defaultBody,
      definition.sampleData,
    );
    expect(rendered).not.toMatch(/\{\{[^{}]+\}\}/);
    expect(rendered).toContain("Priya Kaur has accepted");
  });
});

describe("sendMemberGuestConsentOutcomeEmail (#2307)", () => {
  beforeEach(() => {
    sendEmailMock.mockReset();
    sendEmailMock.mockResolvedValue({
      status: "sent",
      emailLogId: "log_1",
      messageId: "msg_1",
    });
  });

  it("passes the booking id so the per-booking No-emails switch can withhold it", async () => {
    await sendMemberGuestConsentOutcomeEmail(SEND_PARAMS);

    const call = sendEmailMock.mock.calls[0][0];
    expect(call.bookingContext).toEqual({
      bookingId: "bkg_1",
      recipient: { kind: "member", memberId: "member_1" },
    });
    expect(call.templateName).toBe(TEMPLATE);
    expect(call.to).toBe("dave@example.nz");
    expect(call.lodgeId).toBe("lodge_1");
  });

  it("returns the mailer's outcome instead of swallowing it", async () => {
    const outcome = { status: "sent", emailLogId: "log_1", messageId: "msg_1" };
    sendEmailMock.mockResolvedValue(outcome);
    await expect(
      sendMemberGuestConsentOutcomeEmail(SEND_PARAMS),
    ).resolves.toBe(outcome);
  });

  it("reports an acceptance as changing nothing", async () => {
    await sendMemberGuestConsentOutcomeEmail(SEND_PARAMS);
    const call = sendEmailMock.mock.calls[0][0];

    expect(call.subject).toContain("Priya Kaur has accepted");
    expect(call.templateData.consequenceNote).toContain(
      "Nothing has changed on your booking",
    );
  });

  it("reports a lapse that released the place, with D-15's account credit", async () => {
    await sendMemberGuestConsentOutcomeEmail({
      ...SEND_PARAMS,
      outcome: {
        kind: "EXPIRED_REMOVED",
        expiredAt: parseDateOnly("2026-08-07"),
        creditCents: 4800,
      },
    });

    const call = sendEmailMock.mock.calls[0][0];
    expect(call.templateData.outcomeSentence).toContain(
      "lapsed on 7 Aug 2026 with no answer",
    );
    expect(call.templateData.consequenceNote).toContain(
      "$48.00 has been added to your account credit",
    );
    expect(call.html).toContain("$48.00");
  });

  it("says plainly when the club, not the system, has to act", async () => {
    await sendMemberGuestConsentOutcomeEmail({
      ...SEND_PARAMS,
      outcome: {
        kind: "EXPIRED_STILL_ON_BOOKING",
        expiredAt: parseDateOnly("2026-08-07"),
        blocker: "LAST_GUEST",
      },
    });

    const call = sendEmailMock.mock.calls[0][0];
    // The owner must not be told the guest came off when they did not.
    expect(call.templateData.outcomeSentence).not.toContain("taken off");
    expect(call.templateData.consequenceNote).toContain(
      "Priya is still on the booking",
    );
    expect(call.templateData.consequenceNote).toContain("The club has been told");
    // And no credit is claimed, because nothing was repriced.
    expect(call.templateData.consequenceNote).not.toContain("account credit");
  });

  it("reports a decline the system could not carry out AS a decline", async () => {
    // The variant that used to be missing. Every BLOCKED outcome — including a
    // member who actively clicked "No thanks" the same day — was reported as
    // EXPIRED_STILL_ON_BOOKING, so the owner was told the member "did not answer
    // in time", on a lapse date fabricated from `new Date()`. Three separate
    // untruths about one event.
    await sendMemberGuestConsentOutcomeEmail({
      ...SEND_PARAMS,
      outcome: { kind: "DECLINED_STILL_ON_BOOKING", blocker: "SETTLEMENT_CHOICE" },
    });

    const call = sendEmailMock.mock.calls[0][0];
    expect(call.templateData.outcomeHeading).toBe("Priya Kaur has declined");
    expect(call.templateData.outcomeSentence).toBe(
      "Priya Kaur has declined your invitation to your booking at Silverpeak Lodge, 8 Aug 2026 - 10 Aug 2026, but could not be taken off it.",
    );
    // Never "did not answer in time", and no date at all: nothing lapsed.
    expect(call.templateData.outcomeSentence).not.toContain("did not answer");
    expect(call.templateData.outcomeSentence).not.toContain("lapsed");
    // And the reason names the real blocker rather than the vague
    // "this booking is in a state the system cannot change on its own".
    expect(call.templateData.consequenceNote).toBe(
      "Priya is still on the booking, because this booking has already been paid for, so somebody has to choose whether that money comes back to you as a refund or as account credit. The club has been told and will be in touch.",
    );
  });

  it("uses the composed heading in the subject, so the two cannot disagree", async () => {
    await sendMemberGuestConsentOutcomeEmail({
      ...SEND_PARAMS,
      outcome: { kind: "DECLINED", creditCents: 0 },
    });

    const call = sendEmailMock.mock.calls[0][0];
    expect(call.subject).toContain("Priya Kaur has declined");
    expect(call.templateData.outcomeHeading).toBe("Priya Kaur has declined");
    // No money in a subject line either — the amount lives in the body's
    // consequence sentence, and a zero credit promises nothing.
    expect(call.subject).not.toContain("$");
    expect(call.templateData.consequenceNote).toContain("no credit to return");
  });
});
