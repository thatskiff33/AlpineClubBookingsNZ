import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Multi-lodge phase 7 retrofit for the admin chore roster: the route must
// honour an explicit ?lodgeId=, reject unknown/inactive lodges, and keep
// falling back to the default lodge when the parameter is omitted.

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  lodgeFindFirst: vi.fn(),
  lodgeFindUnique: vi.fn(),
  getAdminRosterForDate: vi.fn(),
  updateAdminRosterForDate: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () => {
    const session = await mocks.auth();
    if (!session?.user?.id) {
      return {
        ok: false,
        response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
      };
    }
    return { ok: true, session };
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodge: {
      findFirst: mocks.lodgeFindFirst,
      findUnique: mocks.lodgeFindUnique,
    },
  },
}));

vi.mock("@/lib/admin-roster-service", () => ({
  getAdminRosterForDate: mocks.getAdminRosterForDate,
  updateAdminRosterForDate: mocks.updateAdminRosterForDate,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn() },
}));

import { GET, PUT } from "@/app/api/admin/roster/[date]/route";

const dateParams = { params: Promise.resolve({ date: "2026-07-10" }) };

describe("admin roster lodge scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mocks.lodgeFindFirst.mockResolvedValue({ id: "lodge-default" });
    mocks.getAdminRosterForDate.mockResolvedValue({ body: { ok: true }, init: undefined });
    mocks.updateAdminRosterForDate.mockResolvedValue({ body: { ok: true }, init: undefined });
  });

  it("falls back to the default lodge when no lodgeId is given", async () => {
    const req = new NextRequest("http://localhost/api/admin/roster/2026-07-10");
    const res = await GET(req, dateParams);

    expect(res.status).toBe(200);
    expect(mocks.getAdminRosterForDate).toHaveBeenCalledWith(
      expect.objectContaining({ lodgeId: "lodge-default" }),
    );
    expect(mocks.lodgeFindUnique).not.toHaveBeenCalled();
  });

  it("scopes the roster to an explicitly requested active lodge", async () => {
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });

    const req = new NextRequest(
      "http://localhost/api/admin/roster/2026-07-10?lodgeId=lodge-2",
    );
    const res = await GET(req, dateParams);

    expect(res.status).toBe(200);
    expect(mocks.getAdminRosterForDate).toHaveBeenCalledWith(
      expect.objectContaining({ lodgeId: "lodge-2" }),
    );
    expect(mocks.lodgeFindFirst).not.toHaveBeenCalled();
  });

  it("rejects an unknown or inactive lodgeId with 400", async () => {
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: false });

    const req = new NextRequest(
      "http://localhost/api/admin/roster/2026-07-10?lodgeId=lodge-2",
    );
    const res = await GET(req, dateParams);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: "ROSTER_LODGE_INVALID" });
    expect(mocks.getAdminRosterForDate).not.toHaveBeenCalled();
  });

  it("scopes roster mutations to the requested lodge", async () => {
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });

    const req = new NextRequest(
      "http://localhost/api/admin/roster/2026-07-10?lodgeId=lodge-2",
      {
        method: "PUT",
        body: JSON.stringify({ action: "confirm" }),
        headers: { "Content-Type": "application/json" },
      },
    );
    const res = await PUT(req, dateParams);

    expect(res.status).toBe(200);
    expect(mocks.updateAdminRosterForDate).toHaveBeenCalledWith(
      expect.objectContaining({ lodgeId: "lodge-2" }),
    );
  });

  it("returns a stable actionable load error without leaking the exception", async () => {
    mocks.getAdminRosterForDate.mockRejectedValueOnce(new Error("secret database detail"));
    const req = new NextRequest("http://localhost/api/admin/roster/2026-07-10");
    const res = await GET(req, dateParams);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      code: "ROSTER_LOAD_FAILED",
      error: "Roster could not be loaded because the service is unavailable. Try again.",
    });
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  // The real body schema parses these, so the save carries a whole draft.
  const SAVE_BODY = { action: "save", baseRevision: "rev-1", acknowledgeCompletedReset: false, assignments: [] };
  it.each([
    [SAVE_BODY, "ROSTER_SERVICE_UNAVAILABLE", "Roster not saved because the service could not be reached. Your draft is still here; try Save again."],
    [{ action: "confirm" }, "ROSTER_ACTION_FAILED", "Roster action could not be completed because the service is unavailable. Nothing was changed; try again."],
  ])("returns a stable outer-route %o failure", async (requestBody, code, error) => {
    mocks.updateAdminRosterForDate.mockRejectedValueOnce(new Error("secret route detail"));
    const req = new NextRequest("http://localhost/api/admin/roster/2026-07-10", {
      method: "PUT",
      body: JSON.stringify(requestBody),
      headers: { "Content-Type": "application/json" },
    });
    const res = await PUT(req, dateParams);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ code, error });
    expect(JSON.stringify(body)).not.toContain("secret");
  });
});
