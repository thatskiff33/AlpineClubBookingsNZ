import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  contentAdminSession,
  financeAdminSession,
  readOnlyAdminSession,
} from "./helpers/admin-area-gate-sessions";

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

vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/member-credit", () => ({
  getMemberCreditBalance: mocks.getMemberCreditBalance,
  getAdminMemberCreditHistory: mocks.getAdminMemberCreditHistory,
  getPendingAdminAdjustmentRequests: mocks.getPendingAdminAdjustmentRequests,
  createAdminAdjustmentRequest: mocks.createAdminAdjustmentRequest,
  reviewAdminAdjustmentRequest: mocks.reviewAdminAdjustmentRequest,
  // #3369: the one home for the account-credit refusal four settlement paths
  // share. Real, not stubbed: the mock must not turn a refusal into a pass.
  requireMemberCreditRecipient: (memberId: string | null) => {
    if (!memberId) throw new Error("no account to credit (#3369)");
    return memberId;
  },
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
      user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
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

// ---------------------------------------------------------------------------
// Per-area gate (#2921 / the fork PR #2949 shape). The POST declares
// `{ area: "finance", level: "edit" }`. Before the sweep the mock never received
// it, so this route was exercised only as "is this person in the admin portal",
// and moving the literal to `{ area: "overview", level: "view" }` — the exact
// downgrade that left 83 tests green on #2949 — would not have been noticed here.
// ---------------------------------------------------------------------------
describe("per-area gate on POST /api/admin/members/[id]/credits (#2921)", () => {
  function creditRequest() {
    return new NextRequest(
      "http://localhost/api/admin/members/member-1/credits",
      {
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
      },
    );
  }

  const routeParams = { params: Promise.resolve({ id: "member-1" }) };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.getClientIp.mockReturnValue("127.0.0.1");
    mocks.createAdminAdjustmentRequest.mockResolvedValue({
      request: { id: "req-1", status: "PENDING" },
      replayed: false,
    });
  });

  it("refuses a view-only admin, so the level half of finance:edit is real", async () => {
    mocks.auth.mockResolvedValue(readOnlyAdminSession);

    const response = await createAdjustmentRequest(creditRequest(), routeParams);

    expect(response.status).toBe(403);
    expect(mocks.createAdminAdjustmentRequest).not.toHaveBeenCalled();
  });

  it("refuses an admin with no finance access, so the area half is real", async () => {
    mocks.auth.mockResolvedValue(contentAdminSession);

    const response = await createAdjustmentRequest(creditRequest(), routeParams);

    expect(response.status).toBe(403);
    expect(mocks.createAdminAdjustmentRequest).not.toHaveBeenCalled();
  });

  it("admits a finance-editing admin, so the gate is not simply shut", async () => {
    mocks.auth.mockResolvedValue(financeAdminSession);

    const response = await createAdjustmentRequest(creditRequest(), routeParams);

    expect(response.status).toBe(200);
    expect(mocks.createAdminAdjustmentRequest).toHaveBeenCalled();
  });
});
