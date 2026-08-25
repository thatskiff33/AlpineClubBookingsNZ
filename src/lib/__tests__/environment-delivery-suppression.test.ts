import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The mailer's environment-safety boundary (ENV-SAFETY 2, #3035; epic #2986;
 * INV-CONFIG-004).
 *
 * FOUR OUTCOMES THAT MUST STAY FOUR, which is the whole issue. A message can go
 * unsent because the club decided not to email this person, because this
 * installation is a copy, because nobody has said what this installation is, or
 * because the provider broke. They need four different remedies, so a test that
 * only proved "nothing was sent" would prove almost nothing.
 *
 * Every case below also asserts the provider was never REACHED, not merely that
 * no message arrived — on a copy holding the club's real member addresses,
 * "we called SES and it refused" and "we never called SES" are entirely different
 * facts.
 */

const mocks = vi.hoisted(() => ({
  emailLogCreate: vi.fn(),
  emailLogUpdate: vi.fn(),
  bookingFindUnique: vi.fn(),
  environmentSafetyFindUnique: vi.fn(),
  getActiveEmailSuppression: vi.fn(),
  getAdminEmails: vi.fn(),
  sendMail: vi.fn(),
  getEmailTransporter: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    emailLog: { create: mocks.emailLogCreate, update: mocks.emailLogUpdate },
    booking: { findUnique: mocks.bookingFindUnique },
    environmentSafetySettings: { findUnique: mocks.environmentSafetyFindUnique },
  },
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));
vi.mock("@/lib/email-sender", () => ({
  EMAIL_FROM: "club@club.test",
  SUPPORT_EMAIL: "support@club.test",
}));
vi.mock("@/lib/email-message-settings", () => ({
  EMAIL_DEFAULT_FROM_NAME: "Club Bookings",
  formatEmailFromAddressWithSettings: () => "Club <club@club.test>",
}));
vi.mock("@/lib/email-message-renderer", () => ({
  prepareEmailMessage: async ({
    subject,
    html,
  }: {
    subject: string;
    html: string;
  }) => ({ subject, html, settings: {}, bodyOverrideApplied: false }),
}));
vi.mock("@/lib/email-suppression", () => ({
  getActiveEmailSuppression: mocks.getActiveEmailSuppression,
  normalizeEmailAddress: (value: string) => value.trim().toLowerCase(),
}));
vi.mock("@/lib/email/admin-alerts-shared", () => ({
  getAdminEmails: mocks.getAdminEmails,
}));
/*
  A PARTIAL mock, and the `shouldPersistEmailHtml` half is why (#3035 review).
  This file used to stub it as `() => true`, which made every template look
  retained — so the self-healing claim it certified below was certified against a
  world where the broken case does not exist. Twenty-six templates never persist a
  body, and for those "it goes out by itself" is false. The real implementation is
  used instead, and the cases at the end of this file exercise both sides of it.
*/
vi.mock("@/lib/email/internal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/internal")>();
  return { ...actual, getEmailTransporter: mocks.getEmailTransporter };
});

import { sendEmail, __resetFailClosedAlertThrottle } from "@/lib/email/core";
import {
  declareEnvironmentRole,
  expectEnvironmentRolePremise,
  undeclareEnvironmentRole,
} from "@/lib/__tests__/helpers/environment-role";

const MESSAGE = {
  to: "member@example.com",
  subject: "Your booking",
  html: "<p>body</p>",
  templateName: "booking-modified",
  bookingContext: "none",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.emailLogCreate.mockResolvedValue({ id: "log_1" });
  mocks.emailLogUpdate.mockResolvedValue({});
  mocks.getActiveEmailSuppression.mockResolvedValue(null);
  mocks.environmentSafetyFindUnique.mockResolvedValue(null);
  mocks.sendMail.mockResolvedValue({ messageId: "msg_1" });
  mocks.getEmailTransporter.mockResolvedValue({
    transporter: { sendMail: mocks.sendMail },
    modeLabel: "test",
  });
  mocks.getAdminEmails.mockResolvedValue([]);
  mocks.bookingFindUnique.mockResolvedValue({ noEmails: false });
  __resetFailClosedAlertThrottle();
  // Not a build-mode safety decision: the dev short-circuit is kept as a local
  // convenience, and these tests are about the boundary ABOVE it, so they run in
  // the mode a deployed container runs in.
  vi.stubEnv("NODE_ENV", "production");
});

