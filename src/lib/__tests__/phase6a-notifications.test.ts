import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAppBaseUrl } from "../app-url";
// New resolution (C6 #1985): the outbound "from" is built from the DB-first
// email settings default from-name and the bootstrap envelope sender, not the
// severed club-identity constants. In this config the settings default equals
// EMAIL_DEFAULT_FROM_NAME and the envelope equals EMAIL_FROM.
import { EMAIL_FROM } from "@/lib/email-sender";
import { EMAIL_DEFAULT_FROM_NAME } from "@/lib/email-message-settings";
import { declareEnvironmentRole } from "@/lib/__tests__/helpers/environment-role";

// Use vi.hoisted so the mock objects are available at hoist time
const { mockPrisma, mockTransporter, mockLogger } = vi.hoisted(() => {
  const mockTransporter = {
    sendMail: vi.fn().mockResolvedValue({ messageId: "msg-123" }),
  };
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const mockPrisma = {
    environmentSafetySettings: { findUnique: vi.fn().mockResolvedValue(null) },
    emailLog: {
      create: vi.fn().mockResolvedValue({ id: "log-1" }),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    emailSuppression: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
    member: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    booking: {
      findMany: vi.fn().mockResolvedValue([]),
      // #2258: the mailer reads the booking's "No emails" switch before every
      // booking-scoped send. A null booking is the documented
      // "nothing to suppress" case, so behaviour here is unchanged.
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    // #1285: the check-in reminder path now consults the member's
    // bookingReminder preference; null defaults to "send".
    notificationPreference: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  };
  return { mockPrisma, mockTransporter, mockLogger };
});

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => mockTransporter,
  },
}));

vi.mock("@/lib/logger", () => ({
  default: mockLogger,
}));

/**
 * #2548: admin alert audiences are resolved from the access-role permission
 * matrix, not the legacy `Member.role` scalar, so a candidate row has to carry
 * the access-role assignments the resolver selects. These fixtures are Full
 * Admins, which is who these tests have always been about.
 */
function adminRecipient(
  email: string,
  notificationPreference: Record<string, boolean> | null = null,
) {
  return {
    email,
    canLogin: true,
    accessRoles: [
      { role: "ADMIN", roleDefinitionId: null, roleDefinition: null },
    ],
    notificationPreference,
  };
}

// ============================================================================
// N-10: EmailLog tracking in sendEmail
// ============================================================================

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

