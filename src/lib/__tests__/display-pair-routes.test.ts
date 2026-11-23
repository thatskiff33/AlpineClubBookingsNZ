import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { expectDefaultInvalidJsonAnswer, MALFORMED_JSON_BODY } from "./helpers/invalid-json-body";

// Issue hoppers99/AlpineClubBookingsNZ#27 (LTV-002): route-level behaviour of the display pairing surface —
// the full pairing lifecycle, the heartbeat auth matrix (a rejected token
// never updates lastSeenAt, AC6), the admin bind endpoint's guards, and the
// module-gating decoupling from the kiosk flag (ADR-001 §1).

const { mockPrisma, mockRequireAdmin } = vi.hoisted(() => ({
  mockPrisma: {
    lodgeDisplayDevice: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    $queryRaw: vi.fn().mockRejectedValue(new Error("no shared store in tests")),
    $executeRaw: vi.fn().mockRejectedValue(new Error("no shared store in tests")),
  },
  mockRequireAdmin: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

let nextIp = 1;
function uniqueIp() {
  return `10.9.${Math.floor(nextIp / 250)}.${(nextIp++ % 250) + 1}`;
}

async function pairRequest(body: unknown, cookie?: string, ip?: string) {
  const { NextRequest } = await import("next/server");
  return new NextRequest("http://localhost/api/display/pair", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip ?? uniqueIp(),
      ...(cookie ? { cookie } : {}),
    },
  });
}

function extractCookie(response: Response, name: string): string | null {
  const headers = response.headers.getSetCookie?.() ?? [];
  for (const line of headers) {
    if (line.startsWith(`${name}=`)) {
      return line.split(";")[0].slice(name.length + 1);
    }
  }
  return null;
}

beforeAll(() => {
  process.env.AUTH_SECRET = "test-display-secret";
});

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.lodgeDisplayDevice.findUnique.mockResolvedValue(null);
  mockPrisma.lodgeDisplayDevice.findFirst.mockResolvedValue(null);
  mockPrisma.lodgeDisplayDevice.update.mockResolvedValue({});
  mockRequireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
});