describe("confirmed PRODUCTION", () => {
  beforeEach(() => {
    declareEnvironmentRole("production");
  });

  it("delivers exactly as before, through a clearance-gated transport", async () => {
    await expectEnvironmentRolePremise("PRODUCTION");

    const outcome = await sendEmail({ ...MESSAGE });

    expect(outcome).toEqual({
      status: "sent",
      emailLogId: "log_1",
      messageId: "msg_1",
    });
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    // The transport was obtained WITH a clearance, not with nothing: that
    // argument is what makes the boundary unbypassable at compile time.
    expect(mocks.getEmailTransporter).toHaveBeenCalledTimes(1);
    expect(mocks.getEmailTransporter.mock.calls[0]?.[0]).toBeTruthy();
    expect(mocks.emailLogUpdate).toHaveBeenCalledWith({
      where: { id: "log_1" },
      data: expect.objectContaining({ status: "SENT" }),
    });
  });

  it("still honours the booking's own No emails switch, which is a different rule", async () => {
    mocks.bookingFindUnique.mockResolvedValue({ noEmails: true });

    const outcome = await sendEmail({
      ...MESSAGE,
      bookingContext: {
        bookingId: "bk_1",
        recipient: { kind: "non-login-public-contact" },
      },
    });

    expect(outcome).toEqual({
      status: "withheld_for_booking",
      emailLogId: "log_1",
      bookingId: "bk_1",
      reason: "booking_no_emails",
    });
    expect(mocks.emailLogUpdate).toHaveBeenCalledWith({
      where: { id: "log_1" },
      data: expect.objectContaining({ status: "SKIPPED_NO_EMAILS" }),
    });
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it("still records a bounced recipient as BOUNCED, not as an environment withhold", async () => {
    mocks.getActiveEmailSuppression.mockResolvedValue({
      id: "sup_1",
      reason: "BOUNCE",
    });

    const outcome = await sendEmail({ ...MESSAGE });

    expect(outcome.status).toBe("suppressed");
    expect(mocks.emailLogUpdate).toHaveBeenCalledWith({
      where: { id: "log_1" },
      data: expect.objectContaining({ status: "BOUNCED" }),
    });
    expect(mocks.getEmailTransporter).not.toHaveBeenCalled();
  });

  it("records a real provider failure as FAILED with NO block reason", async () => {
    /*
      The distinguishability requirement, from the other side. A transport failure
      and an unconfirmed environment both land on FAILED — they have to, because
      both are retryable — so the only thing separating them is the
      `deliveryBlockReason` column. A transport failure must leave it unset.
    */
    mocks.sendMail.mockRejectedValue(new Error("SES said no"));

    await expect(sendEmail({ ...MESSAGE })).rejects.toThrow("SES said no");

    const update = mocks.emailLogUpdate.mock.calls.at(-1)?.[0];
    expect(update.data.status).toBe("FAILED");
    expect(update.data).not.toHaveProperty("deliveryBlockReason");
  });
});

describe("confirmed NON_PRODUCTION", () => {
  it("contacts no provider, and records a terminal SKIPPED_NON_PRODUCTION with no body", async () => {
    declareEnvironmentRole("non-production");
    await expectEnvironmentRolePremise("NON_PRODUCTION");

    const outcome = await sendEmail({ ...MESSAGE });

    expect(outcome).toEqual({
      status: "withheld_for_environment",
      emailLogId: "log_1",
      reason: "environment_non_production",
    });
    // Not merely "no message arrived" — no transport was even asked for, so no
    // credential was used and no connection was opened.
    expect(mocks.getEmailTransporter).not.toHaveBeenCalled();
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.emailLogUpdate).toHaveBeenCalledWith({
      where: { id: "log_1" },
      data: {
        status: "SKIPPED_NON_PRODUCTION",
        htmlBody: null,
        bookingRetryHtmlBody: null,
        errorMessage: expect.stringContaining("Held back"),
      },
    });
  });

  it("suppresses when an administrator has forced the copy, even under a declared production", async () => {
    declareEnvironmentRole("production");
    mocks.environmentSafetyFindUnique.mockResolvedValue({
      forceNonProduction: true,
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedByMemberId: "m_1",
    });
    await expectEnvironmentRolePremise("NON_PRODUCTION");

    const outcome = await sendEmail({ ...MESSAGE });

    expect(outcome.status).toBe("withheld_for_environment");
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.emailLogUpdate.mock.calls.at(-1)?.[0].data.errorMessage).toContain(
      "safer override",
    );
  });

  it("does not use the terminal status for the club's own No emails switch", async () => {
    // The two must never collapse into one another: one is an administrator's
    // decision about a booking, the other is a fact about the installation.
    declareEnvironmentRole("non-production");
    mocks.bookingFindUnique.mockResolvedValue({ noEmails: true });

    const outcome = await sendEmail({
      ...MESSAGE,
      bookingContext: {
        bookingId: "bk_1",
        recipient: { kind: "non-login-public-contact" },
      },
    });

    expect(outcome.status).toBe("withheld_for_booking");
    expect(mocks.emailLogUpdate).toHaveBeenCalledWith({
      where: { id: "log_1" },
      data: expect.objectContaining({ status: "SKIPPED_NO_EMAILS" }),
    });
  });
});

