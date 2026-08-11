import { describe, expect, it } from "vitest";
import {
  EMAIL_TEMPLATE_DEFINITIONS,
  SENSITIVE_EMAIL_SUBJECT_TOKEN_SET,
  getSensitiveEmailSubjectTokens,
  getDefaultDeliveryMode,
  getEmailTemplateDefinition,
  isAdminSystemTemplate,
} from "@/lib/email-message-registry";
import {
  neutraliseSensitiveSubjectContent,
  renderTemplateString,
  validateApprovedTemplateTokens,
  validateEmailTemplateContent,
} from "@/lib/email-message-renderer";
import {
  ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES,
  isBookingSuppressibleTemplate,
} from "@/lib/booking-email-suppression";

describe("email message registry", () => {
  it("uses content-only defaults for noisy scheduled report emails", () => {
    expect(getDefaultDeliveryMode("admin-daily-digest")).toBe("content_only");
    expect(getDefaultDeliveryMode("admin-xero-reconciliation-report")).toBe(
      "content_only",
    );
    expect(getDefaultDeliveryMode("admin-payment-failure")).toBe("always");
  });

  it("registers the #1992/#2007 duplicate-capture refund alert as a delivery-editable admin alert", () => {
    const definition = getEmailTemplateDefinition(
      "admin-duplicate-capture-refund",
    );
    if (!definition) throw new Error("missing admin-duplicate-capture-refund");

    // Admin audience, admin-system, NOT delivery-locked (an operational nudge —
    // the refund already happened or is durably queued, so muting loses no
    // money). Required tokens are the member name + admin action link.
    expect(definition.audience).toBe("admin");
    expect(isAdminSystemTemplate("admin-duplicate-capture-refund")).toBe(true);
    expect(definition.deliveryEditable).toBe(true);
    expect(getDefaultDeliveryMode("admin-duplicate-capture-refund")).toBe(
      "always",
    );
    expect(definition.requiredTokens).toEqual(
      expect.arrayContaining(["memberName", "reviewUrl"]),
    );
    for (const token of definition.requiredTokens) {
      expect(definition.defaultBody).toContain(`{{${token}}}`);
    }
  });

  it("has editor-safe defaults for every registered template", () => {
    // Kept for the checks that are NOT circular — raw HTML, unsafe links,
    // subject line breaks, sensitive subject tokens. The token half of this
    // assertion never had teeth on a default (see the #2268 guards below):
    // `allowedTokens` is scraped out of the default body it validates.
    const invalidDefinitions = EMAIL_TEMPLATE_DEFINITIONS.flatMap((definition) => {
      const validation = validateEmailTemplateContent({
        templateName: definition.key,
        subject: definition.defaultSubject,
        bodyText: definition.defaultBody,
      });

      return validation.valid
        ? []
        : [{ key: definition.key, issues: validation.issues }];
    });

    expect(invalidDefinitions).toEqual([]);
  });

  it("allows age-up invitation wording to use configured age-tier data", () => {
    const ageUpDefinition = EMAIL_TEMPLATE_DEFINITIONS.find(
      (definition) => definition.key === "age-up-invitation",
    );

    expect(ageUpDefinition?.allowedTokens).toEqual(
      expect.arrayContaining([
        "targetAgeTier",
        "targetAgeTierLabel",
        "targetAgeTierMinAge",
      ]),
    );
  });

  it("registers the age-up parent email handoff template as editor-safe", () => {
    const handoffDefinition = EMAIL_TEMPLATE_DEFINITIONS.find(
      (definition) => definition.key === "age-up-parent-email-handoff",
    );

    expect(handoffDefinition).toBeDefined();
    expect(handoffDefinition?.allowedTokens).toEqual(
      expect.arrayContaining([
        "memberName",
        "recipientName",
        "targetAgeTier",
        "targetAgeTierLabel",
        "targetAgeTierMinAge",
      ]),
    );
    expect(handoffDefinition?.requiredTokens).toContain("memberName");
  });

  it("rejects unapproved template tokens", () => {
    expect(validateApprovedTemplateTokens(["Hi {{firstName}}"])).toEqual([]);
    expect(validateApprovedTemplateTokens(["Hi {{secretTokenValue}}"])).toEqual([
      "secretTokenValue",
    ]);
  });

  it("rejects template tokens that are not allowed for that message", () => {
    const validation = validateEmailTemplateContent({
      templateName: "password-reset",
      subject: "Reset your password",
      bodyText: "Hi {{memberName}}, reset here {{BASE_URL}}/reset-password?token={{token}}",
    });

    expect(validation.valid).toBe(false);
    expect(validation.disallowedTokens).toContain("memberName");
  });

  it("rejects missing required tokens", () => {
    const validation = validateEmailTemplateContent({
      templateName: "password-reset",
      subject: "Reset your password",
      bodyText: "Please contact support.",
    });

    expect(validation.valid).toBe(false);
    expect(validation.missingRequiredTokens).toContain("token");
  });

  it("accepts required tokens that appear only in the body", () => {
    const validation = validateEmailTemplateContent({
      templateName: "booking-confirmed",
      subject: "Your booking is confirmed",
      bodyText:
        "Hi {{firstName}}, see you soon.\n\n{{promoSummary}}Total Paid: {{totalPaid}}\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\nDoor code: {{doorCode}}",
    });

    expect(validation.valid).toBe(true);
    expect(validation.missingRequiredTokens).toEqual([]);
  });

  it("does not let subject tokens satisfy required body tokens", () => {
    const validation = validateEmailTemplateContent({
      templateName: "age-up-parent-email-handoff",
      subject: "Update about {{memberName}}",
      bodyText: "Hello, an account update has occurred.",
    });

    expect(validation.valid).toBe(false);
    expect(validation.missingRequiredTokens).toContain("memberName");
  });

  it("skips required token checks when the body override is empty", () => {
    // An empty body override falls back to the default body, which already
    // carries the required tokens.
    const validation = validateEmailTemplateContent({
      templateName: "booking-confirmed",
      subject: "Your booking is confirmed",
      bodyText: "",
    });

    expect(validation.valid).toBe(true);
    expect(validation.missingRequiredTokens).toEqual([]);
  });

  it("rejects the door code token in subject lines", () => {
    const validation = validateEmailTemplateContent({
      templateName: "booking-confirmed",
      subject: "Door code {{doorCode}}",
      bodyText:
        "{{promoSummary}}Total Paid: {{totalPaid}}\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\nDoor code: {{doorCode}}",
    });

    expect(validation.valid).toBe(false);
    expect(validation.sensitiveSubjectTokens).toEqual(["doorCode"]);
    expect(validation.issues.map((issue) => issue.code)).toContain(
      "sensitive_subject_token",
    );
  });

  it("rejects credential tokens in subject lines", () => {
    const validation = validateEmailTemplateContent({
      templateName: "password-reset",
      subject: "Your reset code is {{token}}",
      bodyText: "Reset here {{BASE_URL}}/reset-password?token={{token}}",
    });

    expect(validation.valid).toBe(false);
    expect(validation.sensitiveSubjectTokens).toEqual(["token"]);
  });

  it("classifies every bearer-link data alias as subject-sensitive", () => {
    expect(
      [
        "choreLink",
        "claimUrl",
        "confirmUrl",
        "confirmationUrl",
        "payUrl",
        "resetUrl",
        "respondUrl",
        "verifyUrl",
      ].filter((token) => !SENSITIVE_EMAIL_SUBJECT_TOKEN_SET.has(token)),
    ).toEqual([]);
    expect(
      getSensitiveEmailSubjectTokens("nomination-request").has("reviewUrl"),
    ).toBe(true);
    expect(
      getSensitiveEmailSubjectTokens("admin-booking-request-pending").has(
        "reviewUrl",
      ),
    ).toBe(false);
  });

  it("strips sensitive placeholders and live values from rendered subjects", () => {
    expect(
      neutraliseSensitiveSubjectContent("Door code {{doorCode}} is 97531", {
        doorCode: "97531",
      }),
    ).toBe("Door code is");
    expect(
      neutraliseSensitiveSubjectContent("Booking Confirmed - Example Lodge", {
        doorCode: "97531",
      }),
    ).toBe("Booking Confirmed - Example Lodge");
  });

  it("rejects subject line breaks, raw HTML, and unsafe links", () => {
    const validation = validateEmailTemplateContent({
      templateName: "password-reset",
      subject: "Reset\nPassword",
      bodyText:
        "<strong>Reset</strong> javascript:alert(1) {{BASE_URL}}/reset-password?token={{token}}",
    });

    expect(validation.valid).toBe(false);
    expect(validation.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["subject_line_break", "raw_html", "unsafe_link"]),
    );
  });

  it("renders known tokens and drops missing values", () => {
    expect(
      renderTemplateString("Hi {{firstName}} {{missing}}", {
        firstName: "Ada",
      }),
    ).toBe("Hi Ada ");
  });
});

