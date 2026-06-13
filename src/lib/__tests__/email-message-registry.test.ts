import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EMAIL_TEMPLATE_DEFINITIONS,
  getDefaultDeliveryMode,
} from "@/lib/email-message-registry";
import {
  neutraliseSensitiveSubjectContent,
  renderTemplateString,
  validateApprovedTemplateTokens,
  validateEmailTemplateContent,
} from "@/lib/email-message-renderer";

describe("email message registry", () => {
  it("covers every template section in the email audit", () => {
    const audit = fs.readFileSync(
      path.join(process.cwd(), "docs/email-message-audit.md"),
      "utf8",
    );
    const auditTemplateNames = Array.from(
      audit.matchAll(/^### ([^\n]+)$/gm),
      (match) => match[1],
    ).sort();
    const registryTemplateNames = EMAIL_TEMPLATE_DEFINITIONS.map(
      (definition) => definition.key,
    ).sort();

    expect(registryTemplateNames).toEqual(auditTemplateNames);
  });

  it("uses content-only defaults for noisy scheduled report emails", () => {
    expect(getDefaultDeliveryMode("admin-daily-digest")).toBe("content_only");
    expect(getDefaultDeliveryMode("admin-xero-reconciliation-report")).toBe(
      "content_only",
    );
    expect(getDefaultDeliveryMode("admin-payment-failure")).toBe("always");
  });

  it("has editor-safe defaults for every registered template", () => {
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
        "Hi {{firstName}}, see you soon.\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\nDoor code: {{doorCode}}",
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
      bodyText: "{{CLUB_LODGE_TRAVEL_NOTE}}\n\nDoor code: {{doorCode}}",
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
