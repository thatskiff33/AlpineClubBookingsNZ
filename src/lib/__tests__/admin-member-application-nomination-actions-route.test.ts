import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => {
  class MockMembershipApplicationError extends Error {
    status: number;

    constructor(message: string, status = 400) {
      super(message);
      this.status = status;
    }
  }

  return {
    auth: vi.fn(),
    requireActiveSessionUser: vi.fn(),
    refreshMemberApplicationNominations: vi.fn(),
    replaceMemberApplicationNominator: vi.fn(),
    MockMembershipApplicationError,
  };
});

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/member-application-fields", () => ({
  MembershipApplicationError: mocks.MockMembershipApplicationError,
}));

vi.mock("@/lib/nomination", () => ({
  refreshMemberApplicationNominations: mocks.refreshMemberApplicationNominations,
  replaceMemberApplicationNominator: mocks.replaceMemberApplicationNominator,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn() },
}));

function postRequest(path: string, body?: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
  });
}

describe("admin member application nomination action routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
    });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.refreshMemberApplicationNominations.mockResolvedValue({
      refreshedCount: 1,
      emailWarnings: [],
    });
    mocks.replaceMemberApplicationNominator.mockResolvedValue({
      replacementNominatorId: "nom-3",
      emailWarnings: [],
    });
  });

  it("refreshes pending nomination workflow links for admins", async () => {
    const { POST } = await import(
      "@/app/api/admin/member-applications/[id]/nominations/refresh/route"
    );

    const response = await POST(postRequest("/api/admin/member-applications/app-1/nominations/refresh"), {
      params: Promise.resolve({ id: "app-1" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      refreshedCount: 1,
      warnings: [],
    });
    expect(mocks.refreshMemberApplicationNominations).toHaveBeenCalledWith(
      "app-1",
      "admin-1"
    );
  });

  it("replaces an unconfirmed nominator for admins", async () => {
    const { POST } = await import(
      "@/app/api/admin/member-applications/[id]/nominators/[slot]/replace/route"
    );

    const response = await POST(
      postRequest(
        "/api/admin/member-applications/app-1/nominators/nominator1/replace",
        { memberId: "nom-3" }
      ),
      {
        params: Promise.resolve({ id: "app-1", slot: "nominator1" }),
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      replacementNominatorId: "nom-3",
      warnings: [],
    });
    expect(mocks.replaceMemberApplicationNominator).toHaveBeenCalledWith({
      applicationId: "app-1",
      slot: "nominator1",
      replacementMemberId: "nom-3",
      adminMemberId: "admin-1",
    });
  });

  it("rejects invalid nominator slots before calling the service", async () => {
    const { POST } = await import(
      "@/app/api/admin/member-applications/[id]/nominators/[slot]/replace/route"
    );

    const response = await POST(
      postRequest("/api/admin/member-applications/app-1/nominators/bad/replace", {
        memberId: "nom-3",
      }),
      {
        params: Promise.resolve({ id: "app-1", slot: "bad" }),
      }
    );

    expect(response.status).toBe(400);
    expect(mocks.replaceMemberApplicationNominator).not.toHaveBeenCalled();
  });
});
