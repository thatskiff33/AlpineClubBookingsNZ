import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockTransporter, mockLogger } = vi.hoisted(() => {
  const mockTransporter = {
    sendMail: vi.fn().mockResolvedValue({ messageId: "msg-header-test" }),
  };
  const mockPrisma = {
    emailLog: {
      create: vi.fn().mockResolvedValue({ id: "log-header-test" }),
      update: vi.fn().mockResolvedValue({}),
    },
    emailSuppression: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    committeeMember: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
  };
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
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

vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockReturnValue(null),
  rateLimiters: { contact: { limit: 5, windowSeconds: 3600, prefix: "contact" } },
}));

import { POST } from "@/app/api/contact/route";
import { sendEmail } from "@/lib/email";

describe("email header CRLF injection protections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { to: "member@example.com\r\nBcc: attacker@example.com" },
    { to: "member@example.com\nBcc: attacker@example.com" },
  ])("rejects CR/LF in to before sending", async ({ to }) => {
    await expect(
      sendEmail({
        to,
        subject: "Hello",
        html: "<p>Hello</p>",
      })
    ).rejects.toThrow("Email header field to contains CR/LF");

    expect(mockTransporter.sendMail).not.toHaveBeenCalled();
  });

  // Subject CRLF is sanitized rather than thrown (issue #323): silently dropping the
  // email broke admin alerts and confirmations whenever a contaminated member name
  // was interpolated. Defense-in-depth: strip CRLF and continue.
  it.each([
    { subject: "Hello\r\nBcc: attacker@example.com" },
    { subject: "Hello\nBcc: attacker@example.com" },
  ])("sanitizes CR/LF from subject and still sends", async ({ subject }) => {
    vi.stubEnv("NODE_ENV", "production");
    await sendEmail({
      to: "member@example.com",
      subject,
      html: "<p>Hello</p>",
    });

    expect(mockTransporter.sendMail).toHaveBeenCalledTimes(1);
    const call = mockTransporter.sendMail.mock.calls[0][0];
    expect(call.subject).not.toMatch(/[\r\n]/);
    expect(call.subject).toContain("Hello");
    expect(call.subject).toContain("Bcc: attacker@example.com");
    // Persisted EmailLog gets the sanitized value, so retries can't re-introduce CRLF
    expect(mockPrisma.emailLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          subject: expect.not.stringMatching(/[\r\n]/),
        }),
      })
    );
  });

  it("rejects contact-form CRLF payloads before transport", async () => {
    const response = await POST(
      new Request("http://localhost/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "John\r\nBcc: a@b.c",
          email: "john@example.com",
          message: "Hello",
        }),
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid input",
      details: {
        name: ["Name cannot contain line breaks"],
      },
    });
    expect(mockTransporter.sendMail).not.toHaveBeenCalled();
    expect(mockPrisma.committeeMember.findFirst).not.toHaveBeenCalled();
  });
});
