import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted so the mock objects are available at hoist time
const { mockPrisma, mockTransporter } = vi.hoisted(() => {
  const mockTransporter = {
    sendMail: vi.fn().mockResolvedValue({ messageId: "msg-456" }),
  };
  const mockPrisma = {
    emailLog: {
      create: vi.fn().mockResolvedValue({ id: "log-1" }),
      update: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    emailSuppression: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    member: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    booking: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    notificationPreference: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({
        bookingConfirmation: true,
        bookingReminder: true,
        bookingBumped: true,
        bookingCancelled: true,
        choreRoster: true,
        marketingEmails: false,
      }),
      upsert: vi.fn().mockResolvedValue({
        bookingConfirmation: true,
        bookingReminder: true,
        bookingBumped: true,
        bookingCancelled: true,
        choreRoster: true,
        marketingEmails: false,
      }),
    },
  };
  return { mockPrisma, mockTransporter };
});

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => mockTransporter,
  },
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ============================================================================
// N-08: shouldSendEmail helper
// ============================================================================

describe("N-08: shouldSendEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("returns true when no preference record exists (defaults)", async () => {
    mockPrisma.notificationPreference.findUnique.mockResolvedValue(null);
    const { shouldSendEmail } = await import("../email");
    expect(await shouldSendEmail("member-1", "bookingConfirmation")).toBe(true);
  });

  it("returns false for marketingEmails when no preference record exists", async () => {
    mockPrisma.notificationPreference.findUnique.mockResolvedValue(null);
    const { shouldSendEmail } = await import("../email");
    expect(await shouldSendEmail("member-1", "marketingEmails")).toBe(false);
  });

  it("respects stored preference (false)", async () => {
    mockPrisma.notificationPreference.findUnique.mockResolvedValue({
      bookingConfirmation: false,
      bookingReminder: true,
      bookingBumped: true,
      bookingCancelled: true,
      choreRoster: true,
      marketingEmails: false,
    });
    const { shouldSendEmail } = await import("../email");
    expect(await shouldSendEmail("member-1", "bookingConfirmation")).toBe(false);
  });

  it("respects stored preference (true)", async () => {
    mockPrisma.notificationPreference.findUnique.mockResolvedValue({
      bookingConfirmation: true,
      bookingReminder: true,
      bookingBumped: true,
      bookingCancelled: true,
      choreRoster: true,
      marketingEmails: true,
    });
    const { shouldSendEmail } = await import("../email");
    expect(await shouldSendEmail("member-1", "marketingEmails")).toBe(true);
  });

  it("returns true for unknown categories", async () => {
    const { shouldSendEmail } = await import("../email");
    expect(await shouldSendEmail("member-1", "unknownCategory")).toBe(true);
  });
});

describe("sendEmail logging safeguards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("does not persist retry HTML for admin-email-failure alerts", async () => {
    const { sendEmail } = await import("../email");

    await sendEmail({
      to: "admin@example.com",
      subject: "Email delivery permanently failed",
      html: "<p>Alert body</p>",
      templateName: "admin-email-failure",
    });

    expect(mockPrisma.emailLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        templateName: "admin-email-failure",
        htmlBody: null,
      }),
    });
  });
});

// ============================================================================
// N-03: Capacity warnings cron
// ============================================================================

describe("N-03: checkCapacityWarnings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockPrisma.member.findMany.mockResolvedValue([{ email: "support@tokoroa.org.nz" }]);
    mockPrisma.emailLog.create.mockResolvedValue({ id: "log-1" });
    mockPrisma.emailLog.update.mockResolvedValue({});
  });

  it("alerts when days have <= 5 beds remaining", async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dayAfter = new Date(tomorrow);
    dayAfter.setDate(dayAfter.getDate() + 1);

    // Create a booking with 25 guests (only 4 beds remaining)
    mockPrisma.booking.findMany.mockResolvedValue([
      {
        id: "booking-1",
        checkIn: today,
        checkOut: dayAfter,
        status: "CONFIRMED",
        guests: Array.from({ length: 25 }, (_, i) => ({ id: `g-${i}` })),
      },
    ]);

    const { checkCapacityWarnings } = await import("../cron-capacity-warnings");
    const result = await checkCapacityWarnings();

    expect(result.alertedDays).toBeGreaterThan(0);
    expect(mockPrisma.emailLog.create).toHaveBeenCalled();
  });

  it("does not alert when all days have > 5 beds remaining", async () => {
    // No bookings = 29 beds available
    mockPrisma.booking.findMany.mockResolvedValue([]);

    const { checkCapacityWarnings } = await import("../cron-capacity-warnings");
    const result = await checkCapacityWarnings();

    expect(result.alertedDays).toBe(0);
    expect(mockPrisma.emailLog.create).not.toHaveBeenCalled();
  });
});

