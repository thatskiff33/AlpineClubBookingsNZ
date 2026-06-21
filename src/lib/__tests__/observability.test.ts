import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const scheduledCronJobs = vi.hoisted(
  (): Array<{
    expression: string;
    callback: () => Promise<void> | void;
    options?: unknown;
  }> => []
);

const mockPrisma = vi.hoisted(() => ({
  $queryRawUnsafe: vi.fn(),
  $transaction: vi.fn(),
  $executeRawUnsafe: vi.fn(),
  member: { count: vi.fn() },
  booking: {
    findMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  bookingChangeRequest: {
    deleteMany: vi.fn(),
  },
  bookingModification: {
    deleteMany: vi.fn(),
  },
  bookingEvent: {
    deleteMany: vi.fn(),
  },
  promoCode: {
    update: vi.fn(),
  },
  promoRedemption: {
    delete: vi.fn(),
  },
  promoRedemptionAllocation: {
    count: vi.fn(),
  },
  webhookLog: {
    create: vi.fn(),
    groupBy: vi.fn(),
    deleteMany: vi.fn(),
    findMany: vi.fn(),
  },
  emailSuppression: {
    count: vi.fn(),
    findMany: vi.fn(),
  },
  emailLog: {
    findMany: vi.fn(),
  },
  auditLog: {
    count: vi.fn(),
    findMany: vi.fn(),
  },
  cronJobRun: {
    create: vi.fn(),
    findMany: vi.fn(),
  },
}));

// Mock prisma
vi.mock("@/lib/prisma", () => ({
  prisma: mockPrisma,
}));

vi.mock("node-cron", () => ({
  default: {
    schedule: vi.fn(
      (
        expression: string,
        callback: () => Promise<void> | void,
        options?: unknown
      ) => {
        scheduledCronJobs.push({ expression, callback, options });
        return { stop: vi.fn() };
      }
    ),
  },
}));

vi.mock("@sentry/nextjs", () => ({
  captureCheckIn: vi.fn(() => "check-in-id"),
  captureException: vi.fn(),
  init: vi.fn(),
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

const mockRequireActiveSessionUser = vi.fn(async () => null);

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () =>
    (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(),
  requireActiveSessionUser: (...args: unknown[]) =>
    mockRequireActiveSessionUser(...args),
}));

vi.mock("@/lib/health-check", () => ({
  getDetailedHealthReport: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { getDetailedHealthReport } from "@/lib/health-check";

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

    it("redacts sensitive text before persisting webhook errors", async () => {
      vi.mocked(prisma.webhookLog.create).mockResolvedValue({
        id: "3",
        source: "stripe",
        eventType: "payment_intent.failed",
        eventId: "evt_secret",
        status: "failure",
        durationMs: 100,
        error: "client_secret=[REDACTED]",
        createdAt: new Date(),
      });

      const { recordWebhookLog } = await import("@/lib/webhook-log");
      await recordWebhookLog({
        source: "stripe",
        eventType: "payment_intent.failed",
        eventId: "evt_secret",
        status: "failure",
        durationMs: 100,
        error: "Stripe failure for pi_123_secret_liveSecret",
      });

      expect(prisma.webhookLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          error: "Stripe failure for [REDACTED]",
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
// OBS-03: Cron job run recording tests
// ============================================================================

describe("OBS-03: cron job run recording", () => {
  const ENV_KEYS = [
    "NEXT_RUNTIME",
    "CRON_ENABLED",
    "FEATURE_FINANCE_DASHBOARD",
    "FEATURE_WAITLIST",
    "FEATURE_XERO_INTEGRATION",
  ] as const;
  const originalEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]])
  );

  function resetInstrumentationEnv() {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  function mockTransactionWithPrisma() {
    (
      prisma.$transaction as unknown as {
        mockImplementation: (
          implementation: (callback: unknown) => Promise<unknown>
        ) => void;
      }
    ).mockImplementation(async (callback: unknown) => {
      if (typeof callback !== "function") {
        throw new Error("Expected interactive transaction callback");
      }

      return (callback as (tx: typeof prisma) => Promise<unknown>)(prisma);
    });
  }

  async function registerCronJobs() {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.CRON_ENABLED = "true";
    delete process.env.FEATURE_FINANCE_DASHBOARD;
    delete process.env.FEATURE_WAITLIST;
    delete process.env.FEATURE_XERO_INTEGRATION;

    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([{ ok: 1 }] as any);
    const { register } = await import("@/instrumentation.node");
    await register();

    const draftCleanup = scheduledCronJobs.find(
      (job) => job.expression === "0 4 * * *"
    );
    expect(draftCleanup).toBeDefined();
    return draftCleanup!;
  }

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    scheduledCronJobs.length = 0;
  });

  afterEach(() => {
    resetInstrumentationEnv();
  });

  it("records draft cleanup success summaries", async () => {
    const draftCleanup = await registerCronJobs();
    mockTransactionWithPrisma();
    vi.mocked(prisma.booking.findMany).mockResolvedValue([
      {
        id: "booking-1",
        promoRedemption: {
          id: "redemption-1",
          promoCodeId: "promo-1",
        },
      },
    ] as any);
    vi.mocked(prisma.promoRedemptionAllocation.count).mockResolvedValue(1);
    vi.mocked(prisma.promoRedemption.delete).mockResolvedValue({} as any);
    vi.mocked(prisma.promoCode.update).mockResolvedValue({} as any);
    vi.mocked(prisma.bookingChangeRequest.deleteMany).mockResolvedValue({
      count: 0,
    } as any);
    vi.mocked(prisma.bookingModification.deleteMany).mockResolvedValue({
      count: 1,
    } as any);
    vi.mocked(prisma.bookingEvent.deleteMany).mockResolvedValue({
      count: 0,
    } as any);
    vi.mocked(prisma.booking.deleteMany).mockResolvedValue({ count: 1 } as any);

    await draftCleanup.callback();

    expect(prisma.promoRedemption.delete).toHaveBeenCalledWith({
      where: { id: "redemption-1" },
    });
    expect(prisma.promoCode.update).toHaveBeenCalledWith({
      where: { id: "promo-1" },
      data: { currentRedemptions: { decrement: 1 } },
    });
    expect(prisma.booking.deleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["booking-1"] },
        status: "DRAFT",
        draftExpiresAt: { lt: expect.any(Date) },
      },
    });
    expect(prisma.cronJobRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        jobName: "draft-cleanup",
        status: "SUCCESS",
        resultSummary: {
          deletedDrafts: 1,
          promoRedemptions: 1,
          changeRequests: 0,
          modifications: 1,
        },
      }),
    });
  });

  it("records draft cleanup zero-delete successes and failures", async () => {
    const draftCleanup = await registerCronJobs();
    vi.mocked(prisma.booking.findMany).mockResolvedValueOnce([] as any);

    await draftCleanup.callback();

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.cronJobRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        jobName: "draft-cleanup",
        status: "SUCCESS",
        resultSummary: {
          deletedDrafts: 0,
          promoRedemptions: 0,
          changeRequests: 0,
          modifications: 0,
        },
      }),
    });

    vi.mocked(prisma.booking.findMany).mockRejectedValueOnce(
      new Error("database unavailable")
    );

    await draftCleanup.callback();

    expect(prisma.cronJobRun.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        jobName: "draft-cleanup",
        status: "FAILURE",
        error: "database unavailable",
      }),
    });
  });
});