// #1797: the 11 previously-hardcoded senders are now wording-editable via
// EMAIL_AUDIT_DEFAULTS, but their delivery must stay locked (always send).
// two-factor-code is deliberately excluded and stays hardcoded.
const NEWLY_REGISTERED_HARDCODED_KEYS = [
  "booking-review-approved",
  "booking-review-rejected",
  "induction-sign-off-request",
  "school-attendee-confirmation",
  "admin-school-manual-invoice",
  "group-booking-join-verification",
  "group-settlement-receipt",
  "group-join-settled",
  "group-settlement-expired",
  "group-join-released",
  "group-join-cancelled",
] as const;

// The subset that carries an essential action link (required body token).
const ACTION_LINK_KEYS = [
  "booking-review-approved",
  "induction-sign-off-request",
  "school-attendee-confirmation",
  "group-booking-join-verification",
] as const;

describe("newly-registered hardcoded email templates (#1797)", () => {
  it.each(NEWLY_REGISTERED_HARDCODED_KEYS)(
    "registers %s as wording-editable but delivery-locked (always send)",
    (key) => {
      const definition = getEmailTemplateDefinition(key);
      if (!definition) throw new Error(`missing definition for ${key}`);

      // Hard safety invariant: these are member-facing (some carry action
      // links), so wording is editable but delivery must never become
      // admin-disable-able — deliveryEditable stays false and the default
      // delivery mode stays "always", matching today's unconditional send.
      expect(definition.deliveryEditable).toBe(false);
      expect(getDefaultDeliveryMode(key)).toBe("always");
    },
  );

  it.each(NEWLY_REGISTERED_HARDCODED_KEYS)(
    "keeps every required token of %s present in its default body",
    (key) => {
      const definition = getEmailTemplateDefinition(key);
      if (!definition) throw new Error(`missing definition for ${key}`);

      for (const token of definition.requiredTokens) {
        expect(definition.defaultBody).toContain(`{{${token}}}`);
      }
    },
  );

  it("does not confuse two-factor-code as editable (stays hardcoded)", () => {
    expect(getEmailTemplateDefinition("two-factor-code")).toBeUndefined();
  });

  it("registers the #2263 whole-lodge manual-invoice alert as admin-facing and delivery-locked", () => {
    // Its own registry entry rather than a variant of the school one: the copy
    // names a MEMBER (the owner is a real signed-in account, not a non-login
    // school contact) and carries the internet-banking reference the member was
    // given. Locked for the same reason the school one is — disabling it lets an
    // approved whole-lodge booking go un-invoiced while the member has already
    // been told an invoice is coming, which is a direct money loss.
    const definition = getEmailTemplateDefinition(
      "admin-whole-lodge-manual-invoice",
    );
    if (!definition) throw new Error("missing admin-whole-lodge-manual-invoice");
    expect(definition.audience).toBe("admin");
    expect(definition.deliveryEditable).toBe(false);
    expect(getDefaultDeliveryMode("admin-whole-lodge-manual-invoice")).toBe(
      "always",
    );
    // The reference and the amount are what make the alert actionable, so both
    // must be tokens an override cannot silently drop by accident.
    expect(definition.allowedTokens).toContain("paymentReference");
    expect(definition.allowedTokens).toContain("amount");
    expect(definition.allowedTokens).toContain("memberName");
    // And it must not describe the booking as a school group's.
    expect(definition.defaultBody).not.toContain("School");
  });

  it("keeps BOTH late-capture alerts admin-audience and delivery-locked (#2761, #2773, #2774)", () => {
    /*
      The registry is the second of the two mute vectors. The senders read no
      per-member notification preference (pinned at the senders), and these entries
      are what stop an admin disabling them club-wide in Delivery Rules. Both report
      automatic movements of real money: one says a refund went out on its own, the
      other says one was withheld — or went out twice. Neither may be silenceable.

      MUTATION PROOF: remove either name from LOCKED_DELIVERY_TEMPLATE_NAMES and this
      fails, where every sender-level test would still pass.
    */
    for (const name of [
      "admin-late-capture-auto-refund",
      "admin-late-capture-hand-back-conflict",
    ] as const) {
      const definition = getEmailTemplateDefinition(name);
      if (!definition) throw new Error(`missing ${name}`);
      expect(definition.audience).toBe("admin");
      expect(definition.deliveryEditable).toBe(false);
      expect(getDefaultDeliveryMode(name)).toBe("always");
    }

    // Two ENTRIES, not one with a flag. The auto-refund body asserts the money went
    // back and there is nothing to pay back, which is false in both of the
    // conflict alert's directions — and one editable body cannot be correct about a
    // refund that happened AND one that did not.
    const autoRefund = getEmailTemplateDefinition("admin-late-capture-auto-refund");
    const conflict = getEmailTemplateDefinition(
      "admin-late-capture-hand-back-conflict",
    );
    expect(autoRefund?.defaultBody).toContain("nothing to pay back");
    expect(conflict?.defaultBody).not.toContain("nothing to pay back");
    // #2773: the auto-refund body must not hard-code the booking-change wording —
    // both handlers send it now, and the primary path has no supplementary invoice.
    expect(autoRefund?.defaultBody).not.toContain("booking-change payment");
    expect(autoRefund?.defaultBody).not.toContain("supplementary Xero invoice");
    expect(autoRefund?.requiredTokens).toContain("lateCaptureLeadNote");
    // #2774: the direction sentence is the whole message on the conflict alert.
    expect(conflict?.requiredTokens).toContain("handBackConflictNote");
  });

  it("classifies admin-school-manual-invoice as an admin alert but keeps it delivery-locked", () => {
    // It ships via sendToAdmins, so it must classify as an admin alert like its
    // siblings (audience "admin") rather than "member". It stays in
    // LOCKED_DELIVERY_TEMPLATE_NAMES so admins still cannot disable it —
    // disabling would let an approved school booking go un-invoiced (#1797).
    const definition = getEmailTemplateDefinition("admin-school-manual-invoice");
    if (!definition) throw new Error("missing admin-school-manual-invoice");
    expect(definition.audience).toBe("admin");
    expect(definition.deliveryEditable).toBe(false);
    expect(getDefaultDeliveryMode("admin-school-manual-invoice")).toBe("always");
  });
});

