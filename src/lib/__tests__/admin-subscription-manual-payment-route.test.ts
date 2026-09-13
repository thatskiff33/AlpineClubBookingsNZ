import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #2260 — the manual mark-paid route's notifyMember contract.
 *
 * The choice is a real one with a real consequence (a member gets a payment
 * receipt or does not), so the API refuses to guess: it is REQUIRED on
 * direction "paid" and REJECTED on direction "unpaid", 422 either way.
 */

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  applyManualSubscriptionPayment: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/manual-subscription-payment", async () => {
  const actual = (await vi.importActual("@/lib/manual-subscription-payment")) as typeof import("@/lib/manual-subscription-payment");
  return {
    ...actual,
    applyManualSubscriptionPayment: mocks.applyManualSubscriptionPayment,
  };
});
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));
vi.mock("@/lib/email/membership", () => ({
  sendMembershipPaymentRecordedEmail: vi.fn(),
}));

import { POST } from "@/app/api/admin/subscriptions/[id]/manual-payment/route";

const params = Promise.resolve({ id: "sub-1" });

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest(
    "https://example.test/api/admin/subscriptions/sub-1/manual-payment",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  mocks.applyManualSubscriptionPayment.mockResolvedValue({
    id: "sub-1",
    memberId: "m-1",
    seasonYear: 2026,
    status: "PAID",
    direction: "paid",
    memberNotified: true,
    receipt: "queued",
  });
});

describe("POST /api/admin/subscriptions/[id]/manual-payment (#2260)", () => {
  it("422s a mark-paid that does not say whether the member is emailed", async () => {
    const response = await POST(
      makeRequest({ direction: "paid", confirmed: true }),
      { params },
    );

    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain("notifyMember is required");
    // Nothing is written until the caller states the choice.
    expect(mocks.applyManualSubscriptionPayment).not.toHaveBeenCalled();
  });

  it("422s a reversal that carries notifyMember — a reversal emails nobody", async () => {
    const response = await POST(
      makeRequest({ direction: "unpaid", confirmed: true, notifyMember: true }),
      { params },
    );

    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain("never emails the member");
    expect(mocks.applyManualSubscriptionPayment).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "passes the admin's choice (%s) straight through on mark-paid",
    async (notifyMember) => {
      mocks.applyManualSubscriptionPayment.mockResolvedValue({
        id: "sub-1",
        memberId: "m-1",
        seasonYear: 2026,
        status: "PAID",
        direction: "paid",
        memberNotified: notifyMember,
        receipt: notifyMember ? "queued" : "not_requested",
      });

      const response = await POST(
        makeRequest({
          direction: "paid",
          confirmed: true,
          note: "cash",
          notifyMember,
        }),
        { params },
      );

      expect(response.status).toBe(200);
      expect(mocks.applyManualSubscriptionPayment).toHaveBeenCalledWith({
        subscriptionId: "sub-1",
        direction: "paid",
        note: "cash",
        actingMemberId: "admin-1",
        notifyMember,
      });
      // The response says which way it went, so the admin is never left
      // guessing whether the member heard about it.
      expect((await response.json()).message).toContain(
        notifyMember ? "is being emailed" : "was not emailed",
      );
    },
  );

  it("accepts a reversal with no notifyMember and never forwards the field", async () => {
    mocks.applyManualSubscriptionPayment.mockResolvedValue({
      id: "sub-1",
      memberId: "m-1",
      seasonYear: 2026,
      status: "NOT_INVOICED",
      direction: "unpaid",
      memberNotified: false,
      receipt: "not_requested",
    });

    const response = await POST(
      makeRequest({ direction: "unpaid", confirmed: true }),
      { params },
    );

    expect(response.status).toBe(200);
    const call = mocks.applyManualSubscriptionPayment.mock.calls[0][0];
    expect(call).toEqual({
      subscriptionId: "sub-1",
      direction: "unpaid",
      note: null,
      actingMemberId: "admin-1",
    });
    expect("notifyMember" in call).toBe(false);
  });

  it("never reports a receipt as sent when the mailer did not send it", async () => {
    mocks.applyManualSubscriptionPayment.mockResolvedValue({
      id: "sub-1",
      memberId: "m-1",
      seasonYear: 2026,
      status: "PAID",
      direction: "paid",
      // The admin asked for the email; the mailer suppressed it, hit a
      // club-internal placeholder address, or failed outright.
      memberNotified: true,
      receipt: "not_delivered",
    });

    const response = await POST(
      makeRequest({ direction: "paid", confirmed: true, notifyMember: true }),
      { params },
    );

    const message = (await response.json()).message;
    expect(response.status).toBe(200);
    expect(message).toContain("could not be sent");
    // The whole point: no wording that lets the admin walk away believing the
    // member was told.
    expect(message).not.toContain("is being emailed");
    expect(message).not.toContain("has been emailed");
  });

  it("still 400s a malformed body before the notify contract is considered", async () => {
    const response = await POST(
      makeRequest({ direction: "paid", confirmed: true, notifyMember: "yes" }),
      { params },
    );

    expect(response.status).toBe(400);
    expect(mocks.applyManualSubscriptionPayment).not.toHaveBeenCalled();
  });

  it("keeps the finance:edit gate ahead of everything", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    });

    const response = await POST(
      makeRequest({ direction: "paid", confirmed: true }),
      { params },
    );

    expect(response.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "finance", level: "edit" },
    });
  });
});