describe("N-10: EmailLog tracking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset module cache so sendEmail gets fresh mocks
    vi.resetModules();
    mockPrisma.emailLog.create.mockResolvedValue({ id: "log-1" });
    mockPrisma.emailLog.update.mockResolvedValue({});
    mockPrisma.emailLog.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.emailSuppression.findFirst.mockResolvedValue(null);
    mockPrisma.emailSuppression.findUnique.mockResolvedValue(null);
    mockPrisma.emailSuppression.create.mockResolvedValue({});
    mockPrisma.emailSuppression.update.mockResolvedValue({});
    mockPrisma.member.findUnique.mockResolvedValue(null);
    mockPrisma.booking.findUnique.mockResolvedValue(null);
    mockTransporter.sendMail.mockResolvedValue({ messageId: "msg-123" });
  });

  it("creates an EmailLog record with QUEUED status before sending", async () => {
    // Force non-dev mode for this test
    const origEnv = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV ="production";

    const { sendEmail } = await import("../email");

    await sendEmail({
      bookingContext: "none",
      to: "test@example.com",
      subject: "Test",
      html: "<p>Test</p>",
      templateName: "test-template",
    });

    expect(mockPrisma.emailLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        to: "test@example.com",
        subject: "Test",
        templateName: "test-template",
        htmlBody: "<p>Test</p>",
        status: "QUEUED",
      }),
    });

    (process.env as Record<string, string>).NODE_ENV =origEnv;
  });

  it("redacts stored HTML for token-bearing templates", async () => {
    const origEnv = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";

    const { sendEmail } = await import("../email");

    await sendEmail({
      bookingContext: "none",
      to: "test@example.com",
      subject: "Reset your password",
      html: '<a href="https://example.org/reset-password?token=live-secret">Reset</a>',
      templateName: "password-reset",
    });

    expect(mockPrisma.emailLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        templateName: "password-reset",
        htmlBody: null,
      }),
    });

    (process.env as Record<string, string>).NODE_ENV = origEnv;
  });

  it.each([
    "booking-request-quote",
    "school-attendee-confirmation",
    "group-booking-join-verification",
    "chore-roster",
  ])(
    "redacts %s HTML at rest without changing SMTP delivery",
    async (templateName) => {
      const origEnv = process.env.NODE_ENV;
      (process.env as Record<string, string>).NODE_ENV = "production";
      const html = `<a href="https://example.org/action/live-secret">Act</a>`;

      try {
        const { sendEmail } = await import("../email");

        await sendEmail({
          bookingContext: "none",
          to: "test@example.com",
          subject: "Complete your action",
          html,
          templateName,
        });

        expect(mockPrisma.emailLog.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            templateName,
            htmlBody: null,
          }),
        });
        expect(mockTransporter.sendMail).toHaveBeenCalledWith(
          expect.objectContaining({ html }),
        );
      } finally {
        (process.env as Record<string, string>).NODE_ENV = origEnv;
      }
    },
  );

  it("uses a redacted EmailLog recipient without changing SMTP delivery", async () => {
    const origEnv = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";

    const { sendEmail } = await import("../email");

    await sendEmail({
      bookingContext: "none",
      to: "private-committee@example.com",
      subject: "Website Contact",
      html: "<p>Contact message</p>",
      templateName: "website-contact",
      logRecipient: "committee-contact:assignment-1",
    });

    expect(mockPrisma.emailLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        to: "committee-contact:assignment-1",
        templateName: "website-contact",
        htmlBody: null,
      }),
    });
    expect(mockTransporter.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "private-committee@example.com",
      }),
    );
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "committee-contact:assignment-1",
      }),
      "Email delivered",
    );

    (process.env as Record<string, string>).NODE_ENV = origEnv;
  });

  it("redacts sensitive email HTML from dev logs", async () => {
    const origEnv = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "development";

    const { sendEmail } = await import("../email");

    await sendEmail({
      bookingContext: "none",
      to: "test@example.com",
      subject: "Reset your password",
      html: '<a href="https://example.org/reset-password?token=live-secret">Reset</a>',
      templateName: "password-reset",
    });

    expect(mockLogger.debug).toHaveBeenCalledWith(
      { templateName: "password-reset" },
      "Email HTML content redacted for sensitive template"
    );
    expect(mockLogger.debug).not.toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining("live-secret"),
      }),
      "Email HTML content"
    );

    (process.env as Record<string, string>).NODE_ENV = origEnv;
  });

  it("updates EmailLog to SENT on success", async () => {
    const origEnv = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV ="production";

    const { sendEmail } = await import("../email");

    await sendEmail({
      bookingContext: "none",
      to: "test@example.com",
      subject: "Test",
      html: "<p>Test</p>",
      templateName: "test-template",
    });

    expect(mockPrisma.emailLog.update).toHaveBeenCalledWith({
      where: { id: "log-1" },
      data: expect.objectContaining({
        status: "SENT",
        messageId: "msg-123",
      }),
    });
    expect(mockTransporter.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: `"${EMAIL_DEFAULT_FROM_NAME}" <${EMAIL_FROM}>`,
      })
    );

    (process.env as Record<string, string>).NODE_ENV =origEnv;
  });

  it("does not fail delivery if EmailLog SENT update fails", async () => {
    const origEnv = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV ="production";

    mockPrisma.emailLog.update.mockRejectedValueOnce(new Error("EmailLog update failed"));

    const { sendEmail } = await import("../email");

    await expect(
      sendEmail({
        bookingContext: "none",
        to: "test@example.com",
        subject: "Test",
        html: "<p>Test</p>",
        templateName: "test-template",
      })
    ).resolves.toMatchObject({
      status: "sent",
      emailLogId: "log-1",
      messageId: "msg-123",
    });

    expect(mockTransporter.sendMail).toHaveBeenCalled();

    (process.env as Record<string, string>).NODE_ENV =origEnv;
  });

  it("updates EmailLog to FAILED on send error", async () => {
    const origEnv = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV ="production";

    mockTransporter.sendMail.mockRejectedValue(new Error("SMTP connection refused"));

    const { sendEmail } = await import("../email");

    await expect(
      sendEmail({
        bookingContext: "none",
        to: "test@example.com",
        subject: "Test",
        html: "<p>Test</p>",
        templateName: "test-template",
      })
    ).rejects.toThrow("SMTP connection refused");

    expect(mockPrisma.emailLog.update).toHaveBeenCalledWith({
      where: { id: "log-1" },
      data: expect.objectContaining({
        status: "FAILED",
        errorMessage: "SMTP connection refused",
      }),
    });

    (process.env as Record<string, string>).NODE_ENV =origEnv;
  });

  it("skips SMTP delivery for actively suppressed recipients", async () => {
    const origEnv = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    mockPrisma.emailSuppression.findFirst.mockResolvedValue({
      id: "sup-1",
      email: "test@example.com",
      reason: "COMPLAINT",
      eventCount: 1,
      suppressedAt: new Date(),
      lastEventAt: new Date(),
      lastEventType: "complaint",
      lastBounceType: null,
      lastBounceSubType: null,
      lastComplaintFeedbackType: "abuse",
      lastSesMessageId: "ses-message-1",
    });

    const { sendEmail } = await import("../email");

    await sendEmail({
      bookingContext: "none",
      to: "Test@Example.com",
      subject: "Test",
      html: "<p>Test</p>",
      templateName: "test-template",
    });

    expect(mockTransporter.sendMail).not.toHaveBeenCalled();
    expect(mockPrisma.emailLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        to: "Test@Example.com",
        status: "QUEUED",
      }),
    });
    expect(mockPrisma.emailLog.update).toHaveBeenCalledWith({
      where: { id: "log-1" },
      data: expect.objectContaining({
        status: "BOUNCED",
        htmlBody: null,
        errorMessage: expect.stringContaining("suppressed"),
      }),
    });

    (process.env as Record<string, string>).NODE_ENV = origEnv;
  });

  it("records SES complaint feedback as durable recipient suppression", async () => {
    mockPrisma.emailSuppression.create.mockResolvedValue({
      id: "sup-1",
      email: "member@example.com",
    });

    const { ingestSesSnsEmailFeedback } = await import("../email");
    const result = await ingestSesSnsEmailFeedback({
      notificationType: "Complaint",
      mail: { messageId: "ses-message-1", destination: ["member@example.com"] },
      complaint: {
        complaintFeedbackType: "abuse",
        complainedRecipients: [{ emailAddress: "Member@Example.com" }],
      },
    });

    expect(result).toMatchObject({
      handled: true,
      notificationType: "complaint",
      recipients: ["member@example.com"],
      suppressionsProcessed: 1,
    });
    expect(mockPrisma.emailLog.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        to: { in: ["Member@Example.com", "member@example.com"] },
      }),
      data: expect.objectContaining({ status: "BOUNCED" }),
    });
    expect(mockPrisma.emailSuppression.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: "member@example.com",
        reason: "COMPLAINT",
        suppressedAt: expect.any(Date),
        lastComplaintFeedbackType: "abuse",
      }),
    });
  });

  it("preserves the original send error if EmailLog FAILED update also fails", async () => {
    const origEnv = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV ="production";

    mockTransporter.sendMail.mockRejectedValueOnce(new Error("SMTP connection refused"));
    mockPrisma.emailLog.update.mockRejectedValueOnce(new Error("EmailLog update failed"));

    const { sendEmail } = await import("../email");

    await expect(
      sendEmail({
        bookingContext: "none",
        to: "test@example.com",
        subject: "Test",
        html: "<p>Test</p>",
        templateName: "test-template",
      })
    ).rejects.toThrow("SMTP connection refused");

    expect(mockPrisma.emailLog.update).toHaveBeenCalledWith({
      where: { id: "log-1" },
      data: expect.objectContaining({
        status: "FAILED",
        errorMessage: "SMTP connection refused",
      }),
    });

    (process.env as Record<string, string>).NODE_ENV =origEnv;
  });

  it("does not break email delivery if EmailLog create fails", async () => {
    const origEnv = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV ="production";

    mockPrisma.emailLog.create.mockRejectedValue(new Error("DB down"));

    const { sendEmail } = await import("../email");

    // Should not throw even though logging failed
    await sendEmail({
      bookingContext: "none",
      to: "test@example.com",
      subject: "Test",
      html: "<p>Test</p>",
      templateName: "test-template",
    });

    expect(mockTransporter.sendMail).toHaveBeenCalled();

    (process.env as Record<string, string>).NODE_ENV =origEnv;
  });

  it("defaults templateName to 'unknown'", async () => {
    const origEnv = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV ="production";

    const { sendEmail } = await import("../email");

    await sendEmail({
      bookingContext: "none",
      to: "test@example.com",
      subject: "Test",
      html: "<p>Test</p>",
    });

    expect(mockPrisma.emailLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        templateName: "unknown",
      }),
    });

    (process.env as Record<string, string>).NODE_ENV =origEnv;
  });

  it("includes a plain-text alternative for member emails", async () => {
    const origEnv = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";

    const { sendBookingPendingEmail } = await import("../email");

    mockPrisma.booking.findUnique.mockImplementation(
      async (args: { select?: { noEmails?: boolean } }) =>
        args.select?.noEmails
          ? { noEmails: false }
          : { memberId: "member_1", deletedAt: null, guests: [] },
    );
    mockPrisma.member.findUnique.mockResolvedValue({
      email: "member@example.com",
      inheritEmailFromId: null,
      inheritEmailFrom: null,
      role: "USER",
      financeAccessLevel: "NONE",
      active: true,
      archivedAt: null,
      canLogin: true,
      accessRoles: [],
    });

    await sendBookingPendingEmail(
      { bookingId: "bk_test", recipientMemberId: "member_1" },
      "member@example.com",
      "Casey",
      new Date("2026-07-15"),
      new Date("2026-07-18"),
      2,
      new Date("2026-07-08T00:30:00Z")
    );

    expect(mockTransporter.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          `View Booking: ${getAppBaseUrl()}/bookings`
        ),
      })
    );

    (process.env as Record<string, string>).NODE_ENV = origEnv;
  });

  it("includes a plain-text alternative for admin issue report alerts", async () => {
    const origEnv = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    mockPrisma.member.findMany.mockResolvedValue([
      adminRecipient("support@example.org"),
    ]);

    const { sendAdminIssueReportAlert } = await import("../email");
    const appBaseUrl = getAppBaseUrl();

    await sendAdminIssueReportAlert({
      memberName: "Casey Member",
      memberEmail: "casey@example.com",
      pageUrl: `${appBaseUrl}/book`,
      pageTitle: "Book | TAC Bookings",
      description: "Line 1\nLine 2",
      issueReportUrl: `${appBaseUrl}/admin/issue-reports?report=issue-1`,
      hasScreenshot: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockTransporter.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          `Review Issue Report: ${appBaseUrl}/admin/issue-reports?report=issue-1`
        ),
      })
    );

    (process.env as Record<string, string>).NODE_ENV = origEnv;
  });
});