describe("#1967/#1994 split-settlement email templates", () => {
  it("registers the admin split-settlement alert with delivery-mode policy control", () => {
    const definition = getEmailTemplateDefinition("admin-split-settlement-unpaid");
    if (!definition) throw new Error("missing admin-split-settlement-unpaid");

    // Ships via sendToAdmins, so it must classify as an admin alert. Unlike the
    // money-critical admin-school-manual-invoice it is NOT delivery-locked: it
    // is an operational nudge (the member already has their payment link), so
    // admins keep full delivery-mode control. That editable classification is
    // exactly what makes isAdminSystemTemplate true, so shouldSendAdminSystemEmail
    // resolves its policy from the registry instead of always-sending blindly.
    expect(definition.audience).toBe("admin");
    expect(isAdminSystemTemplate("admin-split-settlement-unpaid")).toBe(true);
    expect(definition.deliveryEditable).toBe(true);
    expect(getDefaultDeliveryMode("admin-split-settlement-unpaid")).toBe("always");
  });

  it("registers the member split-guest payment link as a token-bearing member template", () => {
    const definition = getEmailTemplateDefinition("split-guest-payment-link");
    if (!definition) throw new Error("missing split-guest-payment-link");

    // Member-facing token-bearing link: audience "member", not an admin system
    // template, and the /pay/<token> bearer link is a required body token so an
    // override can never drop it (and it stays in the sensitive-log set).
    expect(definition.audience).toBe("member");
    expect(isAdminSystemTemplate("split-guest-payment-link")).toBe(false);
    expect(definition.requiredTokens).toContain("token");
    expect(definition.deliveryEditable).toBe(false);
    expect(getDefaultDeliveryMode("split-guest-payment-link")).toBe("always");
  });
});

