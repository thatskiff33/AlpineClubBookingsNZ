import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  refreshAllMembershipStatuses: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/xero", () => ({
  refreshAllMembershipStatuses: mocks.refreshAllMembershipStatuses,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: mocks.loggerError,
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import { POST } from "@/app/api/admin/xero/sync-memberships/route";

describe("POST /api/admin/xero/sync-memberships", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.refreshAllMembershipStatuses.mockResolvedValue({
      seasonYear: 2026,
      cursorFrom: null,
      cursorTo: "2026-04-27T00:00:00.000Z",
      mode: "incremental",
      changedInvoices: 0,
      changedInvoiceIds: [],
      affectedMembers: 0,
      checked: 0,
      updated: 0,
      errors: 0,
      errorDetails: [],
    });
  });

  it("defaults the membership refresh to incremental mode", async () => {
    const response = await POST(
      new NextRequest(
        "http://localhost/api/admin/xero/sync-memberships?seasonYear=2026",
        { method: "POST" }
      )
    );

    expect(response.status).toBe(200);
    expect(mocks.refreshAllMembershipStatuses).toHaveBeenCalledWith(2026, {
      includeBackfillCandidates: false,
    });
  });

  it("runs the membership refresh in backfill mode when requested", async () => {
    const response = await POST(
      new NextRequest(
        "http://localhost/api/admin/xero/sync-memberships?seasonYear=2026&mode=backfill",
        { method: "POST" }
      )
    );

    expect(response.status).toBe(200);
    expect(mocks.refreshAllMembershipStatuses).toHaveBeenCalledWith(2026, {
      includeBackfillCandidates: true,
    });
  });

  it("rejects invalid season years before calling the refresh", async () => {
    const response = await POST(
      new NextRequest(
        "http://localhost/api/admin/xero/sync-memberships?seasonYear=2019",
        { method: "POST" }
      )
    );

    expect(response.status).toBe(400);
    expect(mocks.refreshAllMembershipStatuses).not.toHaveBeenCalled();
  });

  it("rejects invalid sync modes before calling the refresh", async () => {
    const response = await POST(
      new NextRequest(
        "http://localhost/api/admin/xero/sync-memberships?mode=full",
        { method: "POST" }
      )
    );

    expect(response.status).toBe(400);
    expect(mocks.refreshAllMembershipStatuses).not.toHaveBeenCalled();
  });
});
