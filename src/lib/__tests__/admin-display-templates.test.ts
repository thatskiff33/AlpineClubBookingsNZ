import { beforeEach, describe, expect, it, vi } from "vitest";

// LTV-024: the admin template CRUD surface (raw-JSON editor + copy-to-custom)
// was removed with the v2 rebuild. What remains here is the built-ins list for
// the device picker, the per-lodge display settings (config glob validation,
// granularity persistence, admin-only), and the read-only preview (AC3 — no
// database write on the preview path). The Layout/Template authoring UI returns
// under LTV-032/033.

const { mockPrisma, mockRequireAdmin } = vi.hoisted(() => ({
  mockPrisma: {
    lodge: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    clubTheme: { findUnique: vi.fn().mockResolvedValue(null) },
    lodgeRoom: { findMany: vi.fn() },
    booking: { findMany: vi.fn() },
    choreAssignment: { findMany: vi.fn() },
    // #2286: the display payload carries the custodian in residence, read from
    // a bed-holding hut-leader assignment. None here, so the privacy-reduced
    // state below is unchanged.
    hutLeaderAssignment: { findFirst: vi.fn().mockResolvedValue(null) },
    displayTemplate: { findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
  mockRequireAdmin: vi.fn(),
}));

// The templates GET now pairs the built-ins with v2 rows via the server-only
// save-contract import chain; neutralise the boundary guard for node.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: vi.fn().mockResolvedValue("lodge-default"),
  lodgeNullTolerantScope: (lodgeId: string) => ({ OR: [{ lodgeId }, { lodgeId: null }] }),
}));
vi.mock("@/lib/public-layout-config", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/club-identity-settings")
  >("@/lib/club-identity-settings");
  return { getCachedClubIdentity: actual.getClubIdentity };
});
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: vi
    .fn()
    .mockResolvedValue({ bedAllocation: false, chores: false }),
}));
vi.mock("@/lib/lodge-instructions", () => ({
  getSanitizedLodgeInstructions: vi.fn().mockResolvedValue([]),
}));

async function jsonRequest(url: string, method: string, body?: unknown) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(url, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
      : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "admin-1" } } });
  mockPrisma.lodge.findUnique.mockResolvedValue({
    id: "lodge-default",
    name: "Silverpeak Lodge",
    active: true,
    displayConfig: { "wifi-code": "alpine1234" },
    displayNameGranularity: null,
  });
  mockPrisma.lodge.update.mockResolvedValue({});
});

describe("GET /api/admin/display/templates (v2 rows only, LTV-038)", () => {
  it("returns the v2 template rows and no legacy built-ins group", async () => {
    const { GET } = await import("@/app/api/admin/display/templates/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.templates)).toBe(true);
    // LTV-038 retired the separate built-ins group — the built-ins are now
    // ordinary seeded template rows, so the picker binds everything by id.
    expect(body.builtIns).toBeUndefined();
    // The retired source concept is gone from the payload.
    expect(JSON.stringify(body)).not.toMatch(/override|custom|BUILT_IN/);
  });

  it("requires an admin session", async () => {
    const { NextResponse } = await import("next/server");
    mockRequireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorised" }, { status: 401 }),
    });
    const { GET } = await import("@/app/api/admin/display/templates/route");
    expect((await GET()).status).toBe(401);
  });
});

describe("lodge display settings (AC4/AC5/AC6)", () => {
  it("rejects bad config keys and oversized values with explicit errors", async () => {
    const { PUT } = await import("@/app/api/admin/display/lodge-config/route");
    const badKey = await PUT(
      await jsonRequest("http://localhost/x", "PUT", {
        displayConfig: { "Bad Key!": "x" },
      })
    );
    expect(badKey.status).toBe(400);
    expect((await badKey.json()).error).toContain('"Bad Key!"');

    const tooLong = await PUT(
      await jsonRequest("http://localhost/x", "PUT", {
        displayConfig: { note: "x".repeat(501) },
      })
    );
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()).error).toContain("exceeds 500");
    expect(mockPrisma.lodge.update).not.toHaveBeenCalled();
  });

  it("persists a valid glob and the granularity override (AC5/AC6)", async () => {
    const { PUT } = await import("@/app/api/admin/display/lodge-config/route");
    const res = await PUT(
      await jsonRequest("http://localhost/x", "PUT", {
        displayConfig: { "wifi-code": "alpine1234" },
        displayNameGranularity: "FULL_NAME",
      })
    );
    expect(res.status).toBe(200);
    expect(mockPrisma.lodge.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "lodge-default" },
        data: {
          displayConfig: { "wifi-code": "alpine1234" },
          displayNameGranularity: "FULL_NAME",
        },
      })
    );
    // #1988: the display-config write must leave a member-actor audit row so
    // the bootstrap-import six-signal probe (signal 6) detects a
    // hand-configured lodge display.
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "LODGE_DISPLAY_CONFIG_UPDATED",
        actorMemberId: "admin-1",
        entityType: "Lodge",
        entityId: "lodge-default",
      }),
    });
  });

  it("requires an admin session (AC7)", async () => {
    const { NextResponse } = await import("next/server");
    mockRequireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorised" }, { status: 401 }),
    });
    const { GET } = await import("@/app/api/admin/display/lodge-config/route");
    const res = await GET(await jsonRequest("http://localhost/x", "GET"));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/admin/display/preview (AC3 — read-only, built-ins only)", () => {
  it("returns the template plus the privacy-reduced state and performs NO write", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([]);
    mockPrisma.choreAssignment.findMany.mockResolvedValue([]);
    const { GET } = await import("@/app/api/admin/display/preview/route");
    const res = await GET(
      await jsonRequest(
        "http://localhost/api/admin/display/preview?templateKey=everyday-board",
        "GET"
      )
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.template.key).toBe("everyday-board");
    expect(body.state.lodge.name).toBe("Silverpeak Lodge");

    // No mutation of ANY kind happened on the preview path.
    expect(mockPrisma.lodge.update).not.toHaveBeenCalled();
  });

  it("404s an unknown template", async () => {
    const { GET } = await import("@/app/api/admin/display/preview/route");
    const res = await GET(
      await jsonRequest(
        "http://localhost/api/admin/display/preview?templateKey=nope",
        "GET"
      )
    );
    expect(res.status).toBe(404);
  });
});
