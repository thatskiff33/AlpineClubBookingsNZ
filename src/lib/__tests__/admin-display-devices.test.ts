import { beforeEach, describe, expect, it, vi } from "vitest";

// Issue hoppers99/AlpineClubBookingsNZ#33 (LTV-008): admin lobby-display device management — guards,
// creation (default-lodge fallback for single-lodge clubs), registry-
// validated template assignment, idempotent revocation, template list.

const { mockPrisma, mockRequireAdmin } = vi.hoisted(() => ({
  mockPrisma: {
    lodgeDisplayDevice: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    displayTemplate: { findUnique: vi.fn(), findMany: vi.fn() },
    lodge: { findUnique: vi.fn(), findFirst: vi.fn() },
  },
  mockRequireAdmin: vi.fn(),
}));

// The templates route (imported for the picker's built-ins list) pulls in the
// server-only save contract; neutralise the client-boundary guard for node.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: vi.fn().mockResolvedValue("lodge-default"),
}));

const DEVICE_ROW = {
  id: "dev-1",
  name: "Lobby TV",
  lodgeId: "lodge-a",
  lodge: { name: "Silverpeak Lodge" },
  templateId: null,
  template: null,
  tokenHash: "hash",
  pairingCodeExpiresAt: null,
  lastSeenAt: null,
  revokedAt: null,
  createdAt: new Date("2026-07-11T00:00:00Z"),
};

async function jsonRequest(url: string, method: string, body?: unknown) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(url, {
    method,
    ...(body !== undefined
      ? {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }
      : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  mockPrisma.lodgeDisplayDevice.findMany.mockResolvedValue([DEVICE_ROW]);
  mockPrisma.lodgeDisplayDevice.findUnique.mockResolvedValue(null);
  mockPrisma.lodgeDisplayDevice.create.mockResolvedValue(DEVICE_ROW);
  mockPrisma.lodgeDisplayDevice.update.mockResolvedValue({
    id: "dev-1",
    name: "Lobby TV",
    templateId: null,
  });
  mockPrisma.displayTemplate.findUnique.mockResolvedValue(null);
  mockPrisma.displayTemplate.findMany.mockResolvedValue([]);
  mockPrisma.lodge.findUnique.mockResolvedValue({ id: "lodge-default", active: true });
});

describe("GET/POST /api/admin/display/devices", () => {
  it("requires an admin session on every method", async () => {
    const { NextResponse } = await import("next/server");
    mockRequireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorised" }, { status: 401 }),
    });
    const { GET, POST } = await import("@/app/api/admin/display/devices/route");
    expect((await GET()).status).toBe(401);
    expect(
      (
        await POST(
          await jsonRequest("http://localhost/api/admin/display/devices", "POST", {
            name: "TV",
          })
        )
      ).status
    ).toBe(401);
  });

  it("lists devices with lifecycle fields and never the token hash", async () => {
    const { GET } = await import("@/app/api/admin/display/devices/route");
    const res = await GET();
    const body = await res.json();
    expect(body.devices[0]).toMatchObject({
      id: "dev-1",
      lodgeName: "Silverpeak Lodge",
      paired: true,
      revoked: false,
    });
    expect(JSON.stringify(body)).not.toContain("hash");
  });

  it("requires an explicit lodge and creates in the unpaired state (AC2, #2887)", async () => {
    const { POST } = await import("@/app/api/admin/display/devices/route");
    const missingScope = await POST(
      await jsonRequest("http://localhost/api/admin/display/devices", "POST", {
        name: "Foyer TV",
      })
    );
    expect(missingScope.status).toBe(400);
    expect(mockPrisma.lodgeDisplayDevice.create).not.toHaveBeenCalled();

    const res = await POST(
      await jsonRequest("http://localhost/api/admin/display/devices", "POST", {
        name: "Foyer TV",
        lodgeId: "lodge-default",
      })
    );
    expect(res.status).toBe(201);
    const createArgs = mockPrisma.lodgeDisplayDevice.create.mock.calls[0][0];
    expect(createArgs.data).toEqual({ name: "Foyer TV", lodgeId: "lodge-default" });
    // No token is generated at creation — pairing does that (ADR-001).
    expect(JSON.stringify(createArgs.data)).not.toMatch(/token/i);
  });
});

