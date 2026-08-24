import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  memberFindMany: vi.fn(),
  memberFindUnique: vi.fn(),
  sendMail: vi.fn(),
  resolveEmailDeliveryConfig: vi.fn(),
  // #3035: the delivery policy reads the DECLARED transport kind through this
  // same canonical parser, so a partial mock of the module has to name it or the
  // whole file dies at import.
  resolveEmailTransportKind: vi.fn(() => "live-provider"),
  sendEmail: vi.fn(),
  getAdminEmails: vi.fn(),
  getActiveEmailSuppression: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    environmentSafetySettings: { findUnique: vi.fn().mockResolvedValue(null) },
    emailLog: {
      findMany: mocks.findMany,
      update: mocks.update,
      updateMany: mocks.updateMany,
    },
    member: {
      findMany: mocks.memberFindMany,
      findUnique: mocks.memberFindUnique,
    },
    // #2258: the retry cron re-reads the booking's "No emails" switch before
    // every replay.
    booking: {
      findUnique: mocks.bookingFindUnique,
    },
  },
}));

vi.mock("@/lib/email-suppression", () => ({
  getActiveEmailSuppression: mocks.getActiveEmailSuppression,
  normalizeEmailAddress: (value: string) => value.trim().toLowerCase(),
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({ sendMail: mocks.sendMail })),
  },
}));

vi.mock("@/lib/email-sender", () => ({
  EMAIL_FROM: "noreply@example.test",
  formatEmailFromAddress: (from: string) => from,
}));

vi.mock("@/lib/email-text", () => ({
  htmlToPlainText: (html: string) => html,
}));

vi.mock("@/lib/email-delivery", () => ({
  resolveEmailDeliveryConfig: mocks.resolveEmailDeliveryConfig,
  resolveEmailTransportKind: mocks.resolveEmailTransportKind,
}));

vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/email", () => ({
  sendEmail: mocks.sendEmail,
  // #2548: the retry-exhausted alert resolves its audience through the shared
  // access-role-aware helper instead of querying the legacy ADMIN scalar here.
  getAdminEmails: mocks.getAdminEmails,
}));

import { retryFailedEmails } from "@/lib/cron-email-retry";
import { declareEnvironmentRole } from "@/lib/__tests__/helpers/environment-role";

function failedEmail(overrides: Record<string, unknown> = {}) {
  return {
    id: "email_1",
    to: "member@example.test",
    subject: "Booking update",
    htmlBody: "<p>hello</p>",
    templateName: "booking-confirmed",
    // #2258: rows written since the migration carry their booking. The
    // NULL-bookingId cases (pre-migration rows) are exercised explicitly below.
    bookingId: "bk_1",
    bookingRecipientMemberId: "member_1",
    bookingBodyOverrideApplied: false,
    bookingDetailLinkIncluded: false,
    bookingRetryHtmlBody: null,
    attempts: 0,
    ...overrides,
  };
}

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