// ============================================================================
// OBS-07: Admin health API tests
// ============================================================================

describe("OBS-07: GET /api/admin/health", () => {
  const ENV_KEYS = [
    "SENTRY_DSN",
    "SENTRY_ORG",
    "SENTRY_PROJECT",
    "CRON_ENABLED",
    "CRON_LEADER_RUNTIME_STATUS_URL",
    "CRON_SECRET",
    "APP_RUNTIME_ROLE",
    "XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH",
    "BACKUP_CRON_SCHEDULE",
  ] as const;
  const originalEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]])
  );

  function resetHealthEnv() {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  function mockAdminSession() {
    vi.mocked(auth).mockResolvedValue({
      user: { id: "1", email: "admin@test.com", name: "Admin", role: "ADMIN", forcePasswordChange: false, isEmailVerified: true },
      expires: "",
    } as any);
  }

  function mockAdminHealthDependencies(cronRuns: any[] = []) {
    vi.mocked(prisma.cronJobRun.findMany).mockResolvedValue(cronRuns);
    vi.mocked(prisma.webhookLog.groupBy).mockResolvedValue([] as any);
    vi.mocked(prisma.webhookLog.findMany).mockResolvedValue([]);
    vi.mocked(prisma.emailSuppression.count).mockResolvedValue(0);
    vi.mocked(prisma.emailSuppression.findMany).mockResolvedValue([]);
    vi.mocked(prisma.auditLog.count).mockResolvedValue(0);
    vi.mocked(getDetailedHealthReport).mockResolvedValue({
      httpStatus: 200,
      report: {
        status: "healthy",
        version: "0.1.0",
        uptime: 1000,
        checks: {
          db: { status: "ok", latencyMs: 5 },
          stripe: { status: "ok", latencyMs: 1 },
          xero: { status: "ok", latencyMs: 1 },
          smtp: { status: "ok", latencyMs: 1 },
        },
      },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    resetHealthEnv();
    vi.unstubAllGlobals();
  });

  it("returns 403 for non-admin users", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: "1", email: "user@test.com", name: "Test", role: "MEMBER", forcePasswordChange: false, isEmailVerified: true },
      expires: "",
    } as any);

    const { GET } = await import("@/app/api/admin/health/route");
    const response = await GET();

    expect(response.status).toBe(403);
  });

  it("returns 401 for unauthenticated users", async () => {
    vi.mocked(auth).mockResolvedValue(null as any);

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
    vi.mocked(prisma.emailSuppression.count).mockResolvedValue(0);
    vi.mocked(prisma.emailSuppression.findMany).mockResolvedValue([]);
    vi.mocked(prisma.emailLog.findMany).mockResolvedValue([]);
    vi.mocked(prisma.auditLog.count).mockResolvedValue(0);
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([]);
    vi.mocked(getDetailedHealthReport).mockResolvedValue({
      httpStatus: 200,
      report: {
        status: "healthy",
        version: "0.1.0",
        uptime: 1000,
        checks: {
          db: { status: "ok", latencyMs: 5 },
          stripe: { status: "ok", latencyMs: 1 },
          xero: { status: "ok", latencyMs: 1 },
          smtp: { status: "ok", latencyMs: 1 },
        },
      },
    });

    const { GET } = await import("@/app/api/admin/health/route");
    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.health).toBeDefined();
    expect(data.cronJobs).toBeDefined();
    expect(data.webhookStats).toBeDefined();
    expect(data.emailDeliverability).toEqual({
      summary: {
        activeCount: 0,
        bounceCount: 0,
        complaintCount: 0,
        eventsLast24h: 0,
      },
      suppressions: [],
    });
    expect(data.emailFailures).toEqual({
      summary: {
        activeCount: 0,
        reviewedCount: 0,
        scannedCount: 0,
        maxAttempts: 3,
      },
      failures: [],
      recentlyReviewed: [],
    });
    expect(data.adminAlertDelivery).toEqual({
      summary: {
        recentCount: 0,
        lookbackDays: 7,
      },
      escalations: [],
    });
    expect(data.systemInfo).toBeDefined();
    expect(data.systemInfo.nodeVersion).toBeTruthy();
    expect(data.systemInfo.memoryMb).toBeDefined();
    expect(data.systemInfo.sentryDashboardUrl).toBeNull();
    expect(data.systemInfo.sentryConfigWarning).toContain("SENTRY_DSN");
    expect(data.cronHealth.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jobName: "finance-daily-sync",
          schedule: "15 10 * * *",
          timezone: "Pacific/Auckland",
          expectedLocalTime: "10:15 NZT/NZDT daily",
        }),
        expect.objectContaining({
          jobName: "xero-membership-refresh",
          status: "disabled",
        }),
      ])
    );
  });

  it("returns a real Sentry dashboard link only when the dashboard config is complete", async () => {
    process.env.SENTRY_DSN = "https://public@example.ingest.sentry.io/123";
    process.env.SENTRY_ORG = "example-alpine-club";
    process.env.SENTRY_PROJECT = "456";
    mockAdminSession();
    mockAdminHealthDependencies();

    const { GET } = await import("@/app/api/admin/health/route");
    const response = await GET();
    const data = await response.json();

    expect(data.systemInfo.sentryConfigured).toBe(true);
    expect(data.systemInfo.sentryDashboardUrl).toBe(
      "https://sentry.io/organizations/example-alpine-club/issues/?project=456"
    );
    expect(data.systemInfo.sentryConfigWarning).toBeNull();
  });

  it("reports partial Sentry dashboard config as a warning instead of placeholder links", async () => {
    process.env.SENTRY_DSN = "https://public@example.ingest.sentry.io/123";
    process.env.SENTRY_ORG = "example-alpine-club";
    delete process.env.SENTRY_PROJECT;
    mockAdminSession();
    mockAdminHealthDependencies();

    const { GET } = await import("@/app/api/admin/health/route");
    const response = await GET();
    const data = await response.json();

    expect(data.systemInfo.sentryConfigured).toBe(true);
    expect(data.systemInfo.sentryDashboardUrl).toBeNull();
    expect(data.systemInfo.sentryConfigWarning).toContain("SENTRY_PROJECT");
    expect(JSON.stringify(data.systemInfo)).not.toContain("your-org");
    expect(JSON.stringify(data.systemInfo)).not.toContain("your-project");
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
    vi.mocked(prisma.emailSuppression.count).mockResolvedValue(0);
    vi.mocked(prisma.emailSuppression.findMany).mockResolvedValue([]);
    vi.mocked(prisma.emailLog.findMany).mockResolvedValue([]);
    vi.mocked(prisma.auditLog.count).mockResolvedValue(0);
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([]);
    vi.mocked(getDetailedHealthReport).mockResolvedValue({
      httpStatus: 200,
      report: {
        status: "healthy",
        version: "0.1.0",
        uptime: 1000,
        checks: {
          db: { status: "ok", latencyMs: 5 },
          stripe: { status: "ok", latencyMs: 1 },
          xero: { status: "ok", latencyMs: 1 },
          smtp: { status: "ok", latencyMs: 1 },
        },
      },
    });

    const { GET } = await import("@/app/api/admin/health/route");
    const response = await GET();
    const data = await response.json();

    expect(data.cronJobs["confirm-pending"]).toHaveLength(5);
  });

  it("loads expected daily job history outside the global recent cron window", async () => {
    mockAdminSession();
    mockAdminHealthDependencies();

    const baseTime = Date.now();
    const latestWindow = Array.from({ length: 200 }, (_, i) => ({
      id: `recent-xero-${i}`,
      jobName: i % 2 === 0 ? "xero-operation-replay" : "xero-inbound-reconcile",
      startedAt: new Date(baseTime - i * 60_000),
      completedAt: new Date(baseTime - i * 60_000 + 5_000),
      durationMs: 5000,
      status: "SUCCESS",
      resultSummary: null,
      error: null,
      createdAt: new Date(baseTime - i * 60_000),
    }));
    const financeRun = {
      id: "finance-daily-sync-1",
      jobName: "finance-daily-sync",
      startedAt: new Date(baseTime - 60 * 60_000),
      completedAt: new Date(baseTime - 60 * 60_000 + 7_000),
      durationMs: 7000,
      status: "SUCCESS",
      resultSummary: null,
      error: null,
      createdAt: new Date(baseTime - 60 * 60_000),
    };

    vi.mocked(prisma.cronJobRun.findMany).mockImplementation(
      async (query?: any) => {
        const where = query?.where;
        if (!where) {
          return latestWindow;
        }

        if (where.jobName !== "finance-daily-sync") {
          return [];
        }

        if (where.status === "FAILURE") {
          return [];
        }

        return [financeRun];
      }
    );

    const { GET } = await import("@/app/api/admin/health/route");
    const response = await GET();
    const data = await response.json();
    const financeJob = data.cronHealth.jobs.find(
      (job: { jobName: string }) => job.jobName === "finance-daily-sync"
    );

    expect(response.status).toBe(200);
    expect(financeJob).toMatchObject({
      jobName: "finance-daily-sync",
      status: "current",
      latestRunStatus: "SUCCESS",
      latestSuccessAt: financeRun.completedAt.toISOString(),
    });
    expect(data.cronJobs["finance-daily-sync"]).toEqual([
      expect.objectContaining({ id: "finance-daily-sync-1" }),
    ]);
    expect(prisma.cronJobRun.findMany).toHaveBeenCalledWith({
      orderBy: { startedAt: "desc" },
      take: 200,
    });
    expect(prisma.cronJobRun.findMany).toHaveBeenCalledWith({
      where: { jobName: "finance-daily-sync" },
      orderBy: { startedAt: "desc" },
      take: 5,
    });
    expect(prisma.cronJobRun.findMany).toHaveBeenCalledWith({
      where: { jobName: "finance-daily-sync", status: "SUCCESS" },
      orderBy: { startedAt: "desc" },
      take: 1,
    });
  });

  it("uses cron leader runtime status when admin health is served by a web slot", async () => {
    process.env.APP_RUNTIME_ROLE = "web-blue";
    process.env.CRON_ENABLED = "false";
    process.env.CRON_SECRET = "cron-secret";
    process.env.CRON_LEADER_RUNTIME_STATUS_URL =
      "http://cron-leader.test/api/deploy/runtime-status";
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      expect(_url).toBe("http://cron-leader.test/api/deploy/runtime-status");
      expect((init as RequestInit).headers).toMatchObject({
        "x-cron-secret": "cron-secret",
      });

      return {
        ok: true,
        json: async () => ({
          cronEnabled: true,
          role: "cron-leader",
        }),
      } as Response;
    }));
    mockAdminSession();
    mockAdminHealthDependencies();

    const { GET } = await import("@/app/api/admin/health/route");
    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.cronHealth.cronEnabled).toBe(true);
    expect(data.cronHealth.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jobName: "xero-link-backfill",
          disabledReason: null,
          status: "missing",
        }),
      ])
    );
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

  it("instrumentation-client.ts exists (client-side Sentry + Session Replay)", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const rootPath = path.resolve(process.cwd(), "src", "instrumentation-client.ts");
    expect(fs.existsSync(rootPath)).toBe(true);
  });

  it("sentry.edge.config.ts exists", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const rootPath = path.resolve(process.cwd(), "sentry.edge.config.ts");
    expect(fs.existsSync(rootPath)).toBe(true);
  });
});
