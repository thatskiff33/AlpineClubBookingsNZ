import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  requeue: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));
vi.mock("@/lib/email-failure-review", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/email-failure-review")),
  requeueExhaustedEmailFailure: mocks.requeue,
}));

import { EmailFailureReviewError } from "@/lib/email-failure-review";
import { POST } from "../route";

const params = { params: Promise.resolve({ id: "email-1" }) };
const request = () =>
  new NextRequest("https://club.example.com/api/admin/email-failures/email-1/retry", {
    method: "POST",
  });

describe("POST /api/admin/email-failures/[id]/retry (#4963)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "admin-1" } } });
  });

  it("requires Support & System edit access and requeues nothing without it", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "Forbidden" }, { status: 403 }),
    });

    const res = await POST(request(), params);

    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "support", level: "edit" },
    });
    expect(mocks.requeue).not.toHaveBeenCalled();
  });

  it("hands the row back to the retry job as the signed-in admin", async () => {
    mocks.requeue.mockResolvedValue({ id: "email-1", requeued: true });

    const res = await POST(request(), params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "email-1", requeued: true });
    expect(mocks.requeue).toHaveBeenCalledWith("email-1", { requestedByMemberId: "admin-1" });
  });

  it.each([
    [404, "Email failure not found."],
    [409, "This email can no longer be tried again."],
  ])("answers %i with the service's message", async (status, message) => {
    mocks.requeue.mockRejectedValue(new EmailFailureReviewError(message, status));

    const res = await POST(request(), params);

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: message });
  });

  it("answers 500 without the internal error on anything unexpected", async () => {
    mocks.requeue.mockRejectedValue(new Error("connection reset"));

    const res = await POST(request(), params);

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("connection reset");
  });
});