// ============================================================================
// N-02: Admin alert helper
// ============================================================================

describe("N-02: getAdminEmails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("queries active admin members", async () => {
    mockPrisma.member.findMany.mockResolvedValue([
      adminRecipient("admin1@tac.org.nz"),
      adminRecipient("admin2@tac.org.nz"),
    ]);

    const { getAdminEmails } = await import("../email");
    const emails = await getAdminEmails();

    expect(emails).toEqual(["admin1@tac.org.nz", "admin2@tac.org.nz"]);
    // #2548: candidates are active, login-capable access-role holders, then
    // filtered through the permission matrix (Support & System editors here).
    // The legacy `role: "ADMIN"` scalar is no longer consulted.
    expect(mockPrisma.member.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ active: true, canLogin: true }),
      select: expect.objectContaining({ email: true, canLogin: true }),
    });
  });
});

describe("N-02: sendAdminNewBookingAlert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockPrisma.member.findMany.mockResolvedValue([
      adminRecipient("support@example.org"),
    ]);
    mockPrisma.emailLog.create.mockResolvedValue({ id: "log-1" });
    mockPrisma.emailLog.update.mockResolvedValue({});
    mockPrisma.emailSuppression.findFirst.mockResolvedValue(null);
    mockPrisma.auditLog.create.mockResolvedValue({});
    mockTransporter.sendMail.mockResolvedValue({ messageId: "msg-123" });
  });

  it("sends email to all admins with booking details", async () => {
    const { sendAdminNewBookingAlert } = await import("../email");
    await sendAdminNewBookingAlert({
      memberName: "John Doe",
      checkIn: new Date("2026-04-10"),
      checkOut: new Date("2026-04-12"),
      guestCount: 3,
      totalCents: 45000,
      status: "CONFIRMED",
    });

    expect(mockPrisma.emailLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        to: "support@example.org",
        templateName: "admin-new-booking",
      }),
    });
  });

  it("skips admins who disable new booking alerts", async () => {
    mockPrisma.member.findMany.mockResolvedValue([
      adminRecipient("enabled@example.org", { adminNewBooking: true }),
      adminRecipient("disabled@example.org", { adminNewBooking: false }),
      adminRecipient("default@example.org"),
    ]);

    const { sendAdminNewBookingAlert } = await import("../email");
    await sendAdminNewBookingAlert({
      memberName: "John Doe",
      checkIn: new Date("2026-04-10"),
      checkOut: new Date("2026-04-12"),
      guestCount: 3,
      totalCents: 45000,
      status: "CONFIRMED",
    });

    const recipients = mockPrisma.emailLog.create.mock.calls.map(
      (call) => call[0].data.to
    );

    expect(recipients).toContain("enabled@example.org");
    expect(recipients).toContain("default@example.org");
    expect(recipients).not.toContain("disabled@example.org");
  });

  it("records a critical audit escalation when no admin alert recipient receives the alert", async () => {
    mockPrisma.member.findMany.mockResolvedValue([
      adminRecipient("suppressed@example.org"),
      adminRecipient("failed@example.org"),
    ]);
    mockPrisma.emailSuppression.findFirst.mockImplementation(async (args) => {
      const email = (args as { where: { email: string } }).where.email;
      if (email !== "suppressed@example.org") {
        return null;
      }

      return {
        id: "suppression-1",
        email,
        reason: "BOUNCE",
        eventCount: 1,
        suppressedAt: new Date("2026-06-21T00:00:00.000Z"),
        lastEventAt: new Date("2026-06-21T00:00:00.000Z"),
        lastEventType: "bounce",
        lastBounceType: "Permanent",
        lastBounceSubType: "General",
        lastComplaintFeedbackType: null,
        lastSesMessageId: "ses-1",
      };
    });
    mockTransporter.sendMail.mockRejectedValueOnce(new Error("SMTP down"));

    const { sendAdminNewBookingAlert } = await import("../email");
    await sendAdminNewBookingAlert({
      memberName: "John Doe",
      checkIn: new Date("2026-04-10"),
      checkOut: new Date("2026-04-12"),
      guestCount: 3,
      totalCents: 45000,
      status: "CONFIRMED",
    });

    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "email.admin-alert-undeliverable",
        category: "communication",
        severity: "critical",
        outcome: "failure",
        summary: "Admin alert delivery failed for admin-new-booking",
        metadata: expect.objectContaining({
          templateName: "admin-new-booking",
          preferenceKey: "adminNewBooking",
          attemptedRecipientCount: 2,
          suppressedRecipientCount: 1,
          failedRecipientCount: 1,
        }),
      }),
    });
  });
});

