import { describe, it, expect, vi, beforeEach } from "vitest";

// #2621 (epic #2629) — the expected-arrival-time retirement, from the two ends
// that can break a real club.
//
// THE HAZARD. `allowedTokens` for a template is assembled partly from the tokens
// SCRAPED OUT OF THE CURRENT DEFAULT SUBJECT AND BODY. `{{expectedArrivalNote}}`
// was allowed only because it sat in the shipped pre-arrival default body, and
// this issue takes it out of that body. If nothing else changed, `allowedTokens`
// would silently drop it, every stored override still containing it would raise
// `disallowed_token`, `validateEmailTemplateContent` would return
// `valid: false`, and `PUT /api/admin/email-templates` would answer 400 —
// offering "Restore Default" as the only remedy, which destroys the exact
// wording the compatibility exists to protect. That is the #2269 incident, and
// the club most likely to hit it is the one that customised its template most
// carefully. The failure is also SILENT until an officer next opens the editor,
// possibly months later, because rendering is fail-soft.
//
// THE MITIGATION, and what this file pins:
//   1. BOTH `expectedArrivalTime` and `expectedArrivalNote` are listed in
//      EXTRA_TEMPLATE_TOKENS["pre-arrival-reminder"], so their allowance no
//      longer depends on the default body at all;
//   2. `sendPreArrivalReminderEmail` still SUPPLIES both keys, permanently `""`;
//   3. BOTH tokens are declared in EMPTYABLE_OVERRIDE_TOKENS (the
//      {{creditNote}} #2328 / {{paymentDueNote}} #2444 precedent) —
//      `expectedArrivalNote` MOVED there out of OPTIONAL_TEMPLATE_TOKENS, so
//      guard 5 passes, and `expectedArrivalTime` added beside it — so guard 4
//      still warns about a dangling label in front of either.
//
// It also pins owner decision D-M5: the default body carries the checkout-day
// chore sentence and no arrival remnant.
//
// NOT COVERED, deliberately: the issue's AC2 also asked for the same proof
// "after a config-transfer import". There is no such path — `src/lib/config-
// transfer` has no email-template category and moves only sender-identity
// fields on the club-settings singleton — so no test is written for it.
//
// Sender harness mirrors checkin-reminder-guest-list.test.ts (#2307), which
// pins the same kind of sender-to-token wiring.

const { sendEmailMock } = vi.hoisted(() => ({
  sendEmailMock: vi.fn().mockResolvedValue({ status: "sent" }),
}));

vi.mock("@/lib/email/core", () => ({
  sendEmail: sendEmailMock,
}));

vi.mock("@/lib/email-message-settings", () => ({
  EMAIL_DEFAULT_LODGE_NAME: "Example Club Lodge",
  EMAIL_DEFAULT_FROM_NAME: "Example Club - Online Booking System",
  loadEmailMessageSettingsForLodge: vi.fn().mockResolvedValue({
    lodgeTravelNote: "Take the Bruce Road.",
    doorCode: null,
  }),
}));

import {
  EMAIL_TEMPLATE_DEFINITIONS,
  EXTRA_TEMPLATE_TOKENS,
} from "../email-message-registry";
import { EMAIL_AUDIT_DEFAULTS } from "../email-message-audit-defaults";
import {
  EMPTYABLE_OVERRIDE_TOKENS,
  OPTIONAL_TEMPLATE_TOKENS,
  findDanglingDefaultLines,
} from "../email-message-token-contract";
import {
  validateEmailTemplateContent,
  renderTemplateString,
} from "../email-message-renderer";
// Imported statically rather than with `await import(...)` inside the test.
// `vi.mock` above is hoisted, so the mocks are in place either way — but this
// module pulls in a large graph, and paying for that inside a 5s test body made
// the assertion time out on a loaded machine. Nothing about the wiring changes.
import { sendPreArrivalReminderEmail } from "../email/booking";

const TEMPLATE = "pre-arrival-reminder";