describe("#1993 Part A terminal split-cancellation email templates", () => {
  it("registers the admin terminal cancelled notice as a delivery-editable admin alert (C1)", () => {
    const definition = getEmailTemplateDefinition(
      "admin-split-settlement-cancelled",
    );
    if (!definition) throw new Error("missing admin-split-settlement-cancelled");

    // Its OWN registry entry (not a variant of the recurring alert): admin
    // audience, admin-system, NOT delivery-locked (an operational nudge). Its
    // registered required tokens are the member name + admin action link.
    expect(definition.audience).toBe("admin");
    expect(isAdminSystemTemplate("admin-split-settlement-cancelled")).toBe(true);
    expect(definition.deliveryEditable).toBe(true);
    expect(getDefaultDeliveryMode("admin-split-settlement-cancelled")).toBe(
      "always",
    );
    expect(definition.requiredTokens).toEqual(
      expect.arrayContaining(["memberName", "reviewUrl"]),
    );
    for (const token of definition.requiredTokens) {
      expect(definition.defaultBody).toContain(`{{${token}}}`);
    }
  });

  it("registers the member guest-portion-cancelled notice as a non-token member template (C2)", () => {
    const definition = getEmailTemplateDefinition(
      "split-guest-portion-cancelled",
    );
    if (!definition) throw new Error("missing split-guest-portion-cancelled");

    // Member-facing, no bearer token: audience "member", not an admin system
    // template, delivery not admin-editable, and its required tokens (firstName
    // + stay dates) all appear in the default body.
    expect(definition.audience).toBe("member");
    expect(isAdminSystemTemplate("split-guest-portion-cancelled")).toBe(false);
    expect(definition.deliveryEditable).toBe(false);
    expect(getDefaultDeliveryMode("split-guest-portion-cancelled")).toBe(
      "always",
    );
    expect(definition.requiredTokens).not.toContain("token");
    for (const token of definition.requiredTokens) {
      expect(definition.defaultBody).toContain(`{{${token}}}`);
    }
  });

  /*
    #2350. This email exists to ask a member for money, so an override that
    silently drops the amount, the date it was raised or the stay it belongs to
    leaves a demand the member cannot act on or check — the same reason every
    other member money email pins its load-bearing tokens.
  */
  it("pins the load-bearing tokens of the additional-payment reminder", () => {
    const definition = getEmailTemplateDefinition("additional-payment-reminder");
    if (!definition) throw new Error("missing additional-payment-reminder");

    expect(definition.audience).toBe("member");
    expect(definition.requiredTokens).toEqual(
      expect.arrayContaining([
        "additionalAmount",
        "requestedOn",
        "checkIn",
        "checkOut",
      ]),
    );
    for (const token of definition.requiredTokens) {
      expect(definition.defaultBody).toContain(`{{${token}}}`);
    }
    // And the preview reads as a member reads it: a date where a date belongs,
    // not the literal token name.
    expect(definition.sampleData.requestedOn).toBe("1 Jul 2026");
  });

  /*
    #2350: {{outstandingAdditionalNote}} is the ONLY place a pre-arrival reminder
    says money is still owed, so dropping it in an override would silence that
    for every booking. It is pre-composed like {{doorCodeNote}}, so its preview
    must be the whole sentence rather than the token's own name mid-paragraph.
  */
  it("pins and previews the pre-arrival outstanding-payment note", () => {
    const definition = getEmailTemplateDefinition("pre-arrival-reminder");
    if (!definition) throw new Error("missing pre-arrival-reminder");

    expect(definition.requiredTokens).toContain("outstandingAdditionalNote");
    expect(definition.defaultBody).toContain("{{outstandingAdditionalNote}}");
    expect(String(definition.sampleData.outstandingAdditionalNote)).toContain(
      "still $123.45 to pay",
    );
  });
});