// ============================================================================
// N-05: Xero sync error alert
// ============================================================================

describe("N-05: notifyXeroSyncError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockPrisma.member.findMany.mockResolvedValue([{ email: "support@tokoroa.org.nz" }]);
    mockPrisma.emailLog.create.mockResolvedValue({ id: "log-1" });
    mockPrisma.emailLog.update.mockResolvedValue({});
    mockPrisma.emailLog.findFirst.mockResolvedValue(null);
  });

  it("sends alert on first error", async () => {
    const { notifyXeroSyncError } = await import("../xero-error-alert");
    await notifyXeroSyncError({
      errorType: "API Error",
      operation: "createInvoice",
      errorMessage: "Rate limit exceeded",
    });

    expect(mockPrisma.emailLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        templateName: "admin-xero-sync-error",
      }),
    });
  });

  it("suppresses duplicate alerts within 1 hour", async () => {
    mockPrisma.emailLog.findFirst.mockResolvedValue({
      id: "existing-alert",
      templateName: "admin-xero-sync-error",
    });

    const { notifyXeroSyncError } = await import("../xero-error-alert");
    await notifyXeroSyncError({
      errorType: "API Error",
      operation: "createInvoice",
      errorMessage: "Rate limit exceeded",
    });

    // Should not create a new email log (alert suppressed)
    expect(mockPrisma.emailLog.create).not.toHaveBeenCalled();
  });
});

// ============================================================================
// N-11: Email retry with backoff
// ============================================================================

describe("N-11: retryFailedEmails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("retries failed emails and marks them as SENT on success", async () => {
    mockPrisma.emailLog.findMany.mockResolvedValue([
      {
        id: "log-fail-1",
        to: "user@example.com",
        subject: "Test Subject",
        htmlBody: "<p>Test body</p>",
        attempts: 1,
        status: "FAILED",
      },
    ]);
    mockPrisma.emailLog.update.mockResolvedValue({});

    const { retryFailedEmails } = await import("../cron-email-retry");
    const result = await retryFailedEmails();

    expect(result.retried).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(mockPrisma.emailLog.update).toHaveBeenCalledWith({
      where: { id: "log-fail-1" },
      data: expect.objectContaining({
        status: "SENT",
        attempts: 2,
      }),
    });
    expect(mockTransporter.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '"Tokoroa Alpine Club - Online Booking System" <support@tokoroa.org.nz>',
      })
    );
  });

  it("increments attempt count on retry failure", async () => {
    mockPrisma.emailLog.findMany.mockResolvedValue([
      {
        id: "log-fail-2",
        to: "user@example.com",
        subject: "Test",
        htmlBody: "<p>Test</p>",
        attempts: 2,
        status: "FAILED",
      },
    ]);
    mockTransporter.sendMail.mockRejectedValueOnce(new Error("SMTP error"));
    mockPrisma.emailLog.update.mockResolvedValue({});

    const origEnv = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";

    const { retryFailedEmails } = await import("../cron-email-retry");
    const result = await retryFailedEmails();

    expect(result.retried).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(1);
    expect(mockPrisma.emailLog.update).toHaveBeenCalledWith({
      where: { id: "log-fail-2" },
      data: expect.objectContaining({
        attempts: 3,
        errorMessage: "SMTP error",
      }),
    });

    (process.env as Record<string, string>).NODE_ENV = origEnv!;
  });

  it("does not alert on failed admin-email-failure retries", async () => {
    mockPrisma.emailLog.findMany.mockResolvedValue([
      {
        id: "log-fail-3",
        to: "secretary@tokoroa.org.nz",
        subject: "Email delivery permanently failed",
        templateName: "admin-email-failure",
        htmlBody: "<p>Alert</p>",
        attempts: 2,
        status: "FAILED",
      },
    ]);
    mockTransporter.sendMail.mockRejectedValueOnce(new Error("SMTP error"));
    mockPrisma.emailLog.update.mockResolvedValue({});

    const origEnv = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";

    const { retryFailedEmails } = await import("../cron-email-retry");
    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 1, succeeded: 0, failed: 1 });
    expect(mockPrisma.emailLog.update).toHaveBeenCalledWith({
      where: { id: "log-fail-3" },
      data: expect.objectContaining({
        attempts: 3,
        errorMessage: "SMTP error",
      }),
    });
    expect(mockPrisma.member.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.emailLog.create).not.toHaveBeenCalled();

    (process.env as Record<string, string>).NODE_ENV = origEnv!;
  });

  it("does not retry emails without htmlBody", async () => {
    mockPrisma.emailLog.findMany.mockResolvedValue([]);

    const { retryFailedEmails } = await import("../cron-email-retry");
    const result = await retryFailedEmails();

    expect(result.retried).toBe(0);
    // Verify the query filtered on htmlBody not null
    expect(mockPrisma.emailLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          htmlBody: { not: null },
          attempts: { lt: 3 },
        }),
      })
    );
  });

  it("returns empty results when no failed emails", async () => {
    mockPrisma.emailLog.findMany.mockResolvedValue([]);

    const { retryFailedEmails } = await import("../cron-email-retry");
    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 0, succeeded: 0, failed: 0 });
  });
});