/**
 * The declared local capture mailbox (#3035).
 *
 * The one case where a copy legitimately transmits. It is what keeps the browser
 * suite's email specs working — `e2e/two-factor-email.spec.ts` reads a real
 * two-factor code back out of mailpit — while nothing can reach a member, because
 * a capture forwards mail nowhere.
 */
describe("a declared local capture mailbox", () => {
  function declareCaptureTransport() {
    vi.stubEnv("USE_AWS_SES", "");
    vi.stubEnv("USE_SMTP_RELAY", "");
    vi.stubEnv("USE_LOCAL_CAPTURE", "true");
    vi.stubEnv("EMAIL_SERVER_HOST", "mailpit");
    vi.stubEnv("EMAIL_SERVER_PORT", "1025");
    vi.stubEnv("EMAIL_SERVER_USER", "e2e");
    vi.stubEnv("EMAIL_SERVER_PASSWORD", "e2e");
  }

  it("really transmits on a confirmed copy, and the row is SENT rather than suppressed", async () => {
    declareEnvironmentRole("non-production");
    declareCaptureTransport();
    mocks.getEmailTransporter.mockResolvedValue({
      transporter: { sendMail: mocks.sendMail },
      modeLabel: "Local capture mailbox",
    });

    const outcome = await sendEmail({ ...MESSAGE });

    expect(outcome).toEqual({
      status: "sent",
      emailLogId: "log_1",
      messageId: "msg_1",
    });
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    // SENT, and NOT the terminal suppression status: it was transmitted, so
    // calling it suppressed would be false — and it would inflate the
    // withheld-email count the admin panel reads.
    expect(mocks.emailLogUpdate).toHaveBeenCalledWith({
      where: { id: "log_1" },
      data: expect.objectContaining({ status: "SENT" }),
    });
    for (const call of mocks.emailLogUpdate.mock.calls) {
      expect(call[0].data.status).not.toBe("SKIPPED_NON_PRODUCTION");
    }
    /*
      Which transport carried it is named where an operator ACTUALLY reads it, so
      "sent" on a copy is never mistaken for "sent to a member".

      AT INFO, and the level is the point (#3035 review). This assertion used to
      pin `logger.debug` while the staging and measurement stacks both run
      `LOG_LEVEL: info` — so the line the claim rested on was one nobody ever saw,
      and the test certified a claim that was false in the shipped configuration.
      Only the CAPTURE case is raised: an info line per message on the live site
      would be thousands a day.
    */
    expect(mocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "Local capture mailbox" }),
      expect.stringContaining("capture mailbox"),
    );
    expect(mocks.logger.debug).not.toHaveBeenCalledWith(
      expect.anything(),
      "Email delivered",
    );
  });

  it("is refused on the club's live site, and says why", async () => {
    /*
      The symmetric hazard: a live site in capture mode accepts every message,
      reports every one as sent, and delivers none — a silent total mail outage.
      Recorded as a retryable FAULT, because it clears the moment the flags are
      corrected.
    */
    declareEnvironmentRole("production");
    declareCaptureTransport();

    const outcome = await sendEmail({ ...MESSAGE });

    expect(outcome).toEqual({
      status: "withheld_for_environment",
      emailLogId: "log_1",
      reason: "capture_transport_in_production",
    });
    expect(mocks.getEmailTransporter).not.toHaveBeenCalled();
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.emailLogUpdate).toHaveBeenCalledWith({
      where: { id: "log_1" },
      data: {
        status: "FAILED",
        deliveryBlockReason: "CAPTURE_TRANSPORT_IN_PRODUCTION",
        errorMessage: expect.stringContaining("USE_LOCAL_CAPTURE=true"),
      },
    });
  });

  it("earns an undeclared installation nothing: UNKNOWN still blocks", async () => {
    // Deliberate asymmetry with the copy above. A capture declaration comes from
    // the same deployment configuration that failed to say what this installation
    // is, so it buys no exemption from the fail-closed rule.
    undeclareEnvironmentRole();
    declareCaptureTransport();

    const outcome = await sendEmail({ ...MESSAGE });

    expect(outcome).toEqual({
      status: "withheld_for_environment",
      emailLogId: "log_1",
      reason: "environment_unknown",
    });
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });
});

