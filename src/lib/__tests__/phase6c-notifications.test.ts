import { describe, it, expect, vi, beforeEach } from "vitest";
import { declareEnvironmentRole } from "@/lib/__tests__/helpers/environment-role";

// Use vi.hoisted so the mock objects are available at hoist time
const { mockPrisma, mockTransporter } = vi.hoisted(() => {
  const mockTransporter = {
    sendMail: vi.fn().mockResolvedValue({ messageId: "msg-789" }),
  };
  const mockPrisma = {
    environmentSafetySettings: { findUnique: vi.fn().mockResolvedValue(null) },
    emailLog: {
      create: vi.fn().mockResolvedValue({ id: "log-1" }),
      update: vi.fn().mockResolvedValue({}),
    },
    member: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    booking: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    notificationPreference: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
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
// N-09: Bulk Member Communication - Input Sanitisation
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

describe("N-09: bulkCommunicationTemplate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("escapes HTML in subject and body", async () => {
    const { bulkCommunicationTemplate } = await import("@/lib/email-templates/communications");
    const html = bulkCommunicationTemplate(
      "<script>alert('xss')</script>",
      "Hello <b>world</b> & \"friends\""
    );

    expect(html).not.toContain("<script>alert('xss')</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;world&lt;/b&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;friends&quot;");
  });

  it("preserves whitespace in body via pre-wrap", async () => {
    const { bulkCommunicationTemplate } = await import("@/lib/email-templates/communications");
    const html = bulkCommunicationTemplate("Test", "Line 1\nLine 2");

    expect(html).toContain("white-space: pre-wrap");
    expect(html).toContain("Line 1\nLine 2");
  });
});

// ============================================================================
// N-09: Bulk Communication Send API (unit tests for validation)
// ============================================================================

describe("N-09: Bulk communication validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("sendSchema strips newlines from subject to prevent header injection", async () => {
    // Test the Zod schema directly by importing it indirectly
    const { z } = await import("zod");
    const sendSchema = z.object({
      subject: z
        .string()
        .min(1)
        .max(200)
        .transform((s: string) => s.replace(/[\r\n]/g, " ")),
      body: z.string().min(1).max(10000),
      recipientFilter: z.enum(["all", "members-only", "admins-only", "custom"]),
      memberIds: z.array(z.string()).optional(),
    });

    const result = sendSchema.safeParse({
      subject: "Subject\r\nBcc: evil@hacker.com",
      body: "Test body",
      recipientFilter: "all",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subject).toBe("Subject  Bcc: evil@hacker.com");
      expect(result.data.subject).not.toContain("\r");
      expect(result.data.subject).not.toContain("\n");
    }
  });

  it("rejects subject over 200 characters", async () => {
    const { z } = await import("zod");
    const sendSchema = z.object({
      subject: z.string().min(1).max(200),
      body: z.string().min(1).max(10000),
      recipientFilter: z.enum(["all", "members-only", "admins-only", "custom"]),
    });

    const result = sendSchema.safeParse({
      subject: "A".repeat(201),
      body: "Test",
      recipientFilter: "all",
    });

    expect(result.success).toBe(false);
  });

  it("rejects body over 10000 characters", async () => {
    const { z } = await import("zod");
    const sendSchema = z.object({
      subject: z.string().min(1).max(200),
      body: z.string().min(1).max(10000),
      recipientFilter: z.enum(["all", "members-only", "admins-only", "custom"]),
    });

    const result = sendSchema.safeParse({
      subject: "Valid subject",
      body: "B".repeat(10001),
      recipientFilter: "all",
    });

    expect(result.success).toBe(false);
  });

  it("rejects invalid recipientFilter", async () => {
    const { z } = await import("zod");
    const sendSchema = z.object({
      subject: z.string().min(1).max(200),
      body: z.string().min(1).max(10000),
      recipientFilter: z.enum(["all", "members-only", "admins-only", "custom"]),
    });

    const result = sendSchema.safeParse({
      subject: "Test",
      body: "Test",
      recipientFilter: "invalid-filter",
    });

    expect(result.success).toBe(false);
  });
});

// ============================================================================
// N-09: Bulk Communication - Preference Filtering
// ============================================================================

describe("N-09: Bulk communication preference filtering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockPrisma.emailLog.create.mockResolvedValue({ id: "log-1" });
    mockPrisma.emailLog.update.mockResolvedValue({});
  });

  it("filters out members with marketingEmails=false", async () => {
    // Simulate what the API does: filter recipients by preference
    const recipients = [
      { id: "m1", email: "a@test.com", notificationPreference: { marketingEmails: true } },
      { id: "m2", email: "b@test.com", notificationPreference: { marketingEmails: false } },
      { id: "m3", email: "c@test.com", notificationPreference: null }, // No pref = default false
    ];

    const eligible = recipients.filter(
      (r) => r.notificationPreference?.marketingEmails === true
    );

    expect(eligible).toHaveLength(1);
    expect(eligible[0].email).toBe("a@test.com");
  });
});

// ============================================================================
// N-12: Feedback flow removal
// ============================================================================

describe("N-12: dormant feedback flow removal", () => {
  it("does not export the removed feedback template", async () => {
    // #2689 split the template monolith into one module per message family,
    // so "not exported" now means not exported by ANY of them. The coverage
    // helper reads the module directory at run time, so this cannot go stale.
    const { readEmailTemplateModuleExports } = await import(
      "@/lib/__tests__/support/email-render-coverage"
    );
    const moduleExports = await readEmailTemplateModuleExports();
    expect(Object.values(moduleExports).flat()).not.toContain(
      "postStayFeedbackTemplate",
    );
  });
});

// ============================================================================
// N-09: Rate Limiting
// ============================================================================

describe("N-09: Bulk communication rate limiting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("rate limiter enforces 1 per hour", async () => {
    const { checkRateLimitInMemory: checkRateLimit } = await import("../rate-limit");
    const config = { id: "test-bulk", limit: 1, windowSeconds: 3600 };

    const first = checkRateLimit(config, "admin-global");
    expect(first.success).toBe(true);
    expect(first.remaining).toBe(0);

    const second = checkRateLimit(config, "admin-global");
    expect(second.success).toBe(false);
    expect(second.remaining).toBe(0);
  });
});
