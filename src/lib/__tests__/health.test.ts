import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock prisma
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    member: {
      findUnique: vi.fn(),
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

async function callDeployRuntimeStatusEndpoint({
  envOverrides = {},
  headers = {},
}: {
  envOverrides?: Record<string, string | undefined>;
  headers?: Record<string, string>;
} = {}) {
  const originalEnv = { ...process.env };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  const { GET } = await import("@/app/api/deploy/runtime-status/route");
  const response = await GET(
    new Request("https://example.test/api/deploy/runtime-status", { headers }) as any
  );
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
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      active: true,
      forcePasswordChange: false,
      accessRoles: [{ role: "ADMIN" }],
    } as never);
  });

  it("requires an authenticated session", async () => {
    vi.mocked(auth).mockResolvedValue(null);

    const { response, data } = await callRuntimeStatusEndpoint();

    expect(response.status).toBe(401);
    expect(data).toEqual({ error: "Unauthorized" });
  });

  it("requires an admin session", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
    } as any);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      active: true,
      forcePasswordChange: false,
      accessRoles: [{ role: "USER" }],
    } as any);

    const { response, data } = await callRuntimeStatusEndpoint();

    expect(response.status).toBe(403);
    expect(data).toEqual({ error: "Forbidden" });
  });

  it("returns runtime status for admins", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
    } as any);

    const { response, data } = await callRuntimeStatusEndpoint({
      APP_RUNTIME_ROLE: "cron-leader",
      CRON_ENABLED: "true",
      APP_ENVIRONMENT_ROLE: "production",
    });

    expect(response.status).toBe(200);
    expect(data).toEqual({
      cronEnabled: true,
      role: "cron-leader",
      environmentRole: "production",
    });
  });
});

describe("GET /api/deploy/runtime-status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires the cron secret header", async () => {
    const { response, data } = await callDeployRuntimeStatusEndpoint({
      envOverrides: { CRON_SECRET: "deploy-secret" },
    });

    expect(response.status).toBe(401);
    expect(data).toEqual({ error: "Unauthorized" });
  });

  it("rejects an invalid cron secret header", async () => {
    const { response, data } = await callDeployRuntimeStatusEndpoint({
      envOverrides: { CRON_SECRET: "deploy-secret" },
      headers: { "x-cron-secret": "wrong-secret" },
    });

    expect(response.status).toBe(401);
    expect(data).toEqual({ error: "Unauthorized" });
  });

  it("rejects requests when the deployment secret is not configured", async () => {
    const { response, data } = await callDeployRuntimeStatusEndpoint({
      envOverrides: { CRON_SECRET: undefined },
      headers: { "x-cron-secret": "deploy-secret" },
    });

    expect(response.status).toBe(401);
    expect(data).toEqual({ error: "Unauthorized" });
  });

  it("returns runtime status for deploy verification", async () => {
    const { response, data } = await callDeployRuntimeStatusEndpoint({
      envOverrides: {
        APP_RUNTIME_ROLE: "web-green",
        CRON_ENABLED: "false",
        CRON_SECRET: "deploy-secret",
        APP_ENVIRONMENT_ROLE: "production",
      },
      headers: { "x-cron-secret": "deploy-secret" },
    });

    expect(response.status).toBe(200);
    expect(data).toEqual({
      cronEnabled: false,
      role: "web-green",
      environmentRole: "production",
    });
  });

  /*
    THE CONTAINER'S OWN SELF-REPORT OF THE DECLARATION (ENV-SAFETY 1, #3034; epic
    #2986; INV-CONFIG-003), which is what makes the production deploy able to
    check what the container ACTUALLY GOT rather than what a file said.

    The step-3 preflight validates `.env`. The containers receive whatever Docker
    Compose resolved, and Compose prefers a value exported in the invoking shell
    over the env file and takes the LAST duplicate line rather than the first — so
    a first-match file check can pass while the container runs with the other
    value. `assert_runtime_identity` in
    `scripts/run-production-blue-green-deploy.sh` therefore asserts THIS field, at
    step 14, with the old colour still serving.

    It is the DECLARATION KIND and not the effective role, and that distinction is
    the reason it is safe to assert at all: a correctly declared production
    installation whose administrator has switched the safer override on
    legitimately RESOLVES non-production, and asserting the resolved role would
    refuse that legitimate release.
  */
  it("reports the DECLARATION this process parsed, with no database read", async () => {
    /*
      The prisma double in this file has no `environmentSafetySettings` delegate
      at all, so anything that reached for the resolver rather than the pure
      parser would throw here rather than answer. That is the assertion: this
      field comes from `readEnvironmentRoleDeclaration()`, which is why it is safe
      on a health endpoint.
    */
    const { data } = await callDeployRuntimeStatusEndpoint({
      envOverrides: {
        APP_RUNTIME_ROLE: "web-blue",
        CRON_SECRET: "deploy-secret",
        APP_ENVIRONMENT_ROLE: "non-production",
      },
      headers: { "x-cron-secret": "deploy-secret" },
    });

    expect(data.environmentRole).toBe("non-production");
  });

  it("distinguishes an undeclared container from one holding a refused value", async () => {
    const absent = await callDeployRuntimeStatusEndpoint({
      envOverrides: {
        CRON_SECRET: "deploy-secret",
        APP_ENVIRONMENT_ROLE: undefined,
      },
      headers: { "x-cron-secret": "deploy-secret" },
    });
    expect(absent.data.environmentRole).toBe("absent");

    const refused = await callDeployRuntimeStatusEndpoint({
      envOverrides: {
        CRON_SECRET: "deploy-secret",
        APP_ENVIRONMENT_ROLE: "staging",
      },
      headers: { "x-cron-secret": "deploy-secret" },
    });
    expect(refused.data.environmentRole).toBe("invalid");
    // The four-value enum and NOT the refused value itself. The operator surfaces
    // name the typo, because somebody has to fix it; a deploy-verification
    // endpoint has no use for it and does not repeat deployment strings back.
    expect(JSON.stringify(refused.data)).not.toContain("staging");
  });
});