describe("F20 / #1377: sendAdminOwnerSubstitutionAlert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockPrisma.member.findMany.mockResolvedValue([
      adminRecipient("finance@example.org"),
    ]);
    mockPrisma.emailLog.create.mockResolvedValue({ id: "log-1" });
    mockPrisma.emailLog.update.mockResolvedValue({});
    mockPrisma.emailSuppression.findFirst.mockResolvedValue(null);
    mockPrisma.auditLog.create.mockResolvedValue({});
    mockTransporter.sendMail.mockResolvedValue({ messageId: "msg-123" });
  });

  const ownerSubstitutionData = {
    requestId: "req-xyz",
    bookingId: "bk-123",
    intendedMemberId: "intended-1",
    intendedMemberName: "Alpine Org",
    substituteMemberId: "fresh-9",
    substituteMemberName: "Casey Requester",
    reason: "held owner is now login-capable",
    requesterName: "Casey Requester",
    requesterEmail: "casey@example.com",
    checkIn: new Date("2026-08-01"),
    checkOut: new Date("2026-08-03"),
  };

  it("sends with the admin-owner-substitution template and renders the reconciliation facts", async () => {
    const origEnv = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";

    const { sendAdminOwnerSubstitutionAlert } = await import("../email");
    await sendAdminOwnerSubstitutionAlert(ownerSubstitutionData);

    expect(mockPrisma.emailLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        to: "finance@example.org",
        templateName: "admin-owner-substitution",
      }),
    });
    const sentHtml = mockTransporter.sendMail.mock.calls[0][0].html as string;
    expect(sentHtml).toContain("Owner Substitution");
    expect(sentHtml).toContain("reconcile the invoice");
    expect(sentHtml).toContain("req-xyz");
    expect(sentHtml).toContain("bk-123");
    expect(sentHtml).toContain("intended-1");
    expect(sentHtml).toContain("fresh-9");

    (process.env as Record<string, string>).NODE_ENV = origEnv;
  });

  it("is gated by the Xero-sync-error admin preference", async () => {
    mockPrisma.member.findMany.mockResolvedValue([
      adminRecipient("enabled@example.org", { adminXeroSyncError: true }),
      adminRecipient("disabled@example.org", { adminXeroSyncError: false }),
      adminRecipient("default@example.org"),
    ]);

    const { sendAdminOwnerSubstitutionAlert } = await import("../email");
    await sendAdminOwnerSubstitutionAlert(ownerSubstitutionData);

    const recipients = mockPrisma.emailLog.create.mock.calls.map(
      (call) => call[0].data.to
    );

    expect(recipients).toContain("enabled@example.org");
    expect(recipients).toContain("default@example.org");
    expect(recipients).not.toContain("disabled@example.org");
  });
});