// ============================================================================
// N-13: Admin daily digest
// ============================================================================

describe("N-13: sendAdminDigest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockPrisma.member.findMany.mockResolvedValue([{ email: "support@tokoroa.org.nz" }]);
    mockPrisma.emailLog.create.mockResolvedValue({ id: "log-1" });
    mockPrisma.emailLog.update.mockResolvedValue({});
  });

  it("sends digest with alert counts from past 24h", async () => {
    mockPrisma.emailLog.findMany.mockResolvedValue([
      { templateName: "admin-new-booking", subject: "New booking: Alice" },
      { templateName: "admin-new-booking", subject: "New booking: Bob" },
      { templateName: "admin-new-booking", subject: "New booking: Carol" },
      { templateName: "admin-payment-failure", subject: "Payment failed: xyz" },
      { templateName: "admin-xero-repeated-failure", subject: "Repeated Xero Failure: booking:1" },
    ]);

    const { sendAdminDigest } = await import("../cron-admin-digest");
    const result = await sendAdminDigest();

    expect(result.totalAlerts).toBe(5);
    expect(result.sent).toBe(true);
    expect(mockPrisma.emailLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        templateName: "admin-daily-digest",
      }),
    });
  });

  it("sends digest even when no alerts occurred", async () => {
    mockPrisma.emailLog.findMany.mockResolvedValue([]);

    const { sendAdminDigest } = await import("../cron-admin-digest");
    const result = await sendAdminDigest();

    expect(result.totalAlerts).toBe(0);
    expect(result.sent).toBe(true);
  });
});

// ============================================================================
// Email template tests - Phase 6b
// ============================================================================