describe("UNKNOWN environment", () => {
  it("contacts no provider, and leaves a RETRYABLE row that names why", async () => {
    undeclareEnvironmentRole();
    await expectEnvironmentRolePremise("UNKNOWN");

    const outcome = await sendEmail({ ...MESSAGE });

    expect(outcome).toEqual({
      status: "withheld_for_environment",
      emailLogId: "log_1",
      reason: "environment_unknown",
    });
    expect(mocks.getEmailTransporter).not.toHaveBeenCalled();
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.emailLogUpdate).toHaveBeenCalledWith({
      where: { id: "log_1" },
      data: {
        status: "FAILED",
        deliveryBlockReason: "ENVIRONMENT_DECLARATION_MISSING",
        errorMessage: expect.stringContaining("APP_ENVIRONMENT_ROLE"),
      },
    });
  });

  it("keeps the retained body, because this outcome is meant to self-heal", async () => {
    /*
      The reason this is FAILED rather than a second terminal status. An
      installation that upgraded without the declaration is a LIVE club whose
      members are waiting; the moment an operator sets the variable, the retry
      cron replays what was held back. Dropping the body would make that
      impossible and would need every message re-triggered by hand.
    */
    undeclareEnvironmentRole();

    await sendEmail({ ...MESSAGE });

    const update = mocks.emailLogUpdate.mock.calls.at(-1)?.[0];
    expect(update.data).not.toHaveProperty("htmlBody");
    expect(update.data).not.toHaveProperty("bookingRetryHtmlBody");
  });

  it("distinguishes a refused declaration from a missing one", async () => {
    declareEnvironmentRole("staging");
    await expectEnvironmentRolePremise("UNKNOWN");

    await sendEmail({ ...MESSAGE });

    expect(mocks.emailLogUpdate.mock.calls.at(-1)?.[0].data.deliveryBlockReason).toBe(
      "ENVIRONMENT_DECLARATION_INVALID",
    );
  });

  it("distinguishes a database that cannot answer from a deployment that said nothing", async () => {
    declareEnvironmentRole("production");
    mocks.environmentSafetyFindUnique.mockRejectedValue(
      new Error("relation does not exist"),
    );
    await expectEnvironmentRolePremise("UNKNOWN");

    await sendEmail({ ...MESSAGE });

    expect(mocks.emailLogUpdate.mock.calls.at(-1)?.[0].data.deliveryBlockReason).toBe(
      "ENVIRONMENT_OVERRIDE_UNREADABLE",
    );
  });

  it("raises no admin email about it, because that alert would be held back too", async () => {
    /*
      Deliberately unlike the #2258 fail-closed withhold beside it, which does
      alert. That alert is itself an email: on this path it would be blocked by
      this very gate, and on a copy it would mail the club's real admins from a
      copy. The unresolved state is surfaced where it can be acted on instead —
      the boot log, the setup checklist and Admin -> Environment (all #3034).
    */
    undeclareEnvironmentRole();

    await sendEmail({ ...MESSAGE });

    expect(mocks.getAdminEmails).not.toHaveBeenCalled();
  });
});