describe("Admin member request alerts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockPrisma.emailLog.create.mockResolvedValue({ id: "log-1" });
    mockPrisma.emailLog.update.mockResolvedValue({});
  });

  it("respects the shared member request preference for membership application alerts", async () => {
    mockPrisma.member.findMany.mockResolvedValue([
      adminRecipient("enabled@example.org", { adminFamilyGroupRequest: true }),
      adminRecipient("disabled@example.org", { adminFamilyGroupRequest: false }),
      adminRecipient("default@example.org"),
    ]);

    const { sendAdminMembershipApplicationPendingEmail } = await import("../email");
    await sendAdminMembershipApplicationPendingEmail({
      applicationId: "app-1",
      applicantName: "Jane Doe",
      applicantEmail: "jane@example.com",
      familyMemberCount: 1,
    });

    const recipients = mockPrisma.emailLog.create.mock.calls.map(
      (call) => call[0].data.to
    );

    expect(recipients).toContain("enabled@example.org");
    expect(recipients).toContain("default@example.org");
    expect(recipients).not.toContain("disabled@example.org");
  });
});

// ============================================================================
// N-01: Check-in reminders cron
// ============================================================================

describe("N-01: sendCheckinReminders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockPrisma.emailLog.findFirst.mockResolvedValue(null);
    mockPrisma.emailLog.create.mockResolvedValue({ id: "log-1" });
    mockPrisma.emailLog.update.mockResolvedValue({});
  });

  it("sends reminders for confirmed bookings checking in tomorrow", async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);

    mockPrisma.booking.findMany.mockResolvedValue([
      {
        id: "booking-1",
        status: "CONFIRMED",
        checkIn: tomorrow,
        checkOut: new Date(tomorrow.getTime() + 2 * 86400000),
        member: { id: "member-1", email: "member@test.com", firstName: "Jane" },
        guests: [
          { firstName: "Jane", lastName: "Doe" },
          { firstName: "Bob", lastName: "Smith" },
        ],
        choreAssignments: [],
      },
    ]);

    const { sendCheckinReminders } = await import("../cron-checkin-reminders");
    const result = await sendCheckinReminders();

    expect(result.sent).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("skips bookings where reminder already sent", async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);

    mockPrisma.booking.findMany.mockResolvedValue([
      {
        id: "booking-1",
        status: "CONFIRMED",
        checkIn: tomorrow,
        checkOut: new Date(tomorrow.getTime() + 2 * 86400000),
        member: { id: "member-1", email: "member@test.com", firstName: "Jane" },
        guests: [{ firstName: "Jane", lastName: "Doe" }],
        choreAssignments: [],
      },
    ]);

    // Simulate already-sent reminder
    mockPrisma.emailLog.findFirst.mockResolvedValue({ id: "existing-log" });

    const { sendCheckinReminders } = await import("../cron-checkin-reminders");
    const result = await sendCheckinReminders();

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("returns zeros when no bookings check in tomorrow", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([]);

    const { sendCheckinReminders } = await import("../cron-checkin-reminders");
    const result = await sendCheckinReminders();

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("#1422: excludes bookings blocked by a pending admin review", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([]);

    const { sendCheckinReminders } = await import("../cron-checkin-reminders");
    await sendCheckinReminders();

    // A blocked booking can't check in until an admin clears the review, so the
    // reminder query carries the shared positive eligibility fragment, so
    // rejected and malformed unresolved review states stay blocked too.
    expect(mockPrisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { requiresAdminReview: false },
            { adminReviewStatus: "APPROVED" },
          ],
        }),
      }),
    );
  });
});

