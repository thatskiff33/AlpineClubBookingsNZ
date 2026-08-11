import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2774 D2 pinned AT THE SENDER, for the reason its #2761 sibling has its own
 * file: the webhook test mocks this sender away, so without this nothing anywhere
 * imports the real one and its subject, template name, audience and tokens would
 * all be unasserted.
 *
 * WHAT THIS ALERT IS FOR. Either the automatic late-capture refund was WITHHELD
 * because an operator had already handed the same capture back by hand — the fence,
 * which stops the club paying a member twice — or it went out anyway because that
 * hand-completion committed inside the webhook's own Stripe round trip, in which
 * case the member probably HAS been paid twice. Both directions need a person; the
 * direction decides which way they reconcile.
 *
 * MUTATION PROOF. Route this sender through `sendToAdmins` and "never goes through
 * the muteable preference path" fails. Collapse the two subjects into one and the
 * two subject tests fail. Reuse `admin-late-capture-auto-refund` as the template
 * name and "sends its OWN registry template" fails — and that is the assertion
 * that matters most here, because that template's body says the money went back
 * and there is nothing to pay back, which is false in both of this alert's
 * directions. Drop the `{{handBackConflictNote}}` supply line and "supplies the
 * one sentence that says which way the money went" fails.
 */

const mocks = vi.hoisted(() => ({
  sendToAdmins: vi.fn(),
  sendUnmuteableAdminAlert: vi.fn(),
}));

vi.mock("@/lib/email/admin-alerts-shared", () => ({
  sendToAdmins: mocks.sendToAdmins,
  sendUnmuteableAdminAlert: mocks.sendUnmuteableAdminAlert,
}));

import { sendAdminLateCaptureHandBackConflictAlert } from "@/lib/email/admin-alerts-finance";
import { EMAIL_AUDIT_DEFAULTS } from "@/lib/email-message-audit-defaults";
import {
  getEmailTemplateDefinition,
  getSensitiveEmailSubjectTokens,
} from "@/lib/email-message-registry";
import { lateCaptureHandBackConflictSubjectLabel } from "@/lib/email-message-notes";
import {
  neutraliseSensitiveSubjectContent,
  renderTemplateString,
  validateEmailTemplateContent,
  type EmailTemplateData,
} from "@/lib/email-message-renderer";

type CapturedAlert = {
  subject: string;
  html: string;
  templateName: string;
  templateData: Record<string, unknown>;
  requirement: { area: string; level: string };
};

function captured(): CapturedAlert {
  expect(mocks.sendUnmuteableAdminAlert).toHaveBeenCalledTimes(1);
  const [args] = mocks.sendUnmuteableAdminAlert.mock.calls[0] as [CapturedAlert];
  return args;
}

async function send(options: {
  refundSent: boolean;
  captureKind?: "modification" | "primary";
  handBackAmountCents?: number | null;
}) {
  await sendAdminLateCaptureHandBackConflictAlert({
    memberName: "Alice Example",
    checkIn: new Date("2026-08-01"),
    checkOut: new Date("2026-08-03"),
    amountCents: 2500,
    paymentIntentId: "pi_additional_late",
    bookingId: "booking-9",
    bookingDeleted: true,
    captureKind: options.captureKind ?? "modification",
    handBackAmountCents:
      options.handBackAmountCents === undefined
        ? 2500
        : options.handBackAmountCents,
    refundSent: options.refundSent,
  });
  return captured();
}

/**
 * The subject an admin's SAVED override produces. `prepareEmailMessage` renders a
 * stored subject as `renderTemplateString(override.subject, subjectSafeData)`, and
 * the Email Messages editor pre-populates the form with the shipped default — so
 * the shipped `defaultSubject` rendered with the sender's own templateData is
 * precisely what an admin who saves the form gets, now and forever after.
 */
function renderStoredDefaultSubject(templateData: Record<string, unknown>): string {
  return renderTemplateString(
    EMAIL_AUDIT_DEFAULTS["admin-late-capture-hand-back-conflict"].defaultSubject,
    templateData as EmailTemplateData,
  );
}

