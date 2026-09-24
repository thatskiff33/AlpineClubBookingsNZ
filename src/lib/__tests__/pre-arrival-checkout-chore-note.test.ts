import { describe, it, expect, vi, beforeEach } from "vitest";

// #2621 (epic #2629, owner decision D-M5) — the checkout-day chore sentence of
// the pre-arrival reminder.
//
// WHAT IT SAYS AND WHY IT IS CONDITIONAL. Under the midday-to-midday guest night
// (#2622/#2631) a guest is present on their checkout morning and is eligible for
// that morning's chore; nobody is asked for a departure time and none is
// inferred. This sentence tells a member who wants to leave early that the
// conversation happens with the hut leader. But **the chores module defaults
// OFF** (`ClubModuleSettings.chores` is `@default(false)`), so written
// unconditionally into the shipped default body it would tell every member of
// every chore-free club that they are on a roster that does not exist, and send
// them to find a hut leader about it — on the last message most members read
// before they travel.
//
// So it is carried by a TOKEN the sender composes, exactly like
// {{choreListNote}} on the sibling `checkin-reminder` template in the same file:
// the sender emits the whole sentence or the empty string, because
// `renderTemplateString` has no conditional syntax to express "only when the
// club runs a chore roster".
//
// This file pins the four things that can each break a real club:
//   1. the token is in the shipped default body, and declared in the table that
//      belongs to a token which IS (OPTIONAL_TEMPLATE_TOKENS, not
//      EMPTYABLE_OVERRIDE_TOKENS);
//   2. chores ON renders the owner's sentence verbatim, in BOTH the HTML and the
//      flat body, from ONE composed value;
//   3. chores OFF says nothing about chores or hut leaders, and leaves no
//      blank-line artefact where the sentence would have been — proved by
//      byte-equality against a body that never carried the line;
//   4. the expected-arrival information the owner kept (8 Aug) is untouched by
//      any of it.
//
// Sender harness mirrors checkin-reminder-guest-list.test.ts (#2307), which pins
// the same kind of sender-to-token wiring.

const { sendEmailMock, loadEffectiveModuleFlagsMock } = vi.hoisted(() => ({
  sendEmailMock: vi.fn().mockResolvedValue({ status: "sent" }),
  // The chores module decides whether the sentence is said at all, so the sender
  // reads the club's module flags. Mocked rather than left to the real loader,
  // which reads the database and — because it fails soft to all-modules-off —
  // would otherwise make every test here the chores-OFF case by accident.
  loadEffectiveModuleFlagsMock: vi.fn().mockResolvedValue({ chores: true }),
}));

vi.mock("@/lib/email/core", () => ({
  sendEmail: sendEmailMock,
}));

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: loadEffectiveModuleFlagsMock,
}));

vi.mock("@/lib/email-message-settings", () => ({
  EMAIL_DEFAULT_LODGE_NAME: "Example Club Lodge",
  EMAIL_DEFAULT_FROM_NAME: "Example Club - Online Booking System",
  loadEmailMessageSettingsForLodge: vi.fn().mockResolvedValue({
    lodgeTravelNote: "Take the Bruce Road.",
    doorCode: null,
  }),
}));

import { EMAIL_AUDIT_DEFAULTS } from "../email-message-audit-defaults";
import {
  EMPTYABLE_OVERRIDE_TOKENS,
  OPTIONAL_TEMPLATE_TOKENS,
} from "../email-message-token-contract";
import { renderTemplateString } from "../email-message-renderer";
import {
  checkoutDayChoreNote,
  composeOptionalEmailLine,
} from "../email-message-notes";
import { plainTextEmailTemplate } from "@/lib/email-templates/layout";
// Imported statically rather than with `await import(...)` inside the test.
// `vi.mock` above is hoisted, so the mocks are in place either way — but this
// module pulls in a large graph, and paying for that inside a 5s test body made
// the assertion time out on a loaded machine.
import { sendPreArrivalReminderEmail } from "../email/booking";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const TEMPLATE = "pre-arrival-reminder";
const defaults = EMAIL_AUDIT_DEFAULTS[TEMPLATE];