describe("render path for newly-registered action-link templates (#1797)", () => {
  it.each(ACTION_LINK_KEYS)(
    "renders %s default body from sample data with no unresolved placeholders",
    (key) => {
      const definition = getEmailTemplateDefinition(key);
      if (!definition) throw new Error(`missing definition for ${key}`);

      // This is the override render path an admin edit takes:
      // prepareEmailMessage feeds a stored bodyText through renderTemplateString
      // with the send's templateData. Proving the default body renders cleanly
      // from sampleData proves the required action token substitutes correctly.
      const rendered = renderTemplateString(
        definition.defaultBody,
        definition.sampleData,
      );

      for (const token of definition.requiredTokens) {
        const sample = definition.sampleData[token];
        expect(sample).toBeTruthy();
        expect(rendered).toContain(String(sample));
        expect(rendered).not.toContain(`{{${token}}}`);
      }

      // Every token in the default body has a sample value, so nothing is left
      // as an unrendered {{placeholder}} (bracket annotations are plain text).
      expect(rendered).not.toMatch(/\{\{[^{}]+\}\}/);
    },
  );
});

// #2320 review (MED-1): the sweep cleaned the SHIPPED defaults, but a club's
// saved override authored from the old editor text still carries the
// "[only when …]" junk. The save-time validator now runs guard 1's detector,
// BLOCKING the save (the same severity as an unknown token — every other
// contract violation blocks, and a warn would let the same literal text keep
// reaching members).
describe("#2320 review — bracket annotations are refused at save time", () => {
  it("blocks a body that still carries an [only when ...] authoring note", () => {
    const validation = validateEmailTemplateContent({
      templateName: "pre-arrival-reminder",
      subject: "Pre-arrival Information",
      bodyText:
        "Hi {{firstName}}.\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\nDoor code: {{doorCode}} [only when a door code is set]",
    });

    expect(validation.valid).toBe(false);
    expect(validation.bracketAnnotations).toEqual([
      "[only when a door code is set]",
    ]);
    const issue = validation.issues.find(
      (candidate) => candidate.code === "bracket_annotation",
    );
    expect(issue?.field).toBe("bodyText");
    expect(issue?.message).toContain("word for word");
  });

  it("blocks a subject annotation and reports the field", () => {
    const validation = validateEmailTemplateContent({
      templateName: "pre-arrival-reminder",
      subject: "Pre-arrival Information [only when confirmed]",
      bodyText:
        "Hi {{firstName}}.\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{doorCodeNote}}",
    });

    expect(validation.valid).toBe(false);
    expect(validation.bracketAnnotations).toEqual(["[only when confirmed]"]);
    expect(
      validation.issues.find(
        (candidate) => candidate.code === "bracket_annotation",
      )?.field,
    ).toBe("subject");
  });

  it("keeps a clean override valid with an empty annotations list", () => {
    // Carries {{outstandingAdditionalNote}} because #2350 pins it on this
    // template: this case is about annotations, so the body must satisfy the
    // required-token rule outright rather than fail it for another reason.
    const validation = validateEmailTemplateContent({
      templateName: "pre-arrival-reminder",
      subject: "Pre-arrival Information",
      bodyText:
        "Hi {{firstName}}.\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{outstandingAdditionalNote}}\n\n{{doorCodeNote}}",
    });

    expect(validation.valid).toBe(true);
    expect(validation.bracketAnnotations).toEqual([]);
  });
});

