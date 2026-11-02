import { describe, expect, it } from "vitest";
import { EMAIL_TEMPLATE_DEFINITIONS } from "@/lib/email-message-registry";
import {
  CALLER_RETRIED_ALERT_TEMPLATES,
  isCallerRetriedAlertTemplate,
  NON_RETRYABLE_EMAIL_LOG_TEMPLATES,
  SENSITIVE_EMAIL_LOG_TEMPLATES,
  shouldPersistEmailHtml,
} from "@/lib/email/internal";

const REQUIRED_TOKEN_TEMPLATE_NAMES = EMAIL_TEMPLATE_DEFINITIONS.filter(
  (definition) => definition.requiredTokens.includes("token"),
).map((definition) => definition.key);

describe("sensitive EmailLog HTML classification", () => {
  it.each(REQUIRED_TOKEN_TEMPLATE_NAMES)(
    "redacts the registered token-bearing %s template",
    (templateName) => {
      expect(shouldPersistEmailHtml(templateName)).toBe(false);
    },
  );

  it("redacts the optional token-bearing chore-roster template", () => {
    expect(shouldPersistEmailHtml("chore-roster")).toBe(false);
  });

  it("redacts the split-guest payment link, whose HTML carries a live /pay/<token> link (#1967/#1994)", () => {
    // Registering the template must not weaken #1885 suppression truthfulness:
    // its rendered HTML embeds a bearer /pay/<token> link, so it must never be
    // persisted at rest in EmailLog or the retry table.
    expect(shouldPersistEmailHtml("split-guest-payment-link")).toBe(false);
  });

  it("redacts the magic-link sign-in template, whose HTML carries a live /login/magic?token link (#2034)", () => {
    // The rendered HTML embeds a single-use /login/magic?token=<token> sign-in
    // link, so it must never persist at rest in EmailLog or the retry table.
    expect(shouldPersistEmailHtml("magic-link-login")).toBe(false);
  });

  it("continues to retain HTML for a non-sensitive template", () => {
    expect(shouldPersistEmailHtml("booking-request-declined")).toBe(true);
  });

  it("retains HTML for the #1992/#2007 duplicate-capture refund alert (no bearer token)", () => {
    // The dedicated duplicate-capture alert carries no bearer /pay link, so its
    // HTML must NOT be redacted at rest.
    expect(shouldPersistEmailHtml("admin-duplicate-capture-refund")).toBe(true);
  });

  it("retains HTML for the #1993 terminal split-cancellation templates (no bearer token)", () => {
    // Neither the admin terminal notice nor the member guest-portion-cancelled
    // notice carries a bearer /pay link, so they must NOT be redacted at rest.
    expect(shouldPersistEmailHtml("admin-split-settlement-cancelled")).toBe(true);
    expect(shouldPersistEmailHtml("split-guest-portion-cancelled")).toBe(true);
  });
});

// #4669: these alerts keep their bodies so the email retry cron can replay one
// recipient's lost copy; when nobody received one, the sender releases the
// attempt's rows instead (`caller-retried-alert.ts`), so the owner's retry is the
// only one. Read from the exported set, so a template added there is covered.
describe("caller-retried admin alerts (#4669)", () => {
  const callerRetried = [...CALLER_RETRIED_ALERT_TEMPLATES];
  const remainingNonRetryable = [...NON_RETRYABLE_EMAIL_LOG_TEMPLATES].filter(
    (templateName) => !SENSITIVE_EMAIL_LOG_TEMPLATES.has(templateName),
  );

  it("names the three alerts whose owner retries a send nobody received", () => {
    expect(callerRetried.sort()).toEqual([
      "admin-bank-transfer-settlement-figure",
      "admin-unmatched-app-stripe-payment",
      "admin-unrecognised-stripe-payment",
    ]);
  });

  it.each(callerRetried)("retains %s's body, so one lost copy can be replayed", (templateName) => {
    expect(isCallerRetriedAlertTemplate(templateName)).toBe(true);
    expect(shouldPersistEmailHtml(templateName)).toBe(true);
  });

  it("shares no template with the token-bearing set, whose bodies must never be kept", () => {
    expect(callerRetried.filter((templateName) => SENSITIVE_EMAIL_LOG_TEMPLATES.has(templateName))).toEqual([]);
  });

  it("shares no template with the other non-retryable ones, whose retry belongs entirely elsewhere", () => {
    expect(remainingNonRetryable.length).toBeGreaterThan(0);
    expect(callerRetried.filter((templateName) => remainingNonRetryable.includes(templateName))).toEqual([]);
  });

  it("names no token-bearing or retry-alert template as caller-retried", () => {
    expect(isCallerRetriedAlertTemplate("password-reset")).toBe(false);
    expect(isCallerRetriedAlertTemplate("admin-email-failure")).toBe(false);
    expect(isCallerRetriedAlertTemplate("admin-late-capture-auto-refund")).toBe(false);
  });
});
