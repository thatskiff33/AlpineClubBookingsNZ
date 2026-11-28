import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), cancel: vi.fn(), getClientIp: vi.fn() }));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/admin-credit-deduction-cancel", () => ({ cancelAdminCreditDeductionCorrection: mocks.cancel }));
vi.mock("@/lib/rate-limit", () => ({ getClientIp: mocks.getClientIp }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn() } }));

import { POST } from "@/app/api/admin/members/[id]/credits/corrections/[correctionId]/route";
import { MemberCreditValidationError } from "@/lib/policies/member-credit";

const params = { params: Promise.resolve({ id: "member-1", correctionId: "correction-1" }) };
const request = () => new NextRequest("http://localhost/api/admin/members/member-1/credits/corrections/correction-1", { method: "POST" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "officer-1" } } });
  mocks.getClientIp.mockReturnValue("127.0.0.1");
  mocks.cancel.mockResolvedValue(undefined);
});

describe("cancel credit deduction correction route", () => {
  it("requires finance edit permission before cancellation", async () => {
    mocks.requireAdmin.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) });
    const response = await POST(request(), params);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "finance", level: "edit" } });
    expect(response.status).toBe(403);
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("passes both member and correction ids to the guarded service", async () => {
    const response = await POST(request(), params);
    expect(response.status).toBe(200);
    expect(mocks.cancel).toHaveBeenCalledWith({ memberId: "member-1", correctionId: "correction-1", adminId: "officer-1", ipAddress: "127.0.0.1" });
  });

  it("shows the refusal when Xero already changed", async () => {
    mocks.cancel.mockRejectedValue(new MemberCreditValidationError("Xero has already changed; retry the correction."));
    const response = await POST(request(), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Xero has already changed; retry the correction." });
  });

  it("keeps unexpected provider errors private", async () => {
    mocks.cancel.mockRejectedValue(new Error("private provider detail"));
    const response = await POST(request(), params);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to cancel Xero correction" });
  });
});