// ============================================================================
// N-04: Admin payment failure alert
// ============================================================================

describe("N-04: sendAdminPaymentFailureAlert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockPrisma.member.findMany.mockResolvedValue([
      adminRecipient("support@example.org"),
    ]);
    mockPrisma.emailLog.create.mockResolvedValue({ id: "log-1" });
    mockPrisma.emailLog.update.mockResolvedValue({});
  });

  it("sends payment failure alert to admins", async () => {
    const { sendAdminPaymentFailureAlert } = await import("../email");
    await sendAdminPaymentFailureAlert({
      memberName: "John Doe",
      checkIn: new Date("2026-04-10"),
      checkOut: new Date("2026-04-12"),
      amountCents: 15000,
      errorMessage: "Card declined",
      paymentIntentId: "pi_test123",
    });

    expect(mockPrisma.emailLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        templateName: "admin-payment-failure",
      }),
    });
  });
});

// ============================================================================
// N-06: Pending deadline alerts cron
// ============================================================================

describe("N-06: checkPendingDeadlines", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockPrisma.member.findMany.mockResolvedValue([
      adminRecipient("support@example.org"),
    ]);
    mockPrisma.emailLog.create.mockResolvedValue({ id: "log-1" });
    mockPrisma.emailLog.update.mockResolvedValue({});
  });

  it("sends digest alert when pending bookings approach deadline", async () => {
    const in24Hours = new Date(Date.now() + 24 * 60 * 60 * 1000);

    mockPrisma.booking.findMany.mockResolvedValue([
      {
        id: "booking-1",
        status: "PENDING",
        checkIn: new Date("2026-04-15"),
        checkOut: new Date("2026-04-17"),
        nonMemberHoldUntil: in24Hours,
        member: { firstName: "Jane", lastName: "Doe" },
        guests: [{ firstName: "Jane", lastName: "Doe" }],
      },
    ]);

    const { checkPendingDeadlines } = await import("../cron-pending-deadline-alerts");
    const result = await checkPendingDeadlines();

    expect(result.alertedCount).toBe(1);
    expect(mockPrisma.emailLog.create).toHaveBeenCalled();
  });

  it("does not send alert when no bookings approaching deadline", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([]);

    const { checkPendingDeadlines } = await import("../cron-pending-deadline-alerts");
    const result = await checkPendingDeadlines();

    expect(result.alertedCount).toBe(0);
    expect(mockPrisma.emailLog.create).not.toHaveBeenCalled();
  });
});