describe("sendAdminLateCaptureHandBackConflictAlert (#2774)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendToAdmins.mockResolvedValue(undefined);
    mocks.sendUnmuteableAdminAlert.mockResolvedValue(undefined);
  });

  it("never goes through the muteable preference path", async () => {
    // If anything, the case for locking this one is stronger than for its
    // sibling: it is the only mail on the path that says money may have left the
    // club twice.
    await send({ refundSent: false });
    expect(mocks.sendToAdmins).not.toHaveBeenCalled();
  });

  it("says the refund was withheld, and never claims one was made", async () => {
    const alert = await send({ refundSent: false });
    expect(alert.subject).toContain("Automatic refund withheld");
    expect(alert.subject).toContain("already paid back by hand");
    expect(alert.subject).toContain("Alice Example");
    expect(alert.subject).not.toContain("refunded automatically");
    expect(alert.subject).not.toContain("Payment Failed");
    // The body must not read as a completed refund either.
    expect(alert.html).toContain("was NOT sent");
    expect(alert.html).not.toContain("there is nothing to pay back");
  });

  it("says the money may have gone TWICE on the other direction", async () => {
    const alert = await send({ refundSent: true });
    expect(alert.subject).toContain("refunded TWICE");
    expect(alert.subject).toContain("reconcile");
    expect(alert.subject).not.toContain("withheld");
    expect(alert.html).toContain("may have gone back TWICE");
  });

  it("sends its OWN registry template, not the auto-refund one", async () => {
    /*
      The load-bearing assertion. `admin-late-capture-auto-refund`'s heading is
      "Payment Refunded Automatically" and its body says the money has gone back
      and there is nothing to pay back — false on the withheld arm, and the
      opposite of the truth on the double-payment arm. Sharing the key would also
      mean ONE admin-editable body having to be correct about a refund that
      happened and one that did not.
    */
    const alert = await send({ refundSent: false });
    expect(alert.templateName).toBe("admin-late-capture-hand-back-conflict");
  });

  it("addresses the alert to the people who reconcile the club's money", async () => {
    const alert = await send({ refundSent: true });
    expect(alert.requirement).toEqual({ area: "finance", level: "edit" });
  });

  it("supplies the one sentence that says which way the money went", async () => {
    const withheld = await send({ refundSent: false });
    expect(String(withheld.templateData.handBackConflictNote)).toContain(
      "has NOT been sent back a second time",
    );

    mocks.sendUnmuteableAdminAlert.mockClear();
    const sent = await send({ refundSent: true });
    expect(String(sent.templateData.handBackConflictNote)).toContain(
      "may have gone back TWICE",
    );
    // Two genuinely different sentences, so a saved default cannot tell an
    // operator the opposite of what happened.
    expect(String(sent.templateData.handBackConflictNote)).not.toBe(
      String(withheld.templateData.handBackConflictNote),
    );
  });

  it("names which payment was captured, on both capture kinds (#2773)", async () => {
    const modification = await send({
      refundSent: false,
      captureKind: "modification",
    });
    expect(modification.html).toContain("booking-change payment");

    mocks.sendUnmuteableAdminAlert.mockClear();
    const primary = await send({ refundSent: false, captureKind: "primary" });
    expect(primary.html).toContain("The booking's own payment");
    expect(primary.html).not.toContain("booking-change payment");
  });

  it("prints the hand-back amount when it is known, and omits the row when it is not", async () => {
    // So a person can see whether the hand-back covered the whole capture.
    // Nothing here refunds a difference: that is a new money decision.
    const known = await send({ refundSent: false, handBackAmountCents: 1500 });
    expect(known.html).toContain("Recorded as paid back by hand");
    expect(known.html).toContain("$15.00");

    mocks.sendUnmuteableAdminAlert.mockClear();
    const unknown = await send({
      refundSent: true,
      handBackAmountCents: null,
    });
    expect(unknown.html).not.toContain("Recorded as paid back by hand");
    // The identifiers that let somebody find the row are still there.
    expect(unknown.templateData.bookingId).toBe("booking-9");
    expect(unknown.templateData.paymentIntentId).toBe("pi_additional_late");
  });

  it("states in the body whether the automatic refund went out", async () => {
    // A reader must not have to infer it from the heading alone.
    const withheld = await send({ refundSent: false });
    expect(withheld.html).toContain("Automatic refund sent");
    expect(withheld.html).toContain(">No<");

    mocks.sendUnmuteableAdminAlert.mockClear();
    const sent = await send({ refundSent: true });
    expect(sent.html).toContain("Yes — on top of the hand-back");
  });

  /**
   * THE SUBJECT SURVIVES AN ADMIN SAVING THE TEMPLATE (review finding).
   *
   * The defect this pins is not hypothetical and it is not in the sender. It is in
   * what happens AFTER: `prepareEmailMessage` replaces the sender's computed subject
   * with any stored `EmailTemplateOverride.subject`, unconditionally. The Email
   * Messages editor pre-populates its form with the shipped default, so an admin who
   * saves it untouched — or tweaks one word — stores that string. If `defaultSubject`
   * carried one direction as literal text, from that moment every suspected DOUBLE
   * payment would arrive titled "Automatic refund withheld — already paid back by
   * hand": the subject asserting no money left the club, on the one mail this path
   * adds to say it may have left twice. An operator who triages by subject files it
   * as nothing to do.
   *
   * The render below is exactly the path `prepareEmailMessage` runs for a stored
   * subject — `renderTemplateString(override.subject, subjectSafeData)` — over the
   * shipped default, which is the string an admin's save actually stores.
   *
   * MUTATION PROOF, and it is the point of the test: put either direction's wording
   * back into `defaultSubject` as literal text and this fails, because both
   * directions then render identically. Drop the `handBackConflictLabel` supply line
   * from the sender and it fails with an empty subject.
   */
  it("keeps the direction in the subject even when an admin has saved the template", async () => {
    const withheldSubject = renderStoredDefaultSubject(
      (await send({ refundSent: false })).templateData,
    );
    mocks.sendUnmuteableAdminAlert.mockClear();
    const sentSubject = renderStoredDefaultSubject(
      (await send({ refundSent: true })).templateData,
    );

    expect(withheldSubject).toContain("Automatic refund withheld");
    expect(withheldSubject).not.toContain("TWICE");
    expect(sentSubject).toContain("refunded TWICE");
    expect(sentSubject).not.toContain("withheld");
    // The load-bearing one: an override cannot collapse the two into one claim.
    expect(sentSubject).not.toBe(withheldSubject);
    // And the member is still named, so the mail is still triageable.
    expect(withheldSubject).toContain("Alice Example");
    expect(sentSubject).toContain("Alice Example");
  });

  it("keeps the direction token out of the sensitive-subject set, or it would be stripped", async () => {
    /*
      The token only works in a subject because it is not sensitive: the renderer
      deletes sensitive tokens from subjects outright (door codes, credential
      links). If somebody ever adds this one to that set the subject would silently
      lose its direction and read as a bare member name — which is why the exclusion
      is asserted rather than assumed.
    */
    expect([
      ...getSensitiveEmailSubjectTokens("admin-late-capture-hand-back-conflict"),
    ]).not.toContain("handBackConflictLabel");
    const alert = await send({ refundSent: true });
    expect(
      neutraliseSensitiveSubjectContent(
        renderStoredDefaultSubject(alert.templateData),
        alert.templateData as EmailTemplateData,
        "admin-late-capture-hand-back-conflict",
      ),
    ).toContain("refunded TWICE");
  });

  /**
   * AND AN ADMIN CANNOT TYPE THE DIRECTION BACK OUT (#2774).
   *
   * The shipped default carrying the token covers the admin who presses Save on the
   * pre-populated form, which is the common case and the one the test above pins. It
   * does NOT cover the admin who rewrites the subject in their own words — and on a
   * template sent in two opposite directions about money, "we wrote a good default"
   * is not a guarantee. `REQUIRED_TEMPLATE_TOKENS` could not express this: it is
   * body-only by design and says so in the renderer, so #2774 added
   * `REQUIRED_SUBJECT_TEMPLATE_TOKENS` — this is the first and only entry.
   *
   * MUTATION PROOF: remove the template's entry from
   * `REQUIRED_SUBJECT_TEMPLATE_TOKENS`, or make the renderer's subject check accept
   * a body-supplied token, and the first assertion fails with `valid: true` — a save
   * that pins every future send to one direction going through unchallenged.
   */
  it("refuses a saved subject that drops the direction token", () => {
    const conflictBody =
      EMAIL_AUDIT_DEFAULTS["admin-late-capture-hand-back-conflict"].defaultBody;

    const handTyped = validateEmailTemplateContent({
      templateName: "admin-late-capture-hand-back-conflict",
      // Exactly the failure: an admin rewrites the subject in one direction's words.
      subject: "Automatic refund withheld - already paid back by hand: {{memberName}}",
      bodyText: conflictBody,
    });
    expect(handTyped.valid).toBe(false);
    expect(handTyped.missingRequiredSubjectTokens).toEqual([
      "handBackConflictLabel",
    ]);
    const issue = handTyped.issues.find(
      (candidate) => candidate.code === "missing_required_subject_token",
    );
    expect(issue?.field).toBe("subject");
    // The message has to say what the subject must be able to say, not just name a
    // token: an admin told "add {{handBackConflictLabel}}" learns nothing about why.
    expect(issue?.message).toContain("two opposite directions");

    // The body's own requirement is NOT what satisfied it, and cannot be: the two
    // fields are protected separately because either is read as the whole message.
    expect(
      validateEmailTemplateContent({
        templateName: "admin-late-capture-hand-back-conflict",
        subject: "Reconcile a late capture: {{memberName}}",
        bodyText: `{{handBackConflictLabel}}\n\n${conflictBody}`,
      }).missingRequiredSubjectTokens,
    ).toEqual(["handBackConflictLabel"]);

    // The shipped default passes, so the club that never customises is never nagged
    // and the requirement can never be unsatisfiable.
    const shipped = validateEmailTemplateContent({
      templateName: "admin-late-capture-hand-back-conflict",
      subject:
        EMAIL_AUDIT_DEFAULTS["admin-late-capture-hand-back-conflict"]
          .defaultSubject,
      bodyText: conflictBody,
    });
    expect(shipped.missingRequiredSubjectTokens).toEqual([]);
    expect(shipped.valid).toBe(true);

    // A BLANK stored subject means "use the built-in wording", which carries the
    // token — reporting it as missing would be false drift on a row that renders
    // exactly the shipped subject. Same rule the body requirement already follows.
    expect(
      validateEmailTemplateContent({
        templateName: "admin-late-capture-hand-back-conflict",
        subject: "   ",
        bodyText: conflictBody,
      }).missingRequiredSubjectTokens,
    ).toEqual([]);

    // And it is scoped to the one template that needs it: its sibling ships a
    // {{bookingStateLabel}} subject but is not under this rule, so a club that has
    // reworded that subject is not suddenly refused.
    expect(
      validateEmailTemplateContent({
        templateName: "admin-late-capture-auto-refund",
        subject: "A late payment was refunded: {{memberName}}",
        bodyText:
          EMAIL_AUDIT_DEFAULTS["admin-late-capture-auto-refund"].defaultBody,
      }).missingRequiredSubjectTokens,
    ).toEqual([]);
  });

  /**
   * AND KEEPING THE TOKEN IS NOT ENOUGH ON ITS OWN (#2774, review finding).
   *
   * The requirement above only checks the token is PRESENT. A subject that keeps it
   * and states a direction beside it passed everything:
   * "Automatic refund withheld - {{handBackConflictLabel}}: {{memberName}}" validated
   * clean and rendered, on the double-payment arm, as "Automatic refund withheld -
   * Payment may have been refunded TWICE - reconcile: Alice Example". The leading
   * words are what an inbox truncates to and what an operator triages on, so the mail
   * saying a member may have been paid twice arrived titled as one where no money
   * moved. Prepending a phrase to a pre-populated subject is an ordinary admin edit.
   *
   * The forbidden phrases are DERIVED from `lateCaptureHandBackConflictSubjectLabel`,
   * so rewording an arm moves them with it; the first assertion here is what makes
   * that structural rather than a claim in a comment.
   *
   * MUTATION PROOF: delete the template's entry from `FORBIDDEN_SUBJECT_PHRASES`, or
   * drop the renderer's check, and "refuses a subject that states the direction
   * itself" fails with `valid: true`. Reword one arm's label so a listed phrase is no
   * longer part of either arm, or so it appears in BOTH, and "every forbidden phrase
   * is one arm's own wording" fails.
   */
  it("refuses a subject that states the direction itself, keeping the token or not", () => {
    const conflictBody =
      EMAIL_AUDIT_DEFAULTS["admin-late-capture-hand-back-conflict"].defaultBody;
    const definition = getEmailTemplateDefinition(
      "admin-late-capture-hand-back-conflict",
    );
    const phrases = definition?.forbiddenSubjectPhrases ?? [];

    // Derived, not re-typed: each phrase is part of exactly ONE arm's wording, so a
    // phrase that is really shared vocabulary (or no longer said at all) fails here
    // instead of quietly refusing a subject nobody objects to.
    const normalise = (value: string) =>
      value.toLowerCase().replace(/[-‐-―\s]+/g, " ").trim();
    const labels = [true, false].map((refundSent) =>
      normalise(lateCaptureHandBackConflictSubjectLabel(refundSent)),
    );
    expect(phrases.length).toBeGreaterThan(0);
    for (const phrase of phrases) {
      expect(
        labels.filter((label) => label.includes(normalise(phrase))),
        `"${phrase}" must be one arm's wording and not the other's`,
      ).toHaveLength(1);
    }

    // The exact subject the review found: token kept, direction typed in front of it.
    const prepended = validateEmailTemplateContent({
      templateName: "admin-late-capture-hand-back-conflict",
      subject:
        "Automatic refund withheld - {{handBackConflictLabel}}: {{memberName}}",
      bodyText: conflictBody,
    });
    expect(prepended.valid).toBe(false);
    expect(prepended.forbiddenSubjectPhrases).toContain("withheld");
    const issue = prepended.issues.find(
      (candidate) => candidate.code === "forbidden_subject_phrase",
    );
    expect(issue?.field).toBe("subject");
    // The message has to say why, not just name the words: an admin told "remove
    // 'withheld'" learns nothing about the other case this subject would mistitle.
    expect(issue?.message).toContain("two opposite directions about money");
    expect(issue?.phrases).toContain("withheld");

    // The other arm's wording, and the short form of it, are refused the same way —
    // the defect is stating a direction at all, not one particular direction.
    for (const subject of [
      "Payment may have been refunded TWICE - {{handBackConflictLabel}}: {{memberName}}",
      "Refund withheld — {{handBackConflictLabel}}",
      "{{handBackConflictLabel}} (already paid back by hand): {{memberName}}",
    ]) {
      expect(
        validateEmailTemplateContent({
          templateName: "admin-late-capture-hand-back-conflict",
          subject,
          bodyText: conflictBody,
        }).valid,
        subject,
      ).toBe(false);
    }

    // A subject that says what the email is ABOUT and leaves the direction to the
    // token is accepted, so the rule is satisfiable in an admin's own words.
    const reworded = validateEmailTemplateContent({
      templateName: "admin-late-capture-hand-back-conflict",
      subject: "Late capture needs reconciling — {{handBackConflictLabel}}",
      bodyText: conflictBody,
    });
    expect(reworded.forbiddenSubjectPhrases).toEqual([]);
    expect(reworded.valid).toBe(true);

    // The shipped default and a blank subject both pass, so no club is nagged for
    // never having customised the message.
    for (const subject of [
      EMAIL_AUDIT_DEFAULTS["admin-late-capture-hand-back-conflict"]
        .defaultSubject,
      "   ",
    ]) {
      expect(
        validateEmailTemplateContent({
          templateName: "admin-late-capture-hand-back-conflict",
          subject,
          bodyText: conflictBody,
        }).forbiddenSubjectPhrases,
        subject,
      ).toEqual([]);
    }

    // Scoped to the one template sent in two directions: the sibling alert may say
    // "withheld" in its subject all it likes.
    expect(
      validateEmailTemplateContent({
        templateName: "admin-late-capture-auto-refund",
        subject: "Nothing withheld, refunded twice over: {{memberName}}",
        bodyText:
          EMAIL_AUDIT_DEFAULTS["admin-late-capture-auto-refund"].defaultBody,
      }).forbiddenSubjectPhrases,
    ).toEqual([]);
  });
});