const definition = EMAIL_TEMPLATE_DEFINITIONS.find((d) => d.key === TEMPLATE)!;
const defaults = EMAIL_AUDIT_DEFAULTS[TEMPLATE];

// A plausible stored override from a club that customised its pre-arrival email
// before this release: it holds BOTH arrival tokens, the note on its own line
// (the shape the shipped default taught) and the raw time inside a sentence.
const STORED_OVERRIDE_SUBJECT =
  "See you soon at {{CLUB_LODGE_NAME}} on {{checkIn}}";
const STORED_OVERRIDE_BODY = [
  "Kia ora {{firstName}},",
  "",
  "Check-in: {{checkIn}}",
  "Check-out: {{checkOut}}",
  "{{expectedArrivalNote}}",
  "If you are getting in after dark ({{expectedArrivalTime}} or later), ring the lodge phone.",
  "",
  // Required tokens for this template — an override that drops them is refused
  // for its own reasons, which would mask what this file is testing.
  "{{outstandingAdditionalNote}}",
  "",
  "{{CLUB_LODGE_TRAVEL_NOTE}}",
  "",
  "{{doorCodeNote}}",
].join("\n");

describe("#2621 stored pre-arrival overrides keep working (the #2269 hazard)", () => {
  it("allows BOTH arrival tokens even though neither is in the default body any more", () => {
    // The two halves together are the whole point. If the first assertion held
    // only because the token was still in the default, the mitigation would be
    // an accident waiting to be undone by the next copy edit.
    expect(definition.allowedTokens).toContain("expectedArrivalTime");
    expect(definition.allowedTokens).toContain("expectedArrivalNote");
    expect(defaults.defaultBody).not.toContain("{{expectedArrivalTime}}");
    expect(defaults.defaultBody).not.toContain("{{expectedArrivalNote}}");
    expect(defaults.defaultSubject).not.toContain("{{expectedArrivalTime}}");
    expect(defaults.defaultSubject).not.toContain("{{expectedArrivalNote}}");

    // Which is to say: the allowance comes from the permanent registry entry,
    // not from scraping the default. Deleting either name below re-arms #2269.
    expect(EXTRA_TEMPLATE_TOKENS[TEMPLATE]).toContain("expectedArrivalTime");
    expect(EXTRA_TEMPLATE_TOKENS[TEMPLATE]).toContain("expectedArrivalNote");
  });

  it("validates a stored override containing both tokens, and re-validates on re-save", () => {
    const first = validateEmailTemplateContent({
      templateName: TEMPLATE,
      subject: STORED_OVERRIDE_SUBJECT,
      bodyText: STORED_OVERRIDE_BODY,
    });
    expect(first.valid).toBe(true);
    expect(first.issues).toEqual([]);

    // Re-saving the identical content is the exact action that 400s under
    // #2269 — an officer opening the editor and pressing Save.
    const second = validateEmailTemplateContent({
      templateName: TEMPLATE,
      subject: STORED_OVERRIDE_SUBJECT,
      bodyText: STORED_OVERRIDE_BODY,
    });
    expect(second.valid).toBe(true);
    expect(second.issues).toEqual([]);
  });

  it("makes the disallowed-token path unreachable for either arrival token", () => {
    // Stated as its own assertion rather than inferred from `valid: true`,
    // because `valid` can be false for reasons that have nothing to do with
    // these two names and a future edit could hide the regression behind one.
    for (const token of ["expectedArrivalTime", "expectedArrivalNote"]) {
      const result = validateEmailTemplateContent({
        templateName: TEMPLATE,
        subject: "Reminder",
        bodyText: [
          `Arrival: {{${token}}}`,
          "{{outstandingAdditionalNote}}",
          "{{CLUB_LODGE_TRAVEL_NOTE}}",
          "{{doorCodeNote}}",
        ].join("\n"),
      });
      const codes = result.issues.map((issue) => issue.code);
      expect(codes).not.toContain("disallowed_token");
      expect(codes).not.toContain("unknown_token");
    }
  });

  it("renders both tokens as nothing, with no dangling label left behind", () => {
    // The values the sender now supplies, permanently.
    const rendered = renderTemplateString(STORED_OVERRIDE_BODY, {
      firstName: "Sam",
      checkIn: "15 Jul 2026",
      checkOut: "18 Jul 2026",
      expectedArrivalTime: "",
      expectedArrivalNote: "",
      outstandingAdditionalNote: "",
      CLUB_LODGE_TRAVEL_NOTE: "Take the Bruce Road.",
      doorCodeNote: "",
    });

    expect(rendered).not.toContain("{{");
    expect(rendered).not.toContain("Expected arrival");
    expect(rendered).toContain("Check-out: 18 Jul 2026");
    expect(rendered).toContain("Take the Bruce Road.");
    // The club's own sentence survives; only the substituted value is empty.
    expect(rendered).toContain("ring the lodge phone");
  });

  it("keeps BOTH arrival tokens declared, moved rather than deleted", () => {
    // Deleting either outright would pass the build and turn guard 4 OFF, so an
    // override reading "Arrival: {{expectedArrivalNote}}" — which now ships a
    // bare "Arrival:" to every member, forever — would stop being warned about.
    expect(EMPTYABLE_OVERRIDE_TOKENS[TEMPLATE]).toContain(
      "expectedArrivalNote",
    );
    // {{expectedArrivalTime}} was missed in the first cut of #2621 and matters
    // MORE, not less: it is the raw value token, so it is the one likeliest to
    // sit behind a hand-typed label ("Expected arrival: {{expectedArrivalTime}}"
    // is the line the old shipped default taught). Undeclared, the warning
    // depended on its preview sample happening to be "" — a value a future
    // author could reasonably give a time back to, silently removing the club's
    // only signal.
    expect(EMPTYABLE_OVERRIDE_TOKENS[TEMPLATE]).toContain(
      "expectedArrivalTime",
    );
    // And neither may be left in OPTIONAL_TEMPLATE_TOKENS, whose guard 5
    // requires a declared token to appear in the default body it describes.
    expect(OPTIONAL_TEMPLATE_TOKENS[TEMPLATE] ?? []).not.toContain(
      "expectedArrivalNote",
    );
    expect(OPTIONAL_TEMPLATE_TOKENS[TEMPLATE] ?? []).not.toContain(
      "expectedArrivalTime",
    );
  });

  describe.each([["expectedArrivalNote"], ["expectedArrivalTime"]])(
    "a saved override with a label typed in front of {{%s}}",
    (token) => {
      // Drives guard 4 exactly as `GET /api/admin/email-templates` does — both
      // declaration tables composed together, samples resolved through the
      // definition — over an override that puts the token behind a hand-typed
      // label. "Expected arrival: {{expectedArrivalTime}}" is the line the old
      // shipped default taught, so it is the line real clubs hold.
      const overrideBody = [
        "Kia ora {{firstName}},",
        "",
        `Expected arrival: {{${token}}}`,
        "",
        "{{CLUB_LODGE_TRAVEL_NOTE}}",
      ].join("\n");

      const danglingWith = (sampleFor: (token: string) => string) =>
        findDanglingDefaultLines(
          {
            [TEMPLATE]: {
              defaultSubject: "Pre-arrival Information",
              defaultBody: overrideBody,
            },
          },
          {
            [TEMPLATE]: [
              ...(OPTIONAL_TEMPLATE_TOKENS[TEMPLATE] ?? []),
              ...(EMPTYABLE_OVERRIDE_TOKENS[TEMPLATE] ?? []),
            ],
          },
          sampleFor,
        );

      const EXPECTED = [
        {
          key: TEMPLATE,
          field: "defaultBody",
          detail: '"Expected arrival:"',
        },
      ];

      it("is warned about, as the admin editor sees it today", () => {
        expect(
          danglingWith((sampled) => definition.sampleData[sampled] ?? sampled),
        ).toEqual(EXPECTED);
      });

      it("is STILL warned about if the token's preview sample gets a value back", () => {
        // THE MUTATION PIN. The assertion above cannot fail if either name is
        // deleted from EMPTYABLE_OVERRIDE_TOKENS, because guard 4 renders an
        // undeclared token with its PREVIEW SAMPLE and both samples are
        // currently "" — so the line dangles either way, and today's warning is
        // a coincidence of the sample rather than a consequence of the
        // declaration. Giving the sample a value again is the obvious future
        // edit for a token named "...Time", and it would silently remove the
        // club's only signal.
        //
        // So this run supplies a NON-EMPTY sample for the token under test.
        // Guard 4 then reports the line only because the token is declared
        // emptyable, which is exactly the property being pinned: delete either
        // name from EMPTYABLE_OVERRIDE_TOKENS and this test fails.
        expect(
          danglingWith((sampled) =>
            sampled === token
              ? "18:30"
              : definition.sampleData[sampled] ?? sampled,
          ),
        ).toEqual(EXPECTED);
      });
    },
  );
});

