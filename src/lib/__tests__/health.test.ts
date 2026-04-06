import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock prisma
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    xeroToken: {
      findFirst: vi.fn(),
    },
  },
}));

// Mock logger
vi.mock("@/lib/logger", () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { prisma } from "@/lib/prisma";

// Helper to call the route handler
async function callHealthEndpoint(envOverrides: Record<string, string | undefined> = {}) {
  const originalEnv = { ...process.env };
  Object.assign(process.env, envOverrides);

  // Re-import the route to pick up env changes
  const { GET } = await import("@/app/api/health/route");
  const response = await GET();
  const data = await response.json();

  process.env = originalEnv;
  return { response, data };
}

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.AWS_SES_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
  });

  it("returns healthy when all checks pass", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }]);
    vi.mocked(prisma.xeroToken.findFirst).mockResolvedValue({
      id: "1",
      accessToken: "enc",
      refreshToken: "enc",
      expiresAt: new Date(Date.now() + 3600000),
      tenantId: "t1",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const { response, data } = await callHealthEndpoint();

    expect(response.status).toBe(200);
    expect(data.status).toBe("healthy");
    expect(data.checks.db.status).toBe("ok");
    expect(data.checks.stripe.status).toBe("ok");
    expect(data.checks.xero.status).toBe("ok");
    expect(data.checks.smtp.status).toBe("ok");
    expect(data.version).toBeDefined();
    expect(data.uptime).toBeTypeOf("number");
  });

  it("returns unhealthy when DB is down", async () => {
    vi.mocked(prisma.$queryRaw).mockRejectedValue(new Error("Connection refused"));
    vi.mocked(prisma.xeroToken.findFirst).mockRejectedValue(new Error("Connection refused"));

    const { response, data } = await callHealthEndpoint();

    expect(response.status).toBe(503);
    expect(data.status).toBe("unhealthy");
    expect(data.checks.db.status).toBe("error");
    expect(data.checks.db.error).toBe("Connection refused");
  });

  it("returns degraded when non-critical services fail", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }]);
    vi.mocked(prisma.xeroToken.findFirst).mockResolvedValue(null); // Xero not connected

    const { response, data } = await callHealthEndpoint();

    expect(response.status).toBe(200);
    expect(data.status).toBe("degraded");
    expect(data.checks.db.status).toBe("ok");
    expect(data.checks.xero.status).toBe("error");
  });

  it("returns degraded when Stripe key is missing", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }]);
    vi.mocked(prisma.xeroToken.findFirst).mockResolvedValue({
      id: "1",
      accessToken: "enc",
      refreshToken: "enc",
      expiresAt: new Date(Date.now() + 3600000),
      tenantId: "t1",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const { response, data } = await callHealthEndpoint({
      STRIPE_SECRET_KEY: undefined,
    });

    expect(response.status).toBe(200);
    expect(data.status).toBe("degraded");
    expect(data.checks.stripe.status).toBe("error");
  });

  it("returns degraded when SMTP is not configured", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }]);
    vi.mocked(prisma.xeroToken.findFirst).mockResolvedValue({
      id: "1",
      accessToken: "enc",
      refreshToken: "enc",
      expiresAt: new Date(Date.now() + 3600000),
      tenantId: "t1",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const { response, data } = await callHealthEndpoint({
      SMTP_HOST: undefined,
    });

    expect(response.status).toBe(200);
    expect(data.status).toBe("degraded");
    expect(data.checks.smtp.status).toBe("error");
  });

  it("returns degraded when Xero token is expired", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }]);
    vi.mocked(prisma.xeroToken.findFirst).mockResolvedValue({
      id: "1",
      accessToken: "enc",
      refreshToken: "enc",
      expiresAt: new Date(Date.now() - 3600000), // expired
      tenantId: "t1",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const { response, data } = await callHealthEndpoint();

    expect(response.status).toBe(200);
    expect(data.status).toBe("degraded");
    expect(data.checks.xero.status).toBe("error");
    expect(data.checks.xero.error).toBe("Token expired");
  });

  it("does not expose sensitive details in responses", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }]);
    vi.mocked(prisma.xeroToken.findFirst).mockResolvedValue(null);

    const { data } = await callHealthEndpoint();

    const json = JSON.stringify(data);
    expect(json).not.toContain("sk_test");
    expect(json).not.toContain("password");
    expect(json).not.toContain("AKIA");
    expect(json).not.toContain("postgresql://");
  });

  it("includes latencyMs in each check", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }]);
    vi.mocked(prisma.xeroToken.findFirst).mockResolvedValue(null);

    const { data } = await callHealthEndpoint();

    expect(data.checks.db.latencyMs).toBeTypeOf("number");
    expect(data.checks.stripe.latencyMs).toBeTypeOf("number");
    expect(data.checks.xero.latencyMs).toBeTypeOf("number");
    expect(data.checks.smtp.latencyMs).toBeTypeOf("number");
  });
});