describe("Email templates - Phase 6b", () => {
  it("adminXeroSyncErrorTemplate escapes HTML in error message", async () => {
    const { adminXeroSyncErrorTemplate } = await import("../email-templates");
    const html = adminXeroSyncErrorTemplate({
      errorType: "<script>xss</script>",
      operation: "createInvoice",
      errorMessage: "Something <b>bad</b> happened",
      timestamp: new Date("2026-04-06T10:00:00Z"),
    });

    expect(html).not.toContain("<script>xss</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;bad&lt;/b&gt;");
  });

  it("adminCapacityWarningTemplate renders day table", async () => {
    const { adminCapacityWarningTemplate } = await import("../email-templates");
    const html = adminCapacityWarningTemplate([
      { date: new Date("2026-04-10"), occupiedBeds: 26, availableBeds: 3 },
      { date: new Date("2026-04-11"), occupiedBeds: 28, availableBeds: 1 },
    ]);

    expect(html).toContain("Capacity Warning");
    expect(html).toContain("26/29");
    expect(html).toContain("28/29");
  });

  it("adminDailyDigestTemplate shows alert counts", async () => {
    const { adminDailyDigestTemplate } = await import("../email-templates");
    const html = adminDailyDigestTemplate({
      newBookings: 5,
      paymentFailures: 1,
      capacityWarnings: 0,
      bookingsBumped: 2,
      pendingDeadlines: 0,
      xeroErrors: 0,
      totalAlerts: 8,
    });

    expect(html).toContain("Admin Daily Digest");
    expect(html).toContain("New Bookings");
    expect(html).toContain("Payment Failures");
    expect(html).toContain("Bookings Bumped");
    expect(html).toContain("8");
    // Capacity warnings and xero errors should not show (0 count)
    expect(html).not.toContain("Capacity Warnings");
    expect(html).not.toContain("Xero Errors");
  });

  it("adminDailyDigestTemplate shows no-alerts message when all zero", async () => {
    const { adminDailyDigestTemplate } = await import("../email-templates");
    const html = adminDailyDigestTemplate({
      newBookings: 0,
      paymentFailures: 0,
      capacityWarnings: 0,
      bookingsBumped: 0,
      pendingDeadlines: 0,
      xeroErrors: 0,
      totalAlerts: 0,
    });

    expect(html).toContain("No alerts were triggered");
  });

  it("adminXeroRepeatedFailureTemplate escapes HTML and renders links", async () => {
    const { adminXeroRepeatedFailureTemplate } = await import("../email-templates");
    const html = adminXeroRepeatedFailureTemplate({
      correlationKey: "booking:<script>",
      failureCount: 3,
      windowHours: 24,
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: "pay_123",
      localUrl: "/admin/xero/records/Payment/pay_123",
      xeroObjectUrl: "https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=inv-123",
      latestErrorMessage: "Something <b>bad</b> happened",
      timestamp: new Date("2026-04-13T10:00:00Z"),
    });

    expect(html).toContain("Repeated Xero Failures");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;bad&lt;/b&gt;");
    expect(html).toContain("/admin/xero/records/Payment/pay_123");
  });

  it("adminXeroReconciliationReportTemplate renders summary counts", async () => {
    const { adminXeroReconciliationReportTemplate } = await import("../email-templates");
    const html = adminXeroReconciliationReportTemplate({
      generatedAt: new Date("2026-04-13T10:00:00Z"),
      lookbackHours: 24,
      stalePendingMinutes: 30,
      summary: {
        missingMemberContactLinks: 1,
        missingPaymentInvoiceLinks: 2,
        missingPaymentRefundCreditNoteLinks: 0,
        missingSubscriptionInvoiceLinks: 1,
        mismatchedCanonicalLinks: 1,
        staleCanonicalLinks: 2,
        duplicateActiveCanonicalLinks: 1,
        stalePendingOperations: 3,
        recentFailedOperations: 4,
        recentPartialOperations: 1,
        unsupportedPartialOperations: 1,
        repeatedFailureCorrelations: 2,
        issueCategoryCount: 11,
        issueTotalCount: 19,
      },
      repeatedFailures: [
        {
          correlationKey: "payment:pay_1:invoice:v1",
          failureCount: 3,
          entityType: "INVOICE",
          operationType: "CREATE",
          localModel: "Payment",
          localId: "pay_1",
          localUrl: "/admin/xero/records/Payment/pay_1",
          latestErrorMessage: "Rate limit exceeded",
        },
      ],
      unsupportedPartials: [
        {
          operationId: "op_partial_gap",
          entityType: "CONTACT",
          operationType: "CREATE",
          localModel: "Member",
          localId: "mem_1",
          localUrl: "/admin/xero/records/Member/mem_1",
          reason: "This partial Xero operation does not have a repair handler yet.",
          createdAt: new Date("2026-04-13T10:05:00Z"),
        },
      ],
    });

    expect(html).toContain("Xero Reconciliation Report");
    expect(html).toContain("Missing member contact links");
    expect(html).toContain("Mismatched canonical links");
    expect(html).toContain("Unsupported partial operations");
    expect(html).toContain("19");
    expect(html).toContain("payment:pay_1:invoice:v1");
    expect(html).toContain("op_partial_gap");
  });
});