describe("#2621 the shipped pre-arrival default (owner decision D-M5)", () => {
  it("carries the checkout-day chore sentence and no arrival remnant", () => {
    expect(defaults.defaultBody).toBe(
      "Upcoming Lodge Stay\n\n" +
        "Hi {{firstName}}, your lodge stay is coming up.\n\n" +
        "Check-in: {{checkIn}}\n" +
        "Check-out: {{checkOut}}\n" +
        "Guests: {{guestCount}}\n\n" +
        "You are on the chore roster on the morning you check out, so please talk to the hut leader beforehand if you plan to leave early.\n\n" +
        "{{outstandingAdditionalNote}}\n\n" +
        "How to get to the lodge\n\n" +
        "{{CLUB_LODGE_TRAVEL_NOTE}}\n\n" +
        "{{doorCodeNote}}\n\n" +
        // The canonical authenticated booking link, substituted into every
        // booking-scoped default at export time. Not part of this change.
        "View this booking: {{bookingUrl}}",
    );
  });

  it("renders with no arrival line and no blank-line artefact where it was", () => {
    const rendered = renderTemplateString(defaults.defaultBody, {
      firstName: "Sam",
      checkIn: "15 Jul 2026",
      checkOut: "18 Jul 2026",
      guestCount: 2,
      outstandingAdditionalNote: "",
      CLUB_LODGE_TRAVEL_NOTE: "Take the Bruce Road.",
      doorCodeNote: "",
      BASE_URL: "https://bookings.example.org",
    });

    expect(rendered).not.toMatch(/arrival/i);
    // The guests line runs straight into the chore sentence with exactly one
    // blank line between them — the gap the removed token used to sit in has
    // not turned into a second empty line.
    expect(rendered).toContain(
      "Guests: 2\n\nYou are on the chore roster on the morning you check out,",
    );
  });
});

describe("#2621 sendPreArrivalReminderEmail still supplies both arrival keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("supplies them as empty strings, so an override renders nothing rather than a stale label", async () => {
    await sendPreArrivalReminderEmail({
      bookingId: "bk_test",
      recipientMemberId: "member_1",
      email: "member@example.org",
      firstName: "Sam",
      checkIn: new Date("2026-07-15"),
      checkOut: new Date("2026-07-18"),
      guestCount: 2,
    });

    const call = sendEmailMock.mock.calls[0][0];
    expect(call.templateName).toBe(TEMPLATE);
    // Present-and-empty, NOT absent. An absent key would drop the token out of
    // the supplied-token approval guard and leave the club unable to re-save.
    expect(call.templateData).toHaveProperty("expectedArrivalTime", "");
    expect(call.templateData).toHaveProperty("expectedArrivalNote", "");
    // And the delivered HTML no longer carries the row either.
    expect(call.html).not.toContain("Expected arrival");
    expect(call.html).toContain("chore roster on the morning you check out");
  });
});
