import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `GET|PUT /api/admin/lodges/[id]/roster-settings` (#2942).
 *
 * The route decides how much of one member's name another member learns, so
 * what is worth pinning is narrow and specific: the permission it demands on
 * each verb, that it refuses a value outside the four levels rather than
 * writing it, that the audit row records the level BEFORE as well as after and
 * files the category the lodge-records subsystem is pinned to, and that it
 * answers while the roster module is off — because choosing the level before
 * switching the roster on is the reason this setting exists separately.
 */

const { mockPrisma, mockRequireAdmin, mockCreateAuditLog, mockModuleFlags } =
  vi.hoisted(() => ({
    // `$transaction` RUNS the callback against the same doubles rather than
    // returning a canned value, so the read-then-write the route performs
    // inside it is really exercised. A double that resolved without calling
    // back would make every assertion below pass without the route doing
    // anything.
    mockPrisma: (() => {
      const client = {
        lodge: { findUnique: vi.fn(), update: vi.fn() },
        $transaction: vi.fn(),
      };
      client.$transaction.mockImplementation(
        async (fn: (tx: typeof client) => unknown) => fn(client)
      );
      return client;
    })(),
    mockRequireAdmin: vi.fn(),
    mockCreateAuditLog: vi.fn().mockResolvedValue(undefined),
    mockModuleFlags: vi.fn(),
  }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));
vi.mock("@/lib/audit", () => ({
  createAuditLog: (...args: unknown[]) => mockCreateAuditLog(...args),
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: (...args: unknown[]) => mockModuleFlags(...args),
}));

const ROUTE = "@/app/api/admin/lodges/[id]/roster-settings/route";

function params(id = "lodge-whakapapa") {
  return { params: Promise.resolve({ id }) };
}

async function putRequest(body: unknown) {
  return new Request("http://localhost/api/admin/lodges/x/roster-settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  mockPrisma.lodge.findUnique.mockResolvedValue({
    id: "lodge-whakapapa",
    name: "Whakapapa River Lodge",
    rosterNameGranularity: "FIRST_NAME_ONLY",
  });
  mockPrisma.lodge.update.mockResolvedValue({});
  mockModuleFlags.mockResolvedValue({ memberLodgeRoster: true });
});

describe("GET /api/admin/lodges/[id]/roster-settings", () => {
  it("reads with lodge:view and reports the level, the default and the module state", async () => {
    const { GET } = await import(ROUTE);
    const res = await GET(new Request("http://localhost/x"), params());

    expect(mockRequireAdmin).toHaveBeenCalledWith({
      permission: { area: "lodge", level: "view" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      lodgeId: "lodge-whakapapa",
      lodgeName: "Whakapapa River Lodge",
      rosterNameGranularity: "FIRST_NAME_ONLY",
      // The screen is TOLD the fallback rather than restating it, so it cannot
      // drift from the one the roster reads. It is deliberately not the lobby
      // display's default.
      defaultRosterNameGranularity: "FULL_NAME",
      memberLodgeRosterEnabled: true,
    });
  });

  it("still answers while the roster module is off", async () => {
    mockModuleFlags.mockResolvedValue({ memberLodgeRoster: false });
    const { GET } = await import(ROUTE);
    const res = await GET(new Request("http://localhost/x"), params());

    expect(res.status).toBe(200);
    expect((await res.json()).memberLodgeRosterEnabled).toBe(false);
  });

  it("404s an unknown lodge", async () => {
    mockPrisma.lodge.findUnique.mockResolvedValue(null);
    const { GET } = await import(ROUTE);
    expect((await GET(new Request("http://localhost/x"), params())).status).toBe(
      404,
    );
  });
});

describe("PUT /api/admin/lodges/[id]/roster-settings", () => {
  it("writes the level under lodge:edit and audits both sides of the change", async () => {
    const { PUT } = await import(ROUTE);
    const res = await PUT(
      await putRequest({ rosterNameGranularity: "COUNTS_ONLY" }),
      params(),
    );

    expect(mockRequireAdmin).toHaveBeenCalledWith({
      permission: { area: "lodge", level: "edit" },
    });
    expect(res.status).toBe(200);
    expect(mockPrisma.lodge.update).toHaveBeenCalledWith({
      where: { id: "lodge-whakapapa" },
      data: { rosterNameGranularity: "COUNTS_ONLY" },
    });
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "LODGE_MEMBER_ROSTER_SETTINGS_UPDATED",
        // `admin`, matching every other writer under /api/admin/lodges/ —
        // INV-PRIV-013 pins that subsystem as uniform, and the sibling display
        // writer's `lodge` belongs to a different subsystem.
        category: "admin",
        entityType: "Lodge",
        entityId: "lodge-whakapapa",
        metadata: {
          before: { rosterNameGranularity: "FIRST_NAME_ONLY" },
          after: { rosterNameGranularity: "COUNTS_ONLY" },
        },
      }),
    );
  });

  it("clears the per-lodge choice when sent null", async () => {
    const { PUT } = await import(ROUTE);
    const res = await PUT(
      await putRequest({ rosterNameGranularity: null }),
      params(),
    );

    expect(res.status).toBe(200);
    expect(mockPrisma.lodge.update).toHaveBeenCalledWith({
      where: { id: "lodge-whakapapa" },
      data: { rosterNameGranularity: null },
    });
  });

  it("refuses a level outside the four, and writes nothing", async () => {
    const { PUT } = await import(ROUTE);
    const res = await PUT(
      await putRequest({ rosterNameGranularity: "EVERYTHING" }),
      params(),
    );

    expect(res.status).toBe(400);
    expect(mockPrisma.lodge.update).not.toHaveBeenCalled();
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });

  it("refuses an unrelated field rather than ignoring it", async () => {
    // `.strict()`: a caller aiming at `displayNameGranularity` — the lobby
    // screen's twin of this column — must be told it reached the wrong route,
    // not silently have its change dropped.
    const { PUT } = await import(ROUTE);
    const res = await PUT(
      await putRequest({
        rosterNameGranularity: "FULL_NAME",
        displayNameGranularity: "FULL_NAME",
      }),
      params(),
    );

    expect(res.status).toBe(400);
    expect(mockPrisma.lodge.update).not.toHaveBeenCalled();
  });

  it("404s an unknown lodge before writing or auditing", async () => {
    mockPrisma.lodge.findUnique.mockResolvedValue(null);
    const { PUT } = await import(ROUTE);
    const res = await PUT(
      await putRequest({ rosterNameGranularity: "FULL_NAME" }),
      params(),
    );

    expect(res.status).toBe(404);
    expect(mockPrisma.lodge.update).not.toHaveBeenCalled();
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });

  it("passes a refused guard's own response straight back", async () => {
    const { NextResponse } = await import("next/server");
    mockRequireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });
    const { PUT } = await import(ROUTE);
    const res = await PUT(
      await putRequest({ rosterNameGranularity: "FULL_NAME" }),
      params(),
    );

    expect(res.status).toBe(403);
    expect(mockPrisma.lodge.update).not.toHaveBeenCalled();
  });
});