describe("retryFailedEmails (issue #820)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveEmailDeliveryConfig.mockReturnValue({
      ok: true,
      mode: "smtp-relay",
      modeSource: "explicit-flag",
      modeLabel: "SMTP Relay",
      // #3035: the retry cron now obtains its transport through
      // getEmailTransporter, which builds a cache signature from the auth pair
      // instead of reading transportOptions.host alone.
      transportOptions: {
        host: "smtp.example.test",
        port: 587,
        secure: false,
        auth: { user: "relay-user", pass: "relay-pass" },
      },
      issues: [],
      warnings: [],
    });
    mocks.update.mockResolvedValue({});
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.memberFindMany.mockResolvedValue([]);
    mocks.getAdminEmails.mockResolvedValue([]);
    mocks.getActiveEmailSuppression.mockResolvedValue(null);
    mocks.bookingFindUnique.mockImplementation(
      async (args: { select?: { noEmails?: boolean } }) =>
        args.select?.noEmails
          ? { noEmails: false }
          : { memberId: "member_1", deletedAt: null, guests: [] },
    );
    mocks.memberFindUnique.mockResolvedValue({
      email: "member@example.test",
      inheritEmailFromId: null,
      inheritEmailFrom: null,
      role: "USER",
      financeAccessLevel: "NONE",
      active: true,
      archivedAt: null,
      canLogin: true,
      accessRoles: [],
    });
  });

  it("only queries retryable failures: FAILED, under max attempts, with a retained HTML body", async () => {
    mocks.findMany.mockResolvedValue([]);

    await retryFailedEmails();

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "FAILED",
          attempts: { lt: 3 },
          OR: [
            { htmlBody: { not: null } },
            { bookingRetryHtmlBody: { not: null } },
          ],
        }),
      }),
    );
  });

  it("marks a successfully re-sent email as SENT and increments attempts", async () => {
    mocks.findMany.mockResolvedValue([failedEmail({ attempts: 1 })]);
    mocks.sendMail.mockResolvedValue({ messageId: "msg_1" });

    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 1, succeeded: 1, failed: 0 });
    // The row is claimed atomically (FAILED -> QUEUED, attempts incremented)
    // before the send so a concurrent/interrupted run cannot double-send (F33).
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        id: "email_1",
        status: "FAILED",
        attempts: 1,
        htmlBody: "<p>hello</p>",
        bookingRetryHtmlBody: null,
      },
      data: expect.objectContaining({ status: "QUEUED", attempts: 2 }),
    });
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "email_1" },
        data: expect.objectContaining({ status: "SENT", messageId: "msg_1" }),
      }),
    );
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("keeps a still-retryable email FAILED and does not alert admins yet", async () => {
    mocks.findMany.mockResolvedValue([failedEmail({ attempts: 0 })]);
    mocks.sendMail.mockRejectedValue(new Error("smtp 421"));

    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 1, succeeded: 0, failed: 1 });
    // attempts incremented, status restored to FAILED for the next run
    // (the pre-send claim moved it to QUEUED).
    const updateArg = mocks.update.mock.calls[0][0];
    expect(updateArg.data.attempts).toBe(1);
    expect(updateArg.data.status).toBe("FAILED");
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("re-checks suppression and marks the row BOUNCED without sending (F26, #1885)", async () => {
    // Race: the FAILED row was created before an SNS bounce/complaint
    // suppressed the recipient. The retry must re-check and never re-deliver.
    mocks.findMany.mockResolvedValue([failedEmail({ attempts: 1 })]);
    mocks.getActiveEmailSuppression.mockResolvedValue({
      id: "sup-1",
      reason: "BOUNCE",
    });

    const result = await retryFailedEmails();

    expect(mocks.getActiveEmailSuppression).toHaveBeenCalledWith(
      "member@example.test",
    );
    expect(mocks.sendMail).not.toHaveBeenCalled();
    // Never claimed — a suppressed skip is not a retry attempt.
    expect(mocks.updateMany).not.toHaveBeenCalled();
    // Mirrors core.ts's suppressed write: BOUNCED, body dropped, same reason string.
    // Plus `deliveryBlockReason: null` (#3035): this row may have been failed by
    // the environment gate before, and that column was cleared NOWHERE — so a
    // stale value would keep a bounced address inside the environment-withheld
    // count for the life of the installation.
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "email_1" },
      data: {
        status: "BOUNCED",
        htmlBody: null,
        bookingRetryHtmlBody: null,
        errorMessage: "Email suppressed after SES bounce feedback",
        deliveryBlockReason: null,
      },
    });
    expect(result).toEqual({ retried: 0, succeeded: 0, failed: 0 });
  });

  it("does not send when the pre-send claim is lost (row already claimed/sent) (F33, #1885)", async () => {
    mocks.findMany.mockResolvedValue([failedEmail()]);
    mocks.updateMany.mockResolvedValue({ count: 0 });

    const result = await retryFailedEmails();

    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(result).toEqual({ retried: 0, succeeded: 0, failed: 0 });
  });

  it("never restores FAILED when the post-send SENT write fails, so an interrupted retry cannot re-send (F33, #1885)", async () => {
    mocks.findMany.mockResolvedValue([failedEmail()]);
    mocks.sendMail.mockResolvedValue({ messageId: "msg_1" });
    // SES accepted the message but the SENT write dies (crash-equivalent).
    mocks.update.mockRejectedValue(new Error("db connection lost"));

    const result = await retryFailedEmails();

    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    // The row must stay QUEUED (claimed) — writing FAILED back would re-send
    // an email SES already accepted on the next cron run.
    for (const call of mocks.update.mock.calls) {
      expect(call[0].data.status).not.toBe("FAILED");
    }
    expect(result).toEqual({ retried: 1, succeeded: 1, failed: 0 });
  });

  it("alerts admins when an email exhausts its retries", async () => {
    mocks.findMany.mockResolvedValue([failedEmail({ attempts: 2 })]);
    mocks.sendMail.mockRejectedValue(new Error("smtp 550"));
    mocks.getAdminEmails.mockResolvedValue(["admin@example.test"]);

    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 1, succeeded: 0, failed: 1 });
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "admin@example.test",
        templateName: "admin-email-failure",
      }),
    );
  });

  it("does not re-alert when the failing email is itself the admin failure alert", async () => {
    mocks.findMany.mockResolvedValue([
      failedEmail({ attempts: 2, templateName: "admin-email-failure" }),
    ]);
    mocks.sendMail.mockRejectedValue(new Error("smtp 550"));

    await retryFailedEmails();

    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("throws when email delivery configuration is invalid", async () => {
    mocks.resolveEmailDeliveryConfig.mockReturnValue({
      ok: false,
      mode: "invalid",
      modeSource: "unresolved",
      modeLabel: "Not configured",
      transportOptions: null,
      issues: ["missing EMAIL_FROM"],
      warnings: [],
    });

    // #3035: the refusal now comes from getEmailTransporter, the one accessor
    // that builds a transport, rather than from a second copy of the same check
    // in this job.
    await expect(retryFailedEmails()).rejects.toThrow(
      /Email delivery is not configured/,
    );
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
});

describe('retryFailedEmails and the per-booking "No emails" switch (#2258)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveEmailDeliveryConfig.mockReturnValue({
      ok: true,
      mode: "smtp-relay",
      modeSource: "explicit-flag",
      modeLabel: "SMTP Relay",
      // #3035: the retry cron now obtains its transport through
      // getEmailTransporter, which builds a cache signature from the auth pair
      // instead of reading transportOptions.host alone.
      transportOptions: {
        host: "smtp.example.test",
        port: 587,
        secure: false,
        auth: { user: "relay-user", pass: "relay-pass" },
      },
      issues: [],
      warnings: [],
    });
    mocks.update.mockResolvedValue({});
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.memberFindMany.mockResolvedValue([]);
    mocks.getAdminEmails.mockResolvedValue([]);
    mocks.getActiveEmailSuppression.mockResolvedValue(null);
    mocks.bookingFindUnique.mockImplementation(
      async (args: { select?: { noEmails?: boolean } }) =>
        args.select?.noEmails
          ? { noEmails: false }
          : { memberId: "member_1", deletedAt: null, guests: [] },
    );
    mocks.memberFindUnique.mockResolvedValue({
      email: "member@example.test",
      inheritEmailFromId: null,
      inheritEmailFrom: null,
      role: "USER",
      financeAccessLevel: "NONE",
      active: true,
      archivedAt: null,
      canLogin: true,
      accessRoles: [],
    });
    mocks.sendMail.mockResolvedValue({ messageId: "msg_1" });
  });

  it("does NOT replay a FAILED email whose booking now has the switch on", async () => {
    // The exact hole the gate exists for: the row was queued and failed BEFORE
    // an admin turned the switch on, so the pre-send check in core.ts passed.
    mocks.findMany.mockResolvedValue([failedEmail({ bookingId: "bk_1" })]);
    mocks.bookingFindUnique.mockResolvedValue({ noEmails: true });

    const result = await retryFailedEmails();

    expect(mocks.sendMail).not.toHaveBeenCalled();
    // Not claimed, so it is not counted as a retry attempt.
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ retried: 0, succeeded: 0, failed: 0 });
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "email_1" },
      data: expect.objectContaining({
        status: "SKIPPED_NO_EMAILS",
        htmlBody: null,
      }),
    });
  });

  it("fails closed and leaves the row untouched when the switch cannot be read", async () => {
    mocks.findMany.mockResolvedValue([failedEmail({ bookingId: "bk_1" })]);
    mocks.bookingFindUnique.mockRejectedValue(new Error("connection reset"));

    const result = await retryFailedEmails();

    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ retried: 0, succeeded: 0, failed: 0 });
  });

  it("replays normally when the booking's switch is off", async () => {
    mocks.findMany.mockResolvedValue([failedEmail({ bookingId: "bk_1" })]);

    const result = await retryFailedEmails();

    expect(mocks.bookingFindUnique).toHaveBeenCalledWith({
      where: { id: "bk_1" },
      select: { noEmails: true },
    });
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect(result.succeeded).toBe(1);
  });

  it("removes a retained booking-detail CTA when the member's authority was revoked", async () => {
    mocks.findMany.mockResolvedValue([
      failedEmail({
        htmlBody:
          '<table role="presentation" cellpadding="0" cellspacing="0"><tr><td><a href="http://localhost:3000/bookings/bk_1">View booking</a></td></tr></table><p>Operational update</p>',
        bookingDetailLinkIncluded: true,
      }),
    ]);
    mocks.bookingFindUnique.mockImplementation(
      async (args: { select?: { noEmails?: boolean } }) =>
        args.select?.noEmails
          ? { noEmails: false }
          : { memberId: "different_owner", deletedAt: null, guests: [] },
    );

    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 1, succeeded: 1, failed: 0 });
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    const retry = mocks.sendMail.mock.calls[0][0];
    expect(retry.html).toContain("Operational update");
    expect(retry.html).not.toContain("/bookings/bk_1");
    expect(retry.html).not.toContain("View booking");
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          htmlBody: retry.html,
          bookingDetailLinkIncluded: false,
        }),
      }),
    );
  });

  it("sanitizes a stored override delivery copy after authority is revoked", async () => {
    const storedOverride =
      '<p>Club-authored body</p><a href="http://localhost:3000/bookings/bk_1">Open booking</a>';
    mocks.findMany.mockResolvedValue([
      failedEmail({
        htmlBody: storedOverride,
        bookingBodyOverrideApplied: true,
        bookingDetailLinkIncluded: true,
      }),
    ]);
    mocks.bookingFindUnique.mockImplementation(
      async (args: { select?: { noEmails?: boolean } }) =>
        args.select?.noEmails
          ? { noEmails: false }
          : { memberId: "different_owner", deletedAt: null, guests: [] },
    );

    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 1, succeeded: 1, failed: 0 });
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect(mocks.sendMail.mock.calls[0][0].html).toContain("Club-authored body");
    expect(mocks.sendMail.mock.calls[0][0].html).not.toContain(
      "/bookings/bk_1",
    );
    expect(mocks.updateMany.mock.calls[0][0].data).toMatchObject({
      bookingDetailLinkIncluded: false,
    });
  });

  it("removes the detail link when the member no longer owns the retained destination", async () => {
    mocks.findMany.mockResolvedValue([
      failedEmail({
        to: "old-mailbox@example.test",
        htmlBody:
          '<table role="presentation" cellpadding="0" cellspacing="0"><tr><td><a href="http://localhost:3000/bookings/bk_1">View booking</a></td></tr></table><p>Operational update</p>',
        bookingDetailLinkIncluded: true,
      }),
    ]);

    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 1, succeeded: 1, failed: 0 });
    expect(mocks.sendMail.mock.calls[0][0].to).toBe(
      "old-mailbox@example.test",
    );
    expect(mocks.sendMail.mock.calls[0][0].html).not.toContain(
      "/bookings/bk_1",
    );
    expect(mocks.updateMany.mock.calls[0][0].data).toMatchObject({
      bookingDetailLinkIncluded: false,
    });
  });

  it("retries new booking rows from rollback-isolated storage", async () => {
    const quarantinedHtml = "<p>rollback-isolated booking update</p>";
    mocks.findMany.mockResolvedValue([
      failedEmail({
        htmlBody: null,
        bookingRetryHtmlBody: quarantinedHtml,
      }),
    ]);

    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 1, succeeded: 1, failed: 0 });
    expect(mocks.sendMail.mock.calls[0][0].html).toContain(quarantinedHtml);
    expect(mocks.sendMail.mock.calls[0][0].html).toContain(
      "/bookings/bk_1",
    );
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          htmlBody: null,
          bookingRetryHtmlBody: quarantinedHtml,
        }),
      }),
    );
  });

  it("retries an authorized stored override byte-for-byte", async () => {
    const storedOverride =
      '<p>Club-authored body</p><a href="http://localhost:3000/bookings/bk_1">Open booking</a>';
    mocks.findMany.mockResolvedValue([
      failedEmail({
        htmlBody: storedOverride,
        bookingBodyOverrideApplied: true,
        bookingDetailLinkIncluded: true,
      }),
    ]);

    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 1, succeeded: 1, failed: 0 });
    expect(mocks.sendMail.mock.calls[0][0].html).toBe(storedOverride);
    expect(mocks.updateMany.mock.calls[0][0].data).not.toHaveProperty(
      "htmlBody",
    );
  });

  it("preserves a public recipient's bearer consent action during retry", async () => {
    const bearerHtml =
      '<p>Please answer</p><a href="http://localhost:3000/bookings/consent/guest_1">Answer for this member</a>';
    mocks.findMany.mockResolvedValue([
      failedEmail({
        htmlBody: bearerHtml,
        bookingRecipientMemberId: null,
        bookingDetailLinkIncluded: false,
      }),
    ]);

    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 1, succeeded: 1, failed: 0 });
    expect(mocks.sendMail.mock.calls[0][0].html).toBe(bearerHtml);
  });

  it("fails closed when a known retained detail link cannot be located after URL drift", async () => {
    mocks.findMany.mockResolvedValue([
      failedEmail({
        htmlBody:
          '<a href="https://old-bookings.example.nz/bookings/bk_1">Open booking</a>',
        bookingDetailLinkIncluded: true,
      }),
    ]);

    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 0, succeeded: 0, failed: 0 });
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "email_1", status: "FAILED" }),
      data: expect.objectContaining({
        attempts: 3,
        htmlBody: null,
        errorMessage: expect.stringContaining("current application URL"),
      }),
    });
  });

  it("retires a legacy booking row whose recipient authority context is unknown", async () => {
    mocks.findMany.mockResolvedValue([
      failedEmail({
        bookingRecipientMemberId: null,
        bookingBodyOverrideApplied: null,
        bookingDetailLinkIncluded: null,
      }),
    ]);

    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 0, succeeded: 0, failed: 0 });
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "email_1", status: "FAILED" }),
      data: expect.objectContaining({
        attempts: 3,
        htmlBody: null,
        errorMessage: expect.stringContaining("recipient authorization context"),
      }),
    });
  });

  it("guards fail-closed retirement against a concurrent row claim", async () => {
    mocks.findMany.mockResolvedValue([
      failedEmail({
        bookingBodyOverrideApplied: null,
        bookingDetailLinkIncluded: null,
      }),
    ]);
    mocks.updateMany.mockResolvedValue({ count: 0 });

    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 0, succeeded: 0, failed: 0 });
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        id: "email_1",
        status: "FAILED",
        attempts: 0,
        htmlBody: "<p>hello</p>",
        bookingRetryHtmlBody: null,
      },
      data: expect.objectContaining({ attempts: 3, htmlBody: null }),
    });
  });

  // #2258 review finding: EmailLog.bookingId did not exist before the migration,
  // so EVERY row queued by the previous release is NULL — including booking
  // ones. Replaying those blind in the post-deploy window would send a
  // confirmation for a booking that has since been silenced.
  it("refuses to replay a NULL-bookingId row whose template is always booking-scoped", async () => {
    mocks.findMany.mockResolvedValue([
      failedEmail({ id: "email_1", bookingId: null, templateName: "booking-confirmed" }),
    ]);

    const result = await retryFailedEmails();

    expect(mocks.sendMail).not.toHaveBeenCalled();
    // Not claimed, so not counted as a retry attempt...
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ retried: 0, succeeded: 0, failed: 0 });
    // ...but RETIRED, not left as found: attempts goes to the max so the row
    // leaves this cron's selection window and enters the >=3 operator review
    // queue, with an errorMessage saying what to do about it.
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "email_1" },
      data: expect.objectContaining({
        attempts: 3,
        errorMessage: expect.stringContaining("No emails"),
      }),
    });
  });

  // The reason retiring matters, not just tidiness: the query is
  // status=FAILED + attempts<3 + retained body, ordered oldest-first, take 50.
  // Rows left below the threshold stay selectable forever, so a backlog of them
  // refills the same batch every run and retry dies for everything newer.
  it("does not let refused rows starve the queue: they leave the selection window", async () => {
    const stuck = Array.from({ length: 50 }, (_, i) =>
      failedEmail({ id: `stuck_${i}`, bookingId: null, templateName: "booking-confirmed" }),
    );
    mocks.findMany.mockResolvedValue(stuck);

    await retryFailedEmails();

    // Every one of them is retired in this single run, so the next run's batch
    // is free for newer mail rather than re-selecting these.
    expect(mocks.update).toHaveBeenCalledTimes(50);
    for (const call of mocks.update.mock.calls) {
      expect(call[0].data.attempts).toBe(3);
    }
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it("still replays NULL-bookingId account, membership and admin rows untouched", async () => {
    mocks.findMany.mockResolvedValue([
      failedEmail({ id: "e1", bookingId: null, templateName: "password-reset" }),
      failedEmail({ id: "e2", bookingId: null, templateName: "membership-approved" }),
      failedEmail({ id: "e3", bookingId: null, templateName: "admin-new-booking" }),
      // Genuinely pre-booking: a public request has no booking to silence.
      failedEmail({ id: "e4", bookingId: null, templateName: "booking-request-verification" }),
    ]);

    const result = await retryFailedEmails();

    expect(mocks.sendMail).toHaveBeenCalledTimes(4);
    expect(result.succeeded).toBe(4);
  });

  it("never consults the switch for a row with no booking, and never for an admin-audience template", async () => {
    mocks.findMany.mockResolvedValue([
      failedEmail({ id: "email_1", bookingId: null, templateName: "password-reset" }),
      failedEmail({
        id: "email_2",
        bookingId: "bk_1",
        templateName: "admin-new-booking",
      }),
    ]);
    mocks.bookingFindUnique.mockResolvedValue({ noEmails: true });

    const result = await retryFailedEmails();

    // Neither row reads the switch: the first has no bookingId, and the second
    // is short-circuited by its admin audience before the read. BOTH replay.
    expect(mocks.bookingFindUnique).not.toHaveBeenCalled();
    expect(mocks.sendMail).toHaveBeenCalledTimes(2);
    expect(result.succeeded).toBe(2);
  });
});

