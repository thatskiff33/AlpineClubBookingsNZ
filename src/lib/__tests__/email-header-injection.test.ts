import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockTransporter, mockLogger } = vi.hoisted(() => {
  const mockTransporter = {
    sendMail: vi.fn().mockResolvedValue({ messageId: "msg-header-test" }),
  };
  const mockPrisma = {
    environmentSafetySettings: { findUnique: vi.fn().mockResolvedValue(null) },
    // #2258: the mailer reads the booking's "No emails" switch before every
    // booking-scoped send; off means unchanged behaviour.
    booking: {
      findUnique: vi.fn().mockResolvedValue({ noEmails: false }),
    },
    emailLog: {
      create: vi.fn().mockResolvedValue({ id: "log-header-test" }),
      update: vi.fn().mockResolvedValue({}),
    },
    emailSuppression: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    committeeAssignment: {
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
import { declareEnvironmentRole } from "@/lib/__tests__/helpers/environment-role";

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
        bookingContext: "none",
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
      bookingContext: "none",
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
    expect(mockPrisma.committeeAssignment.findFirst).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed contact-form JSON", async () => {
    const response = await POST(
      new Request("http://localhost/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid JSON payload",
    });
    expect(mockTransporter.sendMail).not.toHaveBeenCalled();
    expect(mockPrisma.committeeAssignment.findFirst).not.toHaveBeenCalled();
  });

  it("redacts committee recipient emails from contact EmailLog rows", async () => {
    vi.stubEnv("NODE_ENV", "production");
    mockPrisma.committeeAssignment.findFirst.mockResolvedValueOnce({
      contactEmailMode: "ROLE",
      contactEmailOverride: null,
      committeeRole: {
        name: "Secretary",
        contactEmail: "secretary@example.org",
      },
      member: { email: "secretary.member@example.org" },
    });

    const response = await POST(
      new Request("http://localhost/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Jordan",
          email: "jordan@example.com",
          message: "Hello",
          recipient: "assignment-1",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(mockTransporter.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "secretary@example.org",
      })
    );
    expect(mockPrisma.emailLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        to: "committee-contact:assignment-1",
        templateName: "website-contact",
        htmlBody: null,
      }),
    });
    expect(mockPrisma.emailLog.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          to: "secretary.private@example.com",
        }),
      })
    );
    expect(mockPrisma.emailLog.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          to: "secretary@example.org",
        }),
      })
    );
  });
});
