import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2307 (epic #2305, MG2) — `member-guest-added`: the ONE template that covers
 * all three ways a member ends up on somebody else's booking without having been
 * asked (notify-only club policy, an admin add, and the booking-request pipeline
 * MG4 reuses it for), plus its registry entry and sender wrapper.
 *
 * The property worth most here is that the removal sentence is COMPUTED from the
 * shared self-removal predicate rather than written as boilerplate, so the email
 * never offers a control the server would refuse (owner decision D-14).
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
import { memberGuestAddedTemplate } from "@/lib/email-templates/member-guest";
import { sendMemberGuestAddedEmail } from "@/lib/email/member-guest";
import {
  buildMemberGuestPartyList,
  composeMemberGuestAdded,
  MEMBER_GUEST_REMOVAL_NOTE_BY_BLOCKER,
  MEMBER_GUEST_SELF_REMOVAL_OFFER,
  type MemberGuestRemovalFacts,
} from "@/lib/member-guest-email-notes";

const TEMPLATE = "member-guest-added";
const PARTY = [
  { firstName: "Dave", lastName: "Ngata" },
  { firstName: "Hana", lastName: "Lee" },
];
/** A future, ordinarily-priced booking the guest may take themselves off. */
const REMOVABLE: MemberGuestRemovalFacts = {
  actorMemberId: "mem_guest",
  guestMemberId: "mem_guest",
  bookingOwnerMemberId: "mem_owner",
  bookingStatus: "PAID",
  bookingCheckIn: parseDateOnly("2026-08-08"),
  bookingGuestCount: 2,
  isQuotePriced: false,
  today: parseDateOnly("2026-08-01"),
};
const SEND_PARAMS = {
  bookingId: "bkg_1",
  recipient: { kind: "member" as const, memberId: "member_1" },
  email: "hana@example.nz",
  firstName: "Hana",
  bookerName: "Dave Ngata",
  context: "NOTIFY_ONLY" as const,
  checkIn: parseDateOnly("2026-08-08"),
  checkOut: parseDateOnly("2026-08-10"),
  guestNights: [parseDateOnly("2026-08-08"), parseDateOnly("2026-08-09")],
  party: PARTY,
  selfRemoval: REMOVABLE,
  lodgeId: "lodge_1",
};

const MONEY_PATTERN = /[$€£]|\d+[.,]\d{2}/;

/** Only what the member can READ — the layout's inline CSS carries decimals. */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

describe("memberGuestAddedTemplate (#2307)", () => {
  const added = composeMemberGuestAdded({
    context: "NOTIFY_ONLY",
    bookerName: "Dave Ngata",
    audience: { kind: "TARGET" },
  });
  const html = memberGuestAddedTemplate({
    firstName: "Hana",
    addedHeading: added.heading,
    addedContextNote: added.contextNote,
    lodgeName: "Silverpeak Lodge",
    checkIn: parseDateOnly("2026-08-08"),
    checkOut: parseDateOnly("2026-08-10"),
    guestNightsLabel: "8 Aug 2026, 9 Aug 2026 (2 nights)",
    nightsLabel: "Your nights",
    partyList: buildMemberGuestPartyList(PARTY),
    removalNote: MEMBER_GUEST_SELF_REMOVAL_OFFER,
  });

  it("states why they are on it, the stay, their nights and the party", () => {
    expect(html).toContain("You have been added to a lodge booking");
    expect(html).toContain("this club does not ask first for member guests");
    expect(html).toContain("Silverpeak Lodge");
    expect(html).toContain("Your nights");
    expect(html).toContain("8 Aug 2026, 9 Aug 2026 (2 nights)");
    expect(html).toContain("<li>Hana Lee</li>");
    expect(html).toContain("View this booking");
  });

  it("mentions no money", () => {
    expect(visibleText(html)).not.toMatch(MONEY_PATTERN);
  });

  it("says nothing about a booking being silenced", () => {
    expect(html.toLowerCase()).not.toContain("no emails");
  });

  it("prints the refusal wording verbatim when removal is blocked", () => {
    const blocked = memberGuestAddedTemplate({
      firstName: "Rewi",
      addedHeading: "You have been added to a lodge booking",
      addedContextNote: composeMemberGuestAdded({
        context: "ADMIN",
        bookerName: "Dave Ngata",
        audience: { kind: "TARGET" },
      }).contextNote,
      lodgeName: "Silverpeak Lodge",
      checkIn: parseDateOnly("2026-08-08"),
      checkOut: parseDateOnly("2026-08-10"),
      guestNightsLabel: "8 Aug 2026 (1 night)",
      nightsLabel: "Your nights",
      partyList: buildMemberGuestPartyList(PARTY),
      removalNote: MEMBER_GUEST_REMOVAL_NOTE_BY_BLOCKER.QUOTE_PRICED,
    });

    expect(blocked).toContain("Only the club can take you off");
    expect(blocked).toContain("re-quote the request");
    expect(blocked).not.toContain(
      "you can take yourself off the booking from your account",
    );
  });

  it("escapes member-supplied names", () => {
    const escaped = memberGuestAddedTemplate({
      firstName: '<script>alert("x")</script>',
      addedHeading: "You have been added to a lodge booking",
      addedContextNote: "somebody added you.",
      lodgeName: "Silverpeak Lodge",
      checkIn: parseDateOnly("2026-08-08"),
      checkOut: parseDateOnly("2026-08-10"),
      guestNightsLabel: "",
      nightsLabel: "Your nights",
      partyList: buildMemberGuestPartyList([]),
      removalNote: MEMBER_GUEST_SELF_REMOVAL_OFFER,
    });

    expect(escaped).not.toContain('<script>alert("x")</script>');
    expect(escaped).toContain("&lt;script&gt;");
    // Empty party list and empty nights leave no orphaned heading or label.
    expect(escaped).not.toContain("Everyone on this booking");
    expect(escaped).not.toContain("Your nights");
  });
});

describe("member-guest-added registry entry (#2307)", () => {
  const definition = getEmailTemplateDefinition(TEMPLATE);

  it("registers as a member-audience, delivery-locked template", () => {
    if (!definition) throw new Error(`missing ${TEMPLATE}`);

    // audience "member" is load-bearing — see isBookingSuppressibleTemplate.
    expect(definition.audience).toBe("member");
    expect(isAdminSystemTemplate(TEMPLATE)).toBe(false);
    expect(definition.deliveryEditable).toBe(false);
    expect(getDefaultDeliveryMode(TEMPLATE)).toBe("always");
  });

  it("refuses an override that drops the why or the honest removal answer", () => {
    if (!definition) throw new Error(`missing ${TEMPLATE}`);

    expect(definition.requiredTokens).toEqual(
      expect.arrayContaining(["addedHeading", "addedContextNote", "removalNote"]),
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

  it("carries the composed tokens alone on their own lines", () => {
    if (!definition) throw new Error(`missing ${TEMPLATE}`);

    // A pre-composed block must not have a label of the body's own in front of
    // it: the sender emits either the whole thing or the empty string, and a
    // stranded label is exactly what that convention exists to prevent.
    expect(definition.defaultBody).toContain("\n\n{{partyListNote}}\n\n");
    expect(definition.defaultBody).toContain("\n\n{{removalNote}}\n\n");
  });

  it("renders its default body from sample data with nothing left unresolved", () => {
    if (!definition) throw new Error(`missing ${TEMPLATE}`);

    const rendered = renderTemplateString(
      definition.defaultBody,
      definition.sampleData,
    );
    expect(rendered).not.toMatch(/\{\{[^{}]+\}\}/);
    expect(rendered).toContain("Everyone on this booking:");
    expect(rendered).not.toMatch(MONEY_PATTERN);
  });
});

describe("sendMemberGuestAddedEmail (#2307)", () => {
  beforeEach(() => {
    sendEmailMock.mockReset();
    sendEmailMock.mockResolvedValue({
      status: "sent",
      emailLogId: "log_1",
      messageId: "msg_1",
    });
  });

  it("passes the booking id so the per-booking No-emails switch can withhold it", async () => {
    await sendMemberGuestAddedEmail(SEND_PARAMS);

    const call = sendEmailMock.mock.calls[0][0];
    expect(call.bookingContext).toEqual({
      bookingId: "bkg_1",
      recipient: { kind: "member", memberId: "member_1" },
    });
    expect(call.templateName).toBe(TEMPLATE);
    expect(call.to).toBe("hana@example.nz");
    expect(call.lodgeId).toBe("lodge_1");
  });

  it("returns the mailer's outcome instead of swallowing it", async () => {
    const outcome = { status: "sent", emailLogId: "log_1", messageId: "msg_1" };
    sendEmailMock.mockResolvedValue(outcome);
    await expect(sendMemberGuestAddedEmail(SEND_PARAMS)).resolves.toBe(outcome);
  });

  it.each([
    ["NOTIFY_ONLY", "this club does not ask first for member guests"],
    ["ADMIN", "on behalf of Dave Ngata"],
    ["BOOKING_REQUEST", "booking request"],
  ] as const)(
    "distinguishes the %s add with one composed sentence",
    async (context, expected) => {
      await sendMemberGuestAddedEmail({ ...SEND_PARAMS, context });

      const call = sendEmailMock.mock.calls[0][0];
      expect(call.templateData.addedContextNote).toContain(expected);
      // The same sentence in the HTML the member receives, so the one template
      // really does say three different things.
      expect(call.html).toContain(expected);
    },
  );

  it("offers self-removal only when the shared predicate would allow it", async () => {
    await sendMemberGuestAddedEmail(SEND_PARAMS);
    expect(sendEmailMock.mock.calls[0][0].templateData.removalNote).toBe(
      MEMBER_GUEST_SELF_REMOVAL_OFFER,
    );

    sendEmailMock.mockClear();
    await sendMemberGuestAddedEmail({
      ...SEND_PARAMS,
      selfRemoval: { ...REMOVABLE, isQuotePriced: true },
    });
    const blocked = sendEmailMock.mock.calls[0][0];
    expect(blocked.templateData.removalNote).toBe(
      MEMBER_GUEST_REMOVAL_NOTE_BY_BLOCKER.QUOTE_PRICED,
    );
    // And the HTML says the same thing — one composer, two renderings.
    expect(blocked.html).toContain("Only the club can take you off");
  });

  it("tells a family delegate about the GUEST, not about themselves (D-9)", async () => {
    await sendMemberGuestAddedEmail({
      ...SEND_PARAMS,
      email: "parent@example.nz",
      firstName: "Aroha",
      audience: {
        kind: "DELEGATE",
        guest: { firstName: "Tama", lastName: "Kaur" },
      },
    });

    const call = sendEmailMock.mock.calls[0][0];
    // Without the audience this email told a parent THEY were going to the lodge.
    expect(call.subject).toContain("Tama Kaur has been added to a lodge booking");
    expect(call.templateData.addedHeading).toBe(
      "Tama Kaur has been added to a lodge booking",
    );
    expect(call.templateData.addedContextNote).toContain("Tama Kaur");
    expect(call.templateData.addedContextNote).not.toContain("added you as a guest");
    // A delegate cannot self-remove and neither can a member with no login, so
    // the note names who actually can instead of offering a control to nobody.
    expect(call.templateData.removalNote).toBe(
      "If Tama would rather not go, ask Dave Ngata or the club to take them off this booking.",
    );
    // And the possessive nights label is dropped, because the nights are not the
    // reader's.
    expect(call.html).not.toContain("Your nights");
    expect(call.html).toContain("Nights");
  });

  it("hands the flat body exactly the composed values the HTML shows", async () => {
    await sendMemberGuestAddedEmail(SEND_PARAMS);
    const call = sendEmailMock.mock.calls[0][0];

    expect(call.templateData).toMatchObject({
      firstName: "Hana",
      checkIn: "8 Aug 2026",
      checkOut: "10 Aug 2026",
      guestNightsLabel: "8 Aug 2026, 9 Aug 2026 (2 nights)",
      partyListNote: buildMemberGuestPartyList(PARTY).text,
    });
    for (const name of buildMemberGuestPartyList(PARTY).names) {
      expect(call.html).toContain(`<li>${name}</li>`);
    }
  });
});