describe("retryFailedEmails and the environment-safety boundary (#3035)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveEmailDeliveryConfig.mockReturnValue({
      ok: true,
      mode: "smtp-relay",
      modeSource: "explicit-flag",
      modeLabel: "SMTP Relay",
      transportOptions: {
        host: "smtp.example.test",
        port: 587,
        secure: false,
        auth: { user: "relay-user", pass: "relay-pass" },
      },
      issues: [],
      warnings: [],
    });
    mocks.update.mockResolvedValue({});
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.getAdminEmails.mockResolvedValue([]);
    mocks.getActiveEmailSuppression.mockResolvedValue(null);
    mocks.bookingFindUnique.mockResolvedValue({ noEmails: false });
    mocks.findMany.mockResolvedValue([failedEmail()]);
  });

  it("replays nothing and touches no row on a confirmed copy, and does not treat it as a failure", async () => {
    /*
      A copy declining to replay the club's mail is the job WORKING, so it returns
      cleanly rather than throwing — a staging copy must not fill its cron history
      with red runs every thirty minutes.

      NO ROW IS TOUCHED, which is the part worth being careful about. A copy
      restored from the club's live database holds the live site's genuinely-failed
      rows; rewriting those as "held back by this copy" would lie about their
      history and inflate the withheld count the admin panel reads. It also means
      no attempt is burned, so nothing drifts towards the unretryable ceiling
      while the installation is a copy.
    */
    declareEnvironmentRole("non-production");

    await expect(retryFailedEmails()).resolves.toEqual({
      retried: 0,
      succeeded: 0,
      failed: 0,
    });
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it("throws on an unconfirmed environment, because that IS a fault", async () => {
    // Unlike a copy, an installation nobody has declared has stopped sending mail
    // its members may be waiting for. Something has to say so out loud, and the
    // job already throws for an unusable delivery configuration.
    vi.stubEnv("APP_ENVIRONMENT_ROLE", "");

    await expect(retryFailedEmails()).rejects.toThrow(
      /Email retry skipped: Not sent/,
    );
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it("never replays a row the boundary already held back terminally", async () => {
    /*
      Structural rather than incidental: the selection query filters
      `status: "FAILED"`, and the guarded claim re-asserts it before any send, so a
      SKIPPED_NON_PRODUCTION row is outside this job by construction. This test
      pins that, because the tempting future edit — widening the filter to a status
      list so "everything unsent" gets retried — would replay exactly the messages
      a copy deliberately withheld.
    */
    declareEnvironmentRole("production");
    await retryFailedEmails();

    const where = mocks.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("FAILED");
    const claim = mocks.updateMany.mock.calls[0][0];
    expect(claim.where.status).toBe("FAILED");
  });

  it("replays normally on the club's live site", async () => {
    declareEnvironmentRole("production");
    mocks.sendMail.mockResolvedValue({ messageId: "msg-1" });

    await expect(retryFailedEmails()).resolves.toEqual({
      retried: 1,
      succeeded: 1,
      failed: 0,
    });
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
  });
});

// --- #3035 review: the block reason has to DRAIN, or the count cries wolf -----
//
// `deliveryBlockReason` was written in one place (the mail gate) and cleared in
// NONE. So: the gate blocks an undeclared send and sets it; an operator declares
// the role; this cron claims the row, the provider rejects it, and the failure
// write left the stale block reason in place. `attempts` reaches 3, the row leaves
// this cron's query, and it stays counted for the life of the installation —
// `readWithheldApplicationEmail` selects exactly `FAILED` + a non-null reason.
// Admin -> Environment then tells a healthy live club it is holding mail back,
// which breaks owner decision 1: that count is the ONLY thing distinguishing a
// live club wrongly declared a copy from a genuine one, so it has to drain after
// the repair. The `SENT` path left it stale too.
//
// The lens that found this predicted that ADDING the fix would break no existing
// test, which is what "entirely unguarded" looks like. These are the tests.
describe("retryFailedEmails clears a stale environment block reason (#3035)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveEmailDeliveryConfig.mockReturnValue({
      ok: true,
      mode: "smtp-relay",
      modeSource: "explicit-flag",
      modeLabel: "SMTP Relay",
      transportOptions: {
        host: "smtp.example.test",
        port: 587,
        secure: false,
        auth: { user: "relay-user", pass: "relay-pass" },
      },
      issues: [],
      warnings: [],
    });
    mocks.update.mockResolvedValue({});
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.getAdminEmails.mockResolvedValue([]);
    mocks.getActiveEmailSuppression.mockResolvedValue(null);
    mocks.bookingFindUnique.mockResolvedValue({ noEmails: false });
    // A row the environment gate failed earlier, now being replayed after the
    // operator declared the role.
    mocks.findMany.mockResolvedValue([
      failedEmail({ deliveryBlockReason: "ENVIRONMENT_DECLARATION_MISSING" }),
    ]);
    declareEnvironmentRole("production");
  });

  /** The last write this cron made to the row. */
  function lastWrite() {
    return mocks.update.mock.calls.at(-1)?.[0] as {
      data: Record<string, unknown>;
    };
  }

  it("clears it when the replay succeeds", async () => {
    mocks.sendMail.mockResolvedValue({ messageId: "msg-1" });

    await retryFailedEmails();

    expect(lastWrite().data.status).toBe("SENT");
    expect(lastWrite().data.deliveryBlockReason).toBeNull();
  });

  it("clears it when the replay hits a GENUINE transport failure", async () => {
    /*
      The important half. This row is now failing for a provider reason and its
      `errorMessage` says so, so keeping the environment block reason would make a
      transport failure indistinguishable from a safety block by anything except a
      message string — exactly what INV-CONFIG-004 and the column's own contract in
      schema.prisma ("NULL for … a genuine transport failure") forbid.
    */
    mocks.sendMail.mockRejectedValue(new Error("SES said no"));

    await retryFailedEmails();

    expect(lastWrite().data.status).toBe("FAILED");
    expect(lastWrite().data.errorMessage).toContain("SES said no");
    expect(lastWrite().data.deliveryBlockReason).toBeNull();
  });

  it("clears it when the recipient turns out to be suppressed", async () => {
    mocks.getActiveEmailSuppression.mockResolvedValue({
      id: "sup_1",
      reason: "BOUNCE",
    });

    await retryFailedEmails();

    expect(lastWrite().data.status).toBe("BOUNCED");
    expect(lastWrite().data.deliveryBlockReason).toBeNull();
  });

  it("clears it when the booking's No emails switch has since been turned on", async () => {
    mocks.bookingFindUnique.mockResolvedValue({ noEmails: true });

    await retryFailedEmails();

    expect(lastWrite().data.status).toBe("SKIPPED_NO_EMAILS");
    // A business withhold must never be counted as an environment-safety one:
    // that is the exact conflation INV-CONFIG-004 forbids.
    expect(lastWrite().data.deliveryBlockReason).toBeNull();
  });
});
