/**
 * POST /api/admin/bookings/[id]/additional-payment/withdraw (#3528,
 * `INV-ADDPAY-040`): auth and shape. The money decisions are the service's
 * (`additional-payment-withdraw.test.ts`); the route's job is to require the
 * finance permission, pass the refusal through untouched, and never leak an
 * unexpected error's message.
 */
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  withdrawAdditionalPaymentAsk: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/additional-payment-withdraw", () => ({
  withdrawAdditionalPaymentAsk: mocks.withdrawAdditionalPaymentAsk,
}));
vi.mock("@/lib/audit", () => ({
  getAuditRequestContext: () => ({
    id: "req_1",
    ipAddress: "127.0.0.1",
    userAgent: "vitest",
  }),
}));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { POST } from "@/app/api/admin/bookings/[id]/additional-payment/withdraw/route";

const params = Promise.resolve({ id: "bk_1" });

function request() {
  return new NextRequest(
    "http://localhost/api/admin/bookings/bk_1/additional-payment/withdraw",
    { method: "POST", headers: { "content-type": "application/json" } },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin_1" } },
  });
  mocks.withdrawAdditionalPaymentAsk.mockResolvedValue({
    ok: true,
    withdrawnAmountCents: 2275,
    paymentIntentId: "pi_1",
    intentStatus: "canceled",
    retired: { xeroOperations: 1 },
  });
});

describe("admin additional-payment withdraw route", () => {
  it("requires the FINANCE edit permission - retiring money instruments is the payments board's authority", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });

    const response = await POST(request(), { params });

    expect(response.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "finance", level: "edit" },
    });
    expect(mocks.withdrawAdditionalPaymentAsk).not.toHaveBeenCalled();
  });

  it("withdraws on behalf of the signed-in officer and reports what was retired", async () => {
    const response = await POST(request(), { params });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      withdrawnAmountCents: 2275,
      retired: { xeroOperations: 1 },
    });
    expect(mocks.withdrawAdditionalPaymentAsk).toHaveBeenCalledWith({
      bookingId: "bk_1",
      actorMemberId: "admin_1",
      auditRequest: { id: "req_1", ipAddress: "127.0.0.1", userAgent: "vitest" },
    });
  });

  it("passes a refusal through with its own status and message", async () => {
    mocks.withdrawAdditionalPaymentAsk.mockResolvedValue({
      ok: false,
      status: 409,
      error: "The member has already paid this request, so it cannot be withdrawn.",
    });

    const response = await POST(request(), { params });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "The member has already paid this request, so it cannot be withdrawn.",
    });
  });

  it("never leaks an unexpected error's message to the caller", async () => {
    mocks.withdrawAdditionalPaymentAsk.mockRejectedValue(
      new Error("connect ECONNREFUSED 10.0.0.7:5432"),
    );

    const response = await POST(request(), { params });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Failed to withdraw the payment request");
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
  });
});
