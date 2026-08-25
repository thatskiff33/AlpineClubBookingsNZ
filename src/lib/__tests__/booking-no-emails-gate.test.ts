import { describe, it, expect, vi, beforeEach } from "vitest";
import { declareEnvironmentRole } from "@/lib/__tests__/helpers/environment-role";

/**
 * Per-booking "No emails" switch — the MAILER GATE (#2258, owner decision D10).
 *
 * These tests pin the three properties the mechanism exists for:
 *   1. flag on  -> nothing is transmitted, and the withhold is auditable
 *   2. flag off -> byte-for-byte unchanged behaviour
 *   3. the flag is read from the BOOKING, never from the recipient address, so
 *      account/security mail and admin alerts are untouched.
 */

const mocks = vi.hoisted(() => ({
  getAdminEmails: vi.fn(),
  emailLogCreate: vi.fn(),
  emailLogUpdate: vi.fn(),
  bookingFindUnique: vi.fn(),
  getActiveEmailSuppression: vi.fn(),
  sendMail: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    environmentSafetySettings: { findUnique: vi.fn().mockResolvedValue(null) },
    emailLog: { create: mocks.emailLogCreate, update: mocks.emailLogUpdate },
    booking: { findUnique: mocks.bookingFindUnique },
  },
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));
vi.mock("@/lib/email-sender", () => ({
  EMAIL_FROM: "club@club.test",
  // The fail-closed alert now renders through the shared email shell (#2689),
  // which imports the support address even though this body does not use the
  // support-link block. Keep the module mock complete for that real graph.
  SUPPORT_EMAIL: "support@club.test",
}));
vi.mock("@/lib/email-message-settings", () => ({
  // The shared shell renders this value in its <title>.
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
vi.mock("@/lib/email/internal", () => ({
  getEmailTransporter: () => ({
    transporter: { sendMail: mocks.sendMail },
    modeLabel: "test",
  }),
  shouldPersistEmailHtml: () => true,
  // #3035: `sendEmail` names which transport carried a delivered message
  // through this helper, so a factory that omits it dies at import.
  logDeliveredTransport: () => {},
}));

import {
  sendEmail,
  __resetFailClosedAlertThrottle,
} from "@/lib/email/core";

// Every member-facing message class the owner named in D10.
const MEMBER_TEMPLATES = [
  "booking-confirmed",
  "booking-modified",
  "booking-pending",
  "checkin-reminder",
  "pre-arrival-reminder",
  "booking-cancelled",
  "waitlist-offer",
  "chore-roster",
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.emailLogCreate.mockResolvedValue({ id: "log_1" });
  mocks.emailLogUpdate.mockResolvedValue({});
  mocks.getActiveEmailSuppression.mockResolvedValue(null);
  mocks.sendMail.mockResolvedValue({ messageId: "msg_1" });
  mocks.bookingFindUnique.mockResolvedValue({ noEmails: false });
  mocks.getAdminEmails.mockResolvedValue([]);
  // The throttle is module state; without this a booking id reused across tests
  // fails confusingly.
  __resetFailClosedAlertThrottle();
  vi.stubEnv("NODE_ENV", "production");
});

/*
  #3035 (ENV-SAFETY 2): this suite exercises a real SEND, so it has to say which
  installation it is pretending to be. `resolveEnvironmentRole()` answers from the
  APP_ENVIRONMENT_ROLE declaration AND the EnvironmentSafetySettings row, and both
  are absent by default in the unit suite — a missing Prisma delegate is an
  UNREADABLE override, not "no override", so the role resolves UNKNOWN and the
  delivery boundary withholds every message. Declaring production plus a
  no-override delegate is what makes these tests exercise live behaviour.
  See src/lib/__tests__/helpers/environment-role.ts.
*/
beforeEach(() => {
  declareEnvironmentRole("production");
});

describe('sendEmail gate: booking "No emails" switch on', () => {
  it.each(MEMBER_TEMPLATES)(
    "withholds %s and records a SKIPPED_NO_EMAILS audit row instead of sending",
    async (templateName) => {
      mocks.bookingFindUnique.mockResolvedValue({ noEmails: true });

      const outcome = await sendEmail({
        to: "member@example.com",
        subject: "Something about your booking",
        html: "<p>body</p>",
        templateName,
        bookingContext: { bookingId: "bk_1", recipient: { kind: "non-login-public-contact" } },
      });

      expect(outcome).toEqual({
        status: "withheld_for_booking",
        emailLogId: "log_1",
        bookingId: "bk_1",
        reason: "booking_no_emails",
      });
      // Nothing was transmitted, and the SES suppression lookup is never even
      // reached (the booking gate runs first).
      expect(mocks.sendMail).not.toHaveBeenCalled();
      expect(mocks.getActiveEmailSuppression).not.toHaveBeenCalled();
      // The withhold is auditable, attributed to the booking, and retains no
      // body (nothing was sent, and the retry cron only replays retained bodies).
      expect(mocks.emailLogUpdate).toHaveBeenCalledWith({
        where: { id: "log_1" },
        data: expect.objectContaining({
          status: "SKIPPED_NO_EMAILS",
          htmlBody: null,
          errorMessage: expect.stringContaining("No emails"),
        }),
      });
      expect(mocks.emailLogCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ bookingId: "bk_1", templateName }),
      });
    },
  );

  it("keys the gate on the booking, never on the recipient address", async () => {
    mocks.bookingFindUnique.mockResolvedValue({ noEmails: true });

    // Same recipient as the withheld booking mail above, but this send carries
    // no booking — an address-keyed shortcut would lock the member out of their
    // own account here.
    const outcome = await sendEmail({
      to: "member@example.com",
      subject: "Your sign-in code",
      html: "<p>123456</p>",
      templateName: "two-factor-code",
      bookingContext: "none",
    });

    expect(outcome.status).toBe("sent");
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect(mocks.bookingFindUnique).not.toHaveBeenCalled();
  });

  it.each([
    "two-factor-code",
    "password-reset",
    "magic-link-login",
    "email-change-notification",
  ])("never withholds the account/security template %s", async (templateName) => {
    mocks.bookingFindUnique.mockResolvedValue({ noEmails: true });

    const outcome = await sendEmail({
      to: "member@example.com",
      subject: "Account",
      html: "<p>token</p>",
      templateName,
      bookingContext: "none",
    });

    expect(outcome.status).toBe("sent");
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
  });

  it.each(["admin-payment-failure", "admin-duplicate-capture-refund", "admin-new-booking"])(
    "never withholds the admin-audience template %s even when handed a suppressed booking",
    async (templateName) => {
      mocks.bookingFindUnique.mockResolvedValue({ noEmails: true });

      const outcome = await sendEmail({
        to: "admin@example.com",
        subject: "Admin alert",
        html: "<p>alert</p>",
        templateName,
        // Deliberately the strongest case: a real booking id AND the switch on.
        // The registry audience is the authority, so the alert still goes out.
        bookingContext: { bookingId: "bk_1", recipient: { kind: "non-login-public-contact" } },
      });

      expect(outcome.status).toBe("sent");
      expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    },
  );

  it("never withholds the system-audience admin-email-failure template", async () => {
    mocks.bookingFindUnique.mockResolvedValue({ noEmails: true });

    const outcome = await sendEmail({
      to: "admin@example.com",
      subject: "Email delivery permanently failed",
      html: "<p>alert</p>",
      templateName: "admin-email-failure",
      bookingContext: { bookingId: "bk_1", recipient: { kind: "non-login-public-contact" } },
    });

    expect(outcome.status).toBe("sent");
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
  });
});

