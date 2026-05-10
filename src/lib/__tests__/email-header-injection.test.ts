import { beforeEach, describe, expect, it, vi } from "vitest";

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

  it.each([
    { field: "to", to: "member@example.com\r\nBcc: attacker@example.com", subject: "Hello" },
    { field: "to", to: "member@example.com\nBcc: attacker@example.com", subject: "Hello" },
    { field: "subject", to: "member@example.com", subject: "Hello\r\nBcc: attacker@example.com" },
    { field: "subject", to: "member@example.com", subject: "Hello\nBcc: attacker@example.com" },
  ])("rejects CR/LF in $field before sending", async ({ field, to, subject }) => {
    await expect(
      sendEmail({
        to,
        subject,
        html: "<p>Hello</p>",
      })
    ).rejects.toThrow(`Email header field ${field} contains CR/LF`);

    expect(mockTransporter.sendMail).not.toHaveBeenCalled();
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
