import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted so the mock objects are available at hoist time
const { mockPrisma, mockTransporter } = vi.hoisted(() => {
  const mockTransporter = {
    sendMail: vi.fn().mockResolvedValue({ messageId: "msg-123" }),
  };
  const mockPrisma = {
    emailLog: {
      create: vi.fn().mockResolvedValue({ id: "log-1" }),
      update: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    member: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    booking: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
// N-10: EmailLog tracking in sendEmail
// ============================================================================

describe("N-10: EmailLog tracking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset module cache so sendEmail gets fresh mocks
    vi.resetModules();
    mockPrisma.emailLog.create.mockResolvedValue({ id: "log-1" });
    mockPrisma.emailLog.update.mockResolvedValue({});
    mockTransporter.sendMail.mockResolvedValue({ messageId: "msg-123" });
  });

  it("creates an EmailLog record with QUEUED status before sending", async () => {
    // Force non-dev mode for this test
    const origEnv = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV ="production";

    const { sendEmail } = await import("../email");

    await sendEmail({
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
        status: "QUEUED",
      }),
    });

    (process.env as Record<string, string>).NODE_ENV =origEnv;
  });

  it("updates EmailLog to SENT on success", async () => {
    const origEnv = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV ="production";

    const { sendEmail } = await import("../email");

    await sendEmail({
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

    (process.env as Record<string, string>).NODE_ENV =origEnv;
  });

  it("does not fail delivery if EmailLog SENT update fails", async () => {
    const origEnv = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV ="production";

    mockPrisma.emailLog.update.mockRejectedValueOnce(new Error("EmailLog update failed"));

    const { sendEmail } = await import("../email");

    await expect(
      sendEmail({
        to: "test@example.com",
        subject: "Test",
        html: "<p>Test</p>",
        templateName: "test-template",
      })
    ).resolves.toBeUndefined();

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

  it("preserves the original send error if EmailLog FAILED update also fails", async () => {
    const origEnv = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV ="production";

    mockTransporter.sendMail.mockRejectedValueOnce(new Error("SMTP connection refused"));
    mockPrisma.emailLog.update.mockRejectedValueOnce(new Error("EmailLog update failed"));

    const { sendEmail } = await import("../email");

    await expect(
      sendEmail({
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
      { email: "admin1@tac.org.nz" },
      { email: "admin2@tac.org.nz" },
    ]);

    const { getAdminEmails } = await import("../email");
    const emails = await getAdminEmails();

    expect(emails).toEqual(["admin1@tac.org.nz", "admin2@tac.org.nz"]);
    expect(mockPrisma.member.findMany).toHaveBeenCalledWith({
      where: { role: "ADMIN", active: true },
      select: { email: true },
    });
  });
});

describe("N-02: sendAdminNewBookingAlert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockPrisma.member.findMany.mockResolvedValue([{ email: "support@tokoroa.org.nz" }]);
    mockPrisma.emailLog.create.mockResolvedValue({ id: "log-1" });
    mockPrisma.emailLog.update.mockResolvedValue({});
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
        to: "support@tokoroa.org.nz",
        templateName: "admin-new-booking",
      }),
    });
  });

  it("skips admins who disable new booking alerts", async () => {
    mockPrisma.member.findMany.mockResolvedValue([
      {
        email: "enabled@tokoroa.org.nz",
        notificationPreference: { adminNewBooking: true },
      },
      {
        email: "disabled@tokoroa.org.nz",
        notificationPreference: { adminNewBooking: false },
      },
      {
        email: "default@tokoroa.org.nz",
        notificationPreference: null,
      },
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

    expect(recipients).toContain("enabled@tokoroa.org.nz");
    expect(recipients).toContain("default@tokoroa.org.nz");
    expect(recipients).not.toContain("disabled@tokoroa.org.nz");
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
        member: { email: "member@test.com", firstName: "Jane" },
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
        member: { email: "member@test.com", firstName: "Jane" },
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
});

// ============================================================================
// N-04: Admin payment failure alert
// ============================================================================

describe("N-04: sendAdminPaymentFailureAlert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockPrisma.member.findMany.mockResolvedValue([{ email: "support@tokoroa.org.nz" }]);
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
    mockPrisma.member.findMany.mockResolvedValue([{ email: "support@tokoroa.org.nz" }]);
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
    mockPrisma.member.findMany.mockResolvedValue([{ email: "support@tokoroa.org.nz" }]);
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
    const { checkinReminderTemplate } = await import("../email-templates");
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
    const { adminNewBookingTemplate } = await import("../email-templates");
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

  it("adminPaymentFailureTemplate includes stripe PI ID", async () => {
    const { adminPaymentFailureTemplate } = await import("../email-templates");
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
    const { adminPendingDeadlineTemplate } = await import("../email-templates");
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
    const { adminBookingBumpedTemplate } = await import("../email-templates");
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
