import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock prisma
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(),
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

vi.mock("@/lib/runtime-config", () => ({
  getRuntimeConfigCheck: vi.fn(() => ({
    status: "ok",
    latencyMs: 1,
  })),
}));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { getRuntimeConfigCheck } from "@/lib/runtime-config";
import { auth } from "@/lib/auth";

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

async function callReadinessEndpoint(envOverrides: Record<string, string | undefined> = {}) {
  const originalEnv = { ...process.env };
  Object.assign(process.env, envOverrides);

  const { GET } = await import("@/app/api/health/ready/route");
  const response = await GET();
  const data = await response.json();

  process.env = originalEnv;
  return { response, data };
}

async function callRuntimeStatusEndpoint(
  envOverrides: Record<string, string | undefined> = {}
) {
  const originalEnv = { ...process.env };
  Object.assign(process.env, envOverrides);

  const { GET } = await import("@/app/api/admin/runtime-status/route");
  const response = await GET();
  const data = await response.json();

  process.env = originalEnv;
  return { response, data };
}

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns healthy when the database check passes", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }]);

    const { response, data } = await callHealthEndpoint();

    expect(response.status).toBe(200);
    expect(data.status).toBe("healthy");
    expect(data.checks.db.status).toBe("ok");
    expect(data.checks.stripe).toBeUndefined();
    expect(data.checks.xero).toBeUndefined();
    expect(data.checks.smtp).toBeUndefined();
    expect(data.version).toBeDefined();
    expect(data.uptime).toBeTypeOf("number");
  });

  it("returns unhealthy when DB is down", async () => {
    vi.mocked(prisma.$queryRaw).mockRejectedValue(new Error("Connection refused"));

    const { response, data } = await callHealthEndpoint();

    expect(response.status).toBe(503);
    expect(data.status).toBe("unhealthy");
    expect(data.checks.db.status).toBe("error");
    expect(data.checks.db.error).toBeUndefined();
  });

  it("does not probe non-database dependencies on the public route", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }]);

    const { response, data } = await callHealthEndpoint();

    expect(response.status).toBe(200);
    expect(data.status).toBe("healthy");
    expect(data.checks.db.status).toBe("ok");
    expect(Object.keys(data.checks)).toEqual(["db"]);
  });

  it("does not expose sensitive details in responses", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }]);

    const { data } = await callHealthEndpoint();

    const json = JSON.stringify(data);
    expect(json).not.toContain("sk_test");
    expect(json).not.toContain("password");
    expect(json).not.toContain("AKIA");
    expect(json).not.toContain("postgresql://");
  });

  it("includes latencyMs in the database check", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }]);

    const { data } = await callHealthEndpoint();

    expect(data.checks.db.latencyMs).toBeTypeOf("number");
  });
});

describe("GET /api/health/ready", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRuntimeConfigCheck).mockReturnValue({
      status: "ok",
      latencyMs: 1,
    });
  });

  it("returns healthy when database and runtime config checks pass", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }]);
    vi.mocked(getRuntimeConfigCheck).mockReturnValue({
      status: "ok",
      latencyMs: 4,
    });

    const { response, data } = await callReadinessEndpoint({
      APP_RUNTIME_ROLE: "web-blue",
      CRON_ENABLED: "false",
    });

    expect(response.status).toBe(200);
    expect(data.status).toBe("healthy");
    expect(data.checks.db.status).toBe("ok");
    expect(data.checks.config.status).toBe("ok");
    expect(data.runtime).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain("cronEnabled");
    expect(JSON.stringify(data)).not.toContain("web-blue");
  });

  it("returns unhealthy when the runtime config check fails", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }]);
    vi.mocked(getRuntimeConfigCheck).mockReturnValue({
      status: "error",
      latencyMs: 2,
      error: "AUTH_SECRET missing",
    });

    const { response, data } = await callReadinessEndpoint();

    expect(response.status).toBe(503);
    expect(data.status).toBe("unhealthy");
    expect(data.checks.config.status).toBe("error");
    expect(data.checks.config.error).toBeUndefined();
  });

  it("returns unhealthy when the database is down", async () => {
    vi.mocked(prisma.$queryRaw).mockRejectedValue(new Error("Connection refused"));

    const { response, data } = await callReadinessEndpoint({
      APP_RUNTIME_ROLE: "cron-leader",
      CRON_ENABLED: "true",
    });

    expect(response.status).toBe(503);
    expect(data.status).toBe("unhealthy");
    expect(data.checks.db.status).toBe("error");
    expect(data.checks.db.error).toBeUndefined();
    expect(data.runtime).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain("cronEnabled");
    expect(JSON.stringify(data)).not.toContain("cron-leader");
  });

  it("does not expose runtime metadata on the error path", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }]);
    vi.mocked(getRuntimeConfigCheck).mockImplementation(() => {
      throw new Error("Config unavailable");
    });

    const { response, data } = await callReadinessEndpoint({
      APP_RUNTIME_ROLE: "web-green",
      CRON_ENABLED: "false",
    });

    expect(response.status).toBe(503);
    expect(data.status).toBe("unhealthy");
    expect(data.checks).toEqual({});
    expect(data.runtime).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain("cronEnabled");
    expect(JSON.stringify(data)).not.toContain("web-green");
  });
});

describe("GET /api/admin/runtime-status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires an authenticated session", async () => {
    vi.mocked(auth).mockResolvedValue(null);

    const { response, data } = await callRuntimeStatusEndpoint();

    expect(response.status).toBe(401);
    expect(data).toEqual({ error: "Unauthorized" });
  });

  it("requires an admin session", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: "member-1", role: "MEMBER" },
    } as any);

    const { response, data } = await callRuntimeStatusEndpoint();

    expect(response.status).toBe(403);
    expect(data).toEqual({ error: "Forbidden" });
  });

  it("returns runtime status for admins", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN" },
    } as any);

    const { response, data } = await callRuntimeStatusEndpoint({
      APP_RUNTIME_ROLE: "cron-leader",
      CRON_ENABLED: "true",
    });

    expect(response.status).toBe(200);
    expect(data).toEqual({
      cronEnabled: true,
      role: "cron-leader",
    });
  });
});