// --- #3035 review: "it goes out by itself" was FALSE for 26 templates ---------
//
// A blocked row keeps whatever body it holds — and `sendEmail` persists NONE for
// the twenty-six `SENSITIVE_EMAIL_LOG_TEMPLATES` (`booking-confirmed`,
// `pre-arrival-reminder`, `split-guest-payment-link`, `age-up-invitation`, every
// token template) nor for any message whose log recipient is redacted, because a
// live sign-in link, a door code or a payment link must not sit at rest.
//
// The retry cron requires a body, so those rows were never replayed. And
// `attempts` defaults to 1 while the operator review queue selects
// `attempts >= 3`, so they surfaced in NO queue either: silently and permanently
// lost, while seven places in this codebase told the operator otherwise.
//
// Retaining the body for them is not the fix — that reintroduces exactly the
// hazard they are excluded for. So the row is written at the retry CEILING, which
// drops it out of the retry query and lands it in the review queue, and the
// operator sentence says "re-send it by hand".
describe("a blocked message whose body is never retained (#3035)", () => {
  const SENSITIVE_MESSAGE = { ...MESSAGE, templateName: "booking-confirmed" };

  /** The last EmailLog update the gate wrote. */
  function lastUpdate() {
    return mocks.emailLogUpdate.mock.calls.at(-1)?.[0] as {
      data: Record<string, unknown>;
    };
  }

  it("lands in the operator review queue instead of nowhere", async () => {
    undeclareEnvironmentRole();

    const outcome = await sendEmail({ ...SENSITIVE_MESSAGE });

    expect(outcome).toMatchObject({
      status: "withheld_for_environment",
      reason: "environment_unknown",
    });
    // AT the ceiling: below it the row sits inside the retry cron's query (which
    // cannot replay it, there being no body) and below the review queue's
    // threshold, so it is visible to nobody.
    expect(lastUpdate().data.attempts).toBe(3);
    expect(lastUpdate().data.status).toBe("FAILED");
    expect(lastUpdate().data.deliveryBlockReason).toBe(
      "ENVIRONMENT_DECLARATION_MISSING",
    );
  });

  it("tells the operator to re-send it by hand, and does NOT claim it self-heals", async () => {
    undeclareEnvironmentRole();

    await sendEmail({ ...SENSITIVE_MESSAGE });

    const message = String(lastUpdate().data.errorMessage);
    expect(message).toContain("re-sent BY HAND");
    expect(message).not.toContain("goes out by itself");
    // And it still says what to fix.
    expect(message).toContain("APP_ENVIRONMENT_ROLE");
  });

  it("says the same for a live site wrongly declaring a capture mailbox", async () => {
    declareEnvironmentRole("production");
    vi.stubEnv("USE_AWS_SES", "");
    vi.stubEnv("USE_SMTP_RELAY", "");
    vi.stubEnv("USE_LOCAL_CAPTURE", "true");
    vi.stubEnv("EMAIL_SERVER_HOST", "mailpit");
    vi.stubEnv("EMAIL_SERVER_PORT", "1025");
    vi.stubEnv("EMAIL_SERVER_USER", "e2e");
    vi.stubEnv("EMAIL_SERVER_PASSWORD", "e2e");

    await sendEmail({ ...SENSITIVE_MESSAGE });

    expect(lastUpdate().data.attempts).toBe(3);
    expect(String(lastUpdate().data.errorMessage)).toContain("re-sent BY HAND");
  });

  it("leaves a RETAINABLE template alone, so it really does self-heal", async () => {
    /*
      The other side of the same rule, and the discriminating half of this pair:
      `booking-modified` is not a sensitive template, so its body IS retained, the
      retry cron can replay it, and burning its attempts would take a message that
      was going to arrive by itself and strand it in a review queue instead.
    */
    undeclareEnvironmentRole();

    await sendEmail({ ...MESSAGE });

    expect(lastUpdate().data).not.toHaveProperty("attempts");
    expect(String(lastUpdate().data.errorMessage)).toContain(
      "goes out by itself",
    );
  });

  it("treats a REDACTED log recipient as unreplayable too, whatever the template", async () => {
    /*
      The second half of `persistHtmlBody`, and easy to forget: a message whose
      logged recipient is redacted retains no body either, however ordinary its
      template. Same consequence, same remedy.
    */
    undeclareEnvironmentRole();

    await sendEmail({ ...MESSAGE, logRecipient: "redacted@example.invalid" });

    expect(lastUpdate().data.attempts).toBe(3);
  });
});