describe('sendEmail gate: booking "No emails" switch off', () => {
  it.each(MEMBER_TEMPLATES)("sends %s exactly as before", async (templateName) => {
    const outcome = await sendEmail({
      to: "member@example.com",
      subject: "Something about your booking",
      html: "<p>body</p>",
      templateName,
      bookingContext: { bookingId: "bk_1", recipient: { kind: "non-login-public-contact" } },
    });

    expect(outcome.status).toBe("sent");
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect(mocks.getActiveEmailSuppression).toHaveBeenCalledTimes(1);
  });

  it("stamps the bookingId on the log row of a normal booking send", async () => {
    await sendEmail({
      to: "member@example.com",
      subject: "Confirmed",
      html: "<p>body</p>",
      templateName: "booking-confirmed",
      bookingContext: { bookingId: "bk_42", recipient: { kind: "non-login-public-contact" } },
    });

    expect(mocks.emailLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bookingId: "bk_42",
        htmlBody: null,
        bookingRetryHtmlBody: "<p>body</p>",
      }),
    });
  });

  it("keeps new booking retry HTML invisible to the rolled-back worker", async () => {
    await sendEmail({
      to: "member@example.com",
      subject: "Operational update",
      html: "<p>retained only for the authority-aware worker</p>",
      templateName: "booking-modified",
      bookingContext: {
        bookingId: "bk_rollback",
        recipient: { kind: "non-login-public-contact" },
      },
    });

    const logged = mocks.emailLogCreate.mock.calls[0][0].data;
    expect(logged.htmlBody).toBeNull();
    expect(logged.bookingRetryHtmlBody).toBe(
      "<p>retained only for the authority-aware worker</p>",
    );
    // This is the previous cron binary's executable body predicate after the
    // initial send later transitions the same row to FAILED.
    expect({ ...logged, status: "FAILED" }.htmlBody !== null).toBe(false);
  });

  it("stores a null bookingId for a send with no booking", async () => {
    await sendEmail({
      to: "member@example.com",
      subject: "Your sign-in code",
      html: "<p>123456</p>",
      templateName: "two-factor-code",
      bookingContext: "none",
    });

    expect(mocks.emailLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bookingId: null,
        htmlBody: "<p>123456</p>",
      }),
    });
  });
});