const RENDER_DATA = {
  firstName: "Sam",
  checkIn: "15 Jul 2026",
  checkOut: "18 Jul 2026",
  guestCount: 2,
  expectedArrivalNote: "Expected arrival: 16:30\n",
  outstandingAdditionalNote: "",
  CLUB_LODGE_TRAVEL_NOTE: "Take the Bruce Road.",
  doorCodeNote: "",
  BASE_URL: "https://bookings.example.org",
};

const SENTENCE =
  "You are on the chore roster on the morning you check out, so please talk to the hut leader beforehand if you plan to leave early.";

const OUTSTANDING =
  "There is still $123.45 to pay on this booking after a change to your stay. Please pay it from your booking page before you arrive.";

/**
 * What the SENDER puts in `templateData.checkoutChoreNote`: the sentence with
 * its own trailing blank line, or nothing at all. The separator rides the value
 * rather than the default body, so a club with no chore roster — the default —
 * receives the message unchanged in every byte.
 */
const choreToken = (choresEnabled: boolean) =>
  composeOptionalEmailLine(null, checkoutDayChoreNote(choresEnabled), {
    trailing: "\n\n",
  });

/**
 * The pre-#2621 body, byte for byte: the shipped body with the token taken out
 * and nothing else touched. Only possible because the token carries no
 * surrounding newlines of its own — which is the property the byte-equality
 * cases below exist to hold in place.
 */
const BODY_WITHOUT_THE_LINE = defaults.defaultBody.replace(
  "{{checkoutChoreNote}}",
  ""
);

describe("#2621 the shipped pre-arrival default carries the chore sentence as a token", () => {
  it("has {{checkoutChoreNote}} in the body, declared in the table for a token that IS in the default", () => {
    expect(defaults.defaultBody).toContain("{{checkoutChoreNote}}");
    // The sentence itself must NOT be written into the body — that is the whole
    // defect this shape fixes.
    expect(defaults.defaultBody).not.toMatch(/chore roster on the morning/);
    // Guard 5 requires a default-body token to be declared here; guard 6 forbids
    // the other table for it.
    expect(OPTIONAL_TEMPLATE_TOKENS[TEMPLATE] ?? []).toContain(
      "checkoutChoreNote"
    );
    expect(EMPTYABLE_OVERRIDE_TOKENS[TEMPLATE] ?? []).not.toContain(
      "checkoutChoreNote"
    );
  });

  it("keeps the expected-arrival note the owner decided to keep", () => {
    // The 8-Aug decision: the arrival time stays as display-only information.
    // Nothing about D-M5 removes it.
    expect(defaults.defaultBody).toContain("{{expectedArrivalNote}}");
    expect(OPTIONAL_TEMPLATE_TOKENS[TEMPLATE] ?? []).toContain(
      "expectedArrivalNote"
    );
  });

  it("renders the D-M5 sentence, verbatim, for a club that runs chore rosters", () => {
    const rendered = renderTemplateString(defaults.defaultBody, {
      ...RENDER_DATA,
      checkoutChoreNote: choreToken(true),
    });

    // The owner's wording, unparaphrased.
    expect(rendered).toContain(SENTENCE);
  });

  // BOTH outstanding-balance cases. The empty one is the ordinary send; the
  // non-empty one is the case that actually moves, because that sentence sits
  // immediately after this token — any newline this change adds to the body
  // lands between the two and re-shapes a message about money for every
  // chore-free club, which is most of them.
  it.each([
    ["nothing else outstanding", ""],
    ["an outstanding balance to pay", OUTSTANDING],
  ])(
    "renders byte-identically to the pre-#2621 message for a club with no chore roster (%s)",
    (_case, outstandingAdditionalNote) => {
      const data = { ...RENDER_DATA, outstandingAdditionalNote };
      const withToken = renderTemplateString(defaults.defaultBody, {
        ...data,
        checkoutChoreNote: choreToken(false),
      });
      const withoutTheLine = renderTemplateString(BODY_WITHOUT_THE_LINE, data);

      expect(withToken).not.toMatch(/chore/i);
      expect(withToken).not.toMatch(/hut leader/i);
      // Byte-identical BEFORE the paragraph splitter runs, not merely after it.
      // The earlier shape survived only the second of these: it added blank
      // lines that `plainTextEmailTemplate` happened to collapse, which is a
      // property of that one renderer rather than of the message.
      expect(withToken).toBe(withoutTheLine);
      expect(plainTextEmailTemplate(withToken)).toBe(
        plainTextEmailTemplate(withoutTheLine)
      );
    }
  );

  it("gives the sentence a paragraph of its own in the flat body when chores are ON", () => {
    const rendered = renderTemplateString(defaults.defaultBody, {
      ...RENDER_DATA,
      outstandingAdditionalNote: OUTSTANDING,
      checkoutChoreNote: choreToken(true),
    });

    // `plainTextEmailTemplate` splits on blank lines; the sentence has to be a
    // whole block, not glued onto the check-in details above it or onto the
    // money sentence below it.
    const blocks = rendered
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter(Boolean);
    expect(blocks).toContain(SENTENCE);
    expect(blocks).toContain(OUTSTANDING);
  });
});

