import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  getStuckStateDashboard: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/stuck-state-dashboard", () => ({
  getStuckStateDashboard: mocks.getStuckStateDashboard,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: mocks.loggerError,
  },
}));

import { GET } from "@/app/api/admin/stuck-states/route";

describe("GET /api/admin/stuck-states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({
      user: {
        id: "admin-1",
        role: "ADMIN",
        accessRoles: [{ role: "ADMIN" }],
      },
    });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.getStuckStateDashboard.mockResolvedValue({
      generatedAt: "2026-06-22T00:00:00.000Z",
      totals: {
        affectedCount: 0,
        itemCount: 0,
        critical: 0,
        warning: 0,
        info: 0,
      },
      domains: [],
      items: [],
    });
  });

  it("returns the stuck-state dashboard for admins", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      generatedAt: "2026-06-22T00:00:00.000Z",
      totals: {
        itemCount: 0,
      },
    });
  });

  // #2823: a Full Admin holds membership:view, so the named member /
  // booking-owner detail rows are requested.
  it("passes viewerCanViewMembership=true for a caller with membership:view", async () => {
    await GET();

    expect(mocks.getStuckStateDashboard).toHaveBeenCalledWith({
      viewerCanViewMembership: true,
      // #4162: and finance:view, for the voided bank refund notes' panel link.
      viewerCanViewFinance: true,
    });
  });

  // #2823: a support-only admin (support:view, membership:none) reaches the
  // dashboard but must not receive the membership-roll rows. The guard admits
  // them (support portal access); the route drops the names.
  it("passes viewerCanViewMembership=false for a support-only admin without membership:view", async () => {
    mocks.auth.mockResolvedValue({
      user: {
        id: "support-1",
        role: "MEMBER",
        accessRoles: [],
        adminPermissionMatrix: { support: "view" },
      },
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(mocks.getStuckStateDashboard).toHaveBeenCalledWith({
      viewerCanViewMembership: false,
      viewerCanViewFinance: false,
    });
  });

  it("rejects non-admin sessions", async () => {
    mocks.auth.mockResolvedValue({
      user: {
        id: "member-1",
        role: "MEMBER",
        accessRoles: [{ role: "USER" }],
      },
    });

    const response = await GET();

    expect(response.status).toBe(403);
    expect(mocks.getStuckStateDashboard).not.toHaveBeenCalled();
  });

  it("returns a bounded failure if the dashboard cannot be built", async () => {
    mocks.getStuckStateDashboard.mockRejectedValue(new Error("database down"));

    const response = await GET();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to load stuck-state dashboard",
    });
    expect(mocks.loggerError).toHaveBeenCalled();
  });
});