// #2320 review (LOW-7): the composed chore-roster line CARRIES the 48-hour
// bearer link, so it must be subject-forbidden exactly like the bare
// {{choreLink}} value ({{doorCodeNote}} precedent).
describe("#2320 review — {{choreLinkNote}} is subject-sensitive", () => {
  it("classifies the composed line like the bare link it carries", () => {
    expect(SENSITIVE_EMAIL_SUBJECT_TOKEN_SET.has("choreLinkNote")).toBe(true);
  });

  it("rejects it in a chore-roster subject line", () => {
    const definition = getEmailTemplateDefinition("chore-roster");
    if (!definition) throw new Error("missing chore-roster");

    const validation = validateEmailTemplateContent({
      templateName: "chore-roster",
      subject: "Chores {{choreLinkNote}}",
      bodyText: definition.defaultBody,
    });

    expect(validation.valid).toBe(false);
    expect(validation.sensitiveSubjectTokens).toEqual(["choreLinkNote"]);
  });
});

// #2320 review (LOW-4): the editor preview is the admin's only picture of what
// a recipient reads, so a per-template sample must match what that template's
// SENDER actually composes — not the global fallthrough for the token name.
describe("#2320 review — per-template preview samples match the real sends", () => {
  it("previews the CANCELLED lead paragraph on the terminal split alert", () => {
    const cancelled = getEmailTemplateDefinition(
      "admin-split-settlement-cancelled",
    );
    if (!cancelled) throw new Error("missing admin-split-settlement-cancelled");
    // The cancelled story, not the recurring unpaid alert's ("hold extended")
    // paragraph that used to sit self-contradictingly under this heading.
    expect(cancelled.sampleData.settlementActionNote).toContain(
      "has now been automatically cancelled",
    );
    expect(cancelled.sampleData.settlementActionNote).not.toContain(
      "hold has been extended",
    );

    // The recurring alert keeps the unpaid paragraph.
    const unpaid = getEmailTemplateDefinition("admin-split-settlement-unpaid");
    if (!unpaid) throw new Error("missing admin-split-settlement-unpaid");
    expect(unpaid.sampleData.settlementActionNote).toContain(
      "hold has been extended",
    );
  });

  it("registers the #2553 hold-lapse notice as a withholdable member template", () => {
    // The reaper closes a member's request and takes back the beds they had
    // reserved, so the notice is member-audience and the per-booking "No emails"
    // switch must be able to withhold it. An admin-audience classification would
    // let a silenced booking mail out; the retry cron leans on the same
    // membership to refuse replaying a NULL-bookingId row.
    const definition = getEmailTemplateDefinition(
      "policy-exception-request-expired",
    );
    if (!definition) throw new Error("missing policy-exception-request-expired");

    expect(definition.audience).toBe("member");
    expect(isAdminSystemTemplate("policy-exception-request-expired")).toBe(false);
    expect(isBookingSuppressibleTemplate("policy-exception-request-expired")).toBe(
      true,
    );
    expect(
      ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES.has(
        "policy-exception-request-expired",
      ),
    ).toBe(true);
    // Not delivery-editable (that control is for admin alerts), and always sent:
    // a member whose request was closed for them has no other signal.
    expect(definition.deliveryEditable).toBe(false);
    expect(getDefaultDeliveryMode("policy-exception-request-expired")).toBe(
      "always",
    );
  });

  it("keeps the lapse notice's load-bearing facts required and renderable", () => {
    const definition = getEmailTemplateDefinition(
      "policy-exception-request-expired",
    );
    if (!definition) throw new Error("missing policy-exception-request-expired");

    // The stay says WHICH request lapsed and the deadline says why it closed.
    expect(definition.requiredTokens).toEqual([
      "checkIn",
      "checkOut",
      "expiresAt",
    ]);
    // The two facts the notice exists to state, in the shipped default itself.
    const rendered = renderTemplateString(
      definition.defaultBody,
      definition.sampleData,
    );
    expect(rendered).toContain("has lapsed");
    expect(rendered).toContain("beds it was holding have been released");
    expect(rendered).toContain("Your booking itself has not changed");
    // No token survives unrendered and no line is left dangling on a label.
    expect(rendered).not.toContain("{{");
    for (const line of rendered.split("\n")) {
      expect(line.trimEnd()).not.toMatch(/[-:–—]$/);
    }
    expect(
      validateEmailTemplateContent({
        templateName: "policy-exception-request-expired",
        subject: definition.defaultSubject,
        bodyText: definition.defaultBody,
      }).valid,
    ).toBe(true);
  });

  it("registers the #2649 restored-place notice as a withholdable member template", () => {
    // The stranded-confirm repair puts a member back on the waitlist after our
    // own code failed to finish their FREE confirmation, so the notice is
    // member-audience and the per-booking "No emails" switch must be able to
    // withhold it — same classification as its three waitlist siblings, and for
    // the same reasons (the retry cron leans on the set membership to refuse
    // replaying a NULL-bookingId row under this name).
    const definition = getEmailTemplateDefinition("waitlist-place-restored");
    if (!definition) throw new Error("missing waitlist-place-restored");

    expect(definition.audience).toBe("member");
    expect(isAdminSystemTemplate("waitlist-place-restored")).toBe(false);
    expect(isBookingSuppressibleTemplate("waitlist-place-restored")).toBe(true);
    expect(
      ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES.has("waitlist-place-restored"),
    ).toBe(true);
    // Not delivery-editable (that control is for admin alerts), and always sent:
    // a member whose confirmation the club broke has no other signal that their
    // place was put back.
    expect(definition.deliveryEditable).toBe(false);
    expect(getDefaultDeliveryMode("waitlist-place-restored")).toBe("always");

    // A true sibling of the expiry notice: same four supplied tokens, so an
    // admin editing either has the same facts available.
    const expiry = getEmailTemplateDefinition("waitlist-offer-expired");
    if (!expiry) throw new Error("missing waitlist-offer-expired");
    expect(definition.allowedTokens).toEqual(expiry.allowedTokens);
  });

  it("keeps the restored-place notice's reassurance in the shipped default, and the expiry wording out of it", () => {
    const definition = getEmailTemplateDefinition("waitlist-place-restored");
    if (!definition) throw new Error("missing waitlist-place-restored");

    const rendered = renderTemplateString(
      definition.defaultBody,
      definition.sampleData,
    );

    // The three things the member has to be told, in the shipped default itself.
    expect(rendered).toContain("put you back on the waitlist");
    expect(rendered).toContain("This was not something you did wrong");
    expect(rendered).toContain("your offer did not run out");
    expect(rendered).toContain("You do not need to do anything");
    expect(rendered).toContain("New Position: #");

    // And never the expiry template's story — that is the defect this template
    // exists to fix, in the subject as well as the body.
    expect(definition.defaultSubject.toLowerCase()).not.toContain("expir");
    expect(rendered.toLowerCase()).not.toContain("expir");

    // No token survives unrendered and no line is left dangling on a label.
    expect(rendered).not.toContain("{{");
    for (const line of rendered.split("\n")) {
      expect(line.trimEnd()).not.toMatch(/[-:–—]$/);
    }
    expect(
      validateEmailTemplateContent({
        templateName: "waitlist-place-restored",
        subject: definition.defaultSubject,
        bodyText: definition.defaultBody,
      }).valid,
    ).toBe(true);
  });

  it("previews the labels the booking-review senders really compose", () => {
    // src/lib/email/booking.ts composes "Note from admin:" on approval and
    // "Reason from admin:" on rejection; the refund-appeal templates keep the
    // global "Notes:" sample because their sender really writes "Notes:".
    expect(
      getEmailTemplateDefinition("booking-review-approved")?.sampleData
        .adminNotesLine,
    ).toMatch(/^Note from admin: /);
    expect(
      getEmailTemplateDefinition("booking-review-rejected")?.sampleData
        .adminNotesLine,
    ).toMatch(/^Reason from admin: /);
    expect(
      getEmailTemplateDefinition("refund-request-approved")?.sampleData
        .adminNotesLine,
    ).toMatch(/^Notes: /);
  });
});
