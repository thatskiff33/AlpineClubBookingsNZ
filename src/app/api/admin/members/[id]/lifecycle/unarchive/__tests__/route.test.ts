import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

// POST /api/admin/members/[id]/lifecycle/unarchive (#5540): an admin session,
// then Full Admin only, then a zod-checked reason, then the service. The
// service's own refusals pass through with their status.
const h = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  actorIsFullAdmin: vi.fn(),
  unarchiveMember: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/admin-account-guards", () => ({ actorIsFullAdmin: h.actorIsFullAdmin }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/member-unarchive", () => ({
  UNARCHIVE_FULL_ADMIN_ONLY_MESSAGE: "Only a Full Admin can unarchive a member.",
  unarchiveMember: h.unarchiveMember,
}));
vi.mock("@/lib/member-lifecycle-actions", () => {
  class MemberLifecycleActionError extends Error {
    constructor(message: string, public readonly statusCode = 400) {
      super(message);
    }
  }
  return { MemberLifecycleActionError };
});
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { POST } from "@/app/api/admin/members/[id]/lifecycle/unarchive/route";
import { jsonRequest, routeParams } from "@/lib/__tests__/helpers";
import { MemberLifecycleActionError } from "@/lib/member-lifecycle-actions";

function post(body: unknown) {
  return POST(
    jsonRequest("/api/admin/members/m-1/lifecycle/unarchive", body),
    routeParams({ id: "m-1" }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "admin-1" } } });
  h.actorIsFullAdmin.mockResolvedValue(true);
  h.unarchiveMember.mockResolvedValue({ request: { id: "req-1", action: "UNARCHIVE", status: "APPROVED" } });
});

describe("POST /api/admin/members/[id]/lifecycle/unarchive (#5540)", () => {
  it("answers the admin guard's refusal unchanged", async () => {
    h.requireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    const res = await post({ reason: "Archived by mistake" });
    expect(res.status).toBe(401);
    expect(h.unarchiveMember).not.toHaveBeenCalled();
  });

  it("refuses an admin who is not a Full Admin with 403", async () => {
    h.actorIsFullAdmin.mockResolvedValue(false);
    const res = await post({ reason: "Archived by mistake" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Only a Full Admin can unarchive a member." });
    expect(h.unarchiveMember).not.toHaveBeenCalled();
  });

  it.each([
    ["no reason", {}],
    ["a blank reason", { reason: "   " }],
    ["a reason over 1000 characters", { reason: "x".repeat(1001) }],
  ])("refuses %s with 400", async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(h.unarchiveMember).not.toHaveBeenCalled();
  });

  it("unarchives with the session's admin as the actor and the trimmed reason", async () => {
    const res = await post({ reason: "  Archived by mistake  " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ request: { id: "req-1", action: "UNARCHIVE", status: "APPROVED" } });
    expect(h.unarchiveMember).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: "m-1", actorMemberId: "admin-1", reason: "Archived by mistake" }),
    );
  });

  it("passes a service refusal through with its status", async () => {
    h.unarchiveMember.mockRejectedValue(new MemberLifecycleActionError("This member is not archived.", 409));
    const res = await post({ reason: "Archived by mistake" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This member is not archived." });
  });

  it("answers 500 without detail for an unexpected failure", async () => {
    h.unarchiveMember.mockRejectedValue(new Error("connection reset"));
    const res = await post({ reason: "Archived by mistake" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to unarchive member" });
  });
});
