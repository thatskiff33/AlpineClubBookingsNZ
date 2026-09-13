import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lodgeFindUnique: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  createAuditLog: vi.fn(),
  parseJsonBody: vi.fn(),
  readGuard: vi.fn(),
  writeGuard: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { lodge: { findUnique: mocks.lodgeFindUnique } },
}));
vi.mock("@/lib/bed-allocation-admin-settings", () => ({
  getEffectiveBedAllocationSettings: mocks.getSettings,
  updateBedAllocationSettings: mocks.updateSettings,
}));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.createAuditLog }));
vi.mock("@/lib/api-json", () => ({
  parseJsonRequestBody: mocks.parseJsonBody,
}));
vi.mock("@/lib/admin-bed-allocation-routes", () => ({
  requireBedAllocationRead: mocks.readGuard,
  requireBedAllocationWrite: mocks.writeGuard,
  bedAllocationErrorResponse: (error: { message?: string; status?: number }) =>
    Response.json(
      { error: error.message ?? "Bed allocation request failed" },
      { status: error.status ?? 500 },
    ),
}));

import {
  GET,
  PUT,
} from "@/app/api/admin/bed-allocation/settings/route";

const session = { user: { id: "admin-1" } };
const settings = {
  autoAllocationEnabled: true,
  allocationPriorityOrder: ["BOOKING_COHESION"],
};

describe("bed-allocation settings route lodge validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readGuard.mockResolvedValue({ ok: true, session });
    mocks.writeGuard.mockResolvedValue({ ok: true, session });
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-1", active: true });
    mocks.getSettings.mockResolvedValue(settings);
    mocks.updateSettings.mockResolvedValue(settings);
    mocks.createAuditLog.mockResolvedValue({});
    mocks.parseJsonBody.mockResolvedValue({
      ok: true,
      body: {
        lodgeId: "lodge-1",
        autoAllocationEnabled: false,
        allocationPriorityOrder: [],
      },
    });
  });

  it("rejects GET with the read guard before resolving or reading a lodge", async () => {
    const denied = Response.json({ error: "Forbidden" }, { status: 403 });
    mocks.readGuard.mockResolvedValue({ ok: false, response: denied });

    const response = await GET(
      new Request(
        "http://localhost/api/admin/bed-allocation/settings?lodgeId=lodge-1",
      ),
    );

    expect(response).toBe(denied);
    expect(mocks.readGuard).toHaveBeenCalledOnce();
    expect(mocks.writeGuard).not.toHaveBeenCalled();
    expect(mocks.lodgeFindUnique).not.toHaveBeenCalled();
    expect(mocks.getSettings).not.toHaveBeenCalled();
    expect(mocks.updateSettings).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("rejects PUT with the write guard before parsing, reading, writing, or auditing", async () => {
    const denied = Response.json({ error: "Forbidden" }, { status: 403 });
    mocks.writeGuard.mockResolvedValue({ ok: false, response: denied });

    const response = await PUT(
      new Request("http://localhost/api/admin/bed-allocation/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deliberately: "invalid" }),
      }),
    );

    expect(response).toBe(denied);
    expect(mocks.writeGuard).toHaveBeenCalledOnce();
    expect(mocks.readGuard).not.toHaveBeenCalled();
    expect(mocks.parseJsonBody).not.toHaveBeenCalled();
    expect(mocks.lodgeFindUnique).not.toHaveBeenCalled();
    expect(mocks.getSettings).not.toHaveBeenCalled();
    expect(mocks.updateSettings).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it.each([null, { id: "lodge-1", active: false }])(
    "rejects an unknown or inactive lodge on GET",
    async (lodge) => {
      mocks.lodgeFindUnique.mockResolvedValue(lodge);

      const response = await GET(
        new Request(
          "http://localhost/api/admin/bed-allocation/settings?lodgeId=lodge-1",
        ),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Lodge not found or not active",
      });
      expect(mocks.getSettings).not.toHaveBeenCalled();
    },
  );

  it("loads settings only after resolving the active lodge", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/admin/bed-allocation/settings?lodgeId=lodge-1",
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.lodgeFindUnique).toHaveBeenCalledWith({
      where: { id: "lodge-1" },
      select: { id: true, active: true },
    });
    expect(mocks.getSettings).toHaveBeenCalledWith(undefined, "lodge-1");
  });

  it("rejects an inactive lodge on PUT before writing or auditing", async () => {
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-1", active: false });

    const response = await PUT(
      new Request("http://localhost/api/admin/bed-allocation/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lodgeId: "lodge-1",
          autoAllocationEnabled: false,
          allocationPriorityOrder: [],
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("preserves an explicitly empty priority order for an active lodge", async () => {
    mocks.updateSettings.mockResolvedValue({
      autoAllocationEnabled: false,
      allocationPriorityOrder: [],
    });

    const response = await PUT(
      new Request("http://localhost/api/admin/bed-allocation/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lodgeId: "lodge-1",
          autoAllocationEnabled: false,
          allocationPriorityOrder: [],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.updateSettings).toHaveBeenCalledWith({
      lodgeId: "lodge-1",
      updatedByMemberId: "admin-1",
      autoAllocationEnabled: false,
      allocationPriorityOrder: [],
    });
  });

  /**
   * #2931 — the write contract is exactly three fields, and stays that way.
   *
   * `GET` answers with the EFFECTIVE settings view, which carries six read-only
   * provenance fields beside the two editable ones. The editor used to send
   * that whole object back, and this `.strict()` schema refused it with 400
   * "Invalid input" — so no save from Allocation preferences ever landed. The
   * fix narrows the client; this pins the server half of that seam, so a future
   * caller that spreads a GET response into a PUT is refused loudly here
   * instead of silently in a browser.
   */
  it("refuses a PUT body carrying the read-only provenance fields", async () => {
    const effective = {
      autoAllocationEnabled: true,
      allocationPriorityOrder: ["BOOKING_COHESION"],
      authoritativeLodgeId: "lodge-1",
      settingsId: "lodge-1",
      source: "LODGE",
      fallback: "NONE",
      updatedByMemberId: "admin-1",
      updatedAt: "2026-07-01T00:00:00.000Z",
    };
    mocks.parseJsonBody.mockResolvedValue({
      ok: true,
      body: { ...effective, lodgeId: "lodge-1" },
    });

    const response = await PUT(
      new Request("http://localhost/api/admin/bed-allocation/settings", {
        method: "PUT",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Invalid input" });
    expect(mocks.updateSettings).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown value", ["UNKNOWN_PRIORITY"]],
    ["a duplicate value", ["BOOKING_COHESION", "BOOKING_COHESION"]],
  ])(
    "rejects priority order containing %s before writing",
    async (_case, value) => {
      mocks.parseJsonBody.mockResolvedValue({
        ok: true,
        body: {
          lodgeId: "lodge-1",
          autoAllocationEnabled: false,
          allocationPriorityOrder: value,
        },
      });

      const response = await PUT(
        new Request("http://localhost/api/admin/bed-allocation/settings", {
          method: "PUT",
        }),
      );

      expect(response.status).toBe(400);
      expect(mocks.updateSettings).not.toHaveBeenCalled();
      expect(mocks.createAuditLog).not.toHaveBeenCalled();
    },
  );
});
