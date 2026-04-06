import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock prisma
vi.mock("@/lib/prisma", () => ({
  prisma: {
    webhookLog: {
      create: vi.fn(),
      groupBy: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn(),
    },
    cronJobRun: {
      findMany: vi.fn(),
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

// Mock auth
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";

// ============================================================================
// OBS-08: Webhook logging tests
// ============================================================================

describe("OBS-08: Webhook logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("recordWebhookLog", () => {
    it("creates a webhook log entry", async () => {
      vi.mocked(prisma.webhookLog.create).mockResolvedValue({
        id: "1",
        source: "stripe",
        eventType: "payment_intent.succeeded",
        eventId: "evt_123",
        status: "success",
        durationMs: 42,
        error: null,
        createdAt: new Date(),
      });

      const { recordWebhookLog } = await import("@/lib/webhook-log");
      await recordWebhookLog({
        source: "stripe",
        eventType: "payment_intent.succeeded",
        eventId: "evt_123",
        status: "success",
        durationMs: 42,
      });

      expect(prisma.webhookLog.create).toHaveBeenCalledWith({
        data: {
          source: "stripe",
          eventType: "payment_intent.succeeded",
          eventId: "evt_123",
          status: "success",
          durationMs: 42,
        },
      });
    });

    it("records failure with error message", async () => {
      vi.mocked(prisma.webhookLog.create).mockResolvedValue({
        id: "2",
        source: "xero",
        eventType: "CONTACT.UPDATE",
        eventId: "res_456",
        status: "failure",
        durationMs: 100,
        error: "Processing failed",
        createdAt: new Date(),
      });

      const { recordWebhookLog } = await import("@/lib/webhook-log");
      await recordWebhookLog({
        source: "xero",
        eventType: "CONTACT.UPDATE",
        eventId: "res_456",
        status: "failure",
        durationMs: 100,
        error: "Processing failed",
      });

      expect(prisma.webhookLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          status: "failure",
          error: "Processing failed",
        }),
      });
    });

    it("does not throw when create fails", async () => {
      vi.mocked(prisma.webhookLog.create).mockRejectedValue(new Error("DB down"));

      const { recordWebhookLog } = await import("@/lib/webhook-log");
      // Should not throw
      await recordWebhookLog({
        source: "stripe",
        eventType: "test",
        eventId: "evt_999",
        status: "success",
        durationMs: 10,
      });
    });
  });

  describe("getWebhookStats", () => {
    it("returns aggregated stats by source", async () => {
      vi.mocked(prisma.webhookLog.groupBy).mockResolvedValue([
        { source: "stripe", status: "success", _count: { id: 10 } },
        { source: "stripe", status: "failure", _count: { id: 2 } },
        { source: "xero", status: "success", _count: { id: 5 } },
      ] as any);

      const { getWebhookStats } = await import("@/lib/webhook-log");
      const stats = await getWebhookStats(24);

      expect(stats.stripe).toEqual({ success: 10, failure: 2, total: 12 });
      expect(stats.xero).toEqual({ success: 5, failure: 0, total: 5 });
    });

    it("returns empty object when no logs", async () => {
      vi.mocked(prisma.webhookLog.groupBy).mockResolvedValue([] as any);

      const { getWebhookStats } = await import("@/lib/webhook-log");
      const stats = await getWebhookStats(24);

      expect(stats).toEqual({});
    });
  });

  describe("pruneWebhookLogs", () => {
    it("deletes logs older than 30 days", async () => {
      vi.mocked(prisma.webhookLog.deleteMany).mockResolvedValue({ count: 5 });

      const { pruneWebhookLogs } = await import("@/lib/webhook-log");
      const count = await pruneWebhookLogs();

      expect(count).toBe(5);
      expect(prisma.webhookLog.deleteMany).toHaveBeenCalledWith({
        where: {
          createdAt: { lt: expect.any(Date) },
        },
      });
    });
  });
});

// ============================================================================
// OBS-05: API request logging tests
// ============================================================================