describe("sendEmail gate: fail closed", () => {
  it("does NOT send when the switch cannot be read, and records the row FAILED so the retry cron re-evaluates it", async () => {
    mocks.bookingFindUnique.mockRejectedValue(new Error("connection reset"));

    const outcome = await sendEmail({
      to: "member@example.com",
      subject: "Confirmed",
      html: "<p>body</p>",
      templateName: "booking-confirmed",
      bookingContext: { bookingId: "bk_1", recipient: { kind: "non-login-public-contact" } },
    });

    expect(outcome).toEqual({
      status: "withheld_for_booking",
      emailLogId: "log_1",
      bookingId: "bk_1",
      reason: "booking_flag_unreadable",
    });
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.emailLogUpdate).toHaveBeenCalledWith({
      where: { id: "log_1" },
      data: expect.objectContaining({ status: "FAILED" }),
    });
    // Deliberately the OPPOSITE of the SES bounce check, which fails open.
    const failedUpdate = mocks.emailLogUpdate.mock.calls[0][0];
    expect(failedUpdate.data).not.toHaveProperty("htmlBody");
  });

  it("still refuses to send when the EmailLog row could not be created either", async () => {
    mocks.emailLogCreate.mockRejectedValue(new Error("db down"));
    mocks.bookingFindUnique.mockRejectedValue(new Error("db down"));

    const outcome = await sendEmail({
      to: "member@example.com",
      subject: "Confirmed",
      html: "<p>body</p>",
      templateName: "booking-confirmed",
      bookingContext: { bookingId: "bk_1", recipient: { kind: "non-login-public-contact" } },
    });

    expect(outcome.status).toBe("withheld_for_booking");
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it("withholds in development mode too (the dev short-circuit is downstream of the gate)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    mocks.bookingFindUnique.mockResolvedValue({ noEmails: true });

    const outcome = await sendEmail({
      to: "member@example.com",
      subject: "Confirmed",
      html: "<p>body</p>",
      templateName: "booking-confirmed",
      bookingContext: { bookingId: "bk_1", recipient: { kind: "non-login-public-contact" } },
    });

    expect(outcome.status).toBe("withheld_for_booking");
    expect(mocks.emailLogUpdate).not.toHaveBeenCalledWith({
      where: { id: "log_1" },
      data: expect.objectContaining({ status: "SENT" }),
    });
  });
});