describe("POST /api/display/pair", () => {
  it("start issues a well-formed code inside an httpOnly signed blob cookie and persists nothing", async () => {
    const { POST } = await import("@/app/api/display/pair/route");
    const { DISPLAY_PAIRING_COOKIE, decodePairingBlob, isPairingCodeFormat } =
      await import("@/lib/lodge-display-auth");

    const res = await POST(await pairRequest({ action: "start" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(isPairingCodeFormat(body.code)).toBe(true);

    const rawCookie = extractCookie(res, DISPLAY_PAIRING_COOKIE);
    expect(rawCookie).toBeTruthy();
    expect(decodePairingBlob(rawCookie!)?.code).toBe(body.code);

    // Anonymous start creates no database state (ADR-001 §2.1).
    expect(mockPrisma.lodgeDisplayDevice.update).not.toHaveBeenCalled();
    expect(mockPrisma.lodgeDisplayDevice.findFirst).not.toHaveBeenCalled();
  });

  it("claim without a blob asks the display to restart pairing", async () => {
    const { POST } = await import("@/app/api/display/pair/route");
    const res = await POST(await pairRequest({ action: "claim" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ paired: false, restart: true });
  });

  it("claim stays unpaired until an admin binds the code, then issues the token cookie", async () => {
    const { POST } = await import("@/app/api/display/pair/route");
    const {
      DISPLAY_PAIRING_COOKIE,
      DISPLAY_TOKEN_COOKIE,
    } = await import("@/lib/lodge-display-auth");
    const { hashActionToken } = await import("@/lib/action-tokens");

    const startRes = await POST(await pairRequest({ action: "start" }));
    const { code } = await startRes.json();
    const blobCookie = extractCookie(startRes, DISPLAY_PAIRING_COOKIE)!;
    const cookieHeader = `${DISPLAY_PAIRING_COOKIE}=${blobCookie}`;

    // Not bound yet → polling stays unpaired.
    const pending = await POST(await pairRequest({ action: "claim" }, cookieHeader));
    await expect(pending.json()).resolves.toEqual({ paired: false });

    // Admin binds the code (simulated at the data layer).
    mockPrisma.lodgeDisplayDevice.findFirst.mockImplementation(({ where }: never) =>
      Promise.resolve(
        (where as { pairingCode: string }).pairingCode === code
          ? { id: "dev-1", lodgeId: "lodge-a", name: "Lobby TV" }
          : null
      )
    );

    const claimed = await POST(await pairRequest({ action: "claim" }, cookieHeader));
    expect(claimed.status).toBe(200);
    await expect(claimed.json()).resolves.toEqual({ paired: true });

    const token = extractCookie(claimed, DISPLAY_TOKEN_COOKIE);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    // Stored hashed, code cleared (single-use).
    const update = mockPrisma.lodgeDisplayDevice.update.mock.calls[0][0];
    expect(update.data.tokenHash).toBe(hashActionToken(token!));
    expect(update.data.pairingCode).toBeNull();
  });

  it("rate limits repeated start requests from one IP (AC8)", async () => {
    const { POST } = await import("@/app/api/display/pair/route");
    const ip = "10.99.99.99";
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await POST(await pairRequest({ action: "start" }, undefined, ip));
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  });

  it("rejects an unknown action", async () => {
    const { POST } = await import("@/app/api/display/pair/route");
    const res = await POST(await pairRequest({ action: "steal-tokens" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid request" });
  });

  it("answers a body that is not JSON with the shared invalid-JSON 400 (#5407)", async () => {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("@/app/api/display/pair/route");
    const res = await POST(
      new NextRequest("http://localhost/api/display/pair", {
        method: "POST",
        body: MALFORMED_JSON_BODY,
        headers: { "content-type": "application/json", "x-forwarded-for": uniqueIp() },
      }),
    );
    await expectDefaultInvalidJsonAnswer(res);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe("POST /api/display/heartbeat", () => {
  const DEVICE = {
    id: "dev-1",
    lodgeId: "lodge-a",
    name: "Lobby TV",
    templateId: null,
    revokedAt: null,
    lodge: { active: true },
  };

  async function heartbeatRequest(token?: string) {
    const { NextRequest } = await import("next/server");
    const { DISPLAY_TOKEN_COOKIE } = await import("@/lib/lodge-display-auth");
    return new NextRequest("http://localhost/api/display/heartbeat", {
      method: "POST",
      headers: {
        "x-forwarded-for": uniqueIp(),
        ...(token ? { cookie: `${DISPLAY_TOKEN_COOKIE}=${token}` } : {}),
      },
    });
  }

  it("updates lastSeenAt for a valid token", async () => {
    mockPrisma.lodgeDisplayDevice.findUnique.mockResolvedValue(DEVICE);
    const { POST } = await import("@/app/api/display/heartbeat/route");

    const res = await POST(await heartbeatRequest("a".repeat(64)));
    expect(res.status).toBe(200);
    expect(mockPrisma.lodgeDisplayDevice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "dev-1" },
        data: { lastSeenAt: expect.any(Date) },
      })
    );
  });

  it("rejects a missing token and updates nothing", async () => {
    const { POST } = await import("@/app/api/display/heartbeat/route");
    const res = await POST(await heartbeatRequest());
    expect(res.status).toBe(401);
    expect(mockPrisma.lodgeDisplayDevice.update).not.toHaveBeenCalled();
  });

  it("rejects a revoked device WITHOUT updating lastSeenAt (AC6)", async () => {
    mockPrisma.lodgeDisplayDevice.findUnique.mockResolvedValue({
      ...DEVICE,
      revokedAt: new Date(),
    });
    const { POST } = await import("@/app/api/display/heartbeat/route");

    const res = await POST(await heartbeatRequest("a".repeat(64)));
    expect(res.status).toBe(401);
    expect(mockPrisma.lodgeDisplayDevice.update).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/display/devices/[id]/pairing", () => {
  async function adminBindRequest(code: string) {
    const { NextRequest } = await import("next/server");
    return new NextRequest(
      "http://localhost/api/admin/display/devices/dev-1/pairing",
      {
        method: "POST",
        body: JSON.stringify({ code }),
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": uniqueIp(),
        },
      }
    );
  }
  const routeParams = { params: Promise.resolve({ id: "dev-1" }) };

  it("requires an admin session", async () => {
    const { NextResponse } = await import("next/server");
    mockRequireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorised" }, { status: 401 }),
    });
    const { POST } = await import(
      "@/app/api/admin/display/devices/[id]/pairing/route"
    );
    const res = await POST(await adminBindRequest("ABCDEF"), routeParams);
    expect(res.status).toBe(401);
    expect(mockPrisma.lodgeDisplayDevice.update).not.toHaveBeenCalled();
  });

  it("binds a valid code to the device", async () => {
    mockPrisma.lodgeDisplayDevice.findUnique.mockResolvedValue({
      id: "dev-1",
      revokedAt: null,
    });
    const { POST } = await import(
      "@/app/api/admin/display/devices/[id]/pairing/route"
    );
    const res = await POST(await adminBindRequest("abcdef"), routeParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockPrisma.lodgeDisplayDevice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ pairingCode: "ABCDEF" }),
      })
    );
  });

  it("maps failures to explicit statuses: bad code 400, unknown device 404, revoked 409", async () => {
    const { POST } = await import(
      "@/app/api/admin/display/devices/[id]/pairing/route"
    );

    expect((await POST(await adminBindRequest("bad code!"), routeParams)).status).toBe(400);

    mockPrisma.lodgeDisplayDevice.findUnique.mockResolvedValue(null);
    expect((await POST(await adminBindRequest("ABCDEF"), routeParams)).status).toBe(404);

    mockPrisma.lodgeDisplayDevice.findUnique.mockResolvedValue({
      id: "dev-1",
      revokedAt: new Date(),
    });
    expect((await POST(await adminBindRequest("ABCDEF"), routeParams)).status).toBe(409);
  });
});

describe("module gating (ADR-001 §1 — decoupled from the kiosk flag)", () => {
  it("display routes require lobbyDisplay and NOT kiosk", async () => {
    const { getRequiredFeaturesForPath } = await import(
      "@/config/feature-routes"
    );
    for (const path of [
      "/display",
      "/api/display/pair",
      "/api/display/heartbeat",
      "/api/admin/display/devices/dev-1/pairing",
    ]) {
      const required = getRequiredFeaturesForPath(path);
      expect(required).toContain("lobbyDisplay");
      expect(required).not.toContain("kiosk");
    }
  });

  it("kiosk routes are unchanged by the new rule", async () => {
    const { getRequiredFeaturesForPath } = await import(
      "@/config/feature-routes"
    );
    const required = getRequiredFeaturesForPath("/api/lodge/access");
    expect(required).toContain("kiosk");
    expect(required).not.toContain("lobbyDisplay");
  });
});
