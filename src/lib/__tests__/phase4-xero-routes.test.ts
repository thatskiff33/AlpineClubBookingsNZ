import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  syncContactsFromXero: vi.fn(),
  importMembersFromXeroGroups: vi.fn(),
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/xero", () => ({
  syncContactsFromXero: mocks.syncContactsFromXero,
  importMembersFromXeroGroups: mocks.importMembersFromXeroGroups,
  XeroDailyLimitError: class XeroDailyLimitError extends Error {},
}));
vi.mock("@/lib/xero-api-errors", () => ({
  getXeroApiErrorInfo: vi.fn((error: unknown, fallback: string) => ({
    handled: false,
    message: error instanceof Error ? error.message : fallback,
    status: 500,
  })),
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));

describe("Phase 4 Xero admin routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "admin_1", role: "ADMIN" } });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
  });

  it("defaults sync contacts to incremental mode when no body is provided", async () => {
    mocks.syncContactsFromXero.mockResolvedValue({
      created: [],
      updated: [],
      skippedNoChanges: 0,
      skippedNoEmail: [],
      skippedOther: [],
      errors: [],
      total: 0,
    });

    const { POST } = await import("@/app/api/admin/xero/sync-contacts/route");
    const res = await POST();

    expect(res.status).toBe(200);
    expect(mocks.syncContactsFromXero).toHaveBeenCalledWith({});
  });

  it("passes explicit repair flags through the sync contacts route", async () => {
    mocks.syncContactsFromXero.mockResolvedValue({
      created: [],
      updated: [],
      skippedNoChanges: 0,
      skippedNoEmail: [],
      skippedOther: [],
      errors: [],
      total: 0,
    });

    const { POST } = await import("@/app/api/admin/xero/sync-contacts/route");
    const req = new NextRequest("http://localhost/api/admin/xero/sync-contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullResync: true,
        backfillJoinedDates: true,
      }),
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mocks.syncContactsFromXero).toHaveBeenCalledWith({
      fullResync: true,
      backfillJoinedDates: true,
    });
  });

  it("passes the cached-import repair flag through the import members route", async () => {
    mocks.importMembersFromXeroGroups.mockResolvedValue({
      created: 0,
      createdAsDependent: 0,
      skippedExisting: 0,
      linkedExisting: 0,
      skippedNoEmail: 0,
      skippedNoEmailDetails: [],
      errors: 0,
      errorDetails: [],
      groupsProcessed: [],
    });

    const { POST } = await import("@/app/api/admin/xero/import-members/route");
    const req = new NextRequest("http://localhost/api/admin/xero/import-members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        groupMappings: [
          {
            groupId: "group_1",
            groupName: "Adults",
            ageTier: "ADULT",
          },
        ],
        sendInvites: false,
        repairMissingContactCache: true,
      }),
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mocks.importMembersFromXeroGroups).toHaveBeenCalledWith(
      [{ groupId: "group_1", groupName: "Adults", ageTier: "ADULT" }],
      false,
      { allowLiveXeroFetch: true }
    );
  });
});