describe("OBS-05: API request logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wraps a handler and logs successful requests", async () => {
    const logger = (await import("@/lib/logger")).default;
    const { withRequestLogging } = await import("@/lib/api-logger");
    const { NextResponse } = await import("next/server");

    const mockHandler = vi.fn().mockResolvedValue(
      NextResponse.json({ ok: true }, { status: 200 })
    );

    const wrappedHandler = withRequestLogging(mockHandler, "test-route");

    const mockRequest = {
      method: "GET",
      url: "http://localhost:3000/api/test",
      headers: new Headers({ "x-forwarded-for": "1.2.3.4" }),
    } as any;

    const response = await wrappedHandler(mockRequest);

    expect(response.status).toBe(200);
    expect(mockHandler).toHaveBeenCalledWith(mockRequest, undefined);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        path: "/api/test",
        status: 200,
        ip: "1.2.3.4",
        route: "test-route",
      }),
      "API request completed"
    );
  });

  it("logs 4xx responses at warn level", async () => {
    const logger = (await import("@/lib/logger")).default;
    const { withRequestLogging } = await import("@/lib/api-logger");
    const { NextResponse } = await import("next/server");

    const mockHandler = vi.fn().mockResolvedValue(
      NextResponse.json({ error: "Not found" }, { status: 404 })
    );

    const wrappedHandler = withRequestLogging(mockHandler);

    const mockRequest = {
      method: "GET",
      url: "http://localhost:3000/api/missing",
      headers: new Headers(),
    } as any;

    await wrappedHandler(mockRequest);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 404 }),
      "API request completed with client error"
    );
  });

  it("logs 5xx responses at error level", async () => {
    const logger = (await import("@/lib/logger")).default;
    const { withRequestLogging } = await import("@/lib/api-logger");
    const { NextResponse } = await import("next/server");

    const mockHandler = vi.fn().mockResolvedValue(
      NextResponse.json({ error: "Internal" }, { status: 500 })
    );

    const wrappedHandler = withRequestLogging(mockHandler);

    const mockRequest = {
      method: "POST",
      url: "http://localhost:3000/api/broken",
      headers: new Headers(),
    } as any;

    await wrappedHandler(mockRequest);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ status: 500, method: "POST" }),
      "API request completed with server error"
    );
  });

  it("logs and rethrows unhandled errors", async () => {
    const logger = (await import("@/lib/logger")).default;
    const { withRequestLogging } = await import("@/lib/api-logger");

    const mockHandler = vi.fn().mockRejectedValue(new Error("Boom"));
    const wrappedHandler = withRequestLogging(mockHandler);

    const mockRequest = {
      method: "GET",
      url: "http://localhost:3000/api/crash",
      headers: new Headers(),
    } as any;

    await expect(wrappedHandler(mockRequest)).rejects.toThrow("Boom");
    expect(logger.error).toHaveBeenCalled();
  });
});

// ============================================================================
// OBS-07: Admin health API tests
// ============================================================================

describe("OBS-07: GET /api/admin/health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 for non-admin users", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: "1", email: "user@test.com", name: "Test", role: "MEMBER", forcePasswordChange: false, isEmailVerified: true },
      expires: "",
    } as any);

    const { GET } = await import("@/app/api/admin/health/route");
    const response = await GET();

    expect(response.status).toBe(401);
  });

  it("returns 401 for unauthenticated users", async () => {
    vi.mocked(auth).mockResolvedValue(null);

    const { GET } = await import("@/app/api/admin/health/route");
    const response = await GET();

    expect(response.status).toBe(401);
  });

  it("returns health data for admin users", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: "1", email: "admin@test.com", name: "Admin", role: "ADMIN", forcePasswordChange: false, isEmailVerified: true },
      expires: "",
    } as any);

    vi.mocked(prisma.cronJobRun.findMany).mockResolvedValue([]);
    vi.mocked(prisma.webhookLog.groupBy).mockResolvedValue([] as any);
    vi.mocked(prisma.webhookLog.findMany).mockResolvedValue([]);

    // Mock global fetch for the internal health check call
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        status: "healthy",
        version: "0.1.0",
        uptime: 1000,
        checks: { db: { status: "ok", latencyMs: 5 } },
      }),
    });

    try {
      const { GET } = await import("@/app/api/admin/health/route");
      const response = await GET();
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.health).toBeDefined();
      expect(data.cronJobs).toBeDefined();
      expect(data.webhookStats).toBeDefined();
      expect(data.systemInfo).toBeDefined();
      expect(data.systemInfo.nodeVersion).toBeTruthy();
      expect(data.systemInfo.memoryMb).toBeDefined();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("groups cron runs by job name with max 5 per job", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: "1", email: "admin@test.com", name: "Admin", role: "ADMIN", forcePasswordChange: false, isEmailVerified: true },
      expires: "",
    } as any);

    const runs = Array.from({ length: 8 }, (_, i) => ({
      id: `run-${i}`,
      jobName: "confirm-pending",
      startedAt: new Date(Date.now() - i * 3600000),
      completedAt: new Date(Date.now() - i * 3600000 + 5000),
      durationMs: 5000,
      status: "SUCCESS",
      resultSummary: null,
      error: null,
      createdAt: new Date(),
    }));

    vi.mocked(prisma.cronJobRun.findMany).mockResolvedValue(runs);
    vi.mocked(prisma.webhookLog.groupBy).mockResolvedValue([] as any);
    vi.mocked(prisma.webhookLog.findMany).mockResolvedValue([]);

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ status: "healthy", checks: {} }),
    });

    try {
      const { GET } = await import("@/app/api/admin/health/route");
      const response = await GET();
      const data = await response.json();

      expect(data.cronJobs["confirm-pending"]).toHaveLength(5);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ============================================================================
// OBS-01/02: Sentry configuration file existence tests
// ============================================================================

describe("OBS-01/02: Sentry config files", () => {
  it("sentry.server.config.ts exists", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const rootPath = path.resolve(process.cwd(), "sentry.server.config.ts");
    expect(fs.existsSync(rootPath)).toBe(true);
  });

  it("sentry.client.config.ts exists", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const rootPath = path.resolve(process.cwd(), "sentry.client.config.ts");
    expect(fs.existsSync(rootPath)).toBe(true);
  });

  it("sentry.edge.config.ts exists", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const rootPath = path.resolve(process.cwd(), "sentry.edge.config.ts");
    expect(fs.existsSync(rootPath)).toBe(true);
  });
});