describe("PATCH /api/admin/display/devices/[id] (template assignment, AC7)", () => {
  const routeParams = { params: Promise.resolve({ id: "dev-1" }) };

  it("rejects a retired templateKey binding without persisting (LTV-038/040)", async () => {
    mockPrisma.lodgeDisplayDevice.findUnique.mockResolvedValue({ id: "dev-1" });
    const { PATCH } = await import(
      "@/app/api/admin/display/devices/[id]/route"
    );
    // The built-ins are seeded v2 rows and the templateKey column is gone (hoppers99/AlpineClubBookingsNZ#86);
    // a stale client sending templateKey must be refused (strict schema), never
    // silently no-op.
    const res = await PATCH(
      await jsonRequest("http://localhost/x", "PATCH", { templateKey: "whole-lodge" }),
      routeParams
    );
    expect(res.status).toBe(400);
    expect(mockPrisma.lodgeDisplayDevice.update).not.toHaveBeenCalled();
  });

  it("assigns a v2 templateId after validating it exists", async () => {
    mockPrisma.lodgeDisplayDevice.findUnique.mockResolvedValue({ id: "dev-1" });
    mockPrisma.displayTemplate.findUnique.mockResolvedValue({ id: "tpl-1" });
    const { PATCH } = await import(
      "@/app/api/admin/display/devices/[id]/route"
    );
    const res = await PATCH(
      await jsonRequest("http://localhost/x", "PATCH", { templateId: "tpl-1" }),
      routeParams
    );
    expect(res.status).toBe(200);
    expect(mockPrisma.lodgeDisplayDevice.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { templateId: "tpl-1" } })
    );
  });

  it("rejects an unknown templateId without persisting", async () => {
    mockPrisma.lodgeDisplayDevice.findUnique.mockResolvedValue({ id: "dev-1" });
    mockPrisma.displayTemplate.findUnique.mockResolvedValue(null);
    const { PATCH } = await import(
      "@/app/api/admin/display/devices/[id]/route"
    );
    const res = await PATCH(
      await jsonRequest("http://localhost/x", "PATCH", { templateId: "ghost" }),
      routeParams
    );
    expect(res.status).toBe(400);
    expect(mockPrisma.lodgeDisplayDevice.update).not.toHaveBeenCalled();
  });

  it("clears a binding back to the club default with templateId null", async () => {
    mockPrisma.lodgeDisplayDevice.findUnique.mockResolvedValue({ id: "dev-1" });
    const { PATCH } = await import(
      "@/app/api/admin/display/devices/[id]/route"
    );
    const res = await PATCH(
      await jsonRequest("http://localhost/x", "PATCH", { templateId: null }),
      routeParams
    );
    expect(res.status).toBe(200);
    expect(mockPrisma.lodgeDisplayDevice.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { templateId: null } })
    );
  });

  it("sets an in-range pollSeconds override (LTV-039)", async () => {
    mockPrisma.lodgeDisplayDevice.findUnique.mockResolvedValue({ id: "dev-1" });
    const { PATCH } = await import(
      "@/app/api/admin/display/devices/[id]/route"
    );
    const res = await PATCH(
      await jsonRequest("http://localhost/x", "PATCH", { pollSeconds: 20 }),
      routeParams
    );
    expect(res.status).toBe(200);
    expect(mockPrisma.lodgeDisplayDevice.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { pollSeconds: 20 } })
    );
  });

  it("resets the cadence to the default with pollSeconds null", async () => {
    mockPrisma.lodgeDisplayDevice.findUnique.mockResolvedValue({ id: "dev-1" });
    const { PATCH } = await import(
      "@/app/api/admin/display/devices/[id]/route"
    );
    const res = await PATCH(
      await jsonRequest("http://localhost/x", "PATCH", { pollSeconds: null }),
      routeParams
    );
    expect(res.status).toBe(200);
    expect(mockPrisma.lodgeDisplayDevice.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { pollSeconds: null } })
    );
  });

  it("rejects an out-of-range pollSeconds with 400 and persists nothing", async () => {
    mockPrisma.lodgeDisplayDevice.findUnique.mockResolvedValue({ id: "dev-1" });
    const { PATCH } = await import(
      "@/app/api/admin/display/devices/[id]/route"
    );
    for (const bad of [5, 601, 30.5]) {
      mockPrisma.lodgeDisplayDevice.update.mockClear();
      const res = await PATCH(
        await jsonRequest("http://localhost/x", "PATCH", { pollSeconds: bad }),
        routeParams
      );
      expect(res.status).toBe(400);
      expect(mockPrisma.lodgeDisplayDevice.update).not.toHaveBeenCalled();
    }
  });
});

describe("POST /api/admin/display/devices/[id]/revoke (AC5)", () => {
  const routeParams = { params: Promise.resolve({ id: "dev-1" }) };

  it("sets revokedAt, clears pairing fields, and is idempotent", async () => {
    mockPrisma.lodgeDisplayDevice.findUnique.mockResolvedValue({
      id: "dev-1",
      name: "Lobby TV",
      lodgeId: "lodge-a",
      revokedAt: null,
    });
    const { POST } = await import(
      "@/app/api/admin/display/devices/[id]/revoke/route"
    );
    const res = await POST(await jsonRequest("http://localhost/x", "POST"), routeParams);
    expect(res.status).toBe(200);
    const update = mockPrisma.lodgeDisplayDevice.update.mock.calls[0][0];
    expect(update.data.revokedAt).toBeInstanceOf(Date);
    expect(update.data.pairingCode).toBeNull();

    // Already revoked → no second write, still 200.
    mockPrisma.lodgeDisplayDevice.update.mockClear();
    mockPrisma.lodgeDisplayDevice.findUnique.mockResolvedValue({
      id: "dev-1",
      name: "Lobby TV",
      lodgeId: "lodge-a",
      revokedAt: new Date(),
    });
    const again = await POST(await jsonRequest("http://localhost/x", "POST"), routeParams);
    expect(again.status).toBe(200);
    expect(mockPrisma.lodgeDisplayDevice.update).not.toHaveBeenCalled();
  });

  it("404s an unknown device", async () => {
    const { POST } = await import(
      "@/app/api/admin/display/devices/[id]/revoke/route"
    );
    const res = await POST(
      await jsonRequest("http://localhost/x", "POST"),
      { params: Promise.resolve({ id: "ghost" }) }
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /api/admin/display/templates (v2 rows only for the device picker)", () => {
  it("lists the v2 template rows and no separate built-ins group (LTV-038)", async () => {
    const { GET } = await import("@/app/api/admin/display/templates/route");
    const res = await GET();
    const body = await res.json();
    // The built-ins are seeded v2 rows now — they appear in `templates`, not a
    // separate `builtIns` group.
    expect(body.builtIns).toBeUndefined();
    expect(Array.isArray(body.templates)).toBe(true);
  });
});
