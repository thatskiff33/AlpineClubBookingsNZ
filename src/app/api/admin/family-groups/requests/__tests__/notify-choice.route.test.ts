import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// #1789 route-threading contract (mirrors cancel-notify-choice.test.ts): the
// admin family-group requests PUT route threads an optional `notifyMember`
// boolean into the review service via the existing zod schema. Absent = notify
// (undefined), false/true are passed through, and a non-boolean is rejected by
// the existing parse (422) before the service runs. The service module is
// mocked but keeps its REAL schema so the parse behaviour is exercised.
const h = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  reviewAdminFamilyGroupRequest: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: h.requireAdmin,
}));

vi.mock("@/lib/admin-family-group-requests-service", async (importActual) => {
  const actual =
    (await importActual()) as typeof import("@/lib/admin-family-group-requests-service");
  return {
    ...actual,
    reviewAdminFamilyGroupRequest: h.reviewAdminFamilyGroupRequest,
  };
});

import { PUT } from "@/app/api/admin/family-groups/requests/route";

function req(body: unknown) {
  return new NextRequest("http://localhost/api/admin/family-groups/requests", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  h.reviewAdminFamilyGroupRequest.mockResolvedValue({
    body: { success: true, action: "approve" },
    init: undefined,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("PUT /api/admin/family-groups/requests notify choice (#1789)", () => {
  it("threads notifyMember as undefined (= notify) when the flag is omitted", async () => {
    const res = await PUT(req({ requestId: "req-1", action: "approve" }));

    expect(res.status).toBe(200);
    expect(h.reviewAdminFamilyGroupRequest).toHaveBeenCalledTimes(1);
    const arg = h.reviewAdminFamilyGroupRequest.mock.calls[0][0];
    expect(arg.data.notifyMember).toBeUndefined();
  });

  it("threads notifyMember: false through to the service", async () => {
    const res = await PUT(
      req({ requestId: "req-1", action: "approve", notifyMember: false })
    );

    expect(res.status).toBe(200);
    expect(h.reviewAdminFamilyGroupRequest).toHaveBeenCalledTimes(1);
    const arg = h.reviewAdminFamilyGroupRequest.mock.calls[0][0];
    expect(arg.data).toMatchObject({ notifyMember: false });
  });

  it("threads notifyMember: true through to the service", async () => {
    const res = await PUT(
      req({ requestId: "req-1", action: "reject", notifyMember: true })
    );

    expect(res.status).toBe(200);
    const arg = h.reviewAdminFamilyGroupRequest.mock.calls[0][0];
    expect(arg.data).toMatchObject({ notifyMember: true });
  });

  it("rejects a non-boolean notifyMember via the existing parse (422), no service call", async () => {
    const res = await PUT(
      req({ requestId: "req-1", action: "approve", notifyMember: "false" })
    );

    expect(res.status).toBe(422);
    expect(h.reviewAdminFamilyGroupRequest).not.toHaveBeenCalled();
  });
});
