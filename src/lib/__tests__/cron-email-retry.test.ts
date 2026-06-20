import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  update: vi.fn(),
  memberFindMany: vi.fn(),
  sendMail: vi.fn(),
  resolveEmailDeliveryConfig: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    emailLog: {
      findMany: mocks.findMany,
      update: mocks.update,
    },
    member: {
      findMany: mocks.memberFindMany,
    },
  },
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
}));

vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/email", () => ({
  sendEmail: mocks.sendEmail,
}));

import { retryFailedEmails } from "@/lib/cron-email-retry";

function failedEmail(overrides: Record<string, unknown> = {}) {
  return {
    id: "email_1",
    to: "member@example.test",
    subject: "Booking update",
    htmlBody: "<p>hello</p>",
    templateName: "booking-confirmed",
    attempts: 0,
    ...overrides,
  };
}

describe("retryFailedEmails (issue #820)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveEmailDeliveryConfig.mockReturnValue({
      ok: true,
      transportOptions: { host: "smtp.example.test" },
      issues: [],
    });
    mocks.update.mockResolvedValue({});
    mocks.memberFindMany.mockResolvedValue([]);
  });

  it("only queries retryable failures: FAILED, under max attempts, with a retained HTML body", async () => {
    mocks.findMany.mockResolvedValue([]);

    await retryFailedEmails();

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "FAILED",
          attempts: { lt: 3 },
          htmlBody: { not: null },
        }),
      }),
    );
  });

  it("marks a successfully re-sent email as SENT and increments attempts", async () => {
    mocks.findMany.mockResolvedValue([failedEmail({ attempts: 1 })]);
    mocks.sendMail.mockResolvedValue({ messageId: "msg_1" });

    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 1, succeeded: 1, failed: 0 });
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "email_1" },
        data: expect.objectContaining({ status: "SENT", attempts: 2 }),
      }),
    );
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("keeps a still-retryable email FAILED and does not alert admins yet", async () => {
    mocks.findMany.mockResolvedValue([failedEmail({ attempts: 0 })]);
    mocks.sendMail.mockRejectedValue(new Error("smtp 421"));

    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 1, succeeded: 0, failed: 1 });
    // attempts incremented, status NOT set to SENT (stays FAILED for next run).
    const updateArg = mocks.update.mock.calls[0][0];
    expect(updateArg.data.attempts).toBe(1);
    expect(updateArg.data.status).toBeUndefined();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("alerts admins when an email exhausts its retries", async () => {
    mocks.findMany.mockResolvedValue([failedEmail({ attempts: 2 })]);
    mocks.sendMail.mockRejectedValue(new Error("smtp 550"));
    mocks.memberFindMany.mockResolvedValue([{ email: "admin@example.test" }]);

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
      transportOptions: null,
      issues: ["missing EMAIL_FROM"],
    });

    await expect(retryFailedEmails()).rejects.toThrow(/delivery config invalid/);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
});