// ============================================================================
// N-07: Admin booking bumped alert
// ============================================================================

describe("N-07: sendAdminBookingBumpedAlert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockPrisma.member.findMany.mockResolvedValue([
      adminRecipient("support@example.org"),
    ]);
    mockPrisma.emailLog.create.mockResolvedValue({ id: "log-1" });
    mockPrisma.emailLog.update.mockResolvedValue({});
  });

  it("sends bumped alert to admins with triggering member", async () => {
    const { sendAdminBookingBumpedAlert } = await import("../email");
    await sendAdminBookingBumpedAlert({
      bumpedMemberName: "Jane Doe",
      checkIn: new Date("2026-04-10"),
      checkOut: new Date("2026-04-12"),
      guestCount: 2,
      triggeringMemberName: "John Smith",
    });

    expect(mockPrisma.emailLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        templateName: "admin-booking-bumped",
      }),
    });
  });
});

// ============================================================================
// Email template tests
// ============================================================================

describe("Email templates - Phase 6a", () => {
  it("checkinReminderTemplate escapes HTML in user values", async () => {
    const { checkinReminderTemplate } = await import("@/lib/email-templates/booking-reminders");
    const html = checkinReminderTemplate(
      "<script>alert('xss')</script>",
      new Date("2026-04-10"),
      new Date("2026-04-12"),
      [{ firstName: "<b>Evil</b>", lastName: "User" }],
      []
    );

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;Evil&lt;/b&gt;");
  });

  it("adminNewBookingTemplate escapes member name", async () => {
    const { adminNewBookingTemplate } = await import("@/lib/email-templates/admin-booking");
    const html = adminNewBookingTemplate({
      memberName: '<img src=x onerror="alert(1)">',
      checkIn: new Date("2026-04-10"),
      checkOut: new Date("2026-04-12"),
      guestCount: 2,
      totalCents: 15000,
      status: "CONFIRMED",
    });

    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).toContain("&lt;img");
  });

  it("adminPaymentFailureTemplate labels its identifier slot 'Reference', not 'Stripe PI'", async () => {
    // #2262 delta LOW-f. This is the club's general payment-anomaly alert and
    // its senders pass a Xero invoice id, or a booking id (the cash / off-Xero
    // mark-paid has neither a Stripe intent nor an invoice by definition), as
    // well as Stripe intents. A label naming the wrong system sends an officer
    // hunting in Stripe for something that was never there.
    const { adminPaymentFailureTemplate } = await import("@/lib/email-templates/admin-finance");
    const html = adminPaymentFailureTemplate({
      memberName: "John Doe",
      checkIn: new Date("2026-04-10"),
      checkOut: new Date("2026-04-12"),
      amountCents: 15000,
      errorMessage: "Stored credit election cleared",
      paymentIntentId: "booking-1",
    });

    expect(html).toContain("Reference");
    expect(html).not.toContain("Stripe PI");
    expect(html).toContain("booking-1");
  });

  it("adminPaymentFailureTemplate includes stripe PI ID", async () => {
    const { adminPaymentFailureTemplate } = await import("@/lib/email-templates/admin-finance");
    const html = adminPaymentFailureTemplate({
      memberName: "John Doe",
      checkIn: new Date("2026-04-10"),
      checkOut: new Date("2026-04-12"),
      amountCents: 15000,
      errorMessage: "Card declined",
      paymentIntentId: "pi_test123",
    });

    expect(html).toContain("pi_test123");
    expect(html).toContain("Card declined");
  });

  it("adminPendingDeadlineTemplate renders booking table", async () => {
    const { adminPendingDeadlineTemplate } = await import("@/lib/email-templates/admin-booking");
    const html = adminPendingDeadlineTemplate([
      {
        memberName: "Jane Doe",
        checkIn: new Date("2026-04-15"),
        checkOut: new Date("2026-04-17"),
        guestCount: 3,
        deadline: new Date("2026-04-14"),
        hoursRemaining: 20,
      },
    ]);

    expect(html).toContain("Jane Doe");
    expect(html).toContain("20h");
  });

  it("adminBookingBumpedTemplate shows triggering member", async () => {
    const { adminBookingBumpedTemplate } = await import("@/lib/email-templates/admin-booking");
    const html = adminBookingBumpedTemplate({
      bumpedMemberName: "Jane Doe",
      checkIn: new Date("2026-04-10"),
      checkOut: new Date("2026-04-12"),
      guestCount: 2,
      triggeringMemberName: "John Smith",
    });

    expect(html).toContain("Jane Doe");
    expect(html).toContain("John Smith");
    expect(html).toContain("Triggered By");
  });
});
