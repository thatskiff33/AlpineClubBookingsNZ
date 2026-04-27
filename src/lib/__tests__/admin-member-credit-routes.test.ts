import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  getMemberCreditBalance: vi.fn(),
  getAdminMemberCreditHistory: vi.fn(),
  getPendingAdminAdjustmentRequests: vi.fn(),
  createAdminAdjustmentRequest: vi.fn(),
  reviewAdminAdjustmentRequest: vi.fn(),
  getClientIp: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/member-credit", () => ({
  getMemberCreditBalance: mocks.getMemberCreditBalance,
  getAdminMemberCreditHistory: mocks.getAdminMemberCreditHistory,
  getPendingAdminAdjustmentRequests: mocks.getPendingAdminAdjustmentRequests,
  createAdminAdjustmentRequest: mocks.createAdminAdjustmentRequest,
  reviewAdminAdjustmentRequest: mocks.reviewAdminAdjustmentRequest,
}));

vi.mock("@/lib/rate-limit", () => ({
  getClientIp: mocks.getClientIp,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  POST as createAdjustmentRequest,
} from "@/app/api/admin/members/[id]/credits/route";

describe("admin member credit routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.auth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN" },
    });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.getClientIp.mockReturnValue("127.0.0.1");
  });

  it("requires an idempotency key when creating an adjustment request", async () => {
    const request = new NextRequest("http://localhost/api/admin/members/member-1/credits", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amountCents: 2500,
        description: "Goodwill credit",
      }),
    });

    const response = await createAdjustmentRequest(request, {
      params: Promise.resolve({ id: "member-1" }),
    });

    expect(response.status).toBe(400);
    expect(mocks.createAdminAdjustmentRequest).not.toHaveBeenCalled();
  });

  it("passes the idempotency key through and returns replay metadata", async () => {
    mocks.createAdminAdjustmentRequest.mockResolvedValue({
      request: {
        id: "req-1",
        status: "PENDING",
      },
      replayed: true,
    });

    const request = new NextRequest("http://localhost/api/admin/members/member-1/credits", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "127.0.0.1",
      },
      body: JSON.stringify({
        amountCents: 2500,
        description: "Goodwill credit",
        idempotencyKey: "9a13b0af-7ffc-451b-a50b-81f6fb8630f4",
      }),
    });

    const response = await createAdjustmentRequest(request, {
      params: Promise.resolve({ id: "member-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.createAdminAdjustmentRequest).toHaveBeenCalledWith(
      "member-1",
      2500,
      "Goodwill credit",
      "admin-1",
      "9a13b0af-7ffc-451b-a50b-81f6fb8630f4",
      "127.0.0.1"
    );
    expect(body).toMatchObject({
      success: true,
      requestId: "req-1",
      requestStatus: "PENDING",
      replayed: true,
    });
  });
});