describe("#2621 sendPreArrivalReminderEmail composes the sentence once for both paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Chores ON unless a test says otherwise.
    loadEffectiveModuleFlagsMock.mockResolvedValue({ chores: true });
  });

  const send = () =>
    sendPreArrivalReminderEmail({
      bookingId: "bk_test",
      recipientMemberId: "member_1",
      email: "member@example.org",
      firstName: "Sam",
      checkIn: new Date("2026-07-15"),
      checkOut: new Date("2026-07-18"),
      guestCount: 2,
      expectedArrivalTime: "16:30",
    }, CLUB_FORMAT_TEST);

  it("says the D-M5 sentence in BOTH the HTML and the flat body when chores is ON", async () => {
    await send();

    const call = sendEmailMock.mock.calls[0][0];
    // Both paths, from the same composed value, so an admin override and the
    // built-in message cannot say different things.
    expect(call.html).toContain("chore roster on the morning you check out");
    // ...and it is a PARAGRAPH in the HTML, not a clause appended to the details
    // table or to the money sentence. The flat body's own paragraph break is the
    // trailing blank line on the token below; this is the HTML half of the same
    // promise.
    expect(call.html).toMatch(
      new RegExp(`<p[^>]*>${SENTENCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</p>`)
    );
    // The token carries the sentence plus its own trailing blank line — the
    // separator rides the value, so the default body needs none around it and a
    // chores-OFF club's message is unchanged.
    expect(call.templateData.checkoutChoreNote).toBe(`${SENTENCE}\n\n`);
    // And the arrival information the owner kept is still there.
    expect(call.html).toContain("Expected arrival");
    expect(call.templateData.expectedArrivalTime).toBe("16:30");
  });

  it("says nothing about chores when the club's chores module is OFF", async () => {
    loadEffectiveModuleFlagsMock.mockResolvedValue({ chores: false });
    await send();

    const call = sendEmailMock.mock.calls[0][0];
    expect(call.html).not.toMatch(/chore/i);
    expect(call.html).not.toMatch(/hut leader/i);
    // Present and EMPTY, not absent: an override holding the token must render
    // nothing rather than the literal "{{checkoutChoreNote}}".
    expect(call.templateData).toHaveProperty("checkoutChoreNote", "");
    // The arrival information is orthogonal and unaffected.
    expect(call.html).toContain("Expected arrival");
  });

  it("stays quiet when the module read fails soft to all-modules-off", async () => {
    // `loadEffectiveModuleFlags` returns all-off on a database problem. That is
    // the right direction for THIS sentence: a blip costs a chores club one
    // reminder sentence, whereas failing open would send a chore-free club's
    // members to find a hut leader about a roster that does not exist.
    loadEffectiveModuleFlagsMock.mockResolvedValue({});
    await send();

    const call = sendEmailMock.mock.calls[0][0];
    expect(call.templateData).toHaveProperty("checkoutChoreNote", "");
    expect(call.html).not.toMatch(/hut leader/i);
  });
});
