import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Route-level threading for the per-review applicant-email choice (#1786). The
// PUT route is requireAdmin()-gated, so the flag is admin-only by construction;
// an omitted flag threads as undefined (= notify) and a non-boolean falls out as
// this route's existing schema-validation response (422 — 400 is reserved for
// invalid JSON here).
const h = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  approveMemberApplication: vi.fn(),
  rejectMemberApplication: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/nomination", () => ({
  approveMemberApplication: h.approveMemberApplication,
  rejectMemberApplication: h.rejectMemberApplication,
}));
// The route's `instanceof MembershipApplicationError` reads the real class from
// `@/lib/member-application-fields`; the happy paths here never throw it.
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { PUT } from "@/app/api/admin/member-applications/[id]/route";

function req(body: unknown) {
  return new NextRequest("http://localhost/api/admin/member-applications/app-1", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const params = Promise.resolve({ id: "app-1" });

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  h.approveMemberApplication.mockResolvedValue({
    application: { status: "APPROVED" },
    applicantMember: { id: "member-1" },
    warnings: [],
  });
  h.rejectMemberApplication.mockResolvedValue({ status: "REJECTED" });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("PUT /api/admin/member-applications/[id] notify choice (#1786)", () => {
  it("threads notifyMember as undefined (= notify) when the flag is omitted on APPROVE", async () => {
    const res = await PUT(req({ decision: "APPROVE" }), { params });

    expect(res.status).toBe(200);
    expect(h.approveMemberApplication).toHaveBeenCalledTimes(1);
    // notifyMember is the 5th positional argument (index 4).
    expect(h.approveMemberApplication.mock.calls[0][4]).toBeUndefined();
  });

  it("threads notifyMember: false through to approveMemberApplication", async () => {
    const res = await PUT(req({ decision: "APPROVE", notifyMember: false }), {
      params,
    });

    expect(res.status).toBe(200);
    expect(h.approveMemberApplication).toHaveBeenCalledTimes(1);
    expect(h.approveMemberApplication.mock.calls[0][4]).toBe(false);
  });

  it("threads notifyMember: true through to approveMemberApplication", async () => {
    const res = await PUT(req({ decision: "APPROVE", notifyMember: true }), {
      params,
    });

    expect(res.status).toBe(200);
    expect(h.approveMemberApplication.mock.calls[0][4]).toBe(true);
  });

  it("threads notifyMember: false through to rejectMemberApplication", async () => {
    const res = await PUT(req({ decision: "REJECT", notifyMember: false }), {
      params,
    });

    expect(res.status).toBe(200);
    expect(h.rejectMemberApplication).toHaveBeenCalledTimes(1);
    // notifyMember is the 4th positional argument (index 3).
    expect(h.rejectMemberApplication.mock.calls[0][3]).toBe(false);
  });

  it("threads notifyMember as undefined (= notify) when the flag is omitted on REJECT", async () => {
    const res = await PUT(req({ decision: "REJECT" }), { params });

    expect(res.status).toBe(200);
    expect(h.rejectMemberApplication).toHaveBeenCalledTimes(1);
    expect(h.rejectMemberApplication.mock.calls[0][3]).toBeUndefined();
  });

  it("rejects a non-boolean notifyMember with the route's 422 validation response and calls no service", async () => {
    const res = await PUT(
      req({ decision: "APPROVE", notifyMember: "false" }),
      { params },
    );

    expect(res.status).toBe(422);
    expect(h.approveMemberApplication).not.toHaveBeenCalled();
    expect(h.rejectMemberApplication).not.toHaveBeenCalled();
  });
});
