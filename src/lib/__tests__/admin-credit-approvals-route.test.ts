import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  getAdminAdjustmentRequests: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/member-credit", () => ({
  getAdminAdjustmentRequests: mocks.getAdminAdjustmentRequests,
}));

import { GET } from "@/app/api/admin/credit-approvals/route";

describe("GET /api/admin/credit-approvals", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.auth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN" },
    });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.getAdminAdjustmentRequests.mockResolvedValue([
      {
        id: "req-1",
        status: "PENDING",
      },
    ]);
  });

  it("defaults to pending requests", async () => {
    const request = new NextRequest("http://localhost/api/admin/credit-approvals");

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.getAdminAdjustmentRequests).toHaveBeenCalledWith("PENDING");
    expect(body).toEqual([
      {
        id: "req-1",
        status: "PENDING",
      },
    ]);
  });

  it("accepts ALL as a filter", async () => {
    const request = new NextRequest(
      "http://localhost/api/admin/credit-approvals?status=ALL"
    );

    await GET(request);

    expect(mocks.getAdminAdjustmentRequests).toHaveBeenCalledWith("ALL");
  });
});