describe("fail-closed withholds are surfaced to an operator (#2258)", () => {
  // Without this, a fail-closed withhold of a body-less sensitive template is
  // invisible: no retained htmlBody means the retry cron's query never sees the
  // FAILED row, and attempts stays at 1 so it never reaches the >=3 exhausted
  // review queue either. The member is silently owed an email nobody knows of.
  it("alerts every admin, naming the template and booking, when the switch cannot be read", async () => {
    mocks.getAdminEmails.mockResolvedValue(["a@club.test", "b@club.test"]);
    mocks.bookingFindUnique.mockRejectedValue(new Error("connection reset"));

    await sendEmail({
      to: "member@example.com",
      subject: "Confirmed",
      html: "<p>body</p>",
      templateName: "booking-confirmed",
      bookingContext: { bookingId: "bk_alert_1", recipient: { kind: "non-login-public-contact" } },
    });

    const alerts = mocks.sendMail.mock.calls.map((call) => call[0]);
    expect(alerts).toHaveLength(2);
    expect(alerts.map((a) => a.to).sort()).toEqual(["a@club.test", "b@club.test"]);
    for (const alert of alerts) {
      expect(alert.html).toContain("booking-confirmed");
      expect(alert.html).toContain("bk_alert_1");
    }
    // The member's own message is still NOT sent — only the admin alert went out.
    expect(alerts.every((a) => a.to !== "member@example.com")).toBe(true);
  });

  it("does NOT alert for a deliberate withhold (that one is already visible on the booking)", async () => {
    mocks.getAdminEmails.mockResolvedValue(["a@club.test"]);
    mocks.bookingFindUnique.mockResolvedValue({ noEmails: true });

    await sendEmail({
      to: "member@example.com",
      subject: "Confirmed",
      html: "<p>body</p>",
      templateName: "booking-confirmed",
      bookingContext: { bookingId: "bk_alert_2", recipient: { kind: "non-login-public-contact" } },
    });

    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it("throttles the alert per booking+template so a database outage cannot storm admins", async () => {
    mocks.getAdminEmails.mockResolvedValue(["a@club.test"]);
    mocks.bookingFindUnique.mockRejectedValue(new Error("connection reset"));

    for (let i = 0; i < 4; i += 1) {
      await sendEmail({
        to: "member@example.com",
        subject: "Confirmed",
        html: "<p>body</p>",
        templateName: "booking-confirmed",
        bookingContext: { bookingId: "bk_throttle", recipient: { kind: "non-login-public-contact" } },
      });
    }

    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
  });

  it("does not let an alert failure change the withheld outcome", async () => {
    mocks.getAdminEmails.mockRejectedValue(new Error("admin lookup failed"));
    mocks.bookingFindUnique.mockRejectedValue(new Error("connection reset"));

    const outcome = await sendEmail({
      to: "member@example.com",
      subject: "Confirmed",
      html: "<p>body</p>",
      templateName: "booking-confirmed",
      bookingContext: { bookingId: "bk_alert_3", recipient: { kind: "non-login-public-contact" } },
    });

    expect(outcome.status).toBe("withheld_for_booking");
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  // The throttle must arm on SUCCESS, not on attempt. Arming up front meant
  // that in the very scenario the alert exists for — a database outage, where
  // the admin lookup is itself a failing prisma call — the first attempt threw,
  // the key stayed armed for the cooldown, and nobody was ever told.
  it("does not arm the throttle when the alert itself failed", async () => {
    mocks.bookingFindUnique.mockRejectedValue(new Error("connection reset"));
    mocks.getAdminEmails.mockRejectedValueOnce(new Error("admin lookup failed"));

    await sendEmail({
      to: "member@example.com",
      subject: "Confirmed",
      html: "<p>body</p>",
      templateName: "booking-confirmed",
      bookingContext: { bookingId: "bk_retry_alert", recipient: { kind: "non-login-public-contact" } },
    });
    expect(mocks.sendMail).not.toHaveBeenCalled();

    // The database recovers enough to look admins up: the alert must still go.
    mocks.getAdminEmails.mockResolvedValue(["a@club.test"]);
    await sendEmail({
      to: "member@example.com",
      subject: "Confirmed",
      html: "<p>body</p>",
      templateName: "booking-confirmed",
      bookingContext: { bookingId: "bk_retry_alert", recipient: { kind: "non-login-public-contact" } },
    });

    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
  });

  it("caps alerts globally so a broad fault cannot fan out to every admin", async () => {
    mocks.getAdminEmails.mockResolvedValue(["a@club.test"]);
    mocks.bookingFindUnique.mockRejectedValue(new Error("connection reset"));

    // Ten DIFFERENT bookings: the per-key throttle does not apply, only the cap.
    for (let i = 0; i < 10; i += 1) {
      await sendEmail({
        to: "member@example.com",
        subject: "Confirmed",
        html: "<p>body</p>",
        templateName: "booking-confirmed",
        bookingContext: { bookingId: `bk_cap_${i}`, recipient: { kind: "non-login-public-contact" } },
      });
    }

    expect(mocks.sendMail).toHaveBeenCalledTimes(5);
  });

  it("supplies the registry-required attemptCount token", async () => {
    mocks.getAdminEmails.mockResolvedValue(["a@club.test"]);
    mocks.bookingFindUnique.mockRejectedValue(new Error("connection reset"));

    await sendEmail({
      to: "member@example.com",
      subject: "Confirmed",
      html: "<p>body</p>",
      templateName: "booking-confirmed",
      bookingContext: { bookingId: "bk_token", recipient: { kind: "non-login-public-contact" } },
    });

    expect(mocks.emailLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ templateName: "admin-email-failure" }),
    });
  });
});
